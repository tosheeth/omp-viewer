// Thin OS/environment-detection wrapper around dist/scripts/register-extension.js.
// Lives outside src/ (plain JS, not compiled) because it must run directly
// via `node scripts/postinstall.mjs` as declared in package.json's
// "postinstall" script.
//
// `npm ci`/`npm install` on a clone of THIS repo also runs this package's
// own postinstall (standard npm lifecycle behavior) -- and does so before
// the separate `npm run build` step, so dist/ does not exist yet at that
// point. A static top-level import of dist/scripts/register-extension.js
// would therefore throw immediately, before the guard below ever runs
// (ES module imports resolve before any function body executes) -- this
// broke CI's `npm ci` step. The import below is deliberately dynamic and
// deferred until after the guard passes, which is also exactly when dist/
// is guaranteed to exist (a real `npm install` of the published package
// always runs after prepublishOnly's build).
import { homedir } from "node:os";
import { join, sep } from "node:path";

function manualFallback(displayPath, reason) {
  console.warn(
    `omp-viewer: could not auto-register the extension in config.yml (${reason}).\n` +
      `Add it manually -- see https://github.com/tosheeth/omp-viewer#install:\n\n` +
      `extensions:\n  - ${displayPath}`,
  );
}

async function main() {
  const installDir = process.cwd();

  if (process.env.CI || !installDir.split(sep).includes("node_modules")) {
    // Local development (clone + npm install) or CI, not a real install.
    return;
  }

  const { registerExtension, toDisplayPath } = await import("../dist/scripts/register-extension.js");

  const home = homedir();
  const configPath = join(home, ".omp", "agent", "config.yml");
  const result = registerExtension(installDir, home, configPath);

  switch (result.status) {
    case "registered":
      console.log(`omp-viewer: registered in ${result.configPath} -- reload plugins or start a new omp session.`);
      break;
    case "already-registered":
      console.log(`omp-viewer: already registered in ${result.configPath}`);
      break;
    case "skipped":
      manualFallback(toDisplayPath(installDir, home), result.reason);
      break;
  }
}

await main();
