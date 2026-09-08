import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PORT } from "./types.js";

/**
 * Resolve the dashboard server port. Both the extension (when choosing where
 * to connect/spawn) and the server subprocess (when binding) call this, so
 * they always agree without a discovery file.
 *
 * Priority: OMP_DASHBOARD_PORT env var, then a project-level
 * `<cwd>/.omp/omp-viewer.json` `{ "port": N }` override, then the default.
 */
export function resolvePort(cwd?: string): number {
  const fromEnv = parsePort(process.env.OMP_DASHBOARD_PORT);
  if (fromEnv !== undefined) return fromEnv;

  const configPath = cwd ? join(cwd, ".omp", "omp-viewer.json") : undefined;
  if (configPath && existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { port?: unknown };
      const fromConfig = parsePort(typeof parsed.port === "number" ? String(parsed.port) : undefined);
      if (fromConfig !== undefined) return fromConfig;
    } catch {
      // Malformed override file: fall through to the default port.
    }
  }

  return DEFAULT_PORT;
}

function parsePort(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
}
