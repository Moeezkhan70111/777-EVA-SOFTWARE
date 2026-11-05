// REMOVING A MATERIAL WITHOUT LOSING WHAT HAPPENED TO IT.
//
// A material may be removed only when it holds no stock. Its movements stay: they are facts, and
// they replicate as append-only events, so a computer that deleted them would disagree for ever
// with every computer that kept them. Removal marks the material instead (removed_at), and the
// mark travels as an ordinary revision.
//
// Stock is what decides, here and on every receiving computer. Rows that merely refer to the
// material never do: a material that held stock and was emptied has a ledger, and always will.
//
// The sending computer and the receiving one share these two functions, so "no stock" and
// "removed" mean the same thing on both.

import { QUANTITY_EPSILON } from "@erp/domain";
import type { CaptureHandle } from "./masterCapture.js";

/** What a material holds on this computer, in its own unit. */
export interface HeldStock {
  readonly quantity: number;
  readonly unitCode: string | null;
}

/** A removed material's signature: it frees the original, so the same material can be made again. */
const removedSignature = (itemId: string): string => `removed:${itemId}`;

/** The stock this material holds here, or null when it holds none. Below the rounding floor is none. */
export function heldStock(sql: Pick<CaptureHandle, "prepare">, itemId: string): HeldStock | null {
  const row = sql
    .prepare(
      `SELECT b.quantity_on_hand AS quantity, u.code AS unit_code FROM inventory_stock_balances b
       LEFT JOIN inventory_units u ON u.id = b.unit_id WHERE b.item_id = ?`
    )
    .get(itemId) as { quantity: number; unit_code: string | null } | undefined;
  if (row === undefined || Math.abs(Number(row.quantity)) <= QUANTITY_EPSILON) return null;
  return { quantity: Number(row.quantity), unitCode: row.unit_code };
}

/**
 * Marks a material removed. Disabled as well, so it leaves every picker, and so a computer on an
 * older version, which does not know the mark, still shows it as disabled.
 */
export function markItemRemoved(sql: Pick<CaptureHandle, "prepare">, itemId: string, removedAt: string, removedBy: string | null): void {
  sql
    .prepare(
      `UPDATE inventory_items SET status = 'INACTIVE', removed_at = ?, signature_hash = ?, updated_by = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(removedAt, removedSignature(itemId), removedBy, removedAt, itemId);
}
