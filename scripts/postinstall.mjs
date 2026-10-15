// Thin OS/environment-detection wrapper around dist/scripts/register-extension.js.
// Lives outside src/ (plain JS, not compiled) because it must run directly
// via `node scripts/postinstall.mjs` as declared in package.json's
// "postinstall" script, before any build step of a *consumer's* project --
// though for this package itself, dist/ is guaranteed to exist by the time
// anyone's npm install reaches this script, since prepublishOnly always
// runs the build first.
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { registerExtension, toDisplayPath } from "../dist/scripts/register-extension.js";

function manualFallback(displayPath, reason) {
  console.warn(
    `omp-viewer: could not auto-register the extension in config.yml (${reason}).\n` +
      `Add it manually -- see https://github.com/tosheeth/omp-viewer#install:\n\n` +
      `extensions:\n  - ${displayPath}`,
  );
}

function main() {
  const installDir = process.cwd();

  if (process.env.CI || !installDir.split(sep).includes("node_modules")) {
    // Local development (clone + npm install) or CI, not a real install.
    return;
  }

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

main();
