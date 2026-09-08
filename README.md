# omp-viewer

Live cross-session dashboard and todo tracker for [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`).

Shows every locally running `omp` session in a small popup window: cwd, session
name, busy/idle status, last tool, context-window pressure, and its todo list
(mirrored from omp's built-in `todo` tool — this extension registers no new
tool and adds no tokens to any request).

## Install

```sh
npm install --prefix ~/.omp/agent/extensions/omp-viewer omp-viewer
```

Or drop the package anywhere and point `~/.omp/agent/config.yml` at it:

```yaml
extensions:
  - ./path/to/omp-viewer
```

Reload plugins (or start a new `omp` session). Nothing else to install — the
bundled server and popup page ship inside this package.

## Use

- The first `omp` session on the machine spawns a small background server
  (default port `8317`) and opens the dashboard in a chromeless Edge window.
- Every later session just connects to that server; closing a session
  removes it from the roster within a heartbeat.
- Run `/dashboard` in any session to reopen the popup if you closed it.
- Killing the server (or the machine sleeping/crashing) recovers
  automatically: the next session that can't connect respawns it.

## Configuration

- `OMP_DASHBOARD_PORT` environment variable, or
- `<project>/.omp/omp-viewer.json`: `{ "port": 8300 }`

## Requirements

- Windows, with `node` (or `bun`) reachable on `PATH` to run the bundled
  server subprocess. Microsoft Edge for the popup window — if Edge isn't
  found, the dashboard link and `/dashboard` command still work, the popup
  just doesn't open (open `http://127.0.0.1:8317` in any browser instead).

## Non-goals

No remote access, no shared multi-user server, no editing todos from the
popup (view-only), no chat/transcript mirroring.
