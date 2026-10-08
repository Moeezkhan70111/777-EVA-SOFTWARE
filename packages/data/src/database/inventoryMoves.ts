// Moving things around the raw material hierarchy: a category to a different parent, or a
// material to a different category.
//
// Both are re-filings, not edits of what the thing IS. Nothing about a material's stock, its
// movements, its labels or its code changes when it moves — only where it is filed, and the
// two things that are DERIVED from where it is filed:
//
//   - its display name, which begins with the category path ("UPPER — PVC UPPER — …");
//   - its identity signature, which is taken over the category and the values.
//
// Its attribute values travel with it by field KEY, because that is what a value means. The
// target category asks for its own set of attributes, so a move is previewed first: what
// carries over, what is left behind, and what the target asks for that this material cannot
// answer. A move that would leave a material invalid or collide with one already there is
// refused — the preview says so before anybody presses anything.
//
// Categories nest as deep as the business needs — a kind of a kind of a kind — and a material
// may be filed at any level, beside sub-categories or not. So the only things left to guard
// are the two that would actually break something: a category cannot be filed inside itself or
// inside anything beneath it (which would cut a branch loose from the tree and loop forever),
// and two categories in the same place cannot share a name.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { CategoryMovePreview, InventoryItemMovePreview } from "./types.js";

interface CategoryRow {
  id: string;
  name: string;
  parent_id: string | null;
}

const field = (row: Record<string, unknown>, key: string): string => String(row[key] ?? "");

export const inventoryMovesMethods = {
  /**
   * What would happen if this category were filed under `newParentId` (null = top level),
   * and what would stop it. An empty `blockers` means the move can go ahead.
   */
  previewCategoryMove(this: SqliteDatabase, categoryId: string, newParentId: string | null): CategoryMovePreview {
    const category = this.db
      .prepare("SELECT id, name, parent_id FROM inventory_categories WHERE id = ?")
      .get(categoryId) as CategoryRow | undefined;
    if (!category) return { blockers: ["This category no longer exists."], from: "", to: "", renames: 0 };

    const blockers: string[] = [];
    const parent = newParentId
      ? (this.db.prepare("SELECT id, name, parent_id FROM inventory_categories WHERE id = ?").get(newParentId) as
          | CategoryRow
          | undefined)
      : null;

    if (newParentId && !parent) {
      blockers.push("That category no longer exists.");
    } else if (parent) {
      // The only move that cannot work: putting a category inside itself or inside one of its
      // own descendants, which would cut that whole branch out of the tree.
      if (parent.id === category.id) {
        blockers.push("A category cannot be filed under itself.");
      } else if (this.categoryDescendants(category.id).includes(parent.id)) {
        blockers.push(`${parent.name} is already inside ${category.name}, so ${category.name} cannot be filed under it.`);
      }
    }

    // A name only has to be unique among its siblings.
    const clash = this.db
      .prepare(
        `SELECT id FROM inventory_categories
         WHERE id <> ? AND UPPER(name) = UPPER(?)
           AND ((parent_id IS NULL AND ? IS NULL) OR parent_id = ?)
         LIMIT 1`
      )
      .get(category.id, category.name, newParentId, newParentId) as { id: string } | undefined;
    if (clash) {
      blockers.push(`There is already a ${newParentId ? "sub-category" : "category"} called ${category.name} there.`);
    }

    // Every material anywhere beneath this category is named after its path, so they are all
    // renamed — however deep the branch runs.
    const branch = [category.id, ...this.categoryDescendants(category.id)];
    const renames = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM inventory_items WHERE category_id IN (${branch.map(() => "?").join(", ")})`
      )
      .get(...branch) as { n: number };

    return {
      blockers,
      from: this.categoryPathName(category.id),
      to: parent ? `${this.categoryPathName(parent.id)} — ${category.name}` : category.name,
      renames: Number(renames.n),
    };
  },

  /**
   * Files a category somewhere else. Every material under it is named after its path, so all
   * of their display names are rebuilt in the same transaction — a name and the place it
   * describes can never disagree.
   *
   * Signatures are NOT touched: a signature is taken over the category a material sits in and
   * the values it was saved with, and neither changes here.
   */
  moveInventoryCategory(this: SqliteDatabase, categoryId: string, newParentId: string | null, movedBy?: string): void {
    const preview = this.previewCategoryMove(categoryId, newParentId);
    if (preview.blockers.length > 0) throw new Error(preview.blockers[0]);

    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db
        .prepare("UPDATE inventory_categories SET parent_id = ?, updated_at = ? WHERE id = ?")
        .run(newParentId, now, categoryId);

      // Read AFTER the parent changed, so the branch is the one that just moved.
      const branch = [categoryId, ...this.categoryDescendants(categoryId)];
      const affected = this.db
        .prepare(
          `SELECT id, category_id FROM inventory_items WHERE category_id IN (${branch.map(() => "?").join(", ")})`
        )
        .all(...branch) as Array<{ id: string; category_id: string }>;
      for (const item of affected) {
        this.rebuildInventoryItemName(item.id, item.category_id, movedBy, now);
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  },

  /**
   * What would happen if this material were filed under `targetCategoryId`.
   *
   * Values travel by field key. `carried` is what the target also asks for, `dropped` is what
   * it does not ask for (those values are let go), and `missingRequired` is what it asks for
   * that this material has no answer to — which blocks the move, because a material that
   * cannot answer its category's required questions is not a valid material.
   */
  previewInventoryItemMove(this: SqliteDatabase, itemId: string, targetCategoryId: string): InventoryItemMovePreview {
    const item = this.db
      .prepare("SELECT id, item_code, display_name, category_id FROM inventory_items WHERE id = ?")
      .get(itemId) as { id: string; item_code: string; display_name: string; category_id: string } | undefined;
    const empty: InventoryItemMovePreview = {
      blockers: [],
      carried: [],
      dropped: [],
      missingRequired: [],
      from: "",
      to: "",
      newDisplayName: "",
    };
    if (!item) return { ...empty, blockers: ["This material no longer exists."] };

    const target = this.db
      .prepare("SELECT id, name, parent_id, status FROM inventory_categories WHERE id = ?")
      .get(targetCategoryId) as (CategoryRow & { status: string }) | undefined;
    if (!target) return { ...empty, blockers: ["That category no longer exists."] };

    const blockers: string[] = [];
    if (target.id === item.category_id) blockers.push("It is already filed here.");
    if (target.status !== "ACTIVE") blockers.push(`${target.name} is not in use.`);

    // What the material holds now, by field key.
    const held = new Map<string, { label: string; text: string | null; number: number | null; urdu: string | null }>();
    const rows = this.db
      .prepare(
        `SELECT f.field_key, f.label, v.text_value, v.number_value, v.text_value_urdu
         FROM inventory_item_values v
         JOIN inventory_category_fields f ON f.id = v.field_id
         WHERE v.item_id = ?`
      )
      .all(item.id) as Array<Record<string, unknown>>;
    for (const row of rows) {
      held.set(field(row, "field_key"), {
        label: field(row, "label"),
        text: row.text_value == null ? null : String(row.text_value),
        number: row.number_value == null ? null : Number(row.number_value),
        urdu: row.text_value_urdu == null ? null : String(row.text_value_urdu),
      });
    }

    const targetFields = this.effectiveCategoryFields(target.id);
    const targetKeys = new Set(targetFields.map((f) => field(f, "field_key")));

    const carried: Array<{ label: string; value: string }> = [];
    const dropped: Array<{ label: string; value: string }> = [];
    const missingRequired: string[] = [];
    const values: Record<string, unknown> = {};

    for (const [key, value] of held) {
      const shown = value.text ?? (value.number == null ? "" : String(value.number));
      if (targetKeys.has(key)) {
        carried.push({ label: value.label, value: shown });
        values[key] = value.text ?? value.number;
      } else {
        dropped.push({ label: value.label, value: shown });
      }
    }

    for (const targetField of targetFields) {
      if (field(targetField, "field_type") === "UNIT" || !targetField.is_required) continue;
      const key = field(targetField, "field_key");
      const value = values[key];
      if (value == null || String(value).trim() === "") missingRequired.push(field(targetField, "label"));
    }
    if (missingRequired.length > 0) {
      blockers.push(`${target.name} asks for ${missingRequired.join(", ")}, which this material has no answer to.`);
    }

    const signature = this.inventorySignature(target.id, targetFields, values);
    const twin = this.db
      .prepare(
        "SELECT item_code, display_name FROM inventory_items WHERE category_id = ? AND signature_hash = ? AND id <> ? AND status = 'ACTIVE' LIMIT 1"
      )
      .get(target.id, signature.hash, item.id) as { item_code: string; display_name: string } | undefined;
    if (twin) {
      blockers.push(`${target.name} already holds the same material — ${twin.display_name} (${twin.item_code}).`);
    }

    return {
      blockers,
      carried,
      dropped,
      missingRequired,
      from: this.categoryPathName(item.category_id),
      to: this.categoryPathName(target.id),
      newDisplayName: this.buildInventoryDisplayName(this.categoryPathName(target.id), targetFields, values),
    };
  },

  /**
   * Files a material under another category. Its code, its stock, its movements and its
   * labels are untouched — only where it is filed, the values it keeps, and the two things
   * derived from those: its display name and its identity signature.
   *
   * Values are re-pointed at the target's own field rows, so nothing is left pointing at the
   * fields of a category the material no longer belongs to.
   */
  moveInventoryItem(this: SqliteDatabase, input: { itemId: string; targetCategoryId: string; movedBy?: string }): void {
    const preview = this.previewInventoryItemMove(input.itemId, input.targetCategoryId);
    if (preview.blockers.length > 0) throw new Error(preview.blockers[0]);

    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const held = this.db
        .prepare(
          `SELECT f.field_key, v.id AS value_id, v.text_value, v.number_value, v.text_value_urdu
           FROM inventory_item_values v
           JOIN inventory_category_fields f ON f.id = v.field_id
           WHERE v.item_id = ?`
        )
        .all(input.itemId) as Array<Record<string, unknown>>;

      const targetFields = this.effectiveCategoryFields(input.targetCategoryId);
      const targetByKey = new Map(targetFields.map((f) => [field(f, "field_key"), f]));

      // Everything is rewritten rather than patched: a value row belongs to a field of the
      // category the material is in, and after the move that is a different set of rows.
      this.db.prepare("DELETE FROM inventory_item_values WHERE item_id = ?").run(input.itemId);

      const values: Record<string, unknown> = {};
      for (const row of held) {
        const key = field(row, "field_key");
        const targetField = targetByKey.get(key);
        if (!targetField) continue; // the target does not ask for it — the preview said so
        const isNumber = field(targetField, "field_type") === "NUMBER";
        const text = row.text_value == null ? null : String(row.text_value);
        const number = row.number_value == null ? null : Number(row.number_value);
        values[key] = text ?? number;
        this.db
          .prepare(
            "INSERT INTO inventory_item_values (id, item_id, field_id, text_value, number_value, text_value_urdu) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run(
            crypto.randomUUID(),
            input.itemId,
            field(targetField, "id"),
            isNumber ? null : text,
            isNumber ? (number ?? (text == null ? null : Number(text))) : null,
            row.text_value_urdu == null ? null : String(row.text_value_urdu)
          );
      }

      const signature = this.inventorySignature(input.targetCategoryId, targetFields, values);
      const displayName = this.buildInventoryDisplayName(
        this.categoryPathName(input.targetCategoryId),
        targetFields,
        values
      );
      this.db
        .prepare(
          "UPDATE inventory_items SET category_id = ?, signature_hash = ?, display_name = ?, updated_by = ?, updated_at = ? WHERE id = ?"
        )
        .run(input.targetCategoryId, signature.hash, displayName, input.movedBy ?? null, now, input.itemId);

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  },

  /**
   * Rebuilds one material's display name from where it is now filed. Used when a CATEGORY
   * moves: the material itself has not changed, but the path its name starts with has.
   * Assumes the caller has opened a transaction.
   */
  rebuildInventoryItemName(
    this: SqliteDatabase,
    itemId: string,
    categoryId: string,
    updatedBy?: string,
    at?: string
  ): void {
    const fields = this.effectiveCategoryFields(categoryId);
    const rows = this.db
      .prepare(
        `SELECT f.field_key, v.text_value, v.number_value
         FROM inventory_item_values v
         JOIN inventory_category_fields f ON f.id = v.field_id
         WHERE v.item_id = ?`
      )
      .all(itemId) as Array<Record<string, unknown>>;

    const values: Record<string, unknown> = {};
    for (const row of rows) {
      values[field(row, "field_key")] = row.text_value ?? (row.number_value == null ? null : Number(row.number_value));
    }

    const displayName = this.buildInventoryDisplayName(this.categoryPathName(categoryId), fields, values);
    this.db
      .prepare("UPDATE inventory_items SET display_name = ?, updated_by = ?, updated_at = ? WHERE id = ?")
      .run(displayName, updatedBy ?? null, at ?? new Date().toISOString(), itemId);
  },
};

export type InventoryMovesMethods = typeof inventoryMovesMethods;
