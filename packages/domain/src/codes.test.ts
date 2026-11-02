import test from "node:test";
import assert from "node:assert/strict";
import { compareNumberedCodes } from "./codes.js";

// Blocks 11 to 99 number in seven digits (docs/41 section 10). Text order would put them first.

test("codes sort by their number, seven digits after six", () => {
  const codes = ["PTY-1000000", "PTY-200000", "PTY-000123", "PTY-099999", "PTY-1000001"];
  assert.deepEqual([...codes].sort(compareNumberedCodes), ["PTY-000123", "PTY-099999", "PTY-200000", "PTY-1000000", "PTY-1000001"]);
});

test("the prefix still separates kinds of code, and equal codes compare equal", () => {
  assert.ok(compareNumberedCodes("MP-1000000", "RM-000001") < 0);
  assert.equal(compareNumberedCodes("RM-000045", "RM-000045"), 0);
});
