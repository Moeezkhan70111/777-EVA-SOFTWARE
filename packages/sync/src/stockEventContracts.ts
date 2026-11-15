// A raw-material stock movement arriving from the store PC (cloud migration 015, docs/37 the
// stock-screen slice).
//
// The event is stored as its origin stored it, and the balance moves by the event's balanceDelta in
// the same transaction -- the change the origin made, read there by the one rule that understands
// both sign conventions. Nothing here re-derives a sign. An event already here moves nothing: the
// balance changes only when the event row is new, so at-least-once delivery cannot count a movement
// twice.
//
// Every prerequisite is a WAIT: the material, its unit and the party travel as master data, and a
// movement that arrives first waits for them. Two more cases wait rather than write wrong numbers:
//
//   * a balance kept here in a different unit than the event's. The store PC never records an
//     event in another unit than its balance, so this means a unit correction (docs/37 W.5, not
//     replicated yet) -- adding the quantity anyway would mix units in one number. Where this
//     balance is certainly a mirror of the store's, the correction is repeated here instead
//     (followUnitCorrection); otherwise it waits.
//   * nothing else. A Dana issue's machine program is NOT waited for: programs do not replicate yet
//     (W.6), so the event is stored without the link and the program's id is kept aside
//     (pending_machine_program_id, migration 097) until they do.
//
// Applied with capture suppressed: a movement received is not this computer's own to send.

import { readStockEventPayload, SYNC_AGGREGATE, withCaptureSuppressed, type CaptureHandle, type StockEventPayload } from "@erp/data";
import { ApplyMustWait, defineContract, rowExists } from "./applyContract.js";
import { asRow, changedRows, type SyncSqlHandle } from "./sqlPort.js";

export const stockEventContract = defineContract({
  aggregateType: SYNC_AGGREGATE.STOCK_EVENT,
  table: "inventory_stock_events",
  read: readStockEventPayload,
  idOf: (event) => event.eventId,
  missing: (sql, event) => {
    if (!rowExists(sql, "SELECT id FROM inventory_items WHERE id = ? LIMIT 1", event.itemId)) {
      return `UNKNOWN_INVENTORY_ITEM:${event.itemId}`;
    }
    if (!rowExists(sql, "SELECT id FROM inventory_units WHERE id = ? LIMIT 1", event.unitId)) {
      return `UNKNOWN_INVENTORY_UNIT:${event.unitId}`;
    }
    if (event.partyId !== null && !rowExists(sql, "SELECT id FROM parties WHERE id = ? LIMIT 1", event.partyId)) {
      return `UNKNOWN_PARTY:${event.partyId}`;
    }
    return null;
  },
  write: (sql, event, replicatedAt) => withCaptureSuppressed(sql as CaptureHandle, () => writeStockEvent(sql, event, replicatedAt)),
  conflict: eventConflict,
});

/**
 * The store's "Correct unit" (correctInventoryItemUnit) re-states a material in another unit WITHOUT
 * converting a figure -- 5 CAN becomes 5 PIECES -- and re-stamps its balance and movements. Only the
 * material's new unit replicates; the re-stamp does not (W.5). A reader then holds the old unit
 * while the store's next movement arrives in the new one, and would wait for ever (PAPER TAP,
 * RM-001247: corrected CAN -> PIECES on 6 Nov 2026, its 13 Nov move out parked on PC1 and PC3).
 *
 * This repeats that re-stamp here, but only where it is certainly the same correction:
 *   * the material here already carries the movement's unit -- its corrected record has arrived;
 *   * every other movement here for it came from the store (replicated_at) in the balance's unit,
 *     so this balance is purely a mirror of the store's, never a figure counted here.
 * The store never converts a balance when its unit changes, so re-stamping changes no quantity.
 * Anything else still waits: a balance this computer counted itself must not be re-labelled.
 */
function followUnitCorrection(sql: SyncSqlHandle, event: StockEventPayload, balanceUnitId: string, replicatedAt: string): boolean {
  const item = asRow(sql.prepare("SELECT default_unit_id FROM inventory_items WHERE id = ?").get(event.itemId));
  if (item === null || item.default_unit_id !== event.unitId) return false;
  const others = asRow(
    sql
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN replicated_at IS NOT NULL AND unit_id = ? THEN 1 ELSE 0 END) AS mirrored
         FROM inventory_stock_events WHERE item_id = ? AND id <> ?`
      )
      .get(balanceUnitId, event.itemId, event.eventId)
  );
  const total = Number(others?.total ?? 0);
  if (total === 0 || Number(others?.mirrored ?? 0) !== total) return false;

  sql.prepare("UPDATE inventory_stock_balances SET unit_id = ?, updated_at = ? WHERE item_id = ?").run(event.unitId, replicatedAt, event.itemId);
  sql.prepare("UPDATE inventory_stock_events SET unit_id = ? WHERE item_id = ?").run(event.unitId, event.itemId);
  return true;
}

function writeStockEvent(sql: SyncSqlHandle, event: StockEventPayload, replicatedAt: string): boolean {
  const programHere =
    event.machineProgramId !== null && rowExists(sql, "SELECT id FROM machine_programs WHERE id = ? LIMIT 1", event.machineProgramId);
  const inserted =
    changedRows(
      sql
        .prepare(
          `INSERT INTO inventory_stock_events (
             id, item_id, event_type, quantity, unit_id, note, created_by, created_at,
             party_id, machine_program_id, pending_machine_program_id, replicated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`
        )
        .run(
          event.eventId,
          event.itemId,
          event.eventType,
          event.quantity,
          event.unitId,
          event.note,
          event.createdBy,
          event.createdAt,
          event.partyId,
          programHere ? event.machineProgramId : null,
          programHere ? null : event.machineProgramId,
          replicatedAt
        )
    ) > 0;
  if (!inserted) return false;

  const balance = asRow(sql.prepare("SELECT unit_id FROM inventory_stock_balances WHERE item_id = ?").get(event.itemId));
  if (balance !== null && balance.unit_id !== event.unitId && !followUnitCorrection(sql, event, String(balance.unit_id), replicatedAt)) {
    throw new ApplyMustWait(`STOCK_UNIT_DIFFERS:${event.itemId}`);
  }
  sql
    .prepare(
      `INSERT INTO inventory_stock_balances (item_id, quantity_on_hand, unit_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET quantity_on_hand = quantity_on_hand + excluded.quantity_on_hand, updated_at = excluded.updated_at`
    )
    .run(event.itemId, event.balanceDelta, event.unitId, replicatedAt);
  return true;
}

/**
 * An event already here under this id must be the same movement: same material, type, quantity and
 * time. The unit is left out on purpose -- the store PC pulls its own events back, and a unit
 * correction there (W.5) rewrites its events' unit, which must not make its own events conflict.
 */
function eventConflict(sql: SyncSqlHandle, event: StockEventPayload): string | null {
  const here = asRow(
    sql.prepare("SELECT item_id, event_type, quantity, created_at FROM inventory_stock_events WHERE id = ?").get(event.eventId)
  );
  const same =
    here !== null &&
    here.item_id === event.itemId &&
    here.event_type === event.eventType &&
    Number(here.quantity) === event.quantity &&
    here.created_at === event.createdAt;
  return same ? null : `STOCK_EVENT_IDENTITY_CONFLICT:${event.eventId}`;
}
