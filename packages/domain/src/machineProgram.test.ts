import test from "node:test";
import assert from "node:assert/strict";
import {
  MACHINE_INJECTORS,
  MACHINE_PROGRAM_DISPLAY_STATUS,
  MACHINE_PROGRAM_STATUS,
  attributeKey,
  programAvailable,
  bagsFromBalance,
  checkProgramQuantity,
  holdsReservation,
  isInjectorNo,
  machineProgramDisplayStatus,
  maxNewAllocation,
  programOutstanding,
  packetsInStore,
  sameAttributeValue,
  DEFAULT_MACHINE_SHIFT,
  MACHINE_SHIFTS,
  checkMachineShift,
  formatMinuteOfDay,
  formatShiftRange,
  sameMachineShift,
  shiftEndsNextDay,
} from "./machineProgram.js";

// The arithmetic every machine program screen and query is built on. Kept here, with the
// gatepass reservation rules it mirrors, so a change to "what is still available" is one
// change in one place.

test("a line owes what has not been scanned out for it, and never less than nothing", () => {
  assert.equal(programOutstanding(30, 0), 30);
  assert.equal(programOutstanding(30, 12), 18);
  assert.equal(programOutstanding(30, 30), 0);
  // A packet bigger than what was left can never push a line into owing a negative amount.
  assert.equal(programOutstanding(30, 35), 0);
  // Floating-point dust is rounded away.
  assert.equal(programOutstanding(30, 20.1), 9.9);
});

test("available is physical minus reserved, and a new allocation cannot go below zero", () => {
  assert.equal(programAvailable(50, 30), 20);
  assert.equal(maxNewAllocation(50, 30), 20);
  // Over-committed (the balance was corrected down after the program was made) shows as a
  // negative figure so a screen can say so, but nothing new may be taken.
  assert.equal(programAvailable(10, 25), -15);
  assert.equal(maxNewAllocation(10, 25), 0);
});

test("a quantity must be positive, at most two decimals, and fit inside what is free", () => {
  assert.equal(checkProgramQuantity(30, { available: 50 }), null);
  assert.equal(checkProgramQuantity(50, { available: 50 }), null, "taking everything that is free is allowed");
  assert.equal(checkProgramQuantity(0.5, { available: 50 }), null, "half a dozen is six pairs");
  assert.equal(checkProgramQuantity(0, { available: 50 }), "INVALID_QUANTITY");
  assert.equal(checkProgramQuantity(-5, { available: 50 }), "INVALID_QUANTITY");
  assert.equal(checkProgramQuantity(Number.NaN, { available: 50 }), "INVALID_QUANTITY");
  assert.equal(checkProgramQuantity(1.234, { available: 50 }), "INVALID_QUANTITY");
  assert.equal(checkProgramQuantity(51, { available: 50 }), "NOT_ENOUGH_STOCK");
});

test("an edited line is measured against what is free plus what it already took", () => {
  // 30 on the line, 10 of them already scanned out: the store's free 20 plus the line's own 10
  // consumed means it may go to 30 + 20 = 50 but no further, and never below 10.
  assert.equal(checkProgramQuantity(50, { available: 40, consumed: 10 }), null);
  assert.equal(checkProgramQuantity(51, { available: 40, consumed: 10 }), "NOT_ENOUGH_STOCK");
  assert.equal(checkProgramQuantity(9, { available: 40, consumed: 10 }), "BELOW_CONSUMED");
  assert.equal(checkProgramQuantity(10, { available: 40, consumed: 10 }), null);
});

test("a balance becomes whole bags only through the pack size, and a part bag is not one", () => {
  assert.equal(bagsFromBalance(100, 25), 4);
  assert.equal(bagsFromBalance(110, 25), 4);
  assert.equal(bagsFromBalance(24, 25), 0);
  assert.equal(bagsFromBalance(100, null), 0);
  assert.equal(packetsInStore({ labelledPackets: 2, labelledContents: 8, quantityOnHand: 8, fixedPackSize: null }), 2);
});

test("only a live program reserves stock", () => {
  assert.equal(holdsReservation(MACHINE_PROGRAM_STATUS.PROGRAMMED), true);
  assert.equal(holdsReservation(MACHINE_PROGRAM_STATUS.COMPLETED), false);
  assert.equal(holdsReservation(MACHINE_PROGRAM_STATUS.CANCELLED), false);
});

test("partially used is derived from what was scanned, never stored", () => {
  const { PROGRAMMED, COMPLETED, CANCELLED } = MACHINE_PROGRAM_STATUS;
  assert.equal(machineProgramDisplayStatus(PROGRAMMED, 40, 0), MACHINE_PROGRAM_DISPLAY_STATUS.PROGRAMMED);
  assert.equal(machineProgramDisplayStatus(PROGRAMMED, 40, 12.5), MACHINE_PROGRAM_DISPLAY_STATUS.PARTIALLY_USED);
  assert.equal(machineProgramDisplayStatus(PROGRAMMED, 40, 40), MACHINE_PROGRAM_DISPLAY_STATUS.COMPLETED);
  assert.equal(machineProgramDisplayStatus(COMPLETED, 40, 40), MACHINE_PROGRAM_DISPLAY_STATUS.COMPLETED);
  assert.equal(machineProgramDisplayStatus(CANCELLED, 40, 3), MACHINE_PROGRAM_DISPLAY_STATUS.CANCELLED);
});

test("a machine has exactly two injectors", () => {
  assert.deepEqual([...MACHINE_INJECTORS], [1, 2]);
  assert.equal(isInjectorNo(1), true);
  assert.equal(isInjectorNo(2), true);
  assert.equal(isInjectorNo(3), false);
  assert.equal(isInjectorNo("1"), false);
});

test("attribute values match exactly, ignoring only case and surrounding space", () => {
  assert.equal(attributeKey("  sk6 "), "SK6");
  assert.equal(sameAttributeValue("SK6", "sk6"), true);
  assert.equal(sameAttributeValue("7/10", " 7/10"), true);
  // Never fuzzy: a space inside the value is a different article.
  assert.equal(sameAttributeValue("SK 43", "SK43"), false);
  assert.equal(sameAttributeValue("", ""), false, "two blanks are not a match");
});

// ─── The shift a program runs ────────────────────────────────────────────────

test("the floor's two shifts are the day shift and the night shift that ends next morning", () => {
  assert.deepEqual([...MACHINE_SHIFTS], [
    { startMinute: 360, endMinute: 1080 },
    { startMinute: 1080, endMinute: 1800 },
  ]);
  assert.deepEqual(DEFAULT_MACHINE_SHIFT, { startMinute: 360, endMinute: 1080 });
  assert.equal(shiftEndsNextDay(MACHINE_SHIFTS[0]), false);
  assert.equal(shiftEndsNextDay(MACHINE_SHIFTS[1]), true, "18:00 to 06:00 finishes the next morning");
  assert.equal(sameMachineShift(MACHINE_SHIFTS[0], { startMinute: 360, endMinute: 1080 }), true);
  assert.equal(sameMachineShift(MACHINE_SHIFTS[0], MACHINE_SHIFTS[1]), false);
});

test("a shift is whole minutes, starts inside the day and ends after it starts", () => {
  assert.equal(checkMachineShift({ startMinute: 360, endMinute: 1080 }), true);
  assert.equal(checkMachineShift({ startMinute: 1080, endMinute: 1800 }), true, "may run past midnight");
  assert.equal(checkMachineShift({ startMinute: 0, endMinute: 2880 }), true, "a full two days is the limit");
  assert.equal(checkMachineShift({ startMinute: 360, endMinute: 360 }), false, "no shift lasts no time");
  assert.equal(checkMachineShift({ startMinute: 600, endMinute: 300 }), false, "never ends before it starts");
  assert.equal(checkMachineShift({ startMinute: -1, endMinute: 600 }), false);
  assert.equal(checkMachineShift({ startMinute: 1440, endMinute: 1800 }), false, "starts inside its own day");
  assert.equal(checkMachineShift({ startMinute: 360, endMinute: 2881 }), false);
  assert.equal(checkMachineShift({ startMinute: 360.5, endMinute: 1080 }), false, "whole minutes only");
  assert.equal(checkMachineShift({ startMinute: Number.NaN, endMinute: 1080 }), false);
});

test("a shift reads as the clock, however many days along it runs", () => {
  assert.equal(formatMinuteOfDay(0), "12:00 AM");
  assert.equal(formatMinuteOfDay(360), "06:00 AM");
  assert.equal(formatMinuteOfDay(720), "12:00 PM");
  assert.equal(formatMinuteOfDay(1080), "06:00 PM");
  assert.equal(formatMinuteOfDay(1800), "06:00 AM", "1800 minutes is 06:00 the next morning");
  assert.equal(formatShiftRange(MACHINE_SHIFTS[0]), "06:00 AM – 06:00 PM");
  assert.equal(formatShiftRange(MACHINE_SHIFTS[1]), "06:00 PM – 06:00 AM");
});
