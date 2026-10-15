import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "./state.js";

test("register creates an idle, not-awaiting snapshot with the given fields", () => {
  const registry = new SessionRegistry();
  registry.register("s1", 123, "/tmp/proj", "my-session", []);
  const [snap] = registry.snapshotAll();
  assert.equal(snap?.sessionId, "s1");
  assert.equal(snap?.pid, 123);
  assert.equal(snap?.cwd, "/tmp/proj");
  assert.equal(snap?.sessionName, "my-session");
  assert.equal(snap?.status, "idle");
  assert.equal(snap?.awaitingInput, false);
  assert.deepEqual(snap?.todoPhases, []);
});

test("remove drops the session from subsequent snapshots", () => {
  const registry = new SessionRegistry();
  registry.register("s1", 1, "/a", undefined, []);
  registry.register("s2", 2, "/b", undefined, []);
  registry.remove("s1");
  const ids = registry.snapshotAll().map((s) => s.sessionId);
  assert.deepEqual(ids, ["s2"]);
});

test("snapshotAll orders sessions by connection time, earliest first", () => {
  const registry = new SessionRegistry();
  registry.register("first", 1, "/a", undefined, []);
  registry.register("second", 2, "/b", undefined, []);
  registry.register("third", 3, "/c", undefined, []);
  const ids = registry.snapshotAll().map((s) => s.sessionId);
  assert.deepEqual(ids, ["first", "second", "third"]);
});

test("setStatus, setTool, setTodoPhases, setContextUsage, setUsage, setSessionName mutate the matching session only", () => {
  const registry = new SessionRegistry();
  registry.register("s1", 1, "/a", undefined, []);
  registry.register("s2", 2, "/b", undefined, []);

  registry.setStatus("s1", "busy");
  registry.setTool("s1", "write");
  registry.setTodoPhases("s1", [{ name: "Foo", tasks: [] }]);
  registry.setContextUsage("s1", { tokens: 10, contextWindow: 100, percent: 10 });
  registry.setUsage("s1", { tokens: 500, cost: 0.01 });
  registry.setSessionName("s1", "renamed");

  const [s1, s2] = registry.snapshotAll();
  assert.equal(s1?.status, "busy");
  assert.equal(s1?.lastTool, "write");
  assert.deepEqual(s1?.todoPhases, [{ name: "Foo", tasks: [] }]);
  assert.deepEqual(s1?.contextUsage, { tokens: 10, contextWindow: 100, percent: 10 });
  assert.deepEqual(s1?.usage, { tokens: 500, cost: 0.01 });
  assert.equal(s1?.sessionName, "renamed");

  // Untouched session is unaffected.
  assert.equal(s2?.status, "idle");
  assert.equal(s2?.lastTool, undefined);
  assert.equal(s2?.sessionName, undefined);
});

test("mutators on an unknown sessionId are a silent no-op, not a throw", () => {
  const registry = new SessionRegistry();
  assert.doesNotThrow(() => {
    registry.setStatus("ghost", "busy");
    registry.setTool("ghost", "write");
    registry.setTodoPhases("ghost", []);
    registry.setContextUsage("ghost", { tokens: 0, contextWindow: 0, percent: 0 });
    registry.setUsage("ghost", { tokens: 0, cost: 0 });
    registry.setSessionName("ghost", "nope");
    registry.remove("ghost");
  });
  assert.equal(registry.setAwaitingInput("ghost", true), false);
  assert.deepEqual(registry.snapshotAll(), []);
});

test("setAwaitingInput reports true only on the false-to-true transition", () => {
  const registry = new SessionRegistry();
  registry.register("s1", 1, "/a", undefined, []);

  // false -> true: the toast-trigger edge.
  assert.equal(registry.setAwaitingInput("s1", true), true);
  // true -> true: already awaiting, not a new edge.
  assert.equal(registry.setAwaitingInput("s1", true), false);
  // true -> false: resolved, not an awaiting edge.
  assert.equal(registry.setAwaitingInput("s1", false), false);
  // false -> false: no-op, not an edge.
  assert.equal(registry.setAwaitingInput("s1", false), false);
  // false -> true again: a second genuine edge.
  assert.equal(registry.setAwaitingInput("s1", true), true);

  assert.equal(registry.snapshotAll()[0]?.awaitingInput, true);
});
