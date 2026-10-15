export interface PopupGateOptions {
  /** Actually attempt to open the popup; called at most once per cooldown window. */
  spawnPopup: () => void;
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Minimum gap between spawn attempts, in ms. Defaults to 2000. */
  cooldownMs?: number;
}

/**
 * Dedupe/cooldown wrapper around opening the dashboard popup.
 *
 * "Check for an open window and open one if there isn't" is evaluated at
 * server startup, every time a session connects, AND on every subsequent
 * turn_start (status -> busy) from an already-connected session — not just
 * once. A fresh bind is one occasion with zero dashboard sockets; a session
 * connecting to an already-long-lived server (the common case — the server
 * rarely restarts) is another; and a user who closed the popup mid-session
 * and kept prompting is a third — "on start up" means all three from the
 * perspective of someone who wants the dashboard open whenever they're
 * actively using a session, not just at the literal first connection.
 *
 * The cooldown dedupes both a burst of sessions connecting within the same
 * instant (main + subagents, several terminals launched together) and
 * repeated turn_start retries within one session, without blocking a
 * genuinely later reopen — e.g. the user closes the popup, then sends
 * another prompt a few seconds later.
 *
 * Returns a gate function: call it with whether a dashboard is currently
 * connected, and it spawns a popup at most once per cooldown window,
 * only when none is connected.
 */
export function createPopupGate(options: PopupGateOptions): (dashboardConnected: boolean) => void {
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? 2_000;
  let cooldownUntil = 0;

  return (dashboardConnected: boolean): void => {
    if (dashboardConnected) return;
    const t = now();
    if (t < cooldownUntil) return;
    cooldownUntil = t + cooldownMs;
    options.spawnPopup();
  };
}
