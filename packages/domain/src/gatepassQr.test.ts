import test from "node:test";
import assert from "node:assert/strict";
import { buildGatepassQr, parseGatepassQr } from "./gatepassQr.js";
import { parseRawMaterialQrId } from "./rawMaterialQr.js";
import { parseQrCode } from "./qr.js";

const ID = "3f2b9c1e-8a4d-4c55-9e1f-2a7b6c0d9e11";

test("a gatepass QR names its gatepass, and reads back to the same id", () => {
  const code = buildGatepassQr(ID);
  assert.equal(code, `GPQR_${ID}`);
  assert.deepEqual(parseGatepassQr(code), { gatepassId: ID });
});

test("a scanner that changes the letters' case, or adds spaces, still opens the same gatepass", () => {
  assert.deepEqual(parseGatepassQr(`  gpqr_${ID.toUpperCase()}\n`), { gatepassId: ID });
});

test("anything else is not a gatepass QR: a carton, a raw material packet, a search, nothing", () => {
  for (const other of ["SK6_BLUE_7/10_001", "RM_6_42_6", "GP-000007", "BEHRAAM", "", "GPQR_", "GPQR_short", "GPQR_bad id with spaces"]) {
    assert.equal(parseGatepassQr(other), null, other);
  }
});

test("a gatepass QR is never mistaken for a carton or a raw material packet", () => {
  const code = buildGatepassQr(ID);
  assert.throws(() => parseQrCode(code));
  assert.throws(() => parseRawMaterialQrId(code));
});

test("an id that is not one is refused rather than printed", () => {
  assert.throws(() => buildGatepassQr(""));
  assert.throws(() => buildGatepassQr("has space"));
});
