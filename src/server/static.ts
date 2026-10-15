import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";

export const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/**
 * Serve a file from `publicDir` for an incoming request URL.
 *
 * A bare `/` maps to `dashboard.html`, and so does `/` with a query string
 * — the popup is always opened as `/?token=<token>` (see
 * `shared/browser.ts`), so the query string must be stripped *before*
 * checking for the root path, not after.
 *
 * The resolved path is required to stay inside `publicDir`: `node:path`'s
 * `join`/`resolve` normalize `..` segments rather than rejecting them, so
 * a request like `/../../etc/passwd` would otherwise escape `publicDir`
 * and let any local process read arbitrary files readable by this
 * process — this endpoint has no token auth, unlike the WebSocket.
 */
export async function serveStatic(url: string | undefined, publicDir: string, res: ServerResponse): Promise<void> {
  const pathname = (url ?? "/").split("?")[0]!;
  const path = pathname === "/" ? "/dashboard.html" : pathname;
  const ext = extname(path);
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    res.writeHead(404).end("Not found");
    return;
  }
  const resolvedPublicDir = resolve(publicDir) + sep;
  const resolvedPath = resolve(join(publicDir, path));
  if (!resolvedPath.startsWith(resolvedPublicDir)) {
    res.writeHead(404).end("Not found");
    return;
  }
  try {
    const body = await readFile(resolvedPath);
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" }).end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}
