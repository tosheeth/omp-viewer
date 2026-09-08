import { trySpawnPopup, trySpawnServer } from "./spawn.js";
import type { AskAnswer, ServerToSessionMessage, SessionToServerMessage, TodoPhase } from "../shared/types.js";

const CONNECT_TIMEOUT_MS = 300;
const MAX_BACKOFF_MS = 5000;

export interface DashboardLinkOptions {
  port: number;
  token: string;
  sessionId: string;
  pid: number;
  cwd: string;
  getSessionName: () => string | undefined;
  initialTodoPhases: TodoPhase[];
  onDashboardStateChange?: (connected: boolean) => void;
  onAskAnswer?: (requestId: string, answers: AskAnswer[]) => void;
  onLog?: (message: string) => void;
  /**
   * Extensions must not use raw setTimeout for background work — a throw
   * inside it escapes the handler-dispatch try/catch and tears down the
   * whole session (see docs/extensions.md "Background work"). Route both
   * reconnect backoff and the connect timeout through the session's managed
   * timer instead.
   */
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

/**
 * Connect-or-spawn WebSocket client. On first connect failure it spawns the
 * bundled server (§5.1 cold start), then retries with bounded backoff
 * forever (§5.3 crash recovery) — there is no giving up, since any other
 * session on the machine may win the next bind race.
 *
 * Uses the platform-global `WebSocket` (available in the Bun runtime that
 * hosts omp itself) rather than the `ws` npm package: under omp's bundled
 * Bun runtime, `ws`'s Node-EventEmitter-style `error` handling did not
 * reliably reach a registered listener and produced a process-fatal
 * unhandled exception on ECONNREFUSED during the cold-start path. The
 * WHATWG `addEventListener` surface used here is what Bun's WebSocket
 * natively implements.
 */
export class DashboardLink {
  private ws: WebSocket | undefined;
  private closed = false;
  private reconnectHandle: unknown;
  private connectTimeoutHandle: unknown;
  private spawnedServer = false;
  dashboardConnected = false;

  constructor(private readonly opts: DashboardLinkOptions) {}

  start(): void {
    this.attemptConnect(0);
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectHandle !== undefined) this.opts.clearTimer(this.reconnectHandle);
    if (this.connectTimeoutHandle !== undefined) this.opts.clearTimer(this.connectTimeoutHandle);
    this.ws?.close();
  }

  send(message: SessionToServerMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private attemptConnect(attempt: number): void {
    if (this.closed) return;

    const socket = new WebSocket(`ws://127.0.0.1:${this.opts.port}/ws`);
    this.ws = socket;

    this.connectTimeoutHandle = this.opts.setTimer(() => {
      if (socket.readyState === WebSocket.CONNECTING) socket.close();
    }, CONNECT_TIMEOUT_MS);

    socket.addEventListener("open", () => this.safely(() => this.handleOpen(socket)), { once: true });
    socket.addEventListener("message", (ev) => this.safely(() => this.handleMessage(ev)));
    socket.addEventListener("close", () => this.safely(() => this.handleDisconnect(socket, attempt)), { once: true });
    // A connection-refused/reset error fires both "error" and "close"; only
    // "close" is handled to avoid double-scheduling a reconnect. An "error"
    // listener still MUST be registered, otherwise some runtimes treat an
    // unlistened socket "error" as an unhandled exception.
    socket.addEventListener("error", () => {});
  }

  private handleOpen(socket: WebSocket): void {
    this.clearConnectTimeout();
    const hello: SessionToServerMessage = {
      type: "hello",
      token: this.opts.token,
      sessionId: this.opts.sessionId,
      pid: this.opts.pid,
      cwd: this.opts.cwd,
      sessionName: this.opts.getSessionName(),
      todoPhases: this.opts.initialTodoPhases,
    };
    socket.send(JSON.stringify(hello));
  }

  private handleMessage(ev: MessageEvent): void {
    const parsed = JSON.parse(String(ev.data)) as ServerToSessionMessage;

    if (parsed.type === "ask_answer") {
      this.opts.onAskAnswer?.(parsed.requestId, parsed.answers);
      return;
    }

    const connected = parsed.type === "welcome" ? parsed.dashboardConnected : parsed.connected;
    this.dashboardConnected = connected;
    this.opts.onDashboardStateChange?.(connected);

    // Only the session that itself spawned the server also opens the
    // popup, and only if nothing is already showing one — this is what
    // keeps "always-available popup" from becoming "one popup per session".
    if (parsed.type === "welcome" && this.spawnedServer && !connected) {
      trySpawnPopup(this.opts.port, this.opts.token);
    }
  }

  private handleDisconnect(socket: WebSocket, attempt: number): void {
    this.clearConnectTimeout();
    if (this.ws === socket) this.ws = undefined;
    if (this.closed) return;

    if (attempt === 0) {
      this.spawnedServer = trySpawnServer(this.opts.port);
      if (!this.spawnedServer) {
        this.opts.onLog?.(
          "omp-viewer: no server reachable and no JS runtime found to spawn one; dashboard link disabled for this session",
        );
      }
    }

    const delay = Math.min(200 * 2 ** attempt, MAX_BACKOFF_MS);
    this.reconnectHandle = this.opts.setTimer(() => this.attemptConnect(attempt + 1), delay);
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeoutHandle === undefined) return;
    this.opts.clearTimer(this.connectTimeoutHandle);
    this.connectTimeoutHandle = undefined;
  }

  /** Socket callbacks run outside handler-dispatch isolation — contain throws ourselves. */
  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.opts.onLog?.(`omp-viewer: dashboard link error: ${String(err)}`);
    }
  }
}
