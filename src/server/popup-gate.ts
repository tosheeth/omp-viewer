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
 * server startup AND every time a session connects, not just once. A fresh
 * bind is one occasion with zero dashboard sockets, but a session connecting
 * to an already-long-lived server (the common case — the server rarely
 * restarts) is another, and is what "on start up" means from the
 * perspective of someone starting a new omp session against a server
 * that's been running for days, or whose previous popup they closed.
 *
 * The cooldown dedupes a burst of sessions connecting within the same
 * instant (main + subagents, several terminals launched together) without
 * blocking a genuinely later reopen — e.g. the user closes the popup, then
 * starts a new session a few seconds later.
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
