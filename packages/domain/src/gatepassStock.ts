// Gatepass stock — the single source of truth for the two stock figures a Gatepass shows.
//
//   Current Stock    physical cartons inside the store right now (stock_projection_by_location
//                    at WAREHOUSE). Changes only when a carton is actually scanned in or out.
//   Reserved         cartons still owed to outstanding Gatepasses:
//                      Σ over CREATED gatepass lines of (requested − dispatched from store)
//   Reflected Stock  what is still free for a NEW Gatepass:
//                      Current Stock − Reserved
//
// Creating a Gatepass reserves; it never moves stock. A Store Move Out scan made for a
// Gatepass moves one carton out of Current Stock AND consumes one of that Gatepass's
// outstanding cartons, so Reflected Stock is unchanged by it. Cancelling a Gatepass releases
// only what was still outstanding — cartons already moved out stay moved out.
//
// Every screen and every query that shows or checks these figures goes through here.

/** Cartons a Gatepass line still owes: requested minus what Store Move Out actually took. */
export const outstandingQuantity = (requested: number, dispatchedFromStore: number): number => requested - dispatchedFromStore;

/** Reflected Stock = Current Stock − Reserved. Negative means the store is over-committed. */
export const reflectedStock = (currentStock: number, reserved: number): number => currentStock - reserved;

/** The most a new Gatepass may ask for: Reflected Stock, never below zero. */
export const maxNewGatepassQuantity = (currentStock: number, reserved: number): number => Math.max(0, reflectedStock(currentStock, reserved));
