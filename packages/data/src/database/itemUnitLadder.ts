// A material's own ladder of units: 1 ROLL = 975 METRE, 1 METRE = 40 INCH.
//
// The arithmetic lives in @erp/domain (unitLadder.ts) so the store, this layer and the screens
// all do it the same way. This module only stores a ladder and refuses an unusable one.
//
// The rule that protects every balance already recorded: the ladder must CONTAIN the unit the
// material's stock is held in. Every rung is then worth a known amount of that unit, so a count
// typed on any rung turns into the figure the balance keeps. A ladder never changes a recorded
// number -- it only lets that number be read and typed in other words.
//
// Changing the stock UNIT is a different act, and rawMaterials.ts already owns it:
// correctInventoryItemUnit re-states a material in the unit it should always have been counted
// in, re-stamping the balance and every recorded movement, without converting any figure. 62
// INCH becomes 62 RULE because the 62 was always rules and only the label was wrong. If the
// NUMBER is wrong, that is a stock correction -- a decision an administrator makes (see
// stockCorrections.ts), not something a unit change does quietly.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import { ladderBaseUnit, ladderProblems, ladderUnits, type UnitLadderStep } from "@erp/domain";
import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { ItemUnitLadder, ItemUnitLadderStepRow, UnitLadderPreset } from "./types.js";

interface UnitRow {
  id: string;
  code: string;
}

export const itemUnitLadderMethods = {
  /** The unit a material's stock is counted in: what its balance is held in, else its default. */
  inventoryItemStockUnit(this: SqliteDatabase, itemId: string): UnitRow | null {
    const row = this.db
      .prepare(
        `SELECT u.id, u.code
         FROM inventory_items ii
         LEFT JOIN inventory_stock_balances b ON b.item_id = ii.id
         LEFT JOIN inventory_units u ON u.id = COALESCE(b.unit_id, ii.default_unit_id)
         WHERE ii.id = ? LIMIT 1`
      )
      .get(itemId) as { id: string | null; code: string | null } | undefined;
    return row?.id && row.code ? { id: row.id, code: row.code } : null;
  },

  /**
   * One material's ladder, biggest unit first, with the unit its stock is held in. A material
   * with no ladder comes back with an empty chain rather than nothing, so every screen has
   * the same shape to render.
   */
  getInventoryItemUnitLadder(this: SqliteDatabase, itemId: string): ItemUnitLadder {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.step_order, s.from_unit_id, f.code AS from_unit, s.to_unit_id, t.code AS to_unit, s.factor
         FROM inventory_item_unit_steps s
         JOIN inventory_units f ON f.id = s.from_unit_id
         JOIN inventory_units t ON t.id = s.to_unit_id
         WHERE s.item_id = ?
         ORDER BY s.step_order`
      )
      .all(itemId) as Array<Record<string, unknown>>;

    const steps: ItemUnitLadderStepRow[] = rows.map((row) => ({
      id: String(row.id),
      stepOrder: Number(row.step_order),
      fromUnitId: String(row.from_unit_id),
      fromUnit: String(row.from_unit),
      toUnitId: String(row.to_unit_id),
      toUnit: String(row.to_unit),
      factor: Number(row.factor),
    }));

    const stockUnit = this.inventoryItemStockUnit(itemId);
    return {
      itemId,
      steps,
      baseUnit: ladderBaseUnit(steps.map((step) => ({ fromUnit: step.fromUnit, toUnit: step.toUnit, factor: step.factor }))),
      stockUnit: stockUnit?.code ?? null,
      stockUnitId: stockUnit?.id ?? null,
    };
  },

  /**
   * Replaces a material's ladder. An empty list clears it.
   *
   * Refused unless the chain is unbroken and its bottom rung is the unit the material's stock
   * is held in — otherwise the figure on the shelf and the figure in the system would start
   * meaning different things.
   */
  setInventoryItemUnitLadder(
    this: SqliteDatabase,
    input: { itemId: string; steps: Array<{ fromUnitId: string; toUnitId: string; factor: number }>; updatedBy?: string }
  ): ItemUnitLadder {
    const item = this.db.prepare("SELECT id FROM inventory_items WHERE id = ?").get(input.itemId) as { id: string } | undefined;
    if (!item) throw new Error("Raw material not found");

    const units = new Map(
      (this.db.prepare("SELECT id, code FROM inventory_units").all() as Array<Record<string, unknown>>).map((unit) => [String(unit.id), String(unit.code)])
    );

    const steps: UnitLadderStep[] = input.steps.map((step) => {
      const fromUnit = units.get(step.fromUnitId);
      const toUnit = units.get(step.toUnitId);
      if (!fromUnit || !toUnit) throw new Error("Choose a unit for every step.");
      return { fromUnit, toUnit, factor: Number(step.factor) };
    });

    const problems = ladderProblems(steps);
    if (problems.length > 0) throw new Error(problems[0]);

    if (steps.length > 0) {
      const stockUnit = this.inventoryItemStockUnit(input.itemId);
      if (!stockUnit) {
        throw new Error("Give this material a unit before building a ladder for it.");
      }
      // The stock unit has to be ON the ladder — anywhere on it. Every rung is then worth a
      // known amount of what the balance is kept in, so a count typed on any rung converts.
      if (!ladderUnits(steps).includes(stockUnit.code)) {
        throw new Error(
          `This material's stock is counted in ${stockUnit.code}, so ${stockUnit.code} has to be one of the units on the ladder.`
        );
      }
    }

    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db.prepare("DELETE FROM inventory_item_unit_steps WHERE item_id = ?").run(input.itemId);
      input.steps.forEach((step, index) => {
        this.db
          .prepare(
            `INSERT INTO inventory_item_unit_steps
               (id, item_id, step_order, from_unit_id, to_unit_id, factor, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(crypto.randomUUID(), input.itemId, index, step.fromUnitId, step.toUnitId, Number(step.factor), now, now);
      });
      if (input.updatedBy) {
        this.db
          .prepare("UPDATE inventory_items SET updated_by = ?, updated_at = ? WHERE id = ?")
          .run(input.updatedBy, now, input.itemId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return this.getInventoryItemUnitLadder(input.itemId);
  },

  /** Every ladder at once, keyed by material — so the Stock tab reads them in one query. */
  listInventoryItemUnitLadders(this: SqliteDatabase): Record<string, ItemUnitLadderStepRow[]> {
    const rows = this.db
      .prepare(
        `SELECT s.item_id, s.id, s.step_order, s.from_unit_id, f.code AS from_unit,
                s.to_unit_id, t.code AS to_unit, s.factor
         FROM inventory_item_unit_steps s
         JOIN inventory_units f ON f.id = s.from_unit_id
         JOIN inventory_units t ON t.id = s.to_unit_id
         ORDER BY s.item_id, s.step_order`
      )
      .all() as Array<Record<string, unknown>>;

    const byItem: Record<string, ItemUnitLadderStepRow[]> = {};
    for (const row of rows) {
      const itemId = String(row.item_id);
      (byItem[itemId] ??= []).push({
        id: String(row.id),
        stepOrder: Number(row.step_order),
        fromUnitId: String(row.from_unit_id),
        fromUnit: String(row.from_unit),
        toUnitId: String(row.to_unit_id),
        toUnit: String(row.to_unit),
        factor: Number(row.factor),
      });
    }
    return byItem;
  },

  /**
   * Changes the unit on every colour of this material at once, the same relabel
   * `correctInventoryItemUnit` does for one. Two colours of the same nawaar are counted the
   * same way, so setting that one colour at a time is only a chance to get it wrong.
   *
   * Each one goes through the same method as its own, so a colour that cannot take the change
   * is reported by name rather than quietly skipped.
   */
  correctInventoryItemUnitForColours(
    this: SqliteDatabase,
    input: { itemId: string; unitId: string; reason: string; correctedBy?: string }
  ): { applied: number; skipped: Array<{ displayName: string; reason: string }> } {
    let applied = 0;
    const skipped: Array<{ displayName: string; reason: string }> = [];

    for (const sibling of this.inventoryItemColourSiblings(input.itemId)) {
      try {
        this.correctInventoryItemUnit({
          itemId: sibling.id,
          unitId: input.unitId,
          reason: input.reason,
          correctedBy: input.correctedBy,
        });
        applied += 1;
      } catch (error) {
        skipped.push({
          displayName: sibling.displayName,
          reason: error instanceof Error ? error.message : "It could not take that unit.",
        });
      }
    }
    return { applied, skipped };
  },

  /**
   * Every colour of the same material: the others in its category whose identity values all
   * match, apart from the one that names a colour. That is what "every colour of
   * NAWAAR — 5 SOOTAR — NAAKI SOOTI" means, and it is narrower than "everything in NAWAAR".
   */
  inventoryItemColourSiblings(this: SqliteDatabase, itemId: string): Array<{ id: string; displayName: string }> {
    const item = this.db
      .prepare("SELECT id, category_id FROM inventory_items WHERE id = ?")
      .get(itemId) as { id: string; category_id: string } | undefined;
    if (!item) return [];

    const valuesOf = (id: string): Map<string, string> => {
      const rows = this.db
        .prepare(
          `SELECT f.field_key, f.label, v.text_value, v.number_value
           FROM inventory_item_values v
           JOIN inventory_category_fields f ON f.id = v.field_id
           WHERE v.item_id = ?`
        )
        .all(id) as Array<Record<string, unknown>>;
      const values = new Map<string, string>();
      for (const row of rows) {
        // A colour is what tells two otherwise identical materials apart, so it is the one
        // value allowed to differ. Matched by label, as the screens do.
        if (/colou?r/i.test(String(row.label ?? ""))) continue;
        values.set(String(row.field_key), String(row.text_value ?? row.number_value ?? ""));
      }
      return values;
    };

    const mine = valuesOf(item.id);
    const others = this.db
      .prepare("SELECT id, display_name FROM inventory_items WHERE category_id = ? AND id <> ? AND status = 'ACTIVE'")
      .all(item.category_id, item.id) as Array<{ id: string; display_name: string }>;

    return others
      .filter((other) => {
        const theirs = valuesOf(other.id);
        if (theirs.size !== mine.size) return false;
        for (const [key, value] of mine) {
          if (theirs.get(key) !== value) return false;
        }
        return true;
      })
      .map((other) => ({ id: other.id, displayName: other.display_name }));
  },

  /**
   * Gives every colour of this material the same ladder. Each one is saved through the same
   * path as its own, so a sibling counted in a unit the ladder does not mention is refused
   * rather than quietly given a ladder that does not fit it.
   */
  applyUnitLadderToColours(
    this: SqliteDatabase,
    input: { itemId: string; updatedBy?: string }
  ): { applied: number; skipped: Array<{ displayName: string; reason: string }> } {
    const ladder = this.getInventoryItemUnitLadder(input.itemId);
    const steps = ladder.steps.map((step) => ({
      fromUnitId: step.fromUnitId,
      toUnitId: step.toUnitId,
      factor: step.factor,
    }));

    let applied = 0;
    const skipped: Array<{ displayName: string; reason: string }> = [];
    for (const sibling of this.inventoryItemColourSiblings(input.itemId)) {
      try {
        this.setInventoryItemUnitLadder({ itemId: sibling.id, steps, updatedBy: input.updatedBy });
        applied += 1;
      } catch (error) {
        skipped.push({
          displayName: sibling.displayName,
          reason: error instanceof Error ? error.message : "It could not take these units.",
        });
      }
    }
    return { applied, skipped };
  },

  // ─── Saved sets of conversions ──────────────────────────────────────────────

  /** Every saved set, with its steps, newest name order. */
  listUnitLadderPresets(this: SqliteDatabase): UnitLadderPreset[] {
    const presets = this.db
      .prepare("SELECT id, name FROM unit_ladder_presets ORDER BY name COLLATE NOCASE")
      .all() as Array<{ id: string; name: string }>;

    return presets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      steps: (
        this.db
          .prepare(
            `SELECT s.id, s.step_order, s.from_unit_id, f.code AS from_unit, s.to_unit_id, t.code AS to_unit, s.factor
             FROM unit_ladder_preset_steps s
             JOIN inventory_units f ON f.id = s.from_unit_id
             JOIN inventory_units t ON t.id = s.to_unit_id
             WHERE s.preset_id = ?
             ORDER BY s.step_order`
          )
          .all(preset.id) as Array<Record<string, unknown>>
      ).map((row) => ({
        id: String(row.id),
        stepOrder: Number(row.step_order),
        fromUnitId: String(row.from_unit_id),
        fromUnit: String(row.from_unit),
        toUnitId: String(row.to_unit_id),
        toUnit: String(row.to_unit),
        factor: Number(row.factor),
      })),
    }));
  },

  /** Saves a set of conversions by name. Saving under a name that exists replaces it. */
  saveUnitLadderPreset(
    this: SqliteDatabase,
    input: { name: string; steps: Array<{ fromUnitId: string; toUnitId: string; factor: number }>; createdBy?: string }
  ): UnitLadderPreset {
    const name = String(input.name ?? "").trim();
    if (!name) throw new Error("Give this set a name.");
    if (input.steps.length === 0) throw new Error("A saved set needs at least one conversion.");

    const units = new Map(
      (this.db.prepare("SELECT id, code FROM inventory_units").all() as Array<Record<string, unknown>>).map((unit) => [
        String(unit.id),
        String(unit.code),
      ])
    );
    const problems = ladderProblems(
      input.steps.map((step) => ({
        fromUnit: units.get(step.fromUnitId) ?? "",
        toUnit: units.get(step.toUnitId) ?? "",
        factor: Number(step.factor),
      }))
    );
    if (problems.length > 0) throw new Error(problems[0]);

    const now = new Date().toISOString();
    const existing = this.db
      .prepare("SELECT id FROM unit_ladder_presets WHERE UPPER(name) = UPPER(?)")
      .get(name) as { id: string } | undefined;
    const id = existing?.id ?? crypto.randomUUID();

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      if (existing) {
        this.db.prepare("UPDATE unit_ladder_presets SET name = ?, updated_at = ? WHERE id = ?").run(name, now, id);
        this.db.prepare("DELETE FROM unit_ladder_preset_steps WHERE preset_id = ?").run(id);
      } else {
        this.db
          .prepare("INSERT INTO unit_ladder_presets (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
          .run(id, name, input.createdBy ?? null, now, now);
      }
      input.steps.forEach((step, index) => {
        this.db
          .prepare(
            `INSERT INTO unit_ladder_preset_steps (id, preset_id, step_order, from_unit_id, to_unit_id, factor)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(crypto.randomUUID(), id, index, step.fromUnitId, step.toUnitId, Number(step.factor));
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return this.listUnitLadderPresets().find((preset) => preset.id === id)!;
  },

  deleteUnitLadderPreset(this: SqliteDatabase, presetId: string): void {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db.prepare("DELETE FROM unit_ladder_preset_steps WHERE preset_id = ?").run(presetId);
      this.db.prepare("DELETE FROM unit_ladder_presets WHERE id = ?").run(presetId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  },
};

export type ItemUnitLadderMethods = typeof itemUnitLadderMethods;
