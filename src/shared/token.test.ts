// Must run in its own process (true for every node:test file by default)
// since it redirects the user's home directory via env var before the
// module under test is first imported, and TOKEN_DIR is computed once at
// module-evaluation time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME_ENV_VAR = process.platform === "win32" ? "USERPROFILE" : "HOME";

test("creates a token file on first call and reuses the same token afterward", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "omp-viewer-token-"));
  const original = process.env[HOME_ENV_VAR];
  process.env[HOME_ENV_VAR] = fakeHome;

  try {
    // Dynamic import is intentional here, not a static-import substitute:
    // `token.js` computes TOKEN_DIR from `homedir()` at module-evaluation
    // time, so the module must load *after* the env var above is set, or
    // it would resolve the real user's home directory instead of the
    // sandbox created for this test.
    const { getOrCreateToken } = await import("./token.js");
    const tokenFile = join(fakeHome, ".omp-viewer", "token");

    assert.equal(existsSync(tokenFile), false);
    const first = getOrCreateToken();
    assert.match(first, /^[0-9a-f]{48}$/);
    assert.equal(existsSync(tokenFile), true);
    assert.equal(readFileSync(tokenFile, "utf8"), first);

    const second = getOrCreateToken();
    assert.equal(second, first);

    if (process.platform !== "win32") {
      assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
    }
  } finally {
    if (original === undefined) delete process.env[HOME_ENV_VAR];
    else process.env[HOME_ENV_VAR] = original;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
