import { CARTONS_PER_DOZEN, dozensToCartons } from "./units.js";

// MANUAL PRODUCTION — cartons recorded by typing them in, with no carton QR (owner, 2026-10-14):
//
//   MACHINE 1 · SK6 · 7/10 · RED · 10 DOZEN  ->  20 cartons
//     ->  the machine's program for today (MP-…), as the QR Generator's runs join it
//     ->  store stock (Current Stock), +20 cartons
//     ->  the machine and packing contractors' ledgers, at the program's or the product's rate
//
// The quantity is typed in DOZEN and kept in CARTONS, the unit stock counts in — one dozen is two
// cartons (units.ts), so a half dozen is one carton and anything finer is not a whole carton and is
// refused. Stock is never rounded into existence.
//
// These cartons carry no QR, so no scan can ever find them: dispatch and gatepass, which take stock
// out by scanning a carton, cannot take these out.

/** The most one entry may record — a typing slip of an extra zero is refused, not stocked. */
export const MANUAL_PRODUCTION_MAX_DOZENS = 5000;

/** Who recorded a carton, as production history names its station. */
export const MANUAL_PRODUCTION_STATION = "MANUAL_PRODUCTION";

/** "MAN-000042" — an entry's number as screens show it. */
export const formatManualProductionCode = (entryNumber: number): string => `MAN-${String(entryNumber).padStart(6, "0")}`;

export type ManualProductionQuantity = { ok: true; dozens: number; cartons: number } | { ok: false; reason: string };

/**
 * The dozens typed, checked and turned into whole cartons. The one rule both the screen (to show the
 * cartons before saving) and the database (before writing stock) use.
 */
export const manualProductionCartons = (input: unknown): ManualProductionQuantity => {
  const raw = typeof input === "number" ? String(input) : String(input ?? "").trim();
  if (raw === "") return { ok: false, reason: "Enter how many dozens were produced." };
  const dozens = Number(raw);
  if (!Number.isFinite(dozens)) return { ok: false, reason: "Enter the dozens as a number, such as 10 or 7.5." };
  if (dozens <= 0) return { ok: false, reason: "Enter more than 0 dozens." };
  if (dozens > MANUAL_PRODUCTION_MAX_DOZENS) {
    return { ok: false, reason: `One entry can record at most ${MANUAL_PRODUCTION_MAX_DOZENS} dozens. Split a larger quantity into more entries.` };
  }
  const cartons = dozensToCartons(dozens);
  if (!Number.isInteger(cartons)) {
    return { ok: false, reason: `Enter whole or half dozens (1 dozen = ${CARTONS_PER_DOZEN} cartons), such as 10 or 10.5.` };
  }
  return { ok: true, dozens, cartons };
};
