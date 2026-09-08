import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { resolvePort } from "../shared/port.js";
import type {
  DashboardToServerMessage,
  ServerToDashboardMessage,
  ServerToSessionMessage,
  SessionToServerMessage,
} from "../shared/types.js";
import { SessionRegistry } from "./state.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const HEARTBEAT_INTERVAL_MS = 15_000;

function main(): void {
  const port = resolvePort();
  const registry = new SessionRegistry();

  const httpServer = createServer((req, res) => {
    void serveStatic(req.url, res);
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  /** Sockets tagged by role so a close handler knows which registry to update. */
  const sessionSockets = new Map<WebSocket, string>();
  const dashboardSockets = new Set<WebSocket>();

  const broadcastSnapshot = (): void => {
    const message: ServerToDashboardMessage = { type: "snapshot", sessions: registry.snapshotAll() };
    const payload = JSON.stringify(message);
    for (const socket of dashboardSockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  };

  const broadcastDashboardState = (): void => {
    const message: ServerToSessionMessage = { type: "dashboard_state", connected: dashboardSockets.size > 0 };
    const payload = JSON.stringify(message);
    for (const socket of sessionSockets.keys()) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  };

  wss.on("connection", (socket) => {
    let role: "session" | "dashboard" | undefined;
    (socket as WebSocket & { isAlive?: boolean }).isAlive = true;
    socket.on("pong", () => {
      (socket as WebSocket & { isAlive?: boolean }).isAlive = true;
    });

    socket.on("message", (raw) => {
      let parsed: SessionToServerMessage | DashboardToServerMessage;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (parsed.type === "hello" && "role" in parsed && parsed.role === "dashboard") {
        role = "dashboard";
        dashboardSockets.add(socket);
        const welcome: ServerToDashboardMessage = { type: "snapshot", sessions: registry.snapshotAll() };
        socket.send(JSON.stringify(welcome));
        broadcastDashboardState();
        return;
      }

      if (parsed.type === "hello" && "sessionId" in parsed) {
        role = "session";
        sessionSockets.set(socket, parsed.sessionId);
        registry.register(parsed.sessionId, parsed.pid, parsed.cwd, parsed.sessionName, parsed.todoPhases ?? []);
        const welcome: ServerToSessionMessage = { type: "welcome", dashboardConnected: dashboardSockets.size > 0 };
        socket.send(JSON.stringify(welcome));
        broadcastSnapshot();
        return;
      }

      if (role !== "session") return;
      const sessionId = sessionSockets.get(socket);
      if (!sessionId) return;

      switch (parsed.type) {
        case "status":
          registry.setStatus(sessionId, parsed.status);
          break;
        case "tool":
          registry.setTool(sessionId, parsed.toolName);
          break;
        case "todo":
          registry.setTodoPhases(sessionId, parsed.phases);
          break;
        case "context":
          registry.setContextUsage(sessionId, parsed.usage);
          break;
        case "name":
          registry.setSessionName(sessionId, parsed.sessionName);
          break;
        case "awaiting_input":
          registry.setAwaitingInput(sessionId, parsed.waiting);
          break;
      }
      broadcastSnapshot();
    });

    socket.on("close", () => {
      if (role === "dashboard") {
        dashboardSockets.delete(socket);
        broadcastDashboardState();
        return;
      }
      const sessionId = sessionSockets.get(socket);
      sessionSockets.delete(socket);
      if (sessionId) {
        registry.remove(sessionId);
        broadcastSnapshot();
      }
    });
  });

  // Protocol-level ping/pong: a session that vanished without a clean close
  // (killed process, network drop) is pruned within one heartbeat interval
  // instead of lingering in the roster forever.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const tracked = socket as WebSocket & { isAlive?: boolean };
      if (tracked.isAlive === false) {
        socket.terminate();
        continue;
      }
      tracked.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      // Another process already won the bind race for this port. Per the
      // port-bind failover design, the loser simply exits.
      process.exit(0);
    }
    process.exit(1);
  });

  httpServer.listen(port, "127.0.0.1");
}

async function serveStatic(url: string | undefined, res: import("node:http").ServerResponse): Promise<void> {
  const path = url === "/" || !url ? "/dashboard.html" : url.split("?")[0]!;
  const ext = extname(path);
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    res.writeHead(404).end("Not found");
    return;
  }
  try {
    const body = await readFile(join(PUBLIC_DIR, path));
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" }).end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

main();
