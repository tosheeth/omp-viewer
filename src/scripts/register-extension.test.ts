import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { registerExtension, toDisplayPath } from "./register-extension.js";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-viewer-register-"));
  configPath = join(dir, "config.yml");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("toDisplayPath returns a ~-relative forward-slash path when inside home", () => {
  const home = join(dir, "home");
  const absPath = join(home, ".omp", "agent", "extensions", "omp-viewer", "node_modules", "omp-viewer");
  assert.equal(toDisplayPath(absPath, home), "~/.omp/agent/extensions/omp-viewer/node_modules/omp-viewer");
});

test("toDisplayPath returns a forward-slash absolute path when outside home", () => {
  const home = join(dir, "home");
  const absPath = join(dir, "elsewhere", "omp-viewer");
  assert.equal(toDisplayPath(absPath, home), absPath.split(sep).join("/"));
});

test("skips with a reason when config.yml does not exist", () => {
  const result = registerExtension("/install/dir", "/home", configPath);
  assert.equal(result.status, "skipped");
  if (result.status !== "skipped") throw new Error("unreachable");
  assert.match(result.reason, /no config\.yml found/);
});

test("adds an extensions: key when the file has none, preserving existing content", () => {
  writeFileSync(configPath, "shellPath: /bin/bash\n# keep me\nsetupVersion: 2\n");
  const result = registerExtension("/install/dir", "/home", configPath);
  assert.equal(result.status, "registered");

  const content = readFileSync(configPath, "utf8");
  assert.match(content, /# keep me/);
  assert.match(content, /setupVersion: 2/);
  assert.match(content, /extensions:\n\s*- \/install\/dir/);
});

test("appends to an existing extensions list without disturbing other entries", () => {
  writeFileSync(configPath, "extensions:\n  - ./some/other/extension\n");
  const result = registerExtension("/install/dir", "/home", configPath);
  assert.equal(result.status, "registered");

  const content = readFileSync(configPath, "utf8");
  assert.match(content, /- \.\/some\/other\/extension/);
  assert.match(content, /- \/install\/dir/);
});

test("is idempotent: a second call reports already-registered and does not duplicate", () => {
  writeFileSync(configPath, "extensions:\n  - /install/dir\n");
  const result = registerExtension("/install/dir", "/home", configPath);
  assert.equal(result.status, "already-registered");

  const content = readFileSync(configPath, "utf8");
  const occurrences = content.split("/install/dir").length - 1;
  assert.equal(occurrences, 1);
});

test("skips without modifying the file when extensions is not a list", () => {
  writeFileSync(configPath, "extensions: not-a-list\n");
  const before = readFileSync(configPath, "utf8");
  const result = registerExtension("/install/dir", "/home", configPath);
  assert.equal(result.status, "skipped");
  if (result.status !== "skipped") throw new Error("unreachable");
  assert.match(result.reason, /isn't a list/);
  assert.equal(readFileSync(configPath, "utf8"), before);
});

test("skips without modifying the file when the YAML is malformed", () => {
  writeFileSync(configPath, "this: is: not: valid: yaml: [[[\n");
  const before = readFileSync(configPath, "utf8");
  const result = registerExtension("/install/dir", "/home", configPath);
  assert.equal(result.status, "skipped");
  assert.equal(readFileSync(configPath, "utf8"), before);
});
