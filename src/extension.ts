import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { DashboardLink } from "./client/link.js";
import { trySpawnPopup } from "./shared/browser.js";
import { resolvePort } from "./shared/port.js";
import { getOrCreateToken } from "./shared/token.js";
import type { AskAnswer, AskQuestion, TodoPhase } from "./shared/types.js";

interface AskToolOption {
  label: string;
  description?: string;
  preview?: string;
}

interface AskToolQuestion {
  id: string;
  question: string;
  options: AskToolOption[];
  header?: string;
  multi?: boolean;
  recommended?: number;
}

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
  const z = pi.zod;

  let link: DashboardLink | undefined;
  let port = 0;
  let token = "";
  let currentStatus: "idle" | "busy" = "idle";
  const pendingApprovals = new Set<string>();
  const pendingQuestions = new Set<string>();
  const pendingAskResolvers = new Map<string, (answers: AskAnswer[]) => void>();

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
    token = getOrCreateToken();
    const sessionId = ctx.sessionManager.getSessionId();

    link = new DashboardLink({
      port,
      token,
      sessionId,
      pid: process.pid,
      cwd: ctx.cwd,
      getSessionName: () => pi.getSessionName(),
      initialTodoPhases: reconstructTodoPhases(ctx),
      onLog: (message) => pi.logger.warn(message),
      onAskAnswer: (requestId, answers) => {
        pendingAskResolvers.get(requestId)?.(answers);
      },
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
    const stats = ctx.sessionManager.getUsageStatistics();
    if (stats) link?.send({ type: "usage", usage: { tokens: stats.totalTokens, cost: stats.cost } });
    refreshTitle(ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    link?.send({ type: "tool", toolName: event.toolName });
    // The shadowed `ask` tool below tracks its own awaiting-input state
    // directly (it needs to regardless of whether a dashboard is linked),
    // so this only needs to cover approval prompts on other tools.
  });

  pi.on("tool_result", (event: ToolResultEvent) => {
    if (event.toolName !== "todo" || event.isError) return;
    const phases = (event.details as { phases?: TodoPhase[] } | undefined)?.phases;
    if (Array.isArray(phases)) link?.send({ type: "todo", phases });
  });

  registerAskShadow(pi, z, {
    getLink: () => link,
    getPendingQuestions: () => pendingQuestions,
    getPendingAskResolvers: () => pendingAskResolvers,
    sendAwaitingInput,
    refreshTitle,
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
      const opened = trySpawnPopup(port, token);
      ctx.ui.notify(
        opened ? "Opening dashboard\u2026" : "Could not find a supported browser to open the dashboard",
        opened ? "info" : "warning",
      );
    },
  });
}

interface AskShadowDeps {
  getLink: () => DashboardLink | undefined;
  getPendingQuestions: () => Set<string>;
  getPendingAskResolvers: () => Map<string, (answers: AskAnswer[]) => void>;
  sendAwaitingInput: () => void;
  refreshTitle: (ctx: ExtensionContext) => void;
}

/**
 * Shadows the built-in `ask` tool so its question can also be answered from
 * the dashboard. Races a dashboard answer against the normal terminal
 * dialog (via `ctx.invokeTool`, the native delegation seam) — whichever
 * answers first wins, and the loser is aborted/ignored. When no native
 * built-in exists to delegate to (headless session, e.g. no interactive
 * UI), only the dashboard path is available; without a dashboard link
 * either, it fails the same way the native tool does outside interactive
 * mode.
 */
function registerAskShadow(pi: ExtensionAPI, z: ExtensionAPI["zod"], deps: AskShadowDeps): void {
  pi.registerTool({
    name: "ask",
    label: "Ask",
    description: "Ask the user one or more questions and wait for their answer.",
    approval: "read",
    parameters: z.object({
      questions: z
        .array(
          z.object({
            id: z.string(),
            question: z.string(),
            options: z.array(
              z.object({
                label: z.string(),
                description: z.string().optional(),
                preview: z.string().optional(),
              }),
            ),
            header: z.string().optional(),
            multi: z.boolean().optional(),
            recommended: z.number().optional(),
          }),
        )
        .min(1),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      // `params` is already zod-validated by the `parameters` schema above; these casts reflect that validated shape.
      const typedParams = params as { questions: AskToolQuestion[] };
      const questions = typedParams.questions;
      const nativeParams = params as Record<string, unknown>;
      const link = deps.getLink();
      const nativeInvoke = ctx.invokeTool;

      if (!link) {
        if (nativeInvoke) return nativeInvoke(nativeParams, { signal });
        return { content: [{ type: "text", text: "Ask tool requires interactive mode." }], isError: true };
      }

      const requestId = randomUUID();
      const relayQuestions: AskQuestion[] = questions.map((q) => ({
        id: q.id,
        question: q.question,
        options: q.options.map((o) => ({ label: o.label, description: o.description })),
        multi: q.multi,
      }));

      deps.getPendingQuestions().add(toolCallId);
      deps.sendAwaitingInput();
      deps.refreshTitle(ctx);

      const dashboardAnswer = new Promise<AskAnswer[]>((resolve) => {
        deps.getPendingAskResolvers().set(requestId, resolve);
      });
      link.send({ type: "ask_question", requestId, questions: relayQuestions });

      const cleanup = (): void => {
        deps.getPendingAskResolvers().delete(requestId);
        deps.getPendingQuestions().delete(toolCallId);
        deps.sendAwaitingInput();
        deps.refreshTitle(ctx);
        deps.getLink()?.send({ type: "ask_resolved", requestId });
      };

      if (!nativeInvoke) {
        const answers = await dashboardAnswer;
        cleanup();
        return buildAskResult(questions, answers);
      }

      const abortNative = new AbortController();
      const forwardAbort = (): void => abortNative.abort();
      signal?.addEventListener("abort", forwardAbort);

      const nativeSettled = nativeInvoke(nativeParams, { signal: abortNative.signal })
        .then((result) => ({ source: "native" as const, result }))
        .catch((error: unknown) => ({ source: "native-error" as const, error }));
      const dashboardSettled = dashboardAnswer.then((answers) => ({ source: "dashboard" as const, answers }));

      try {
        const winner = await Promise.race([nativeSettled, dashboardSettled]);
        cleanup();
        if (winner.source === "dashboard") {
          abortNative.abort();
          return buildAskResult(questions, winner.answers);
        }
        if (winner.source === "native-error") throw winner.error;
        return winner.result;
      } finally {
        signal?.removeEventListener("abort", forwardAbort);
      }
    },
  });
}

function buildAskResult(questions: AskToolQuestion[], answers: AskAnswer[]): AgentToolResult {
  const answerText = (q: AskToolQuestion): string => {
    const a = answers.find((x) => x.id === q.id);
    if (a?.customInput) return a.customInput;
    if (a && a.selectedLabels.length > 0) return a.selectedLabels.join(", ");
    return "(no answer)";
  };

  if (questions.length === 1) {
    const q = questions[0]!;
    const a = answers.find((x) => x.id === q.id);
    return {
      content: [{ type: "text", text: answerText(q) }],
      details: {
        question: q.question,
        options: q.options,
        multi: Boolean(q.multi),
        selectedOptions: a?.selectedLabels ?? [],
        customInput: a?.customInput,
      },
    };
  }

  const lines = questions.map((q) => `${q.id}: ${answerText(q)}`);
  return {
    content: [{ type: "text", text: `User answers:\n${lines.join("\n")}` }],
    details: {
      results: questions.map((q) => {
        const a = answers.find((x) => x.id === q.id);
        return {
          id: q.id,
          question: q.question,
          options: q.options,
          multi: Boolean(q.multi),
          selectedOptions: a?.selectedLabels ?? [],
          customInput: a?.customInput,
        };
      }),
    },
  };
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
