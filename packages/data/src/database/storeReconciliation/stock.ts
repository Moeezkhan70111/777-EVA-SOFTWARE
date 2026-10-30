// ONE-TIME STORE RECONCILIATION — materials, label runs, serial counters and balances.
//
// The serial counters carry the promise that no label is ever printed twice. Three kinds of change:
//   RAISE — a material the target already has, where the source printed on from the target's counter.
//           Only safe if the target's counter still stands exactly where the source's first run began.
//   NEW   — a material only the source has: its counter comes across with it.
//   GUARD — a counter raised for a DIFFERENT material whose code the old labels still spell. A
//           renumbered material's packets keep their printed IDs (RM_6_965_3 now belongs to RM-000995),
//           and the target's own RM-000965 must never print RM_6_965_3 again.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { compactRawMaterialQrToken, normalizeRawMaterialQrCode, parseRawMaterialQrId, stockEventBalanceDelta } from "@erp/domain";
import { TABLE, all, nextFreeNumber, num, one, sourceOnly, text, textOrNull, type Row } from "./shared.js";

export interface RenumberedMaterial {
  readonly source: Row;
  readonly newCode: string;
}

export interface MaterialPlan {
  readonly materials: readonly RenumberedMaterial[];
  readonly values: readonly Row[];
  readonly audits: readonly Row[];
}

export interface CounterChange {
  readonly kind: "RAISE" | "NEW" | "GUARD";
  readonly counterId: string;
  readonly partyId: string;
  readonly itemId: string;
  /** The target's counter before, or null when it has none. */
  readonly from: number | null;
  readonly to: number;
  readonly updatedAt: string;
  /** The source's counter row, written as it is, for a NEW counter. */
  readonly source: Row | null;
}

export interface BalanceChange {
  readonly itemId: string;
  readonly unitId: string;
  readonly from: number | null;
  readonly to: number;
  /** The source's balance for a material only it had: the computed figure must agree with it. */
  readonly source: Row | null;
}

const exists = (db: DatabaseSync, table: string, id: string): boolean => one(db, `SELECT 1 AS x FROM ${table} WHERE id = ?`, id) !== undefined;
const pairKey = (partyId: string, itemId: string): string => `${partyId}|${itemId}`;

/** The source's new materials, renumbered past the target's codes in the source's code order. */
export function planMaterials(source: DatabaseSync, target: DatabaseSync, refusals: string[]): MaterialPlan {
  const rows = sourceOnly(source, target, TABLE.ITEMS).sort((a, b) => text(a, "item_code").localeCompare(text(b, "item_code")));
  const first = rows.length > 0 ? nextFreeNumber(target, "inventoryItemCode") : 0;
  const materials = rows.map((row, i) => ({ source: row, newCode: `RM-${String(first + i).padStart(6, "0")}` }));
  for (const { source: row } of materials) {
    const code = text(row, "item_code");
    if (!code.startsWith("RM-")) refusals.push(`Material ${code} is not a raw material code.`);
    if (one(target, "SELECT item_code FROM inventory_items WHERE signature_hash = ?", text(row, "signature_hash"))) refusals.push(`Material ${code} already exists on the target under another code.`);
    if (!exists(target, "inventory_categories", text(row, "category_id"))) refusals.push(`Material ${code}'s category is not on the target.`);
    const unit = textOrNull(row, "default_unit_id");
    if (unit !== null && !exists(target, "inventory_units", unit)) refusals.push(`Material ${code}'s unit is not on the target.`);
  }
  const itemIds = new Set(rows.map((row) => text(row, "id")));
  const values = sourceOnly(source, target, TABLE.ITEM_VALUES);
  const audits = sourceOnly(source, target, TABLE.ITEM_AUDIT);
  for (const value of values) {
    if (!itemIds.has(text(value, "item_id"))) refusals.push(`Material value ${text(value, "id")} belongs to no brought material.`);
    if (!exists(target, "inventory_category_fields", text(value, "field_id"))) refusals.push(`Material value ${text(value, "id")}'s field is not on the target.`);
  }
  for (const audit of audits) if (!itemIds.has(textOrNull(audit, "item_id") ?? "")) refusals.push(`Material audit ${text(audit, "id")} belongs to no brought material.`);
  return { materials, values, audits };
}

/** The source's label runs and their packets. Every packet belongs to a brought run, and every run is whole. */
export function planRuns(source: DatabaseSync, target: DatabaseSync, broughtItems: ReadonlySet<string>, refusals: string[]): { runs: Row[]; packets: Row[] } {
  const runs = sourceOnly(source, target, TABLE.RUNS).sort((a, b) => text(a, "created_at").localeCompare(text(b, "created_at")));
  const packets = sourceOnly(source, target, TABLE.PACKETS).sort((a, b) => text(a, "batch_id").localeCompare(text(b, "batch_id")) || num(a, "sequence") - num(b, "sequence"));
  const byRun = new Map(runs.map((run) => [text(run, "id"), [] as Row[]]));
  for (const packet of packets) {
    const list = byRun.get(text(packet, "batch_id"));
    if (list) list.push(packet);
    else refusals.push(`Packet ${text(packet, "id")} belongs to no brought label run.`);
  }
  for (const run of runs) {
    const label = `Label run ${text(run, "id")}`;
    const itemId = text(run, "item_id");
    if (!exists(target, "parties", text(run, "party_id"))) refusals.push(`${label}'s supplier is not on the target.`);
    if (!broughtItems.has(itemId) && !exists(target, "inventory_items", itemId)) refusals.push(`${label}'s material is neither brought nor on the target.`);
    const own = byRun.get(text(run, "id")) ?? [];
    const serials = own.map((packet) => num(packet, "sequence")).join(",");
    const expected = Array.from({ length: num(run, "quantity") }, (_, i) => num(run, "start_sequence") + i).join(",");
    if (serials !== expected) refusals.push(`${label} does not hold exactly serials ${num(run, "start_sequence")}-${num(run, "end_sequence")}.`);
    if (own.some((packet) => packet.party_id !== run.party_id || packet.item_id !== itemId)) refusals.push(`${label} holds a packet of another supplier or material.`);
  }
  return { runs, packets };
}

function targetCounter(target: DatabaseSync, partyId: string, itemId: string): Row | undefined {
  return one(target, "SELECT * FROM raw_material_qr_sequences WHERE party_id = ? AND item_id = ?", partyId, itemId);
}

/** The counter each brought run leaves behind, refusing when the target has printed since. */
function runCounters(source: DatabaseSync, target: DatabaseSync, runs: readonly Row[], broughtItems: ReadonlySet<string>, refusals: string[]): Map<string, CounterChange> {
  const groups = new Map<string, Row[]>();
  for (const run of runs) {
    const key = pairKey(text(run, "party_id"), text(run, "item_id"));
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  const changes = new Map<string, CounterChange>();
  for (const [key, list] of groups) {
    const [partyId, itemId] = key.split("|");
    const ordered = [...list].sort((a, b) => num(a, "start_sequence") - num(b, "start_sequence"));
    const last = num(ordered[ordered.length - 1], "end_sequence");
    const theirs = one(source, "SELECT * FROM raw_material_qr_sequences WHERE party_id = ? AND item_id = ?", partyId, itemId);
    const ours = targetCounter(target, partyId, itemId);
    if (!theirs || num(theirs, "last_sequence") !== last) refusals.push(`The source's counter for ${key} does not stand at the end of its runs (${last}).`);
    let expected = (ours ? num(ours, "last_sequence") : 0) + 1;
    for (const run of ordered) {
      if (num(run, "start_sequence") !== expected) refusals.push(`The target's counter for ${key} has moved: the source's run starts at ${num(run, "start_sequence")}, the target would print ${expected} next. Labels may already be duplicated.`);
      expected = num(run, "end_sequence") + 1;
    }
    if (broughtItems.has(itemId) && ours) refusals.push(`The target already has a counter for a material only the source has (${key}).`);
    if (!theirs) continue;
    changes.set(key, {
      kind: ours ? "RAISE" : "NEW", partyId, itemId, from: ours ? num(ours, "last_sequence") : null, to: last,
      counterId: text(ours ?? theirs, "id"), updatedAt: text(theirs, "updated_at"), source: ours ? null : theirs,
    });
  }
  return changes;
}

export interface LabelTokenIndex {
  readonly parties: ReadonlyMap<string, readonly string[]>;
  readonly items: ReadonlyMap<string, readonly string[]>;
}

/**
 * Which suppliers and materials each label token names: the token is a code's numeric tail, as
 * buildRawMaterialQrId spells it. `extraItems` adds materials not written yet, by their new codes.
 */
export function labelTokenIndex(db: DatabaseSync, extraItems: ReadonlyArray<{ code: string; id: string }> = []): LabelTokenIndex {
  const add = (map: Map<string, string[]>, code: string, id: string): void => {
    const token = compactRawMaterialQrToken(normalizeRawMaterialQrCode(code));
    map.set(token, [...(map.get(token) ?? []), id]);
  };
  const parties = new Map<string, string[]>();
  const items = new Map<string, string[]>();
  for (const row of all(db, "SELECT id, party_code FROM parties WHERE party_code IS NOT NULL")) add(parties, text(row, "party_code"), text(row, "id"));
  for (const row of all(db, "SELECT id, item_code FROM inventory_items")) add(items, text(row, "item_code"), text(row, "id"));
  for (const item of extraItems) add(items, item.code, item.id);
  return { parties, items };
}

/**
 * Every (supplier, material) pair whose next labels would spell this packet's ID, with the serial the
 * pair's counter must have reached. Empty for a legacy RMQR_ identity, which is no longer generated.
 */
export function pairsSpelling(index: LabelTokenIndex, packetId: string): Array<{ partyId: string; itemId: string; serial: number }> {
  if (!packetId.startsWith("RM_")) return [];
  const parsed = parseRawMaterialQrId(packetId);
  const serial = Number(parsed.serial);
  return (index.parties.get(parsed.partyCode) ?? []).flatMap((partyId) =>
    (index.items.get(parsed.itemCode) ?? []).map((itemId) => ({ partyId, itemId, serial }))
  );
}

/** Raises any counter that could otherwise print a brought packet's ID again, for any material. */
function guardCounters(target: DatabaseSync, packets: readonly Row[], materials: readonly RenumberedMaterial[], planned: Map<string, CounterChange>, nowIso: string): void {
  const index = labelTokenIndex(target, materials.map((m) => ({ code: m.newCode, id: text(m.source, "id") })));
  for (const packet of packets) {
    for (const { partyId, itemId, serial } of pairsSpelling(index, text(packet, "id"))) {
      const key = pairKey(partyId, itemId);
      const ours = targetCounter(target, partyId, itemId);
      const standing = planned.get(key)?.to ?? (ours ? num(ours, "last_sequence") : 0);
      if (standing >= serial) continue;
      planned.set(key, {
        kind: "GUARD", partyId, itemId, from: ours ? num(ours, "last_sequence") : null, to: serial,
        counterId: ours ? text(ours, "id") : planned.get(key)?.counterId ?? randomUUID(), updatedAt: nowIso, source: null,
      });
    }
  }
}

/** Every counter change: run counters, then guards. Source-only counters must all be accounted for. */
export function planCounters(
  source: DatabaseSync,
  target: DatabaseSync,
  input: { runs: readonly Row[]; packets: readonly Row[]; materials: readonly RenumberedMaterial[]; nowIso: string },
  refusals: string[]
): CounterChange[] {
  const broughtItems = new Set(input.materials.map((material) => text(material.source, "id")));
  const changes = runCounters(source, target, input.runs, broughtItems, refusals);
  for (const counter of sourceOnly(source, target, TABLE.COUNTERS)) {
    const change = changes.get(pairKey(text(counter, "party_id"), text(counter, "item_id")));
    if (change?.kind !== "NEW") refusals.push(`The source's counter ${text(counter, "id")} belongs to no brought label run.`);
  }
  guardCounters(target, input.packets, input.materials, changes, input.nowIso);
  return [...changes.values()];
}

/** Each touched material's balance after its brought movements, in time order. Refuses a unit mismatch or a negative. */
export function planBalances(source: DatabaseSync, target: DatabaseSync, movements: readonly Row[], refusals: string[]): BalanceChange[] {
  const byItem = new Map<string, Row[]>();
  for (const movement of movements) byItem.set(text(movement, "item_id"), [...(byItem.get(text(movement, "item_id")) ?? []), movement]);
  const changes: BalanceChange[] = [];
  for (const [itemId, list] of byItem) {
    const ours = one(target, "SELECT * FROM inventory_stock_balances WHERE item_id = ?", itemId);
    const unitId = ours ? text(ours, "unit_id") : text(list[0], "unit_id");
    let quantity = ours ? num(ours, "quantity_on_hand") : 0;
    for (const movement of list) {
      if (movement.unit_id !== unitId) refusals.push(`Stock movement ${text(movement, "id")} is in another unit than its material's balance.`);
      quantity += stockEventBalanceDelta(text(movement, "event_type"), num(movement, "quantity"));
      if (quantity < -1e-9) refusals.push(`Stock of material ${itemId} would go negative at movement ${text(movement, "id")}.`);
    }
    const theirs = ours ? null : one(source, "SELECT * FROM inventory_stock_balances WHERE item_id = ?", itemId) ?? null;
    changes.push({ itemId, unitId, from: ours ? num(ours, "quantity_on_hand") : null, to: quantity, source: theirs });
  }
  return changes;
}
