import { STORE_DIRECTION, type StoreDirection } from "./storeDailyReport.js";

// STORE HAND VOUCHERS (docs/49): raw material moved in or out of the store WITHOUT labels, written as one numbered
// voucher.
//
//   SIV-100012 · IN  · SHEHZAD RUBBER · Bilty 42              materials that came in from a supplier
//   SOV-100007 · OUT · ASLAM (contractor) · cutting table     materials that went out to a party, for a purpose
//     1  NAWAAR 5 SOOTAR BLACK   3 RULE     = 2,925 INCH
//
// One voucher is one party and one direction: every line is a hand move on its material's balance, made through the
// same rules as moving one material by hand (rawMaterialHandMove.ts). The voucher says what the movements were for:
// its number, its party, its day, its note, and who wrote it.
//
// A voucher may be EDITED or DELETED on the day it was written, and only then. Neither rewrites history: the old
// lines' movements are reversed by new movements naming the voucher, and the new lines are moved again. A voucher that
// is deleted keeps its number and its lines, marked deleted. A number is never reused.
//
// Pure: these are the rules the screen and the data layer share.

/** A voucher is POSTED until it is deleted. */
export const STORE_HAND_VOUCHER_STATUS = { POSTED: "POSTED", DELETED: "DELETED" } as const;
export type HandVoucherStatus = (typeof STORE_HAND_VOUCHER_STATUS)[keyof typeof STORE_HAND_VOUCHER_STATUS];

/** The most lines one voucher may hold. A delivery or an issue is a handful of materials, not hundreds. */
export const STORE_HAND_VOUCHER_MAX_LINES = 100;

/** The longest note a voucher may carry. */
export const STORE_HAND_VOUCHER_NOTE_MAX = 160;

/** Each direction is its own series: SIV- in, SOV- out. */
const CODE_PREFIX: Readonly<Record<StoreDirection, string>> = { [STORE_DIRECTION.IN]: "SIV", [STORE_DIRECTION.OUT]: "SOV" };

/** "SIV-100012", "SOV-100007" — a voucher's number as screens and slips show it. */
export const formatHandVoucherCode = (direction: StoreDirection, voucherNumber: number): string =>
  `${CODE_PREFIX[direction]}-${String(voucherNumber).padStart(6, "0")}`;

/** The prefix alone, for the number box: "SIV", "SOV". */
export const handVoucherPrefix = (direction: StoreDirection): string => CODE_PREFIX[direction];

export const isHandVoucherStatus = (value: unknown): value is HandVoucherStatus =>
  value === STORE_HAND_VOUCHER_STATUS.POSTED || value === STORE_HAND_VOUCHER_STATUS.DELETED;

export const isStoreDirection = (value: unknown): value is StoreDirection => value === STORE_DIRECTION.IN || value === STORE_DIRECTION.OUT;

/** Whether a voucher written on `voucherDate` may still be edited or deleted on `today` (both Asia/Karachi days). */
export const handVoucherEditable = (voucherDate: string, today: string, status: string): boolean =>
  status === STORE_HAND_VOUCHER_STATUS.POSTED && voucherDate === today;

/** Why a typed line quantity cannot be saved, or null when it can. An empty box is not an error yet. */
export function handQuantityProblem(typed: string, direction: StoreDirection = STORE_DIRECTION.IN): string | null {
  const text = typed.trim();
  if (text === "") return null;
  const value = Number(text);
  if (Number.isFinite(value) && value > 0) return null;
  return direction === STORE_DIRECTION.OUT ? "Type how much is going out — a number above 0." : "Type how much came in — a number above 0.";
}

/** A Move Out voucher must say what the material is going out for; a Move In voucher's reference is optional. */
export const handVoucherNeedsNote = (direction: StoreDirection): boolean => direction === STORE_DIRECTION.OUT;
