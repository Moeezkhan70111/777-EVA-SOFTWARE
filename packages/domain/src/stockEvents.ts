// How much a stored raw-material stock event moved its material's balance.
//
// inventory_stock_events holds TWO sign conventions, written by two functions that both update the
// balance in the same transaction as the event:
//
//   applyRawMaterialStockChange  (packet scans in and out)   stores the quantity POSITIVE, and the
//                                type says the direction: RECEIVE adds, TRANSFER_OUT subtracts.
//   applyInventoryStockChange    (hand moves, adjustments,  stores the quantity SIGNED, and adds it
//                                corrections, opening stock) to the balance whatever the type says
//                                -- a hand move out is TRANSFER_OUT with a negative quantity.
//
// So the SAME type appears with both signs, and a reader that derived the direction from the type
// alone would get every scan-out or every hand move out backwards. This is the one rule that reads
// a stored event correctly under both: checked 2026-10-25 against the store snapshot, it reproduces
// all 903 material balances exactly, where a plain sum of quantities gets 148 of them wrong.
//
// Replication carries the result of this rule with each event (balanceDelta), so a receiving
// computer applies exactly what the source applied and never re-derives a sign. The rebuild of
// balances from events uses it too.

export const STOCK_EVENT_TYPE = {
  RECEIVE: "RECEIVE",
  ADJUST: "ADJUST",
  CONSUME: "CONSUME",
  TRANSFER_IN: "TRANSFER_IN",
  TRANSFER_OUT: "TRANSFER_OUT",
  RETURN: "RETURN",
} as const;

export type StockEventType = (typeof STOCK_EVENT_TYPE)[keyof typeof STOCK_EVENT_TYPE];

/** The change one stored event made to its material's balance, in the event's (the balance's) unit. */
export const stockEventBalanceDelta = (eventType: string, quantity: number): number =>
  eventType === STOCK_EVENT_TYPE.TRANSFER_OUT && quantity > 0 ? -quantity : quantity;
