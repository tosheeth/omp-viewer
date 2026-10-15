import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { resolvePort } from "../shared/port.js";
import { getOrCreateToken } from "../shared/token.js";
import { trySpawnPopup } from "../shared/browser.js";
import { createPopupGate } from "./popup-gate.js";
import { serveStatic } from "./static.js";
import type {
  DashboardToServerMessage,
  ServerToDashboardMessage,
  ServerToSessionMessage,
  SessionToServerMessage,
} from "../shared/types.js";
import { notifyAwaitingInput } from "./notify.js";
import { SessionRegistry } from "./state.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

const HEARTBEAT_INTERVAL_MS = 15_000;
/** Close code used for a rejected/missing auth token, distinct from an ordinary drop. */
const UNAUTHORIZED_CLOSE_CODE = 4001;

function main(): void {
  const port = resolvePort();
  const token = getOrCreateToken();
  const registry = new SessionRegistry();

  const httpServer = createServer((req, res) => {
    void serveStatic(req.url, PUBLIC_DIR, res);
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  /** Sockets tagged by role so a close handler knows which registry to update. */
  const sessionSockets = new Map<WebSocket, string>();
  const dashboardSockets = new Set<WebSocket>();
  /** requestId -> the session socket that posted the question, so a dashboard's answer routes back to the right session. */
  const pendingAsks = new Map<string, WebSocket>();
  const ensurePopupOpen = createPopupGate({ spawnPopup: () => trySpawnPopup(port, token) });

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

  const broadcastToDashboards = (message: ServerToDashboardMessage): void => {
    const payload = JSON.stringify(message);
    for (const socket of dashboardSockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  };

  wss.on("connection", (socket) => {
    let role: "session" | "dashboard" | undefined;
    let authorized = false;
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
        if (parsed.token !== token) {
          socket.close(UNAUTHORIZED_CLOSE_CODE, "unauthorized");
          return;
        }
        role = "dashboard";
        authorized = true;
        dashboardSockets.add(socket);
        const welcome: ServerToDashboardMessage = { type: "snapshot", sessions: registry.snapshotAll() };
        socket.send(JSON.stringify(welcome));
        broadcastDashboardState();
        return;
      }

      if (parsed.type === "hello" && "sessionId" in parsed) {
        if (parsed.token !== token) {
          socket.close(UNAUTHORIZED_CLOSE_CODE, "unauthorized");
          return;
        }
        role = "session";
        authorized = true;
        sessionSockets.set(socket, parsed.sessionId);
        registry.register(parsed.sessionId, parsed.pid, parsed.cwd, parsed.sessionName, parsed.todoPhases ?? []);
        ensurePopupOpen(dashboardSockets.size > 0);
        const welcome: ServerToSessionMessage = { type: "welcome", dashboardConnected: dashboardSockets.size > 0 };
        socket.send(JSON.stringify(welcome));
        broadcastSnapshot();
        return;
      }

      if (!authorized) return;

      if (role === "dashboard" && parsed.type === "ask_answer") {
        const target = pendingAsks.get(parsed.requestId);
        if (target?.readyState === WebSocket.OPEN) {
          const message: ServerToSessionMessage = { type: "ask_answer", requestId: parsed.requestId, answers: parsed.answers };
          target.send(JSON.stringify(message));
        }
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
        case "usage":
          registry.setUsage(sessionId, parsed.usage);
          break;
        case "name":
          registry.setSessionName(sessionId, parsed.sessionName);
          break;
        case "awaiting_input": {
          const becameAwaiting = registry.setAwaitingInput(sessionId, parsed.waiting);
          if (becameAwaiting) {
            const snapshot = registry.snapshotAll().find((s) => s.sessionId === sessionId);
            if (snapshot) notifyAwaitingInput(snapshot);
          }
          break;
        }
        case "ask_question":
          pendingAsks.set(parsed.requestId, socket);
          broadcastToDashboards({ type: "ask_question", sessionId, requestId: parsed.requestId, questions: parsed.questions });
          break;
        case "ask_resolved":
          pendingAsks.delete(parsed.requestId);
          broadcastToDashboards({ type: "ask_resolved", requestId: parsed.requestId });
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
      for (const [requestId, questionSocket] of pendingAsks) {
        if (questionSocket === socket) pendingAsks.delete(requestId);
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

  // The instant this process actually becomes the live server (won the
  // bind race above), or reset/reinitialized after a crash, there is no
  // dashboard connected yet — open one immediately rather than waiting for
  // the first session's hello (which may be seconds away on cold start).
  httpServer.on("listening", () => {
    ensurePopupOpen(dashboardSockets.size > 0);
  });

  httpServer.listen(port, "127.0.0.1");
}

main();
