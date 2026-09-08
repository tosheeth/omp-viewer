import type {
  ContextUsage,
  SessionSnapshot,
  SessionStatus,
  SessionUsage,
  TodoPhase,
} from "../shared/types.js";

/**
 * In-memory session registry. One process owns this; there is no
 * persistence, no lock file, and no TTL — a session's entry lives exactly as
 * long as its socket does (see docs/05 "Server crash mid-session": recovery
 * falls out of the OS closing the socket, not custom bookkeeping).
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionSnapshot>();

  register(sessionId: string, pid: number, cwd: string, sessionName: string | undefined, todoPhases: TodoPhase[]): void {
    const now = Date.now();
    this.sessions.set(sessionId, {
      sessionId,
      pid,
      cwd,
      sessionName,
      status: "idle",
      awaitingInput: false,
      lastActivity: now,
      connectedAt: now,
      todoPhases,
    });
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  setStatus(sessionId: string, status: SessionStatus): void {
    this.touch(sessionId, (s) => {
      s.status = status;
    });
  }

  setTool(sessionId: string, toolName: string): void {
    this.touch(sessionId, (s) => {
      s.lastTool = toolName;
    });
  }

  /** Returns true exactly when this call transitions the session from not-awaiting to awaiting — the toast trigger edge. */
  setAwaitingInput(sessionId: string, waiting: boolean): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    const becameAwaiting = waiting && !s.awaitingInput;
    s.awaitingInput = waiting;
    s.lastActivity = Date.now();
    return becameAwaiting;
  }

  setUsage(sessionId: string, usage: SessionUsage): void {
    this.touch(sessionId, (s) => {
      s.usage = usage;
    });
  }

  setTodoPhases(sessionId: string, phases: TodoPhase[]): void {
    this.touch(sessionId, (s) => {
      s.todoPhases = phases;
    });
  }

  setContextUsage(sessionId: string, usage: ContextUsage): void {
    this.touch(sessionId, (s) => {
      s.contextUsage = usage;
    });
  }

  setSessionName(sessionId: string, sessionName: string): void {
    this.touch(sessionId, (s) => {
      s.sessionName = sessionName;
    });
  }

  snapshotAll(): SessionSnapshot[] {
    return [...this.sessions.values()].sort((a, b) => a.connectedAt - b.connectedAt);
  }

  private touch(sessionId: string, mutate: (s: SessionSnapshot) => void): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    mutate(s);
    s.lastActivity = Date.now();
  }
}
