import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { basename } from "node:path";

const SERVER_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "index.js");

/**
 * omp itself is distributed as a self-contained compiled binary (verified:
 * this workstation has no standalone `bun` on PATH, only `omp.exe`), so
 * `process.execPath` inside the extension resolves to the omp CLI, not a
 * generic interpreter — it cannot "run this arbitrary script" the way a
 * plain `bun`/`node` binary can. Prefer PATH-resolved generic runtimes;
 * fall back to `process.execPath` only when it is plausibly a real
 * interpreter (not the omp binary itself), and give up gracefully if none
 * of these can be confirmed.
 */
function resolveRuntime(): string | undefined {
  for (const candidate of ["node", "bun"]) {
    if (commandRuns(candidate, ["--version"])) return candidate;
  }
  const execName = basename(process.execPath).toLowerCase();
  if (!execName.startsWith("omp") && commandRuns(process.execPath, ["--version"])) {
    return process.execPath;
  }
  return undefined;
}

function commandRuns(cmd: string, args: string[]): boolean {
  try {
    const result = spawnSync(cmd, args, { stdio: "ignore", windowsHide: true });
    return result.error === undefined;
  } catch {
    return false;
  }
}

/**
 * Spawn the bundled dashboard server as a detached background process.
 * Returns false when no usable JS runtime could be found on this machine —
 * the extension degrades to reporting no dashboard link rather than
 * throwing.
 */
export function trySpawnServer(port: number): boolean {
  const runtime = resolveRuntime();
  if (!runtime) return false;

  const child = spawn(runtime, [SERVER_ENTRY], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, OMP_DASHBOARD_PORT: String(port) },
  });
  child.unref();
  return true;
}

const EDGE_CANDIDATES = [
  join(process.env["PROGRAMFILES(X86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
  join(process.env.PROGRAMFILES ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
  join(process.env.LOCALAPPDATA ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
];

function findEdge(): string | undefined {
  return EDGE_CANDIDATES.find((path) => path.length > 0 && existsSync(path));
}

/**
 * Open the popup in a chromeless Edge app-mode window. No-ops (returns
 * false) when Edge cannot be located — per the spec's graceful-degradation
 * requirement, the extension and its hooks keep working either way.
 */
export function trySpawnPopup(port: number): boolean {
  const edgePath = findEdge();
  if (!edgePath) return false;

  const child = spawn(
    edgePath,
    [`--app=http://127.0.0.1:${port}`, "--window-size=380,720"],
    { detached: true, stdio: "ignore", windowsHide: false },
  );
  child.unref();
  return true;
}
