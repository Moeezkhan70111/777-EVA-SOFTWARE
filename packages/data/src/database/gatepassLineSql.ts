// What one gatepass line has had, read from the append-only records every time -- never cached, so
// Reserved, Reflected Stock, scan progress and the cancel all read the same figures. `gl` must be the
// gatepass_lines alias in the enclosing query. The same rule as @erp/domain gatepassStock.ts.
//
//   LINE_DISPATCHED_SQL  cartons Store Move Out has scanned out for the line
//   LINE_ISSUED_SQL      cartons taken out of stock directly when the gatepass was made, net of a cancel
//   LINE_SETTLED_SQL     the two together: what the line no longer owes the QR scanners

import { CARTON_STOCK_EVENT_TYPE } from "@erp/domain";

// ─── The one derivation of "dispatched from store" ───────────────────────────
// Per gatepass line, the cartons Store Move Out has actually taken for it: every STORE_EXIT
// event that names this gatepass and this variant, minus every STORE_ENTRY that brought one
// of those cartons back from the gate (the compensating record). Both are MOVED events;
// the business sub-kind lives in metadata_json exactly as the store sessions read it. The
// gatepass id on the event is the only ownership rule; it is stamped by the scan itself from
// findOldestOutstandingGatepassLine (oldest open line for the scanned variant) — never from
// article + size + time afterwards.
export const LINE_DISPATCHED_SQL = `(SELECT COALESCE(SUM(CASE json_extract(pe.metadata_json, '$.eventType')
                                                    WHEN 'STORE_EXIT' THEN 1
                                                    WHEN 'STORE_ENTRY' THEN -1
                                                    ELSE 0 END), 0)
                              FROM production_events pe
                              WHERE pe.gatepass_id = gl.gatepass_id
                                AND pe.product_variant_id = gl.product_variant_id
                                AND pe.event_type = 'MOVED')`;

// ─── Issued directly (docs/42 section 3.5) ───────────────────────────────────
// The cartons a line took out of Current Stock when its gatepass was made -- the part QR cartons in
// the store could not cover -- from the carton movements that name the line: each GATEPASS_ISSUE
// adds, each GATEPASS_CANCEL takes back. The net, never the size of the events, and never a column
// that could be edited.
export const LINE_ISSUED_SQL = `(SELECT COALESCE(SUM(CASE ce.event_type
                                               WHEN '${CARTON_STOCK_EVENT_TYPE.GATEPASS_ISSUE}' THEN ce.quantity
                                               WHEN '${CARTON_STOCK_EVENT_TYPE.GATEPASS_CANCEL}' THEN -ce.quantity
                                               ELSE 0 END), 0)
                          FROM carton_stock_events ce
                          WHERE ce.gatepass_line_id = gl.id)`;

/** What the line no longer owes the QR scanners: scanned out, or issued directly. */
export const LINE_SETTLED_SQL = `(${LINE_DISPATCHED_SQL} + ${LINE_ISSUED_SQL})`;
