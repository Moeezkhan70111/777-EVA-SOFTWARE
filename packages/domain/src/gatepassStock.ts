// Gatepass stock — the single source of truth for the stock figures a Gatepass shows.
//
//   Current Stock    physical cartons inside the store right now (stock_projection_by_location
//                    at WAREHOUSE): QR cartons and Manual Production cartons together.
//   Reserved         cartons still owed to live Gatepasses by the QR scanners:
//                      Σ over live gatepass lines of (requested − dispatched by scan − issued directly)
//   Reflected Stock  what is still free for a NEW Gatepass:
//                      Current Stock − Reserved
//
// A LINE IS SPLIT WHEN THE GATEPASS IS MADE (docs/42 section 3.5, revised 2026-11-03):
//   * what QR cartons in the store can cover (and no other live Gatepass has claimed) is RESERVED,
//     and a Store Move Out scan consumes it, carton by carton, exactly as before: the scan moves one
//     carton out of Current Stock AND consumes one reserved carton, so Reflected Stock is unchanged
//   * the shortfall -- cartons with no QR, made by Manual Production -- is ISSUED DIRECTLY: taken out
//     of Current Stock at once by a GATEPASS_ISSUE carton movement, and never reserved
// So a line owes the QR scanners only what is neither scanned nor issued, and no carton leaves
// Current Stock twice. Cancelling releases the reservation and puts back exactly what was issued;
// cartons already scanned out stay moved out.
//
// Every screen and every query that shows or checks these figures goes through here (the SQL in
// @erp/data gatepassLineSql.ts is the same rule, per line).

/** Cartons a Gatepass line still owes the QR scanners: requested minus scanned out minus issued directly. */
export const outstandingQuantity = (requested: number, dispatchedFromStore: number, issuedDirectly: number): number =>
  requested - dispatchedFromStore - issuedDirectly;

/** Reflected Stock = Current Stock − Reserved. Negative means the store is over-committed. */
export const reflectedStock = (currentStock: number, reserved: number): number => currentStock - reserved;

/** The most a new Gatepass may ask for: Reflected Stock, never below zero. */
export const maxNewGatepassQuantity = (currentStock: number, reserved: number): number => Math.max(0, reflectedStock(currentStock, reserved));

/**
 * How a new line is split. `qrAvailable` is the QR cartons in the store that no other live Gatepass
 * has claimed: those are reserved for scanning, and only the shortfall is issued at once.
 */
export const splitGatepassLine = (lineQuantity: number, qrAvailable: number): { issueNow: number; reserved: number } => {
  const issueNow = Math.max(0, lineQuantity - Math.max(0, qrAvailable));
  return { issueNow, reserved: lineQuantity - issueNow };
};
