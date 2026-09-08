// Wire protocol and shared state shapes for the omp-viewer dashboard.
//
// Kept intentionally tiny: the bundled server is a dumb relay/registry, and
// the popup computes display-only derived state (blocked-first sort, idle
// graying, context-pressure coloring) from the raw fields below.

export type TodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "abandoned"
  | "blocked";

export interface TodoItem {
  content: string;
  status: TodoStatus;
  blocker?: string;
}

export interface TodoPhase {
  name: string;
  tasks: TodoItem[];
}

export interface ContextUsage {
  tokens: number;
  contextWindow: number;
  percent: number;
}

export type SessionStatus = "idle" | "busy";

/** Full state the server holds per connected session; also what it broadcasts to popups. */
export interface SessionSnapshot {
  sessionId: string;
  pid: number;
  cwd: string;
  sessionName?: string;
  status: SessionStatus;
  /** True while this session has a live tool-approval or `ask` prompt waiting on the user. */
  awaitingInput: boolean;
  lastTool?: string;
  lastActivity: number;
  connectedAt: number;
  todoPhases: TodoPhase[];
  contextUsage?: ContextUsage;
}

// ---- session (extension) -> server ----

export type SessionToServerMessage =
  | { type: "hello"; sessionId: string; pid: number; cwd: string; sessionName?: string; todoPhases?: TodoPhase[] }
  | { type: "status"; status: SessionStatus }
  | { type: "tool"; toolName: string }
  | { type: "todo"; phases: TodoPhase[] }
  | { type: "context"; usage: ContextUsage }
  | { type: "name"; sessionName: string }
  | { type: "awaiting_input"; waiting: boolean };

// ---- server -> session ----

export type ServerToSessionMessage =
  | { type: "welcome"; dashboardConnected: boolean }
  | { type: "dashboard_state"; connected: boolean };

// ---- dashboard (popup) -> server ----

export type DashboardToServerMessage = { type: "hello"; role: "dashboard" };

// ---- server -> dashboard (popup) ----

export type ServerToDashboardMessage = {
  type: "snapshot";
  sessions: SessionSnapshot[];
};

export const DEFAULT_PORT = 8317;
