import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sep } from "node:path";
import { parseDocument, isSeq } from "yaml";

export type RegisterResult =
  | { status: "registered"; configPath: string }
  | { status: "already-registered"; configPath: string }
  | { status: "skipped"; reason: string };

/**
 * Converts an absolute install path into omp's `config.yml` path notation:
 * `~/...`-relative when it's inside `home` (matching the documented,
 * manually-verified-working README format), otherwise a forward-slash
 * absolute path.
 */
export function toDisplayPath(absPath: string, home: string): string {
  if (absPath.toLowerCase().startsWith(home.toLowerCase())) {
    return "~" + absPath.slice(home.length).split(sep).join("/");
  }
  return absPath.split(sep).join("/");
}

/**
 * Registers `installDir` in `configPath`'s `extensions:` list, preserving
 * the rest of the file via the YAML Document round-trip API (comments and
 * formatting elsewhere survive).
 *
 * Only ever EDITS an existing, well-formed config.yml with an
 * `extensions:` key that's absent or a plain list -- never fabricates a
 * file (a missing config.yml implies `omp` has never been run, and
 * guessing at the rest of its shape risks corrupting a setup we've never
 * seen), never clobbers a key it doesn't understand, and never throws --
 * every failure mode returns `{ status: "skipped", reason }` so the
 * caller can fall back to printing manual instructions.
 */
export function registerExtension(installDir: string, home: string, configPath: string): RegisterResult {
  if (!existsSync(configPath)) {
    return { status: "skipped", reason: `no config.yml found at ${configPath} -- have you run \`omp\` at least once?` };
  }

  const displayPath = toDisplayPath(installDir, home);

  try {
    const raw = readFileSync(configPath, "utf8");
    const doc = parseDocument(raw);

    const extensions = doc.get("extensions");
    if (extensions === undefined) {
      doc.set("extensions", [displayPath]);
    } else if (isSeq(extensions)) {
      const already = extensions.items.some(
        (item) => String(item) === displayPath || String((item as { value?: unknown } | undefined)?.value) === displayPath,
      );
      if (already) return { status: "already-registered", configPath };
      extensions.add(displayPath);
    } else {
      return { status: "skipped", reason: `config.yml's "extensions" key isn't a list -- left it untouched` };
    }

    writeFileSync(configPath, doc.toString());
    return { status: "registered", configPath };
  } catch (err) {
    return { status: "skipped", reason: err instanceof Error ? err.message : String(err) };
  }
}
