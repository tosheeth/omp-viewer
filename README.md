# omp-viewer

Live cross-session dashboard and todo tracker for [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`).

Shows every locally running `omp` session in a small popup window: cwd, session
name, busy/idle/needs-you status, last tool, context-window pressure, cumulative
cost/token usage, and its todo list (mirrored from omp's built-in `todo` tool —
this extension registers no new todo tool and adds no tokens to any request).

## Install

```sh
npm install --prefix ~/.omp/agent/extensions/omp-viewer omp-viewer
```

Then register it in `~/.omp/agent/config.yml` (`omp` does not auto-discover
anything under `extensions/` — this step is required, not optional):

```yaml
extensions:
  - ~/.omp/agent/extensions/omp-viewer/node_modules/omp-viewer
```

Or skip npm and point `config.yml` straight at a package you dropped
somewhere yourself:

```yaml
extensions:
  - ./path/to/omp-viewer
```

Reload plugins (or start a new `omp` session). The bundled server and popup
page ship inside this package — nothing else to install.

## Use

- The first `omp` session on the machine spawns a small background server
  (default port `8317`) and opens the dashboard in a chromeless app-mode
  browser window.
- Every later session just connects to that server; closing a session
  removes it from the roster within a heartbeat.
- Run `/dashboard` in any session to reopen the popup if you closed it.
- Killing the server (or the machine sleeping/crashing) recovers
  automatically: the next session that can't connect respawns it.
- The terminal window/tab title updates live with a status glyph
  (🟢 idle / 🟡 busy / 🔴 needs you) plus the session name, so you can find
  the right window without the popup at all.
- A native desktop notification fires the moment any session starts needing
  you (tool approval or a question), on Windows and Linux.
- Any question the agent asks via the `ask` tool can be answered from either
  the terminal or the popup — whichever you respond to first wins; the other
  is cancelled. Tool-approval prompts ("Allow tool: write/bash/...") are
  still terminal-only — the extension can flag them (red dot, toast) but has
  no API to decide them, and routing that decision through an unauthenticated
  local socket would be a real security regression.

## Configuration

- `OMP_DASHBOARD_PORT` environment variable, or
- `<project>/.omp/omp-viewer.json`: `{ "port": 8300 }`

## Security

The dashboard WebSocket requires a shared secret, generated on first run and
stored at `~/.omp-viewer/token` (owner-only file permissions). Without it,
any local process on the machine could otherwise read your session state (or,
now that `ask` answering exists, answer the model's questions on your
behalf) just by connecting to the loopback port. The extension and the popup
both read this token automatically — nothing to configure.

## Requirements

- Windows or Linux, with `node` (or `bun`) reachable on `PATH` to run the
  bundled server subprocess.
- For the popup window: Microsoft Edge or Google Chrome/Chromium on Windows;
  `microsoft-edge`, `google-chrome`, or `chromium` on Linux. If none is
  found, the dashboard link, `/dashboard` command, and terminal-title/toast
  signals all still work — the popup just doesn't open (open
  `http://127.0.0.1:8317/?token=<contents of ~/.omp-viewer/token>` in any
  browser instead).

## Non-goals

No remote access, no shared multi-user server, no editing todos from the
popup, no chat/transcript mirroring, no answering tool-approval prompts
remotely.
