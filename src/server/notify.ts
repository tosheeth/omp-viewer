import { spawn } from "node:child_process";
import type { SessionSnapshot } from "../shared/types.js";

/**
 * Fire an OS-native desktop notification when a session starts needing you.
 * Platform-specific by necessity — there is no cross-platform toast API in
 * Node — but each branch uses only what ships with the OS, no extra
 * install:
 *
 * - Windows: PowerShell + the WinRT `Windows.UI.Notifications` toast API.
 * - Linux: `notify-send` (part of libnotify, present on most desktop
 *   environments with a notification daemon — GNOME, KDE, XFCE, etc.).
 * - Anything else (macOS, headless Linux with no notification daemon): a
 *   no-op. The popup's red dot and the terminal title glyph remain the
 *   fallback signal.
 */
export function notifyAwaitingInput(session: SessionSnapshot): void {
  const label = session.sessionName || session.cwd;
  const title = "omp needs your input";
  const body = `${label}${session.lastTool ? ` — ${session.lastTool}` : ""}`;

  if (process.platform === "win32") {
    fireWindowsToast(title, body);
  } else if (process.platform === "linux") {
    fireLinuxNotification(title, body);
  }
}

function fireWindowsToast(title: string, body: string): void {
  const escape = (s: string) => s.replace(/'/g, "''");
  const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$textNodes = $template.GetElementsByTagName("text")
$textNodes.Item(0).AppendChild($template.CreateTextNode('${escape(title)}')) > $null
$textNodes.Item(1).AppendChild($template.CreateTextNode('${escape(body)}')) > $null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("omp-viewer").Show($toast)
`.trim();

  spawnDetachedIgnore("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script]);
}

function fireLinuxNotification(title: string, body: string): void {
  spawnDetachedIgnore("notify-send", ["--app-name=omp-viewer", title, body]);
}

function spawnDetachedIgnore(command: string, args: string[]): void {
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {
      // Missing binary or notification daemon: silently skip. The popup
      // and terminal-title signals still work regardless.
    });
    child.unref();
  } catch {
    // Same as above — spawn() can throw synchronously for some failures.
  }
}
