import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { basename } from "node:path";
import { DashboardLink } from "./client/link.js";
import { trySpawnPopup } from "./client/spawn.js";
import { resolvePort } from "./shared/port.js";
import type { TodoPhase } from "./shared/types.js";

/**
 * omp-viewer: cross-session dashboard + todo mirror.
 *
 * Deliberately does not register a `todo_write` tool or a `/todos` command —
 * omp already ships a built-in `todo` tool, `/todo` command, and TUI panel.
 * This extension only mirrors that existing state out over a loopback
 * WebSocket so a popup can show every session at once; it never calls
 * `sendMessage`/`sendUserMessage`/`appendEntry`, so it adds no tokens to any
 * request.
 */
export default function ompViewer(pi: ExtensionAPI): void {
  pi.setLabel("Session Dashboard");

  let link: DashboardLink | undefined;
  let port = 0;
  let currentStatus: "idle" | "busy" = "idle";
  const pendingApprovals = new Set<string>();
  const pendingQuestions = new Set<string>();

  const sendAwaitingInput = (): void => {
    link?.send({ type: "awaiting_input", waiting: pendingApprovals.size > 0 || pendingQuestions.size > 0 });
  };

  // Terminal window/tab title: a status glyph plus session name (or cwd
  // basename) so the right window is identifiable in the taskbar / Alt-Tab
  // / terminal tab strip without needing the dashboard at all. There is no
  // documented API to change the window *icon* — `setTitle` (text only) is
  // the supported surface, so the glyph carries that signal instead.
  const refreshTitle = (ctx: ExtensionContext): void => {
    const awaiting = pendingApprovals.size > 0 || pendingQuestions.size > 0;
    const glyph = awaiting ? "\u{1F534}" : currentStatus === "busy" ? "\u{1F7E1}" : "\u{1F7E2}";
    const label = pi.getSessionName() || basename(ctx.cwd);
    ctx.ui.setTitle(`${glyph} ${label}`);
  };

  pi.on("session_start", (_event, ctx) => {
    port = resolvePort(ctx.cwd);
    const sessionId = ctx.sessionManager.getSessionId();

    link = new DashboardLink({
      port,
      sessionId,
      pid: process.pid,
      cwd: ctx.cwd,
      getSessionName: () => pi.getSessionName(),
      initialTodoPhases: reconstructTodoPhases(ctx),
      onLog: (message) => pi.logger.warn(message),
      setTimer: (fn, ms) => ctx.setTimeout(fn, ms),
      clearTimer: (handle) => ctx.clearTimer(handle as Parameters<typeof ctx.clearTimer>[0]),
    });
    link.start();
    refreshTitle(ctx);
  });

  pi.on("session_shutdown", () => {
    link?.stop();
    link = undefined;
  });

  // "Permission prompt" (tool approval) and "question prompt" (the `ask`
  // tool) both block the session on the user. `tool_approval_requested`
  // only fires when an interactive approval handler is registered, i.e.
  // exactly when the TUI is showing an "Allow tool" dialog.
  pi.on("tool_approval_requested", (event, ctx) => {
    pendingApprovals.add(event.toolCallId);
    sendAwaitingInput();
    refreshTitle(ctx);
  });

  pi.on("tool_approval_resolved", (event, ctx) => {
    pendingApprovals.delete(event.toolCallId);
    sendAwaitingInput();
    refreshTitle(ctx);
  });

  pi.on("turn_start", (_event, ctx) => {
    currentStatus = "busy";
    link?.send({ type: "status", status: "busy" });
    refreshTitle(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    currentStatus = "idle";
    link?.send({ type: "status", status: "idle" });
    const usage = ctx.getContextUsage();
    if (usage) link?.send({ type: "context", usage });
    refreshTitle(ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    link?.send({ type: "tool", toolName: event.toolName });
    if (event.toolName === "ask") {
      pendingQuestions.add(event.toolCallId);
      sendAwaitingInput();
      refreshTitle(ctx);
    }
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (event.toolName === "ask") {
      pendingQuestions.delete(event.toolCallId);
      sendAwaitingInput();
      refreshTitle(ctx);
    }
  });

  pi.on("tool_result", (event: ToolResultEvent) => {
    if (event.toolName !== "todo" || event.isError) return;
    const phases = (event.details as { phases?: TodoPhase[] } | undefined)?.phases;
    if (Array.isArray(phases)) link?.send({ type: "todo", phases });
  });

  pi.registerCommand("dashboard", {
    description: "Open the omp session dashboard popup",
    handler: async (_args, ctx) => {
      if (!link) {
        ctx.ui.notify("Dashboard link is not active for this session", "warning");
        return;
      }
      if (link.dashboardConnected) {
        ctx.ui.notify("Dashboard is already open", "info");
        return;
      }
      const opened = trySpawnPopup(port);
      ctx.ui.notify(
        opened ? "Opening dashboard\u2026" : "Could not find Microsoft Edge to open the dashboard",
        opened ? "info" : "warning",
      );
    },
  });
}

/**
 * Best-effort initial state for a resumed session, so the popup doesn't show
 * an empty list until the next `todo` call. Scans backward for either a
 * `/todo`-edited snapshot (`user_todo_edit` custom entry) or the latest
 * successful `todo` tool result — the same two sources omp's own todo
 * restoration logic considers (docs/tools/todo.md).
 */
function reconstructTodoPhases(ctx: ExtensionContext): TodoPhase[] {
  try {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i] as {
        type?: string;
        customType?: string;
        data?: unknown;
        message?: { role?: string; toolName?: string; isError?: boolean; details?: unknown };
      };

      if (entry.type === "custom" && entry.customType === "user_todo_edit") {
        const phases = (entry.data as { phases?: TodoPhase[] } | undefined)?.phases;
        if (Array.isArray(phases)) return phases;
      }

      const message = entry.type === "message" ? entry.message : undefined;
      if (message?.role === "toolResult" && message.toolName === "todo" && !message.isError) {
        const phases = (message.details as { phases?: TodoPhase[] } | undefined)?.phases;
        if (Array.isArray(phases)) return phases;
      }
    }
  } catch {
    // Best-effort only: live tool_result tracking keeps state accurate from here on
    // even if this reconstruction fails for an unexpected transcript shape.
  }
  return [];
}
