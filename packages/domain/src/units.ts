// Packing units — the single source of truth for how 777 counts footwear.
//
//   1 dozen  = 12 pairs
//   1 dozen  = 2 cartons   (one carton = 6 pairs; one scanned QR = one carton)
//
// Every screen and every query that converts between dozens, pairs and cartons must
// go through these helpers. Do not write `* 12` or `/ 2` for these conversions anywhere else.

export const PAIRS_PER_DOZEN = 12;
export const CARTONS_PER_DOZEN = 2;
export const PAIRS_PER_CARTON = PAIRS_PER_DOZEN / CARTONS_PER_DOZEN;

export const dozensToPairs = (dozens: number): number => dozens * PAIRS_PER_DOZEN;
export const pairsToDozens = (pairs: number): number => pairs / PAIRS_PER_DOZEN;
export const dozensToCartons = (dozens: number): number => dozens * CARTONS_PER_DOZEN;
export const cartonsToDozens = (cartons: number): number => cartons / CARTONS_PER_DOZEN;
export const cartonsToPairs = (cartons: number): number => cartons * PAIRS_PER_CARTON;

/**
 * Cartons written the way the floor says them: dozens, to at most one decimal, with the unit.
 *
 * Stock, gatepass lines and scans are all counted in cartons, but nobody on the floor talks in
 * cartons — they say "ten dozen". Every screen that shows a gatepass quantity goes through
 * here so the conversion lives in one place and a half-dozen never silently becomes a whole.
 */
export const formatQuantityInDozens = (cartons: number): string => {
  const dozens = cartonsToDozens(cartons);
  const text = Number.isInteger(dozens) ? String(dozens) : dozens.toFixed(1);
  return text + " DZN";
};
export const pairsToCartons = (pairs: number): number => pairs / PAIRS_PER_CARTON;

/**
 * Conversion table (source of truth for every screen, query and report):
 *
 *   quantity on a sale voucher line   dozens
 *   one scanned QR                    1 carton  = 6 pairs
 *   1 dozen                           2 cartons = 12 pairs
 *   stock projections                 cartons (one per QR)
 *   dispatch allowance                cartons (dozens × 2 scans per line)
 */
export const UNIT_MODEL = Object.freeze({
  voucherLineUnit: "DOZEN",
  scanUnit: "CARTON",
  stockUnit: "CARTON",
} as const);

// ─── Operational day ─────────────────────────────────────────────────────────
// The business day runs 06:00 → 06:00 the next morning, not midnight to midnight.
// Daily production/dispatch reports and scan grouping use this boundary.

export const OPERATIONAL_DAY_START_HOUR = 6;

/** `HH:00:00.000` suffix for building local-time boundaries, e.g. `T06:00:00.000`. */
export const OPERATIONAL_DAY_START_TIME = `${String(OPERATIONAL_DAY_START_HOUR).padStart(2, "0")}:00:00.000`;

/**
 * Local-time boundaries of the operational day that contains the given calendar date
 * (`YYYY-MM-DD`). The upper bound is exclusive. Strings stay in the "local timestamp
 * without zone" space that `production_events.event_ts_local` uses, so callers can
 * compare them directly without any UTC conversion.
 */
export function operationalDayBounds(dateYmd: string): { from: string; to: string } {
  const day = dateYmd.slice(0, 10);
  const next = new Date(`${day}T00:00:00`);
  next.setDate(next.getDate() + 1);
  const nextYmd = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
  return {
    from: `${day}T${OPERATIONAL_DAY_START_TIME}`,
    to: `${nextYmd}T${OPERATIONAL_DAY_START_TIME}`,
  };
}
