import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

type BrowserCandidate = { kind: "path"; path: string } | { kind: "command"; command: string };

/**
 * Popup browser candidates, per platform. Windows Edge is rarely on PATH,
 * so those candidates are checked as absolute Program Files paths; Linux
 * browsers are normally PATH-installed by their package manager, so those
 * are checked with a PATH-probe (spawn + `--version`) instead. Other
 * platforms get no candidates — `trySpawnPopup` then no-ops, per the
 * graceful-degradation requirement.
 */
function browserCandidates(): BrowserCandidate[] {
  if (process.platform === "win32") {
    return [
      join(process.env["PROGRAMFILES(X86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
      join(process.env.PROGRAMFILES ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
      join(process.env.LOCALAPPDATA ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
    ].map((path) => ({ kind: "path", path }));
  }
  if (process.platform === "linux") {
    return ["microsoft-edge-stable", "microsoft-edge", "google-chrome-stable", "google-chrome", "chromium-browser", "chromium"].map(
      (command) => ({ kind: "command", command }),
    );
  }
  return [];
}

function commandRuns(cmd: string, args: string[]): boolean {
  try {
    const result = spawnSync(cmd, args, { stdio: "ignore", windowsHide: true });
    return result.error === undefined;
  } catch {
    return false;
  }
}

function findBrowser(): string | undefined {
  for (const candidate of browserCandidates()) {
    if (candidate.kind === "path") {
      if (candidate.path.length > 0 && existsSync(candidate.path)) return candidate.path;
    } else if (commandRuns(candidate.command, ["--version"])) {
      return candidate.command;
    }
  }
  return undefined;
}

/**
 * Open the popup in a chromeless app-mode browser window. No-ops (returns
 * false) when no candidate browser can be located — per the spec's
 * graceful-degradation requirement, the rest of the dashboard keeps working
 * either way (terminal title glyph, desktop toast, `/dashboard` retry).
 *
 * Used both by the server itself (auto-open whenever no dashboard is
 * connected, on bind and on each new session hello — see
 * `ensurePopupOpen` in server/index.ts) and by the extension's
 * `/dashboard` command (manual reopen after the user closed the window).
 *
 * Pinning the popup above other windows is handled client-side, by the
 * popup page itself, via the Document Picture-in-Picture API (see
 * `public/dashboard.js`) — not here. That API needs a real user gesture
 * (a click) to open a Picture-in-Picture window, so it can't be done at
 * spawn time from this process; OS-level alternatives (Win32
 * `SetWindowPos(HWND_TOPMOST)`, X11 `wmctrl -b add,above`) were tried and
 * dropped in favor of the browser-native mechanism — same one Spotify's
 * web player miniplayer uses.
 */
export function trySpawnPopup(port: number, token: string): boolean {
  const browserPath = findBrowser();
  if (!browserPath) return false;

  const url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
  const child = spawn(browserPath, [`--app=${url}`, "--window-size=380,288"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return true;
}
