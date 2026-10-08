import test from "node:test";
import assert from "node:assert/strict";
import {
  InvalidQrError,
  QrParserRegistry,
  QrParserV2,
  buildQrId,
  isValidQrCode,
  normalizeQrColor,
  parseQrCode,
} from "./qr.js";

test("parseQrCode parses V1 QR", () => {
  const parsed = parseQrCode("SK6_BLUE_7/10_001");
  assert.equal(parsed.parserVersion, "v1");
  assert.equal(parsed.payload.qrId, "SK6_BLUE_7/10_001");
  assert.equal(parsed.payload.article, "SK6");
  assert.equal(parsed.payload.color, "BLUE");
  assert.equal(parsed.payload.size, "7/10");
  assert.equal(parsed.payload.serial, "001");
});

test("V2 can be enabled with explicit registry", () => {
  const registry = new QrParserRegistry([new QrParserV2()]);
  const parsed = registry.parse("F001_SK6_BLUE_7/10_B22_001");
  assert.equal(parsed.parserVersion, "v2");
  assert.equal(parsed.payload.factoryCode, "F001");
  assert.equal(parsed.payload.batchCode, "B22");
});

test("invalid QR is rejected", () => {
  assert.equal(isValidQrCode("bad-qr-value"), false);
  assert.equal(isValidQrCode("F001_SK6_BLUE_7/10_B22_001"), false);
  assert.throws(() => parseQrCode("bad-qr-value"));
});

test("buildQrId produces a 6-digit serial in the canonical format", () => {
  assert.equal(buildQrId({ article: "SK6", color: "RED", size: "7/10", sequence: 1 }), "SK6_RED_7/10_000001");
  assert.equal(buildQrId({ article: "SK6", color: "RED", size: "7/10", sequence: 500 }), "SK6_RED_7/10_000500");
  // Past the padding width the serial keeps growing rather than wrapping or truncating.
  assert.equal(buildQrId({ article: "SK6", color: "RED", size: "7/10", sequence: 1234567 }), "SK6_RED_7/10_1234567");
});

test("every identity buildQrId issues parses back to the same product facts", () => {
  const qrId = buildQrId({ article: "SK6", color: "RED", size: "7/10", sequence: 42 });
  const parsed = parseQrCode(qrId);
  assert.equal(parsed.payload.article, "SK6");
  assert.equal(parsed.payload.color, "RED");
  assert.equal(parsed.payload.size, "7/10");
  assert.equal(parsed.payload.serial, "000042");
  assert.equal(parsed.payload.qrId, qrId);
});

test("colour normalisation folds casing and spacing onto one identity", () => {
  assert.equal(normalizeQrColor("red"), "RED");
  assert.equal(normalizeQrColor("Red"), "RED");
  assert.equal(normalizeQrColor("  RED  "), "RED");
  assert.equal(normalizeQrColor("light blue"), "LIGHTBLUE");
  assert.equal(normalizeQrColor("Light-Blue"), "LIGHTBLUE");

  const a = buildQrId({ article: "SK6", color: "red", size: "7/10", sequence: 1 });
  const b = buildQrId({ article: "SK6", color: " Red ", size: "7/10", sequence: 1 });
  assert.equal(a, b);
});

test("buildQrId refuses parts the scanner could not read back", () => {
  assert.throws(() => buildQrId({ article: "SK 6", color: "RED", size: "7/10", sequence: 1 }), InvalidQrError);
  assert.throws(() => buildQrId({ article: "SK6", color: "RED/BLUE", size: "7/10", sequence: 1 }), InvalidQrError);
  assert.throws(() => buildQrId({ article: "SK6", color: "RED", size: "LARGE", sequence: 1 }), InvalidQrError);
  assert.throws(() => buildQrId({ article: "SK6", color: "RED", size: "7/10", sequence: 0 }), InvalidQrError);
  assert.throws(() => buildQrId({ article: "SK6", color: "RED", size: "7/10", sequence: -1 }), InvalidQrError);
  assert.throws(() => buildQrId({ article: "SK6", color: "RED", size: "7/10", sequence: 1.5 }), InvalidQrError);
});
