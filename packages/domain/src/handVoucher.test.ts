import test from "node:test";
import assert from "node:assert/strict";
import { STORE_HAND_VOUCHER_STATUS, formatHandVoucherCode, handQuantityProblem, handVoucherEditable, handVoucherNeedsNote } from "./handVoucher.js";
import { stockEventReportDirection, stockEventReportQuantity } from "./storeDailyReport.js";

test("Move In vouchers read SIV-, Move Out vouchers SOV-, six digits and a seventh when the block needs it", () => {
  assert.equal(formatHandVoucherCode("IN", 12), "SIV-000012");
  assert.equal(formatHandVoucherCode("IN", 100012), "SIV-100012");
  assert.equal(formatHandVoucherCode("OUT", 100007), "SOV-100007");
  assert.equal(formatHandVoucherCode("OUT", 1000001), "SOV-1000001");
});

test("only a posted voucher of today may be edited or deleted", () => {
  assert.equal(handVoucherEditable("2026-11-15", "2026-11-15", STORE_HAND_VOUCHER_STATUS.POSTED), true);
  assert.equal(handVoucherEditable("2026-11-14", "2026-11-15", STORE_HAND_VOUCHER_STATUS.POSTED), false);
  assert.equal(handVoucherEditable("2026-11-15", "2026-11-15", STORE_HAND_VOUCHER_STATUS.DELETED), false);
});

test("a typed quantity is a number above zero, said for its direction; an empty box is not an error yet", () => {
  assert.equal(handQuantityProblem(""), null);
  assert.equal(handQuantityProblem("2.5"), null);
  assert.match(handQuantityProblem("0") ?? "", /came in — a number above 0/);
  assert.match(handQuantityProblem("abc", "OUT") ?? "", /going out — a number above 0/);
});

test("a Move Out voucher must say what for; a Move In voucher's reference is optional", () => {
  assert.equal(handVoucherNeedsNote("OUT"), true);
  assert.equal(handVoucherNeedsNote("IN"), false);
});

test("the day's report counts each voucher's reversal against its own side, and every other movement by its size", () => {
  assert.equal(stockEventReportQuantity("RECEIVE", 50), 50);
  assert.equal(stockEventReportQuantity("RECEIVE", -50), -50);
  assert.equal(stockEventReportQuantity("TRANSFER_OUT", -30), 30);
  assert.equal(stockEventReportQuantity("ADJUST", -4), 4);

  // A Move Out line taken back: material put back (TRANSFER_IN), counted against the day's OUT.
  const reversal = "Manual move out — reversed 3 RULE · SOV-100001 edited";
  assert.equal(stockEventReportDirection("TRANSFER_IN", 2925, reversal), "OUT");
  assert.equal(stockEventReportQuantity("TRANSFER_IN", 2925, reversal), -2925);
  // An ordinary TRANSFER_IN stays an IN movement.
  assert.equal(stockEventReportDirection("TRANSFER_IN", 10, "Returned from floor"), "IN");
  assert.equal(stockEventReportQuantity("TRANSFER_IN", 10, "Returned from floor"), 10);
});
