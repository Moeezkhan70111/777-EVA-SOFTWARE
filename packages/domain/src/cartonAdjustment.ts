// STOCK ADJUSTMENT DOCUMENTS (docs/46): Opening Stock and Stock Adjustment, in cartons.
//
//   OPENING      SA-000001 · SK6 RED · 7/10 +20, 10/13 +35   the first figure a product is given, once
//   ADJUSTMENT   SA-000002 · SK6 RED · 7/10 -2 (count short)  a correction, in or out, with a reason
//
// Each line is one CARTON_ADJUST_IN or CARTON_ADJUST_OUT movement (cartonStock.ts): the figure moves exactly as it
// does for every other carton movement, and never below zero. A posted document is never changed; a mistake is put
// right by another document. Manual Production is a different thing and is not used here.
//
// These rules are the screen's and the database's: the screen shows the problem before posting, and the database
// refuses the same document.

/** The two kinds of document. */
export const CARTON_ADJUSTMENT_KIND = { OPENING: "OPENING", ADJUSTMENT: "ADJUSTMENT" } as const;
export type CartonAdjustmentKind = (typeof CARTON_ADJUSTMENT_KIND)[keyof typeof CARTON_ADJUSTMENT_KIND];

/** Which way a line moves the figure. Opening stock only ever adds. */
export const CARTON_ADJUSTMENT_DIRECTION = { IN: "IN", OUT: "OUT" } as const;
export type CartonAdjustmentDirection = (typeof CARTON_ADJUSTMENT_DIRECTION)[keyof typeof CARTON_ADJUSTMENT_DIRECTION];

/** The most one line may move: a typing slip of an extra zero is refused, not stocked. */
export const CARTON_ADJUSTMENT_MAX_CARTONS = 100_000;
/** The most lines one document may hold. */
export const CARTON_ADJUSTMENT_MAX_LINES = 300;

/** "SA-000042" — a document's number as screens show it. */
export const formatCartonAdjustmentCode = (documentNumber: number): string => `SA-${String(documentNumber).padStart(6, "0")}`;

export const isCartonAdjustmentKind = (value: unknown): value is CartonAdjustmentKind =>
  value === CARTON_ADJUSTMENT_KIND.OPENING || value === CARTON_ADJUSTMENT_KIND.ADJUSTMENT;

export const isCartonAdjustmentDirection = (value: unknown): value is CartonAdjustmentDirection =>
  value === CARTON_ADJUSTMENT_DIRECTION.IN || value === CARTON_ADJUSTMENT_DIRECTION.OUT;

/** Why a line's quantity cannot be posted, or null when it can. Cartons are whole and above zero. */
export function cartonAdjustmentQuantityProblem(cartons: number): string | null {
  if (!Number.isInteger(cartons) || cartons <= 0) return "Enter whole cartons, above zero.";
  if (cartons > CARTON_ADJUSTMENT_MAX_CARTONS) return `One line may move at most ${CARTON_ADJUSTMENT_MAX_CARTONS.toLocaleString("en-US")} cartons.`;
  return null;
}

/** The figure after a line: what the preview shows. */
export const cartonAdjustmentResult = (current: number, direction: CartonAdjustmentDirection, cartons: number): number =>
  direction === CARTON_ADJUSTMENT_DIRECTION.OUT ? current - cartons : current + cartons;

/** "YYYY-MM-DD", a real calendar date. */
export function isBusinessDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
