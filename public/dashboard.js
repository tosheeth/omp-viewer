// Popup client: connects as a "dashboard" role peer, renders a tab per
// session plus a detail panel for whichever tab is selected, and recomputes
// purely-derived display state (tab ordering, idle graying, context-pressure
// coloring, usage rollup) on every render — none of that is sent over the
// wire except answers to a pending `ask` question.

const STALE_AFTER_MS = 15 * 60 * 1000;
const CONTEXT_WARN = 65;
const CONTEXT_DANGER = 85;
const RECONNECT_MAX_MS = 5000;
const UNAUTHORIZED_CLOSE_CODE = 4001;

const STATUS_ICON = {
  pending: "\u25CB",
  in_progress: "\u25B6",
  completed: "\u2713",
  abandoned: "\u2717",
  blocked: "\u26D4",
};

const token = new URLSearchParams(location.search).get("token") ?? "";

const connState = document.getElementById("conn-state");
const usageRollupEl = document.getElementById("usage-rollup");
const tabsEl = document.getElementById("tabs");
const panelEl = document.getElementById("panel");
const tabTemplate = document.getElementById("tab-template");
const panelTemplate = document.getElementById("panel-template");

const pinBtn = document.getElementById("pin-btn");
const appRoot = document.getElementById("app");

let ws;
let latestSessions = [];
let selectedSessionId;
/** sessionId -> { requestId, questions, answers, submitted } for any pending `ask` question. */
const pendingAsks = new Map();

// ---- Pin to front (Document Picture-in-Picture) ----
//
// The popup spawns as an ordinary chromeless window (see
// src/shared/browser.ts) — nothing keeps it above other windows until the
// user asks for that here. Clicking #pin-btn moves #app into a
// browser-native always-on-top Picture-in-Picture window, the same
// mechanism Spotify's web player miniplayer uses for its floating
// controls. That API requires a real user gesture to open (the click
// itself), so there's no way to pin automatically on load; browsers
// without it (anything short of Chromium 116) just never see the button.
if ("documentPictureInPicture" in window) {
  pinBtn.hidden = false;
  pinBtn.addEventListener("click", async () => {
    if (documentPictureInPicture.window) {
      documentPictureInPicture.window.close();
      return;
    }

    const pipWindow = await documentPictureInPicture.requestWindow({ width: 380, height: 288 });
    for (const styleSheet of document.styleSheets) {
      try {
        const cssText = [...styleSheet.cssRules].map((rule) => rule.cssText).join("");
        const style = pipWindow.document.createElement("style");
        style.textContent = cssText;
        pipWindow.document.head.appendChild(style);
      } catch {
        const link = pipWindow.document.createElement("link");
        link.rel = "stylesheet";
        link.href = styleSheet.href;
        pipWindow.document.head.appendChild(link);
      }
    }
    pipWindow.document.title = document.title;
    pipWindow.document.body.append(appRoot);
    pinBtn.textContent = "\u{1F4CD}";
    pinBtn.title = "Unpin";
    pinBtn.classList.add("pinned");

    const placeholder = document.createElement("div");
    placeholder.className = "pin-placeholder";
    placeholder.innerHTML = "<p>Dashboard is pinned to front in a separate window.</p>";
    const restoreBtn = document.createElement("button");
    restoreBtn.type = "button";
    restoreBtn.textContent = "Unpin";
    restoreBtn.addEventListener("click", () => pipWindow.close());
    placeholder.appendChild(restoreBtn);
    document.body.appendChild(placeholder);

    pipWindow.addEventListener(
      "pagehide",
      () => {
        placeholder.remove();
        document.body.prepend(appRoot);
        pinBtn.textContent = "\u{1F4CC}";
        pinBtn.title = "Pin to front (stays above other windows)";
        pinBtn.classList.remove("pinned");
      },
      { once: true },
    );
  });
}

function connect(attempt) {
  ws = new WebSocket(`ws://${location.host}/ws`);

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "hello", role: "dashboard", token }));
    setConnState("ok");
  });

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "snapshot") {
      latestSessions = msg.sessions;
      pruneStaleAsks();
      reconcileSelection();
      render();
    } else if (msg.type === "ask_question") {
      pendingAsks.set(msg.sessionId, { requestId: msg.requestId, questions: msg.questions, answers: {}, submitted: false });
      render();
    } else if (msg.type === "ask_resolved") {
      for (const [sessionId, pending] of pendingAsks) {
        if (pending.requestId === msg.requestId) pendingAsks.delete(sessionId);
      }
      render();
    }
  });

  ws.addEventListener("close", (ev) => {
    if (ev.code === UNAUTHORIZED_CLOSE_CODE) {
      setConnState("unauthorized");
      return; // do not reconnect with the same (rejected) token
    }
    scheduleReconnect(attempt);
  });
  ws.addEventListener("error", () => ws.close());
}

function scheduleReconnect(attempt) {
  setConnState("down");
  const delay = Math.min(200 * 2 ** attempt, RECONNECT_MAX_MS);
  setTimeout(() => connect(attempt + 1), delay);
}

function setConnState(state) {
  const text = { ok: "connected", down: "reconnecting\u2026", unauthorized: "unauthorized \u2014 reopen via /dashboard" };
  connState.textContent = text[state];
  connState.className = `conn-state ${state}`;
}

function pruneStaleAsks() {
  const liveIds = new Set(latestSessions.map((s) => s.sessionId));
  for (const sessionId of pendingAsks.keys()) {
    if (!liveIds.has(sessionId)) pendingAsks.delete(sessionId);
  }
}

/** Keep the current selection sticky across snapshots; only re-pick when it's gone. */
function reconcileSelection() {
  if (latestSessions.some((s) => s.sessionId === selectedSessionId)) return;
  const ordered = sortSessions(latestSessions);
  selectedSessionId = ordered.length > 0 ? ordered[0].sessionId : undefined;
}

function render() {
  renderUsageRollup();
  renderTabs();
  renderPanel();
}

function renderUsageRollup() {
  const withUsage = latestSessions.filter((s) => s.usage);
  if (withUsage.length === 0) {
    usageRollupEl.textContent = "";
    return;
  }
  const totalTokens = withUsage.reduce((sum, s) => sum + s.usage.tokens, 0);
  const totalCost = withUsage.reduce((sum, s) => sum + s.usage.cost, 0);
  usageRollupEl.textContent = `Total: ${formatCost(totalCost)} \u00B7 ${formatTokens(totalTokens)} tokens \u00B7 ${latestSessions.length} session${latestSessions.length === 1 ? "" : "s"}`;
}

function formatCost(cost) {
  return `$${cost < 1 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

function formatTokens(tokens) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function hasBlockedTask(session) {
  return session.todoPhases.some((p) => p.tasks.some((t) => t.status === "blocked"));
}

function sortSessions(sessions) {
  return [...sessions].sort((a, b) => {
    const awaitingDiff = Number(b.awaitingInput) - Number(a.awaitingInput);
    if (awaitingDiff !== 0) return awaitingDiff;
    const blockedDiff = Number(hasBlockedTask(b)) - Number(hasBlockedTask(a));
    if (blockedDiff !== 0) return blockedDiff;
    const busyDiff = Number(b.status === "busy") - Number(a.status === "busy");
    if (busyDiff !== 0) return busyDiff;
    return b.lastActivity - a.lastActivity;
  });
}

function renderTabs() {
  tabsEl.replaceChildren();
  for (const session of sortSessions(latestSessions)) {
    tabsEl.appendChild(renderTab(session));
  }
}

function renderTab(session) {
  const node = tabTemplate.content.firstElementChild.cloneNode(true);
  node.classList.toggle("busy", session.status === "busy");
  node.classList.toggle("awaiting", session.awaitingInput);
  node.classList.toggle("active", session.sessionId === selectedSessionId);
  node.querySelector(".tab-label").textContent = session.sessionName || cwdBasename(session.cwd);
  node.addEventListener("click", () => {
    selectedSessionId = session.sessionId;
    render();
  });
  return node;
}

function renderPanel() {
  panelEl.replaceChildren();

  const session = latestSessions.find((s) => s.sessionId === selectedSessionId);
  if (!session) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No omp sessions connected.";
    panelEl.appendChild(empty);
    return;
  }

  panelEl.appendChild(renderSessionDetail(session));
}

function renderSessionDetail(session) {
  const node = panelTemplate.content.firstElementChild.cloneNode(true);
  const isStale = session.status === "idle" && Date.now() - session.lastActivity > STALE_AFTER_MS;
  const pending = pendingAsks.get(session.sessionId);

  node.classList.toggle("busy", session.status === "busy");
  node.classList.toggle("stale", isStale);
  node.classList.toggle("has-blocked", hasBlockedTask(session));
  node.classList.toggle("awaiting", session.awaitingInput);

  node.querySelector(".session-name").textContent = session.sessionName || cwdBasename(session.cwd);
  const cwdEl = node.querySelector(".session-cwd");
  cwdEl.textContent = session.cwd;
  cwdEl.title = session.cwd;

  node.querySelector(".last-tool").textContent = session.lastTool ? `\u2192 ${session.lastTool}` : "";
  node.querySelector(".last-activity").textContent = relativeTime(session.lastActivity);

  const fill = node.querySelector(".context-bar-fill");
  if (session.contextUsage) {
    const pct = Math.round(session.contextUsage.percent);
    fill.style.width = `${Math.min(pct, 100)}%`;
    fill.classList.toggle("warn", session.contextUsage.percent >= CONTEXT_WARN && session.contextUsage.percent < CONTEXT_DANGER);
    fill.classList.toggle("danger", session.contextUsage.percent >= CONTEXT_DANGER);
  } else {
    node.querySelector(".context-bar").style.display = "none";
  }

  // A question with a live dashboard form is more actionable than the
  // generic banner (which still shows above it for a plain approval
  // prompt, since those can only be answered in the terminal).
  const askSlot = node.querySelector(".ask-slot");
  if (pending) askSlot.appendChild(renderAskForm(pending));

  const phasesEl = node.querySelector(".todo-phases");
  for (const phase of session.todoPhases) {
    if (phase.tasks.length === 0) continue;
    const nameEl = document.createElement("div");
    nameEl.className = "todo-phase-name";
    nameEl.textContent = phase.name;
    phasesEl.appendChild(nameEl);
    for (const task of phase.tasks) phasesEl.appendChild(renderTask(task));
  }

  return node;
}

function renderAskForm(pending) {
  const container = document.createElement("div");

  if (pending.submitted) {
    container.className = "ask-sent";
    container.textContent = "Answer sent \u2014 waiting for the session to catch up\u2026";
    return container;
  }

  container.className = "ask-form";
  for (const q of pending.questions) {
    const state = pending.answers[q.id] ?? (pending.answers[q.id] = { selectedLabels: [], customInput: "" });

    const qEl = document.createElement("div");
    qEl.className = "ask-question";

    const qText = document.createElement("div");
    qText.className = "ask-question-text";
    qText.textContent = q.question;
    qEl.appendChild(qText);

    const optsEl = document.createElement("div");
    optsEl.className = "ask-options";
    for (const opt of q.options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ask-option";
      btn.textContent = opt.label;
      if (opt.description) btn.title = opt.description;
      btn.classList.toggle("selected", state.selectedLabels.includes(opt.label));
      btn.addEventListener("click", () => {
        if (q.multi) {
          const idx = state.selectedLabels.indexOf(opt.label);
          if (idx >= 0) state.selectedLabels.splice(idx, 1);
          else state.selectedLabels.push(opt.label);
        } else {
          state.selectedLabels = [opt.label];
        }
        render();
      });
      optsEl.appendChild(btn);
    }
    qEl.appendChild(optsEl);

    const customInput = document.createElement("input");
    customInput.type = "text";
    customInput.className = "ask-custom";
    customInput.placeholder = "Or type your own answer";
    customInput.value = state.customInput;
    customInput.addEventListener("input", () => {
      state.customInput = customInput.value;
    });
    qEl.appendChild(customInput);

    container.appendChild(qEl);
  }

  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "ask-submit";
  submit.textContent = "Submit";
  submit.addEventListener("click", () => {
    const answers = pending.questions.map((q) => {
      const state = pending.answers[q.id];
      return { id: q.id, selectedLabels: state.selectedLabels, customInput: state.customInput || undefined };
    });
    ws.send(JSON.stringify({ type: "ask_answer", requestId: pending.requestId, answers }));
    pending.submitted = true;
    render();
  });
  container.appendChild(submit);

  return container;
}

function renderTask(task) {
  const row = document.createElement("div");
  row.className = `todo-task ${task.status}`;

  const icon = document.createElement("span");
  icon.className = "icon";
  icon.textContent = STATUS_ICON[task.status] ?? "\u25CB";
  row.appendChild(icon);

  const content = document.createElement("span");
  content.textContent = task.content;
  row.appendChild(content);

  if (task.status === "blocked" && task.blocker) {
    const reason = document.createElement("span");
    reason.className = "blocker-reason";
    reason.textContent = `\u2014 ${task.blocker}`;
    row.appendChild(reason);
  }

  return row;
}

function cwdBasename(cwd) {
  const normalized = cwd.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

function relativeTime(ms) {
  const deltaSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (deltaSec < 5) return "just now";
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.round(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHour = Math.round(deltaMin / 60);
  return `${deltaHour}h ago`;
}

// Re-render periodically even without new data: relative timestamps and the
// idle-declutter threshold both depend purely on wall-clock time.
setInterval(render, 30_000);

connect(0);
