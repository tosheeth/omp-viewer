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

/** Cumulative session usage, mirroring `SessionManager.getUsageStatistics()`. */
export interface SessionUsage {
  tokens: number;
  cost: number;
}

export type SessionStatus = "idle" | "busy";

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  id: string;
  question: string;
  options: AskOption[];
  multi?: boolean;
}

export interface AskAnswer {
  id: string;
  selectedLabels: string[];
  customInput?: string;
}

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
  usage?: SessionUsage;
}

// ---- session (extension) -> server ----

export type SessionToServerMessage =
  | { type: "hello"; token: string; sessionId: string; pid: number; cwd: string; sessionName?: string; todoPhases?: TodoPhase[] }
  | { type: "status"; status: SessionStatus }
  | { type: "tool"; toolName: string }
  | { type: "todo"; phases: TodoPhase[] }
  | { type: "context"; usage: ContextUsage }
  | { type: "usage"; usage: SessionUsage }
  | { type: "name"; sessionName: string }
  | { type: "awaiting_input"; waiting: boolean }
  | { type: "ask_question"; requestId: string; questions: AskQuestion[] }
  | { type: "ask_resolved"; requestId: string };

// ---- server -> session ----

export type ServerToSessionMessage =
  | { type: "welcome"; dashboardConnected: boolean }
  | { type: "dashboard_state"; connected: boolean }
  | { type: "ask_answer"; requestId: string; answers: AskAnswer[] };

// ---- dashboard (popup) -> server ----

export type DashboardToServerMessage =
  | { type: "hello"; role: "dashboard"; token: string }
  | { type: "ask_answer"; requestId: string; answers: AskAnswer[] };

// ---- server -> dashboard (popup) ----

export type ServerToDashboardMessage =
  | { type: "snapshot"; sessions: SessionSnapshot[] }
  | { type: "ask_question"; sessionId: string; requestId: string; questions: AskQuestion[] }
  | { type: "ask_resolved"; requestId: string };

export const DEFAULT_PORT = 8317;
