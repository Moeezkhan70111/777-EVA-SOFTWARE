// Two more ways a product is classified: its TYPE, and the SUB GROUP inside its product group.
//
//   Main Group        CHAPPAL
//   Product Group     GENTS
//   Product Sub Group GENTS CASUAL     belongs to GENTS
//   Article Series    SK
//   Product Type      MOULDED          a list of its own
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
//
// Product Type is FLAT, exactly like main_groups: a product is of a type whatever group it sits
// in. Product Sub Group is NOT — the owner settled it on 2026-10-11: a sub group belongs to a
// product group, so it carries its parent and is only ever offered under that parent.
//
// Renaming and deleting these is NOT here. Both tables were given the same shape as the lists
// that already exist, so the Product Lists page manages them through the one implementation
// that already renames and deletes a list entry (products.ts, PRODUCT_LIST_TABLES).

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { ProductSubGroupRecord, ProductTypeRecord } from "./types.js";

const text = (value: unknown): string => (value == null ? "" : String(value));

export const productClassificationMethods = {
  // ─── Product type ───────────────────────────────────────────────────────────

  listProductTypes(this: SqliteDatabase): ProductTypeRecord[] {
    const rows = this.db
      .prepare("SELECT id, name, description, is_active FROM product_types WHERE deleted_at IS NULL ORDER BY name ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: text(row.id),
      name: text(row.name),
      description: row.description ? text(row.description) : null,
      isActive: Boolean(row.is_active),
      hasNoUpper: Boolean(row.has_no_upper),
    }));
  },

  /**
   * Idempotent on the name, the way createArticleSeries is: adding a type that already exists
   * returns the existing one rather than refusing or duplicating it. The "+" on the product form
   * is a fast path, and an operator typing a name that is already there means the one that is
   * already there.
   */
  createProductType(this: SqliteDatabase, input: { name: string; description?: string | null }): string {
    const trimmed = text(input.name).trim();
    if (!trimmed) throw new Error("Product type name is required");

    const existing = this.db
      .prepare("SELECT id FROM product_types WHERE UPPER(name) = ? AND deleted_at IS NULL LIMIT 1")
      .get(trimmed.toUpperCase()) as { id: string } | undefined;
    if (existing) return text(existing.id);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO product_types (id, name, description, is_active, created_at, updated_at, deleted_at, deleted_by, delete_reason)
         VALUES (?, ?, ?, 1, ?, ?, NULL, NULL, NULL)`
      )
      .run(id, trimmed, input.description ?? null, now, now);
    return id;
  },

  // ─── Product sub group ──────────────────────────────────────────────────────

  /**
   * The sub groups of one product group, or every sub group when no group is named.
   *
   * The form passes the chosen group, so the dropdown only ever offers sub groups that belong to
   * it. The Product Lists page passes nothing, because it manages all of them.
   */
  listProductSubGroups(this: SqliteDatabase, productGroupId?: string | null): ProductSubGroupRecord[] {
    const groupId = text(productGroupId).trim();
    const rows = this.db
      .prepare(
        `SELECT sg.id, sg.product_group_id, sg.name, sg.description, sg.is_active, sg.has_no_upper, pg.group_name
           FROM product_sub_groups sg
           JOIN product_groups pg ON pg.id = sg.product_group_id
          WHERE sg.deleted_at IS NULL AND (? = '' OR sg.product_group_id = ?)
          ORDER BY pg.group_name ASC, sg.name ASC`
      )
      .all(groupId, groupId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: text(row.id),
      productGroupId: text(row.product_group_id),
      productGroupName: text(row.group_name),
      name: text(row.name),
      description: row.description ? text(row.description) : null,
      isActive: Boolean(row.is_active),
      hasNoUpper: Boolean(row.has_no_upper),
    }));
  },

  /**
   * Adds a sub group under a product group.
   *
   * The parent is required and is checked: a sub group with no group is not a sub group, and the
   * screen offering it would have nowhere to file it. Idempotent WITHIN the group — "CASUAL"
   * under GENTS and "CASUAL" under LADIES are two different sub groups, which is what the unique
   * index on (product_group_id, name) says too.
   */
  createProductSubGroup(this: SqliteDatabase, input: { productGroupId: string; name: string; description?: string | null; hasNoUpper?: boolean }): string {
    const trimmed = text(input.name).trim();
    if (!trimmed) throw new Error("Product sub group name is required");
    const groupId = text(input.productGroupId).trim();
    if (!groupId) throw new Error("Choose the product group this sub group belongs to");

    const group = this.db
      .prepare("SELECT id FROM product_groups WHERE id = ? AND deleted_at IS NULL LIMIT 1")
      .get(groupId) as { id: string } | undefined;
    if (!group) throw new Error("That product group is no longer in the Product Master");

    const existing = this.db
      .prepare("SELECT id FROM product_sub_groups WHERE product_group_id = ? AND UPPER(name) = ? AND deleted_at IS NULL LIMIT 1")
      .get(groupId, trimmed.toUpperCase()) as { id: string } | undefined;
    if (existing) return text(existing.id);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO product_sub_groups (id, product_group_id, name, description, is_active, created_at, updated_at, deleted_at, deleted_by, delete_reason, has_no_upper)
         VALUES (?, ?, ?, ?, 1, ?, ?, NULL, NULL, NULL, ?)`
      )
      .run(id, groupId, trimmed, input.description ?? null, now, now, input.hasNoUpper ? 1 : 0);
    return id;
  },

  /**
   * Ticks or unticks "these products have no upper" on a sub group.
   *
   * Changing it never rewrites a machine program that is already saved: a run records what it
   * was made as (its inner sole colour and its own quantity), so a sub group reclassified today
   * cannot retrospectively turn yesterday's runs into something they were not.
   */
  setProductSubGroupHasNoUpper(this: SqliteDatabase, id: string, hasNoUpper: boolean): void {
    this.db
      .prepare("UPDATE product_sub_groups SET has_no_upper = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(hasNoUpper ? 1 : 0, new Date().toISOString(), text(id).trim());
  },

  /**
   * Whether an article + size is a FIX article: no upper, two sole colours.
   *
   * Read from the product's sub group, which is the one place the fact lives.
   */
  articleHasNoUpper(this: SqliteDatabase, articleSizeId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT sg.has_no_upper FROM article_sizes a
           JOIN product_sub_groups sg ON sg.id = a.product_sub_group_id
          WHERE a.id = ? AND sg.deleted_at IS NULL LIMIT 1`
      )
      .get(text(articleSizeId).trim()) as { has_no_upper: number } | undefined;
    return Boolean(row?.has_no_upper);
  },
};

export type ProductClassificationMethods = typeof productClassificationMethods;
