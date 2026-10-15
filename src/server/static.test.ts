import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import { serveStatic } from "./static.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

function fakeResponse(): { res: ServerResponse; status: () => number | undefined; headers: () => Record<string, string> | undefined; body: () => string } {
  let status: number | undefined;
  let headers: Record<string, string> | undefined;
  let body = "";
  const res = {
    writeHead(code: number, h?: Record<string, string>) {
      status = code;
      headers = h;
      return res;
    },
    end(chunk?: Buffer | string) {
      if (chunk !== undefined) body = chunk.toString();
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, headers: () => headers, body: () => body };
}

test("serves dashboard.html for a bare root path", async () => {
  const f = fakeResponse();
  await serveStatic("/", PUBLIC_DIR, f.res);
  assert.equal(f.status(), 200);
  assert.match(f.body(), /<!doctype html>/i);
});

test("serves dashboard.html for root with a query string — the popup's real URL (regression: previously 404'd)", async () => {
  const f = fakeResponse();
  await serveStatic("/?token=abc123", PUBLIC_DIR, f.res);
  assert.equal(f.status(), 200);
  assert.match(f.body(), /<!doctype html>/i);
});

test("treats an undefined request url the same as a bare root path", async () => {
  const f = fakeResponse();
  await serveStatic(undefined, PUBLIC_DIR, f.res);
  assert.equal(f.status(), 200);
  assert.match(f.body(), /<!doctype html>/i);
});

test("serves dashboard.js with the javascript MIME type", async () => {
  const f = fakeResponse();
  await serveStatic("/dashboard.js", PUBLIC_DIR, f.res);
  assert.equal(f.status(), 200);
  assert.equal(f.headers()?.["Content-Type"], "text/javascript; charset=utf-8");
});

test("serves dashboard.css with the css MIME type", async () => {
  const f = fakeResponse();
  await serveStatic("/dashboard.css", PUBLIC_DIR, f.res);
  assert.equal(f.status(), 200);
  assert.equal(f.headers()?.["Content-Type"], "text/css; charset=utf-8");
});

test("404s for an unrecognized extension", async () => {
  const f = fakeResponse();
  await serveStatic("/dashboard.png", PUBLIC_DIR, f.res);
  assert.equal(f.status(), 404);
});

test("404s for a missing file with a known extension", async () => {
  const f = fakeResponse();
  await serveStatic("/does-not-exist.html", PUBLIC_DIR, f.res);
  assert.equal(f.status(), 404);
});

test("404s for a path-traversal attempt escaping the public directory", async () => {
  const f = fakeResponse();
  // Allowed extension (.js) so this exercises traversal protection
  // specifically, not just the unknown-extension rejection above.
  await serveStatic("/../dist/server/static.js", PUBLIC_DIR, f.res);
  assert.equal(f.status(), 404);
});
