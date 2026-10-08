import test from "node:test";
import assert from "node:assert/strict";
import { ScannerFrameAssembler } from "./scannerFrameAssembler.js";

test("scanner emits frame on Enter", () => {
  const scanner = new ScannerFrameAssembler();
  const chars = "SK6_BLUE_7/10_001";

  for (const ch of chars) {
    const result = scanner.pushCharacter(ch, 1);
    assert.equal(result.accepted, false);
  }

  const finalResult = scanner.pushCharacter("Enter", 2);
  assert.equal(finalResult.accepted, true);
  assert.equal(finalResult.frame, chars);
});

test("scanner discards partial input after timeout", () => {
  const scanner = new ScannerFrameAssembler({ frameTimeoutMs: 100 });
  scanner.pushCharacter("S", 1);
  scanner.pushCharacter("K", 10);
  scanner.pushCharacter("6", 20);

  scanner.pushCharacter("_", 500);
  const result = scanner.pushCharacter("Enter", 520);
  assert.equal(result.accepted, true);
  assert.equal(result.frame, "_");
});

test("scanner handles rapid consecutive scans", () => {
  const scanner = new ScannerFrameAssembler();
  const first = "SK6_BLUE_7/10_001";
  const second = "SK6_BLUE_7/10_002";

  for (const ch of first) {
    scanner.pushCharacter(ch, 1);
  }
  const firstResult = scanner.pushCharacter("Enter", 2);

  for (const ch of second) {
    scanner.pushCharacter(ch, 3);
  }
  const secondResult = scanner.pushCharacter("Enter", 4);

  assert.equal(firstResult.accepted, true);
  assert.equal(secondResult.accepted, true);
  assert.equal(firstResult.frame, first);
  assert.equal(secondResult.frame, second);
});
