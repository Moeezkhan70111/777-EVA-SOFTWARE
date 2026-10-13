import test from "node:test";
import assert from "node:assert/strict";
import {
  MACHINE_INJECTORS,
  MACHINE_PROGRAM_DISPLAY_STATUS,
  MACHINE_PROGRAM_STATUS,
  attributeKey,
  upperSizeForArticleSize,
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
  checkSoleSlot,
  clockText,
  formatDuration,
  minuteFromClock,
  cartonsExpectedFromUppers,
  shiftFromClocks,
  shiftMinutes,
  slotFromClocks,
  soleSlotOf,
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
// ─── Custom hours, and how long each sole runs in them ───────────────────────

const DAY_SHIFT = { startMinute: 6 * 60, endMinute: 18 * 60 };
const NIGHT_SHIFT = { startMinute: 18 * 60, endMinute: 30 * 60 };

test("how long a stretch of time lasts, said the way somebody says it", () => {
  assert.equal(shiftMinutes(DAY_SHIFT), 720);
  assert.equal(shiftMinutes(NIGHT_SHIFT), 720, "a night shift is twelve hours, not minus twelve");
  assert.equal(formatDuration(720), "12 hours");
  assert.equal(formatDuration(60), "1 hour");
  assert.equal(formatDuration(510), "8 hours 30 min");
  assert.equal(formatDuration(45), "45 min");
  assert.equal(formatDuration(0), "0 min");
});

test("a clock control reads and writes the shift convention", () => {
  assert.equal(clockText(360), "06:00");
  assert.equal(clockText(1080), "18:00");
  assert.equal(clockText(1800), "06:00", "1800 minutes is 06:00 the next morning");
  assert.equal(minuteFromClock("06:00"), 360);
  assert.equal(minuteFromClock("18:30"), 1110);
  assert.equal(minuteFromClock(""), null, "an empty control is not a time");
  assert.equal(minuteFromClock("24:00"), null);
  assert.equal(minuteFromClock("6pm"), null);
});

test("two clock faces become the shift the floor means", () => {
  assert.deepEqual(shiftFromClocks("08:00", "14:00"), { startMinute: 480, endMinute: 840 }, "hours nobody offered before");
  assert.deepEqual(shiftFromClocks("18:00", "06:00"), NIGHT_SHIFT, "a finish before the start is the next morning");
  assert.deepEqual(shiftFromClocks("06:00", "06:00"), { startMinute: 360, endMinute: 1800 }, "a full day round the clock");
  assert.equal(shiftFromClocks("08:00", ""), null, "half a time is no time");
});

test("a sole's hours are numbered on its own shift's clock", () => {
  assert.deepEqual(slotFromClocks("06:00", "10:00", DAY_SHIFT), { startMinute: 360, endMinute: 600 });
  assert.deepEqual(
    slotFromClocks("22:00", "02:00", NIGHT_SHIFT),
    { startMinute: 1320, endMinute: 1560 },
    "02:00 inside a night shift is 26:00, not the small hours before it started"
  );
  assert.deepEqual(
    slotFromClocks("01:00", "05:00", NIGHT_SHIFT),
    { startMinute: 1500, endMinute: 1740 },
    "the whole slot moves to the morning after"
  );
  assert.equal(slotFromClocks("06:00", "", DAY_SHIFT), null);
});

test("a sole may only run while the machine is running", () => {
  assert.equal(checkSoleSlot({ startMinute: 360, endMinute: 600 }, DAY_SHIFT), null);
  assert.equal(checkSoleSlot(DAY_SHIFT, DAY_SHIFT), null, "one colour may have the whole shift");
  assert.equal(
    checkSoleSlot({ startMinute: 600, endMinute: 900 }, { startMinute: 360, endMinute: 780 }),
    "OUTSIDE_SHIFT",
    "a sole cannot run after the machine stops"
  );
  assert.equal(checkSoleSlot({ startMinute: 300, endMinute: 600 }, DAY_SHIFT), "OUTSIDE_SHIFT", "nor before it starts");
  assert.equal(checkSoleSlot({ startMinute: 600, endMinute: 600 }, DAY_SHIFT), "INVALID_TIME");
  assert.equal(checkSoleSlot({ startMinute: 600, endMinute: 480 }, DAY_SHIFT), "INVALID_TIME");
  assert.equal(checkSoleSlot({ startMinute: 360.5, endMinute: 600 }, DAY_SHIFT), "INVALID_TIME");
  // Two colours sharing an hour is a sole change, not a mistake: the floor reads them in order.
  assert.equal(checkSoleSlot({ startMinute: 360, endMinute: 660 }, DAY_SHIFT), null);
  assert.equal(checkSoleSlot({ startMinute: 600, endMinute: 1080 }, DAY_SHIFT), null);
});

test("a run nobody timed runs the whole shift", () => {
  assert.equal(soleSlotOf({ startMinute: null, endMinute: null }), null);
  assert.equal(soleSlotOf({}), null, "a run saved before the hours existed");
  assert.equal(soleSlotOf({ startMinute: 360, endMinute: null }), null, "half a slot is no slot");
  assert.deepEqual(soleSlotOf({ startMinute: 360, endMinute: 600 }), { startMinute: 360, endMinute: 600 });
});

// ─── The upper's own size ────────────────────────────────────────────────────

test("4/6 and 1/3 are made with the 1/6 upper, and every other size with its own", () => {
  assert.equal(upperSizeForArticleSize("4/6"), "1/6");
  assert.equal(upperSizeForArticleSize("1/3"), "1/6");
  assert.equal(upperSizeForArticleSize("7/10"), "7/10");
  assert.equal(upperSizeForArticleSize("11/13"), "11/13");
});

test("an article size is read the way every other attribute is: trimmed, spaces ignored", () => {
  assert.equal(upperSizeForArticleSize(" 4 / 6 "), "1/6");
  assert.equal(upperSizeForArticleSize("1/6"), "1/6", "the upper's own size is already the upper's size");
  assert.equal(upperSizeForArticleSize(""), "");
  assert.equal(upperSizeForArticleSize(null), "");
});

// ─── Dozens to carton labels ─────────────────────────────────────────────────
//
// One rule decides every carton count on a machine program: an upper LINE's plan (migration 076)
// and a FIX run's plan both go through cartonsExpectedFromUppers. It had no test of its own, and
// the owner decision of 2026-10-14 turns on exactly this arithmetic: a line planned at 4.5 DOZEN
// is owed 9 cartons, because what the store issued in whole packets can never add up to 4.5.
//
// A carton QR is a permanent identity, so a figure that would have to be guessed at is REFUSED
// rather than rounded. Null means "send it to QR Generator", never "print your best guess".

test("whole cartons of DOZEN become that many carton labels", () => {
  assert.equal(cartonsExpectedFromUppers(1, "DOZEN"), 2, "a dozen is two cartons");
  assert.equal(cartonsExpectedFromUppers(2, "DOZEN"), 4);
  assert.equal(cartonsExpectedFromUppers(32, "DOZEN"), 64, "a fix run of 32 DOZEN");
});

test("half a dozen is a whole carton, so a fractional plan that lands on one is owed its labels", () => {
  assert.equal(cartonsExpectedFromUppers(4.5, "DOZEN"), 9, "the 4.5 DOZEN line the plan rule was written for");
  assert.equal(cartonsExpectedFromUppers(0.5, "DOZEN"), 1, "half a dozen IS a carton");
  assert.equal(cartonsExpectedFromUppers(32.5, "DOZEN"), 65);
});

test("a plan that does not come to whole cartons is refused, never rounded", () => {
  assert.equal(cartonsExpectedFromUppers(4.25, "DOZEN"), null, "8.5 cartons cannot be labelled");
  assert.equal(cartonsExpectedFromUppers(0.25, "DOZEN"), null);
  assert.equal(cartonsExpectedFromUppers(32.1, "DOZEN"), null);
});

test("nothing is owed when the quantity is not a usable number", () => {
  assert.equal(cartonsExpectedFromUppers(0, "DOZEN"), null, "nothing planned is nothing owed");
  assert.equal(cartonsExpectedFromUppers(-4, "DOZEN"), null);
  assert.equal(cartonsExpectedFromUppers(Number.NaN, "DOZEN"), null);
  assert.equal(cartonsExpectedFromUppers(Number.POSITIVE_INFINITY, "DOZEN"), null);
});

test("only DOZEN is counted in cartons, read the way every other attribute is", () => {
  assert.equal(cartonsExpectedFromUppers(4.5, " dozen "), 9, "trimmed and upper-cased like attributeKey");
  assert.equal(cartonsExpectedFromUppers(4, "PAIR"), null, "pairs are not cartons");
  assert.equal(cartonsExpectedFromUppers(4, "PCS"), null);
  assert.equal(cartonsExpectedFromUppers(4, null), null, "a line with no unit says nothing about cartons");
  assert.equal(cartonsExpectedFromUppers(4, ""), null);
});
