// Machine Program — the single source of truth for the figures and rules a machine program
// is made of. Every screen, use case and query that shows or checks one goes through here.
//
// A program belongs to one MACHINE on one DATE. The machine has two INJECTORS, and each
// injector is given one or more SOLE RUNS: a sole, the colour it is moulded in, and the
// article + size it is moulded onto. A run is then given UPPER colours in a quantity
// (DOZEN, the unit uppers are stocked in):
//
//   MACHINE 1 · 4 Oct 2026
//     INJECTOR 1
//       SKECHERS · BLACK sole · SK6 7/10
//         BLACK upper  30 DOZEN
//         GREEN upper  10 DOZEN
//
// The upper lines are what the program RESERVES. Dana is shown so the operator knows the
// sole can be moulded, and is never reserved here.
//
//   Physical    what the store holds of an upper (the balance, in its stock unit)
//   Reserved    quantity still owed to live (PROGRAMMED) programs:
//                 Σ over their lines of (quantity − scanned out for that line)
//   Available   what is still free for a NEW allocation: Physical − Reserved
//
// Creating a program reserves; it never moves stock. A Raw Material Output scan moves one
// packet out of Physical AND consumes that packet's contents from a line's outstanding
// quantity, so Available is unchanged by it. Deleting a program releases only what was still
// outstanding — packets already issued stay issued.
//
// This mirrors packages/domain/src/gatepassStock.ts, which does the same job for cartons.

export const MACHINE_PROGRAM_STATUS = {
  /** Saved and holding a reservation. */
  PROGRAMMED: "PROGRAMMED",
  /** Every allocated quantity has been scanned out. Holds no reservation. */
  COMPLETED: "COMPLETED",
  /** Deleted. Holds no reservation, and never restores what was already issued. */
  CANCELLED: "CANCELLED",
} as const;
export type MachineProgramStatus = (typeof MACHINE_PROGRAM_STATUS)[keyof typeof MACHINE_PROGRAM_STATUS];

/**
 * What a program is called on screen.
 *
 * PARTIALLY_USED is deliberately not a stored status: it is what a PROGRAMMED program looks
 * like once some of its uppers have been scanned out, and deriving it from the event log means
 * it can never disagree with what actually happened at the scanner.
 */
export const MACHINE_PROGRAM_DISPLAY_STATUS = {
  PROGRAMMED: "PROGRAMMED",
  PARTIALLY_USED: "PARTIALLY_USED",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
} as const;
export type MachineProgramDisplayStatus =
  (typeof MACHINE_PROGRAM_DISPLAY_STATUS)[keyof typeof MACHINE_PROGRAM_DISPLAY_STATUS];

/** Below this, two quantities are the same quantity. Dozens are entered to two decimals. */
export const QUANTITY_EPSILON = 1e-6;

/** Quantities are typed to two decimals at most (0.5 DOZEN is six pairs). */
export const MAX_QUANTITY_DECIMALS = 2;

/** Rounds away floating-point dust so 30 − 20.1 reads as 9.9, not 9.899999999999999. */
export const roundQuantity = (value: number): number => Math.round(value * 100) / 100;

export const machineProgramDisplayStatus = (
  status: string,
  totalQuantity: number,
  consumedQuantity: number
): MachineProgramDisplayStatus => {
  if (status === MACHINE_PROGRAM_STATUS.CANCELLED) return MACHINE_PROGRAM_DISPLAY_STATUS.CANCELLED;
  if (status === MACHINE_PROGRAM_STATUS.COMPLETED) return MACHINE_PROGRAM_DISPLAY_STATUS.COMPLETED;
  if (consumedQuantity <= QUANTITY_EPSILON) return MACHINE_PROGRAM_DISPLAY_STATUS.PROGRAMMED;
  if (totalQuantity > 0 && consumedQuantity >= totalQuantity - QUANTITY_EPSILON) return MACHINE_PROGRAM_DISPLAY_STATUS.COMPLETED;
  return MACHINE_PROGRAM_DISPLAY_STATUS.PARTIALLY_USED;
};

/** Only a live program reserves anything. Completing or deleting releases by itself. */
export const holdsReservation = (status: string): boolean => status === MACHINE_PROGRAM_STATUS.PROGRAMMED;

// ─── The machine and what it is made of ──────────────────────────────────────

/** Every machine on the floor has exactly two injectors, programmed independently. */
export const MACHINE_INJECTORS = [1, 2] as const;
export type InjectorNo = (typeof MACHINE_INJECTORS)[number];

export const isInjectorNo = (value: unknown): value is InjectorNo =>
  typeof value === "number" && (MACHINE_INJECTORS as readonly number[]).includes(value);

/**
 * The top-level raw material categories the program reads. These are the store's own words —
 * the Raw Material Master names them — so they are matched by name, from this one place.
 */
export const RAW_MATERIAL_KIND = {
  /** Granules a sole is moulded from. Shown on a program, never reserved by it. */
  DANA: "DANA",
  /** The top a sole is moulded onto. What a program reserves. */
  UPPER: "UPPER",
} as const;

/** The attribute keys (inventory_category_fields.field_key) the program matches on. */
export const RAW_MATERIAL_ATTRIBUTE = {
  ARTICLE: "article",
  SIZE: "size",
  COLOUR: "color",
  TYPE: "type",
} as const;

/**
 * A stored attribute value as the program compares it: trimmed and upper-cased, nothing more.
 *
 * Deliberately NOT fuzzy. "SK 43" and "SK43" are different text, and deciding they are the same
 * article is a decision for the Raw Material Master, not a guess for the program to make.
 */
export const attributeKey = (value: string | null | undefined): string => String(value ?? "").trim().toUpperCase();

export const sameAttributeValue = (a: string | null | undefined, b: string | null | undefined): boolean =>
  attributeKey(a) !== "" && attributeKey(a) === attributeKey(b);

// ─── The reservation arithmetic ──────────────────────────────────────────────

/** What a line still owes: allocated minus what Raw Material Output actually took for it. */
export const programOutstanding = (quantity: number, consumedQuantity: number): number =>
  Math.max(0, roundQuantity(quantity - consumedQuantity));

/** Available = Physical − Reserved. Negative means the store is over-committed. */
export const programAvailable = (physical: number, reserved: number): number => roundQuantity(physical - reserved);

/** The most a new allocation may take: Available, never below zero. */
export const maxNewAllocation = (physical: number, reserved: number): number =>
  Math.max(0, programAvailable(physical, reserved));

export type ProgramQuantityProblem =
  /** Not a number, zero, negative, or more than two decimals. */
  | "INVALID_QUANTITY"
  /** Lower than what has already been scanned out for the line. */
  | "BELOW_CONSUMED"
  /** More than is free for a new allocation right now. */
  | "NOT_ENOUGH_STOCK";

/**
 * Whether a quantity may be put on a line.
 *
 * `available` is what is free for this line NOW — the line's own outstanding reservation
 * already added back, so editing 30 → 35 is measured against the store plus its own 30.
 * `consumed` is what has already left the store for the line: a line can never be lowered
 * below it, because those uppers are physically on the machine.
 */
export const checkProgramQuantity = (
  quantity: number,
  limits: { available: number; consumed?: number }
): ProgramQuantityProblem | null => {
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0) return "INVALID_QUANTITY";
  if (Math.abs(roundQuantity(quantity) - quantity) > QUANTITY_EPSILON) return "INVALID_QUANTITY";
  const consumed = limits.consumed ?? 0;
  if (quantity < consumed - QUANTITY_EPSILON) return "BELOW_CONSUMED";
  if (quantity - consumed > limits.available + QUANTITY_EPSILON) return "NOT_ENOUGH_STOCK";
  return null;
};

// ─── Packets in the store (shared with the Raw Material Stock tab) ───────────

/**
 * How many whole packs a balance is worth.
 *
 * The balance is the authority and is held in the unit the material is COUNTED in, so the
 * divisor must already be the pack expressed in that same unit (`packSizeInStockUnit` in the
 * data layer). A part-pack is not a bag anybody can pick up, so it is floored.
 */
export const bagsFromBalance = (quantityOnHand: number, packSizeInStockUnit: number | null): number => {
  if (packSizeInStockUnit == null || packSizeInStockUnit <= 0) return 0;
  // A hair of tolerance so 75 / 25 computed as 2.9999999 is still 3 bags.
  return Math.floor(quantityOnHand / packSizeInStockUnit + 1e-9);
};

/**
 * How many packets a material has in the store.
 *
 * Labelled packets are COUNTED: each label carries what its own packet holds (5 DOZEN on one,
 * 3 DOZEN on the next), so 8 DOZEN in two labelled packets is 2 packets, never 8 ÷ anything.
 * Stock with no label behind it (opening stock, an approved correction) is only expressed as
 * packets when the material still has a fixed pack size from before labels carried their own
 * contents — otherwise it stays a measured quantity and is not a packet anybody can pick up.
 */
export const packetsInStore = (input: {
  labelledPackets: number;
  /** What the labelled packets hold between them, in the unit stock is counted in. */
  labelledContents: number;
  quantityOnHand: number;
  /** The material's old fixed pack, in the stock unit. Null when it has none. */
  fixedPackSize: number | null;
}): number =>
  input.labelledPackets + bagsFromBalance(Math.max(0, input.quantityOnHand - input.labelledContents), input.fixedPackSize);

// ─── The shift a machine is programmed for ───────────────────────────────────
//
//   06:00 AM - 06:00 PM   the day shift
//   06:00 PM - 06:00 AM   the night shift, which runs past midnight into the next morning
//
// Held as minutes from midnight of the program's own date, exactly as the first shape of this
// feature held its time slots (migration 044). An end past 1440 is a shift that finishes the
// next morning, so "does this run into tomorrow" is an integer comparison and no screen ever
// does timezone arithmetic of its own (R16).
//
// A program belongs to one machine on one date and runs one shift. The shift is a fact about
// the program, not about a line, so changing it never touches a reservation.

export const MINUTES_IN_DAY = 1440;

/** A shift is never longer than one full turn of the clock from its own start. */
export const MAX_SHIFT_END_MINUTE = MINUTES_IN_DAY * 2;

export interface MachineShift {
  /** Minutes from midnight of the program date, 0 to 1439. */
  startMinute: number;
  /** Minutes from the same midnight. Above 1440 when the shift ends the next morning. */
  endMinute: number;
}

/** The two shifts the floor actually works. Anything else is typed as its own start and end. */
export const MACHINE_SHIFTS: readonly MachineShift[] = [
  { startMinute: 6 * 60, endMinute: 18 * 60 },
  { startMinute: 18 * 60, endMinute: 30 * 60 },
] as const;

/** What a program is given when nobody says otherwise: the day shift. */
export const DEFAULT_MACHINE_SHIFT: MachineShift = MACHINE_SHIFTS[0];

export const sameMachineShift = (a: MachineShift, b: MachineShift): boolean =>
  a.startMinute === b.startMinute && a.endMinute === b.endMinute;

/** Whether a shift may be saved: whole minutes, starting inside the day, ending after it starts. */
export const checkMachineShift = (shift: MachineShift): boolean => {
  const { startMinute, endMinute } = shift;
  if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute)) return false;
  if (startMinute < 0 || startMinute >= MINUTES_IN_DAY) return false;
  return endMinute > startMinute && endMinute <= MAX_SHIFT_END_MINUTE;
};

/** "06:00 AM", "12:30 PM" — one minute of the clock, however many days along it is. */
export const formatMinuteOfDay = (minute: number): string => {
  const inDay = ((Math.round(minute) % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  const hour24 = Math.floor(inDay / 60);
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${String(hour12).padStart(2, "0")}:${String(inDay % 60).padStart(2, "0")} ${hour24 < 12 ? "AM" : "PM"}`;
};

/** "06:00 AM - 06:00 PM" — the whole shift, the way the program sheet prints it. */
export const formatShiftRange = (shift: MachineShift): string =>
  `${formatMinuteOfDay(shift.startMinute)} – ${formatMinuteOfDay(shift.endMinute)}`;

/** True when the shift finishes on the morning after the program's date. */
export const shiftEndsNextDay = (shift: MachineShift): boolean => shift.endMinute > MINUTES_IN_DAY;
