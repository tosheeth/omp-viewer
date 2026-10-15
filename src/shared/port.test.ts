import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePort } from "./port.js";
import { DEFAULT_PORT } from "./types.js";

let tmpDir: string;
let originalEnvPort: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omp-viewer-port-"));
  originalEnvPort = process.env.OMP_DASHBOARD_PORT;
  delete process.env.OMP_DASHBOARD_PORT;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalEnvPort === undefined) delete process.env.OMP_DASHBOARD_PORT;
  else process.env.OMP_DASHBOARD_PORT = originalEnvPort;
});

function writeConfig(cwd: string, content: string): void {
  const dir = join(cwd, ".omp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "omp-viewer.json"), content);
}

test("falls back to the default port with no env var, no cwd, and no config", () => {
  assert.equal(resolvePort(), DEFAULT_PORT);
});

test("falls back to the default port when cwd has no .omp/omp-viewer.json", () => {
  assert.equal(resolvePort(tmpDir), DEFAULT_PORT);
});

test("OMP_DASHBOARD_PORT env var wins over everything else", () => {
  process.env.OMP_DASHBOARD_PORT = "9999";
  writeConfig(tmpDir, JSON.stringify({ port: 1234 }));
  assert.equal(resolvePort(tmpDir), 9999);
});

test("reads the port from <cwd>/.omp/omp-viewer.json when no env var is set", () => {
  writeConfig(tmpDir, JSON.stringify({ port: 8300 }));
  assert.equal(resolvePort(tmpDir), 8300);
});

test("falls back to the default port when the config file is malformed JSON", () => {
  writeConfig(tmpDir, "{ not json");
  assert.equal(resolvePort(tmpDir), DEFAULT_PORT);
});

test("falls back to the default port when the configured port is out of range", () => {
  writeConfig(tmpDir, JSON.stringify({ port: 99999 }));
  assert.equal(resolvePort(tmpDir), DEFAULT_PORT);
});

test("falls back to the default port when the configured port is not a number", () => {
  writeConfig(tmpDir, JSON.stringify({ port: "not-a-number" }));
  assert.equal(resolvePort(tmpDir), DEFAULT_PORT);
});

test("an invalid OMP_DASHBOARD_PORT env var falls through to config, then default", () => {
  process.env.OMP_DASHBOARD_PORT = "not-a-port";
  writeConfig(tmpDir, JSON.stringify({ port: 8300 }));
  assert.equal(resolvePort(tmpDir), 8300);

  rmSync(join(tmpDir, ".omp"), { recursive: true, force: true });
  assert.equal(resolvePort(tmpDir), DEFAULT_PORT);
});
