import { test } from "node:test";
import assert from "node:assert/strict";
import { createPopupGate } from "./popup-gate.js";

test("spawns on the first call when no dashboard is connected", () => {
  let calls = 0;
  const gate = createPopupGate({ spawnPopup: () => calls++, now: () => 0 });
  gate(false);
  assert.equal(calls, 1);
});

test("never spawns while a dashboard is connected", () => {
  let calls = 0;
  const gate = createPopupGate({ spawnPopup: () => calls++, now: () => 0 });
  gate(true);
  gate(true);
  assert.equal(calls, 0);
});

test("dedupes a burst of calls within the cooldown window", () => {
  let calls = 0;
  let t = 1_000;
  const gate = createPopupGate({ spawnPopup: () => calls++, now: () => t, cooldownMs: 2_000 });
  gate(false);
  t += 500;
  gate(false);
  t += 1_499; // still inside the 2000ms window started by the first call
  gate(false);
  assert.equal(calls, 1);
});

test("spawns again once the cooldown window has elapsed", () => {
  let calls = 0;
  let t = 1_000;
  const gate = createPopupGate({ spawnPopup: () => calls++, now: () => t, cooldownMs: 2_000 });
  gate(false);
  t += 2_000; // exactly at the boundary: cooldownUntil = 1000 + 2000 = 3000, now = 3000 -> not < cooldownUntil
  gate(false);
  assert.equal(calls, 2);
});

test("a connected dashboard does not reset or consume the cooldown", () => {
  let calls = 0;
  let t = 1_000;
  const gate = createPopupGate({ spawnPopup: () => calls++, now: () => t, cooldownMs: 2_000 });
  gate(false);
  t += 100;
  gate(true); // dashboard connected in between: short-circuits before the cooldown check
  t += 2_000;
  gate(false);
  assert.equal(calls, 2);
});
