// Raw material master v2: units, categories, attributes, items and stock movements.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
// `this` is the database instance; bodies are unchanged from the original class.

import type { SqliteDatabase } from "../sqliteDatabase.js";
import { createHash } from "node:crypto";
import { EFFECTIVE_PACK_NAME_SQL, normalizeInventoryText, normalizePackName } from "./shared.js";
import type { DatabaseSync } from "node:sqlite";
import { fromPaisaOrNull, packetsInStore as countPacketsInStore, toPaisaOrNull } from "@erp/domain";
import type { InventoryStockEventRow, RawMaterialHop, RawMaterialMovementConfigRow, RawMaterialSetupTemplate, WorkSection } from "./types.js";

export const rawMaterialsMethods = {
  listInventoryUnits(this: SqliteDatabase): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM inventory_units WHERE is_active = 1 ORDER BY name").all() as Array<Record<string, unknown>>;
  },

  createInventoryUnit(this: SqliteDatabase, input: { code: string; name: string; symbol?: string; unitFamily?: string; decimalScale?: number }): string {
    const code = normalizeInventoryText(input.code).replace(/ /g, "_");
    if (!code || !input.name.trim()) throw new Error("Unit code and name are required");
    const existing = this.db.prepare("SELECT id FROM inventory_units WHERE UPPER(code) = UPPER(?)").get(code) as { id: string } | undefined;
    if (existing) throw new Error(`A unit with code "${code}" already exists`);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO inventory_units (id, code, name, symbol, unit_family, decimal_scale, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, code, input.name.trim(), input.symbol ?? null, input.unitFamily ?? "COUNT", input.decimalScale ?? 0, now, now);
    return id;
  },

  listInventoryUnitConversions(this: SqliteDatabase): Array<Record<string, unknown>> {
    return this.db.prepare(`SELECT c.*, fu.code as from_unit_code, tu.code as to_unit_code
      FROM inventory_unit_conversions c
      JOIN inventory_units fu ON fu.id = c.from_unit_id
      JOIN inventory_units tu ON tu.id = c.to_unit_id
      ORDER BY fu.code, tu.code`).all() as Array<Record<string, unknown>>;
  },

  createInventoryUnitConversion(this: SqliteDatabase, input: { fromUnitId: string; toUnitId: string; factor: number }): string {
    if (input.fromUnitId === input.toUnitId) throw new Error("Choose two different units to convert between");
    if (!(input.factor > 0)) throw new Error("Conversion factor must be greater than zero");
    const existing = this.db.prepare("SELECT id FROM inventory_unit_conversions WHERE from_unit_id = ? AND to_unit_id = ?").get(input.fromUnitId, input.toUnitId) as { id: string } | undefined;
    if (existing) throw new Error("A conversion between these units already exists");
    const id = crypto.randomUUID();
    this.db.prepare("INSERT INTO inventory_unit_conversions (id, from_unit_id, to_unit_id, factor, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, input.fromUnitId, input.toUnitId, input.factor, new Date().toISOString());
    return id;
  },

  /** Converts a quantity between two units using a direct or inverse conversion rule; null when no rule exists. */
  convertInventoryUnit(this: SqliteDatabase, quantity: number, fromUnitId: string, toUnitId: string): number | null {
    if (fromUnitId === toUnitId) return quantity;
    const direct = this.db.prepare("SELECT factor FROM inventory_unit_conversions WHERE from_unit_id = ? AND to_unit_id = ?").get(fromUnitId, toUnitId) as { factor: number } | undefined;
    if (direct) return quantity * direct.factor;
    const inverse = this.db.prepare("SELECT factor FROM inventory_unit_conversions WHERE from_unit_id = ? AND to_unit_id = ?").get(toUnitId, fromUnitId) as { factor: number } | undefined;
    if (inverse) return quantity / inverse.factor;
    return null;
  },

  /**
   * A category's own attributes, and those it inherits from its parent.
   *
   * A sub-category IS a kind of its parent, so it asks for everything the parent asks for
   * plus whatever tells its own materials apart. The parent's come first and are flagged
   * `inherited_from`, so a screen can show them as read-only — they are edited where they
   * are defined, on the parent, and changing one there changes it for every sub-category.
   *
   * This is the ONE definition of "the fields of a category": item creation, the identity
   * signature, the display name and every screen read it, so they cannot drift apart.
   */
  effectiveCategoryFields(this: SqliteDatabase, categoryId: string): Array<Record<string, unknown>> {
    const row = this.db
      .prepare("SELECT parent_id FROM inventory_categories WHERE id = ? LIMIT 1")
      .get(categoryId) as { parent_id: string | null } | undefined;

    const own = (categoryId: string, inheritedFrom: string | null) =>
      (
        this.db
          .prepare("SELECT * FROM inventory_category_fields WHERE category_id = ? AND is_active = 1 ORDER BY sort_order, label")
          .all(categoryId) as Array<Record<string, unknown>>
      ).map((field) => ({
        ...field,
        inherited_from: inheritedFrom,
        options: this.db
          .prepare(
            "SELECT id, option_value, display_label FROM inventory_category_field_options WHERE field_id = ? AND is_active = 1 ORDER BY sort_order, display_label"
          )
          .all(String(field.id)),
      }));

    if (!row?.parent_id) return own(categoryId, null);

    // However deep the nesting goes, a category IS a kind of each of its ancestors, so it asks
    // for everything all of them ask for. Outermost first, its own last.
    const ancestry = this.categoryAncestry(categoryId);
    return ancestry.flatMap((step, index) =>
      index === ancestry.length - 1 ? own(step.id, null) : own(step.id, step.name)
    );
  },

  /**
   * "UPPER — PVC UPPER — PRINTED" — every ancestor, outermost first.
   *
   * Categories nest as deep as the business needs, so this walks the whole chain rather than
   * looking at one parent. A material's display name starts with this, which is why moving a
   * category rebuilds the names of everything beneath it.
   */
  categoryPathName(this: SqliteDatabase, categoryId: string): string {
    return this.categoryAncestry(categoryId)
      .map((row) => row.name)
      .join(" — ");
  },

  /**
   * A category and everything it is a kind of, outermost first. The guard against a loop is
   * the visited set: a database that somehow held a cycle would stop rather than hang.
   */
  categoryAncestry(this: SqliteDatabase, categoryId: string): Array<{ id: string; name: string }> {
    const chain: Array<{ id: string; name: string }> = [];
    const seen = new Set<string>();
    let current: string | null = categoryId;
    while (current && !seen.has(current)) {
      seen.add(current);
      const row = this.db
        .prepare("SELECT id, name, parent_id FROM inventory_categories WHERE id = ? LIMIT 1")
        .get(current) as { id: string; name: string; parent_id: string | null } | undefined;
      if (!row) break;
      chain.unshift({ id: String(row.id), name: String(row.name) });
      current = row.parent_id ? String(row.parent_id) : null;
    }
    return chain;
  },

  /** Every category beneath this one, however deep. Used when something moves or is removed. */
  categoryDescendants(this: SqliteDatabase, categoryId: string): string[] {
    const found: string[] = [];
    const queue = [categoryId];
    const seen = new Set<string>([categoryId]);
    while (queue.length > 0) {
      const next = queue.shift()!;
      const children = this.db
        .prepare("SELECT id FROM inventory_categories WHERE parent_id = ?")
        .all(next) as Array<{ id: string }>;
      for (const child of children) {
        const id = String(child.id);
        if (seen.has(id)) continue;
        seen.add(id);
        found.push(id);
        queue.push(id);
      }
    }
    return found;
  },

  listInventoryCategories(this: SqliteDatabase): Array<Record<string, unknown>> {
    const categories = this.db
      .prepare(
        `SELECT c.*, p.name AS parent_name,
                (SELECT COUNT(1) FROM inventory_categories k WHERE k.parent_id = c.id AND k.status = 'ACTIVE') AS sub_category_count
         FROM inventory_categories c
         LEFT JOIN inventory_categories p ON p.id = c.parent_id
         WHERE c.status = 'ACTIVE'
         ORDER BY COALESCE(p.name, c.name), c.parent_id IS NOT NULL, c.name`
      )
      .all() as Array<Record<string, unknown>>;
    return categories.map((category) => ({
      ...category,
      // The whole chain, however deep — the screens show and sort by this.
      path_name: this.categoryPathName(String(category.id)),
      fields: this.effectiveCategoryFields(String(category.id)),
    }));
  },

  createInventoryCategory(this: SqliteDatabase, input: { name: string; description?: string; parentId?: string | null; packName?: string | null; createdBy?: string }): string {
    const name = normalizeInventoryText(input.name);
    if (!name) throw new Error("Category name is required");

    const parentId = input.parentId ? String(input.parentId) : null;
    if (parentId) {
      const parent = this.db
        .prepare("SELECT id, name, parent_id FROM inventory_categories WHERE id = ? AND status = 'ACTIVE'")
        .get(parentId) as { id: string; name: string; parent_id: string | null } | undefined;
      if (!parent) throw new Error("The category this would sit under was not found");
      // No depth limit: a kind of a kind of a kind is how the store actually talks about its
      // materials, so the tree goes as deep as the business needs (owner's call, 2026-10-07).
    }

    // A name only has to be unique among its siblings: PLAIN under RAGZINE and PLAIN under
    // DANA are different things, and the store calls them both PLAIN.
    const existing = this.db
      .prepare("SELECT id FROM inventory_categories WHERE UPPER(name) = UPPER(?) AND COALESCE(parent_id, '') = COALESCE(?, '') AND status = 'ACTIVE'")
      .get(name, parentId) as { id: string } | undefined;
    if (existing) {
      throw new Error(parentId ? `That category already has a "${name}"` : `A category named "${name}" already exists`);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const code = name.replace(/ /g, "_");
    this.db.prepare("INSERT INTO inventory_categories (id, category_code, name, description, parent_id, pack_name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, code, name, input.description ? normalizeInventoryText(input.description) : null, parentId, normalizePackName(input.packName), input.createdBy ?? null, now, now);
    this.writeInventoryAudit(null, "CATEGORY", id, "CREATE", null, input, input.createdBy);
    return id;
  },

  /** `packName`: left out keeps it, an empty string clears it (a sub-category then follows its parent). */
  updateInventoryCategory(this: SqliteDatabase, categoryId: string, input: { name?: string; description?: string; packName?: string | null; updatedBy?: string }): void {
    const current = this.db.prepare("SELECT * FROM inventory_categories WHERE id = ? AND status = 'ACTIVE'").get(categoryId) as Record<string, unknown> | undefined;
    if (!current) throw new Error("Category not found");
    const name = input.name == null ? String(current.name) : normalizeInventoryText(input.name);
    // Unique among its siblings only — see createInventoryCategory. Re-parenting is not
    // offered: an item's stored display name carries its category path, so moving a
    // sub-category would leave every material it holds describing a place it no longer is.
    const duplicate = this.db
      .prepare("SELECT id FROM inventory_categories WHERE UPPER(name) = UPPER(?) AND COALESCE(parent_id, '') = COALESCE(?, '') AND id <> ? AND status = 'ACTIVE'")
      .get(name, current.parent_id == null ? null : String(current.parent_id), categoryId) as { id: string } | undefined;
    if (duplicate) throw new Error(`A category named "${name}" already exists here`);
    const code = name.replace(/ /g, "_");
    const description = input.description == null ? (current.description == null ? null : String(current.description)) : normalizeInventoryText(input.description);
    const packName = input.packName === undefined ? (current.pack_name == null ? null : String(current.pack_name)) : normalizePackName(input.packName);
    this.db.prepare("UPDATE inventory_categories SET category_code = ?, name = ?, description = ?, pack_name = ?, updated_at = ? WHERE id = ?")
      .run(code, name, description, packName, new Date().toISOString(), categoryId);
    this.writeInventoryAudit(null, "CATEGORY", categoryId, "UPDATE", current, input, input.updatedBy);
  },

  addInventoryCategoryField(this: SqliteDatabase, input: { categoryId: string; fieldKey: string; label: string; fieldType: string; required?: boolean; searchable?: boolean; sortOrder?: number }): string {
    const fieldKey = normalizeInventoryText(input.fieldKey).toLowerCase().replace(/ /g, "_");
    if (!fieldKey || !input.label.trim()) throw new Error("Attribute key and label are required");
    if (!["TEXT", "NUMBER", "DROPDOWN", "UNIT"].includes(input.fieldType)) throw new Error("Unsupported attribute type");

    const now = new Date().toISOString();

    // Check for an active duplicate first
    const active = this.db.prepare("SELECT id FROM inventory_category_fields WHERE category_id = ? AND field_key = ? AND is_active = 1").get(input.categoryId, fieldKey) as { id: string } | undefined;
    if (active) throw new Error(`An attribute with key "${fieldKey}" already exists in this category`);

    // A sub-category already asks for everything its parent asks for, so redefining one of
    // those here would give a material two answers to the same question.
    const parent = this.db
      .prepare(
        `SELECT p.id, p.name FROM inventory_categories c
         JOIN inventory_categories p ON p.id = c.parent_id
         WHERE c.id = ? LIMIT 1`
      )
      .get(input.categoryId) as { id: string; name: string } | undefined;
    if (parent) {
      const inherited = this.db
        .prepare("SELECT id FROM inventory_category_fields WHERE category_id = ? AND field_key = ? AND is_active = 1")
        .get(parent.id, fieldKey) as { id: string } | undefined;
      if (inherited) {
        throw new Error(`"${input.label.trim()}" already comes from ${parent.name}. Change it there and every sub-category follows.`);
      }
    }

    // If a soft-deleted row exists for this (category, key) pair, reactivate it
    // instead of inserting — avoids a UNIQUE constraint violation.
    const softDeleted = this.db.prepare("SELECT id FROM inventory_category_fields WHERE category_id = ? AND field_key = ? AND is_active = 0").get(input.categoryId, fieldKey) as { id: string } | undefined;
    if (softDeleted) {
      this.db.prepare(
        "UPDATE inventory_category_fields SET label = ?, field_type = ?, is_required = ?, is_searchable = ?, is_active = 1, updated_at = ? WHERE id = ?"
      ).run(
        normalizeInventoryText(input.label),
        input.fieldType,
        input.required ? 1 : 0,
        input.searchable === false ? 0 : 1,
        now,
        softDeleted.id,
      );
      return softDeleted.id;
    }

    const id = crypto.randomUUID();
    const next = this.db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS sort_order FROM inventory_category_fields WHERE category_id = ?").get(input.categoryId) as { sort_order: number };
    this.db.prepare("INSERT INTO inventory_category_fields (id, category_id, field_key, label, field_type, is_required, is_searchable, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.categoryId, fieldKey, normalizeInventoryText(input.label), input.fieldType, input.required ? 1 : 0, input.searchable === false ? 0 : 1, input.sortOrder ?? next.sort_order, now, now);
    return id;
  },

  updateInventoryCategoryField(this: SqliteDatabase, fieldId: string, input: { label?: string; fieldType?: string; required?: boolean; searchable?: boolean; updatedBy?: string }): void {
    const current = this.db.prepare("SELECT * FROM inventory_category_fields WHERE id = ? AND is_active = 1").get(fieldId) as Record<string, unknown> | undefined;
    if (!current) throw new Error("Attribute not found");
    const label = input.label == null ? String(current.label) : normalizeInventoryText(input.label);
    const fieldType = input.fieldType ?? String(current.field_type);
    if (!["TEXT", "NUMBER", "DROPDOWN", "UNIT"].includes(fieldType)) throw new Error("Unsupported attribute type");
    this.db.prepare("UPDATE inventory_category_fields SET label = ?, field_type = ?, is_required = ?, is_searchable = ?, updated_at = ? WHERE id = ?")
      .run(label, fieldType, input.required == null ? Number(current.is_required ?? 0) : input.required ? 1 : 0, input.searchable == null ? Number(current.is_searchable ?? 1) : input.searchable ? 1 : 0, new Date().toISOString(), fieldId);
    this.writeInventoryAudit(null, "CATEGORY_FIELD", fieldId, "UPDATE", current, input, input.updatedBy);
  },

  removeInventoryCategoryField(this: SqliteDatabase, fieldId: string, updatedBy?: string): void {
    const current = this.db.prepare("SELECT * FROM inventory_category_fields WHERE id = ? AND is_active = 1").get(fieldId) as Record<string, unknown> | undefined;
    if (!current) throw new Error("Attribute not found");
    this.db.prepare("UPDATE inventory_category_fields SET is_active = 0, updated_at = ? WHERE id = ?").run(new Date().toISOString(), fieldId);
    this.writeInventoryAudit(null, "CATEGORY_FIELD", fieldId, "DELETE", current, null, updatedBy);
  },

  addInventoryFieldOption(this: SqliteDatabase, input: { fieldId: string; value: string; label?: string; sortOrder?: number }): string {
    const optionValue = normalizeInventoryText(input.value);
    if (!optionValue) throw new Error("Option value is required");
    const existing = this.db.prepare("SELECT id FROM inventory_category_field_options WHERE field_id = ? AND option_value = ? AND is_active = 1 LIMIT 1").get(input.fieldId, optionValue) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = crypto.randomUUID();
    this.db.prepare("INSERT INTO inventory_category_field_options (id, field_id, option_value, display_label, sort_order) VALUES (?, ?, ?, ?, ?)")
      .run(id, input.fieldId, optionValue, normalizeInventoryText(input.label || input.value), input.sortOrder ?? 0);
    return id;
  },

  writeInventoryAudit(this: SqliteDatabase, itemId: string | null, entityType: string, entityId: string, action: string, oldValue: unknown, newValue: unknown, changedBy?: string): void {
    this.db.prepare("INSERT INTO inventory_item_audit (id, item_id, entity_type, entity_id, action, old_value_json, new_value_json, changed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), itemId, entityType, entityId, action, oldValue == null ? null : JSON.stringify(oldValue), newValue == null ? null : JSON.stringify(newValue), changedBy ?? null, new Date().toISOString());
  },

  /** Deterministic category + non-unit-attribute signature used to detect duplicate items; never exposed to the UI. */
  inventorySignature(this: SqliteDatabase, categoryId: string, fields: Array<Record<string, unknown>>, values: Record<string, unknown>): { normalized: string; hash: string } {
    const parts = fields
      .filter((field) => String(field.field_type) !== "UNIT")
      .map((field) => String(field.field_key))
      .sort()
      .map((fieldKey) => [fieldKey, normalizeInventoryText(values[fieldKey] ?? "")]);
    const normalized = JSON.stringify({ categoryId, parts });
    return { normalized, hash: createHash("sha256").update(normalized).digest("hex") };
  },

  /** Builds a readable display name from the category name and its configured (non-unit) attribute values, in attribute order. */
  buildInventoryDisplayName(this: SqliteDatabase, categoryName: string, fields: Array<Record<string, unknown>>, values: Record<string, unknown>): string {
    const parts = [...fields]
      .filter((field) => String(field.field_type) !== "UNIT")
      .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
      .map((field) => normalizeInventoryText(values[String(field.field_key)] ?? ""))
      .filter(Boolean);
    return [normalizeInventoryText(categoryName), ...parts].join(" — ");
  },

  listInventoryItems(this: SqliteDatabase, query: { search?: string; categoryId?: string; attributes?: Record<string, string>; status?: string } = {}): Array<Record<string, unknown>> {
    // "ALL" includes disabled materials: without it a disabled one cannot be found at all,
    // and so cannot be put back in use or erased.
    const status = query.status ?? "ACTIVE";
    const where: string[] = [];
    const args: Array<string> = [];
    if (status !== "ALL") {
      where.push("ii.status = ?");
      args.push(status);
    }
    if (query.categoryId) {
      // Choosing a category means "everything under it", however deep the branch runs.
      where.push(
        `ii.category_id IN (
           WITH RECURSIVE branch(id) AS (
             SELECT ? UNION ALL
             SELECT c.id FROM inventory_categories c JOIN branch b ON c.parent_id = b.id
           ) SELECT id FROM branch
         )`
      );
      args.push(query.categoryId);
    }
    if (query.attributes) {
      for (const [fieldKey, value] of Object.entries(query.attributes)) {
        if (value == null || String(value).trim() === "") continue;
        where.push("EXISTS (SELECT 1 FROM inventory_item_values v JOIN inventory_category_fields f ON f.id = v.field_id WHERE v.item_id = ii.id AND f.field_key = ? AND UPPER(COALESCE(v.text_value, '')) = ?)");
        args.push(fieldKey, normalizeInventoryText(value));
      }
    }
    if (query.search?.trim()) {
      const tokens = normalizeInventoryText(query.search).split(" ").filter(Boolean);
      for (const token of tokens) {
        const needle = `%${token}%`;
        where.push("(UPPER(ii.item_code) LIKE ? OR UPPER(ii.display_name) LIKE ? OR EXISTS (SELECT 1 FROM inventory_item_values v WHERE v.item_id = ii.id AND UPPER(COALESCE(v.text_value, '')) LIKE ?))");
        args.push(needle, needle, needle);
      }
    }
    const rows = this.db.prepare(`SELECT ii.*, ic.name as category_name, ic.parent_id as category_parent_id,
        parent.name as parent_category_name,
        iu.code as unit_code, iu.symbol as unit_symbol, COALESCE(isb.quantity_on_hand, 0) as quantity_on_hand
      FROM inventory_items ii
      JOIN inventory_categories ic ON ic.id = ii.category_id
      LEFT JOIN inventory_categories parent ON parent.id = ic.parent_id
      LEFT JOIN inventory_units iu ON iu.id = ii.default_unit_id
      LEFT JOIN inventory_stock_balances isb ON isb.item_id = ii.id
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ii.display_name`).all(...args) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...row,
      // Where the material sits: the top-level kind, and the sub-kind when it has one.
      top_category_name: String(row.parent_category_name ?? row.category_name ?? ""),
      sub_category_name: row.parent_category_name ? String(row.category_name ?? "") : "",
      // The legacy REAL cost_price column has been retired; this field is synthesized here
      // (in rupees, for the existing app-facing shape) from the sole-authoritative paisa column.
      cost_price: fromPaisaOrNull(row.cost_price_paisa == null ? null : Number(row.cost_price_paisa)),
      values: this.db.prepare("SELECT f.field_key, f.label, f.field_type, v.text_value, v.number_value, v.text_value_urdu FROM inventory_item_values v JOIN inventory_category_fields f ON f.id = v.field_id WHERE v.item_id = ? ORDER BY f.sort_order").all(String(row.id)),
    }));
  },

  /** Filters items exactly like listInventoryItems, then aggregates their stock per unit and (optionally) converts to a target unit. */
  queryInventoryStock(this: SqliteDatabase, filters: { search?: string; categoryId?: string; attributes?: Record<string, string>; targetUnitId?: string } = {}): {
    itemCount: number;
    totalsByUnit: Array<{ unitId: string; unitCode: string; quantity: number }>;
    equivalent?: { unitId: string; unitCode: string; quantity: number };
  } {
    const items = this.listInventoryItems({ search: filters.search, categoryId: filters.categoryId, attributes: filters.attributes });
    const totals = new Map<string, { unitId: string; unitCode: string; quantity: number }>();
    for (const item of items) {
      const unitId = item.default_unit_id as string | null;
      const quantity = Number(item.quantity_on_hand ?? 0);
      if (!unitId || !quantity) continue;
      const entry = totals.get(unitId) ?? { unitId, unitCode: String(item.unit_code ?? ""), quantity: 0 };
      entry.quantity += quantity;
      totals.set(unitId, entry);
    }
    const totalsByUnit = Array.from(totals.values());
    const result: { itemCount: number; totalsByUnit: typeof totalsByUnit; equivalent?: { unitId: string; unitCode: string; quantity: number } } = { itemCount: items.length, totalsByUnit };
    if (filters.targetUnitId) {
      let convertedTotal = 0;
      let allConvertible = totalsByUnit.length > 0;
      for (const entry of totalsByUnit) {
        const converted = this.convertInventoryUnit(entry.quantity, entry.unitId, filters.targetUnitId);
        if (converted == null) { allConvertible = false; break; }
        convertedTotal += converted;
      }
      if (allConvertible) {
        const unit = this.db.prepare("SELECT code FROM inventory_units WHERE id = ?").get(filters.targetUnitId) as { code: string } | undefined;
        result.equivalent = { unitId: filters.targetUnitId, unitCode: unit?.code ?? "", quantity: convertedTotal };
      }
    }
    return result;
  },

  /**
   * Creates one raw material. Assumes the caller has already opened a transaction.
   *
   * Split out of `createInventoryItem` so a bulk import can create every row of a
   * spreadsheet inside ONE transaction — a file that fails half way through must leave no
   * materials behind. Both paths run the same validation, the same signature/duplicate rule
   * and the same audit write; there is no second way to create a material.
   */
  /**
   * Creates one raw material. Assumes the caller has already opened a transaction.
   *
   * Split out of `createInventoryItem` so a bulk import can create every row of a
   * spreadsheet inside ONE transaction — a file that fails half way through must leave no
   * materials behind. Both paths run the same validation, the same signature/duplicate rule
   * and the same audit write; there is no second way to create a material.
   */
  insertInventoryItem(this: SqliteDatabase, input: { categoryId: string; values: Record<string, unknown>; valuesUrdu?: Record<string, unknown>; unitId?: string; stockQuantity?: number; costPrice?: number; createdBy?: string; packName?: string | null; packingQuantity?: number | null; packingUnitId?: string | null }): { id: string; code: string; displayName: string; duplicate?: boolean } {
    const category = this.db.prepare("SELECT * FROM inventory_categories WHERE id = ? AND status = 'ACTIVE'").get(input.categoryId) as Record<string, unknown> | undefined;
    if (!category) throw new Error("Category not found");
    // A material may be filed at any level, including in a category that also has
    // sub-categories: "UPPER" can hold a plain upper of its own as well as the kinds of
    // upper. The owner asked for that freedom explicitly (2026-10-07).
    const fields = this.effectiveCategoryFields(input.categoryId);
    for (const field of fields) {
      if (String(field.field_type) === "UNIT" || !field.is_required) continue;
      const value = input.values[String(field.field_key)];
      if (value == null || String(value).trim() === "") throw new Error(`${field.label} is required`);
    }
    const signature = this.inventorySignature(input.categoryId, fields, input.values);
    const existing = this.db.prepare("SELECT id, item_code, display_name FROM inventory_items WHERE category_id = ? AND signature_hash = ? AND status = 'ACTIVE' LIMIT 1").get(input.categoryId, signature.hash) as { id: string; item_code: string; display_name: string } | undefined;
    if (existing) return { id: existing.id, code: existing.item_code, displayName: existing.display_name, duplicate: true };
    const displayName = this.buildInventoryDisplayName(this.categoryPathName(input.categoryId), fields, input.values);
    const next = this.db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(item_code, 4) AS INTEGER)), 0) + 1 as n FROM inventory_items WHERE item_code LIKE 'RM-%'").get() as { n: number };
    const itemCode = `RM-${String(next.n).padStart(6, "0")}`;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const unitId = input.unitId ?? null;
    this.db.prepare("INSERT INTO inventory_items (id, item_code, category_id, display_name, signature_hash, default_unit_id, cost_price_paisa, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, itemCode, input.categoryId, displayName, signature.hash, unitId, toPaisaOrNull(input.costPrice), input.createdBy ?? null, now, now);
    for (const field of fields) {
      if (String(field.field_type) === "UNIT") continue;
      const raw = input.values[String(field.field_key)];
      if (raw == null || String(raw).trim() === "") continue;
      const isNumber = String(field.field_type) === "NUMBER";
      // Only ever populated today for a Colour field the operator corrected by hand — see
      // materialLabelAttributes, which prefers this over the automatic Urdu translation.
      const urdu = input.valuesUrdu?.[String(field.field_key)];
      const urduText = urdu != null && String(urdu).trim() !== "" ? String(urdu).trim() : null;
      this.db.prepare("INSERT INTO inventory_item_values (id, item_id, field_id, text_value, number_value, text_value_urdu) VALUES (?, ?, ?, ?, ?, ?)")
        .run(crypto.randomUUID(), id, String(field.id), isNumber ? null : normalizeInventoryText(raw), isNumber ? Number(raw) : null, urduText);
    }
    if (input.stockQuantity != null && unitId) {
      this.db.prepare("INSERT INTO inventory_stock_balances (item_id, quantity_on_hand, unit_id, updated_at) VALUES (?, ?, ?, ?)").run(id, input.stockQuantity, unitId, now);
      this.db.prepare("INSERT INTO inventory_stock_events (id, item_id, event_type, quantity, unit_id, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(crypto.randomUUID(), id, "RECEIVE", input.stockQuantity, unitId, "Initial stock", input.createdBy ?? null, now);
    }
    // The pack comes WITH the material, because it is a fact about the kind of thing it is:
    // every colour of DANA — EVA arrives in the same bag. Applied inside the caller's
    // transaction, so a material is never left created but half-configured.
    if (input.packingQuantity != null && input.packingUnitId) {
      this.writeRawMaterialMovementConfig(id, {
        packName: input.packName,
        packingQuantity: input.packingQuantity,
        packingUnitId: input.packingUnitId,
      });
    }

    this.writeInventoryAudit(id, "ITEM", id, "CREATE", null, input, input.createdBy);
    return { id, code: itemCode, displayName };
  },

  /** Creates one raw material in its own transaction. */
  createInventoryItem(this: SqliteDatabase, input: { categoryId: string; values: Record<string, unknown>; valuesUrdu?: Record<string, unknown>; unitId?: string; stockQuantity?: number; costPrice?: number; createdBy?: string; packName?: string | null; packingQuantity?: number | null; packingUnitId?: string | null }): { id: string; code: string; displayName: string; duplicate?: boolean } {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
    const created = this.insertInventoryItem(input);
    this.db.exec("COMMIT");
    return created;
    } catch (error) {
    this.db.exec("ROLLBACK");
    throw error;
    }
  },

  /**
   * Records a stock movement and updates the materialized balance. Assumes the caller has
   * already opened a transaction.
   *
   * Split out of `adjustInventoryStock` so that approving a stock correction can apply the
   * change in the SAME transaction that records the decision — the request and the stock
   * event must never be able to disagree about whether the correction happened. There is
   * still exactly one implementation of what a correction does to stock.
   */
  applyInventoryStockChange(this: SqliteDatabase, input: { itemId: string; quantity: number; eventType?: "RECEIVE" | "ADJUST" | "CONSUME" | "TRANSFER_IN" | "TRANSFER_OUT" | "RETURN"; unitId?: string; note?: string; createdBy?: string }): { unitId: string; quantityOnHand: number } {
    const item = this.db.prepare("SELECT * FROM inventory_items WHERE id = ? AND status = 'ACTIVE'").get(input.itemId) as Record<string, unknown> | undefined;
    if (!item) throw new Error("Item not found");
    const balance = this.db.prepare("SELECT * FROM inventory_stock_balances WHERE item_id = ?").get(input.itemId) as { quantity_on_hand: number; unit_id: string } | undefined;
    const unitId = input.unitId ?? balance?.unit_id ?? (typeof item.default_unit_id === "string" ? item.default_unit_id : undefined);
    if (!unitId) throw new Error("A unit is required to record stock");
    if (balance && balance.unit_id !== unitId) throw new Error("Existing stock for this item is tracked in a different unit");
    const now = new Date().toISOString();
    const eventType = input.eventType ?? "ADJUST";

    this.db.prepare("INSERT INTO inventory_stock_events (id, item_id, event_type, quantity, unit_id, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), input.itemId, eventType, input.quantity, unitId, input.note ?? null, input.createdBy ?? null, now);
    const nextQuantity = (balance?.quantity_on_hand ?? 0) + input.quantity;
    this.db.prepare(`INSERT INTO inventory_stock_balances (item_id, quantity_on_hand, unit_id, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET quantity_on_hand = excluded.quantity_on_hand, unit_id = excluded.unit_id, updated_at = excluded.updated_at`)
      .run(input.itemId, nextQuantity, unitId, now);
    if (!item.default_unit_id) this.db.prepare("UPDATE inventory_items SET default_unit_id = ? WHERE id = ?").run(unitId, input.itemId);

    return { unitId, quantityOnHand: nextQuantity };
  },

  /** Records a stock movement and updates the materialized balance; all items track stock in a single unit. */
  adjustInventoryStock(this: SqliteDatabase, input: { itemId: string; quantity: number; eventType?: "RECEIVE" | "ADJUST" | "CONSUME" | "TRANSFER_IN" | "TRANSFER_OUT" | "RETURN"; unitId?: string; note?: string; createdBy?: string }): void {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.applyInventoryStockChange(input);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  },

  /** Update an inventory item's purchase/cost price. */
  /**
   * One material's stock movements, newest first — the ledger behind its balance.
   *
   * Read-only. Every writer of `inventory_stock_balances` (the two scan use cases and
   * `adjustInventoryStock`) appends here in the same transaction, so this is the single
   * explanation of how a material reached the quantity it is showing.
   */
  listInventoryStockEvents(this: SqliteDatabase, itemId: string, limit = 50): InventoryStockEventRow[] {
    const capped = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 500) : 50;
    const rows = this.db
      .prepare(
        `SELECT e.id, e.item_id, e.event_type, e.quantity, e.unit_id, u.code AS unit_code,
                e.note, e.created_by, e.created_at
         FROM inventory_stock_events e
         LEFT JOIN inventory_units u ON u.id = e.unit_id
         WHERE e.item_id = ?
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT ?`
      )
      .all(itemId, capped) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      itemId: String(row.item_id),
      eventType: String(row.event_type),
      quantity: Number(row.quantity),
      unitId: String(row.unit_id),
      unitCode: row.unit_code ? String(row.unit_code) : null,
      note: row.note ? String(row.note) : null,
      createdBy: row.created_by ? String(row.created_by) : null,
      createdAt: String(row.created_at),
    }));
  },

  /**
   * Sets — or corrects — the unit a material's stock is counted in, for a material saved without
   * one (or with the wrong one).
   *
   * Only while nothing has been recorded in it: no balance, no movement, no printed label (a label
   * stores what its packet holds in this unit). After that, changing the unit would silently
   * change what every recorded figure means — 25 DOZEN would read as 25 KILOGRAM — so it is
   * refused rather than "fixed".
   */
  setInventoryItemUnit(this: SqliteDatabase, input: { itemId: string; unitId: string; updatedBy?: string }): void {
    const item = this.db.prepare("SELECT id, default_unit_id FROM inventory_items WHERE id = ? AND status = 'ACTIVE'").get(input.itemId) as
      | { id: string; default_unit_id: string | null }
      | undefined;
    if (!item) throw new Error("Raw material not found.");
    const unit = this.db.prepare("SELECT id FROM inventory_units WHERE id = ?").get(input.unitId) as { id: string } | undefined;
    if (!unit) throw new Error("Choose a unit from the list.");

    const used = (sql: string) => (this.db.prepare(sql).get(input.itemId) as { n: number }).n > 0;
    if (used("SELECT COUNT(1) AS n FROM inventory_stock_balances WHERE item_id = ?")
      || used("SELECT COUNT(1) AS n FROM inventory_stock_events WHERE item_id = ?")
      || used("SELECT COUNT(1) AS n FROM raw_material_qrs WHERE item_id = ?")) {
      throw new Error("This material already has stock, movements or labels in its unit, so the unit can no longer be changed.");
    }

    const now = new Date().toISOString();
    this.db.prepare("UPDATE inventory_items SET default_unit_id = ?, updated_at = ? WHERE id = ?").run(input.unitId, now, input.itemId);
    this.writeInventoryAudit(input.itemId, "ITEM", input.itemId, "SET_UNIT", { unitId: item.default_unit_id }, { unitId: input.unitId }, input.updatedBy);
  },

  updateInventoryItemPrice(this: SqliteDatabase, itemId: string, costPrice: number | null): void {
    this.db.prepare("UPDATE inventory_items SET cost_price_paisa = ?, updated_at = ? WHERE id = ?").run(toPaisaOrNull(costPrice), new Date().toISOString(), itemId);
  },

  /**
   * Re-states a material in the unit it should always have been counted in, WITHOUT converting
   * any figure — 41 stays 41 and only its unit changes.
   *
   * This is the repair for a unit chosen wrongly at entry time, where the quantities already
   * typed are the real ones and only the label on them is wrong. `setInventoryItemUnit` refuses
   * once stock exists precisely because it cannot know that, so this is a separate, deliberate
   * correction: it re-stamps the unit on the balance and on every recorded movement as well, so
   * nothing is left reading in the old unit. Converting instead is a different operation and
   * belongs in a stock correction, not here.
   */
  correctInventoryItemUnit(this: SqliteDatabase, input: { itemId: string; unitId: string; reason: string; correctedBy?: string }): {
    itemCode: string;
    displayName: string;
    fromUnitCode: string | null;
    toUnitCode: string;
    quantityOnHand: number | null;
    movementsRestamped: number;
  } {
    const reason = String(input.reason ?? "").trim();
    if (!reason) throw new Error("Say why the unit is being corrected — it is kept with the change.");

    const item = this.db.prepare(
      `SELECT i.id, i.item_code, i.display_name, i.default_unit_id, u.code AS unit_code
       FROM inventory_items i LEFT JOIN inventory_units u ON u.id = i.default_unit_id
       WHERE i.id = ?`
    ).get(input.itemId) as { id: string; item_code: string; display_name: string; default_unit_id: string | null; unit_code: string | null } | undefined;
    if (!item) throw new Error("Raw material not found.");

    const unit = this.db.prepare("SELECT id, code FROM inventory_units WHERE id = ?").get(input.unitId) as { id: string; code: string } | undefined;
    if (!unit) throw new Error("Choose a unit from the list.");

    // Labels carry their packet's contents in the unit of the day they were printed, and a
    // printed sticker cannot be re-stamped, so a material that already has labels is left alone.
    const labels = (this.db.prepare("SELECT COUNT(1) AS n FROM raw_material_qrs WHERE item_id = ?").get(input.itemId) as { n: number }).n;
    if (labels > 0) {
      throw new Error(`This material already has ${labels} printed label(s) carrying the old unit, so its unit cannot be corrected.`);
    }

    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.db.prepare("UPDATE inventory_items SET default_unit_id = ?, updated_at = ? WHERE id = ?").run(unit.id, now, item.id);
      this.db.prepare("UPDATE inventory_stock_balances SET unit_id = ?, updated_at = ? WHERE item_id = ?").run(unit.id, now, item.id);
      const movements = this.db.prepare("UPDATE inventory_stock_events SET unit_id = ? WHERE item_id = ?").run(unit.id, item.id);
      const balance = this.db.prepare("SELECT quantity_on_hand FROM inventory_stock_balances WHERE item_id = ?").get(item.id) as { quantity_on_hand: number } | undefined;

      this.writeInventoryAudit(
        item.id, "ITEM", item.id, "CORRECT_UNIT",
        { unitId: item.default_unit_id, unitCode: item.unit_code },
        { unitId: unit.id, unitCode: unit.code, reason, quantitiesUnchanged: true },
        input.correctedBy
      );
      this.db.exec("COMMIT");

      return {
        itemCode: item.item_code,
        displayName: item.display_name,
        fromUnitCode: item.unit_code,
        toUnitCode: unit.code,
        quantityOnHand: balance ? Number(balance.quantity_on_hand) : null,
        movementsRestamped: Number(movements.changes ?? 0),
      };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  /**
   * Why this material cannot be deleted, in the words the operator reads. Empty means deleting
   * it would erase nothing but the material's own definition.
   *
   * Deleting is for a material entered by mistake. Anything that records what actually happened
   * — stock, movements, labels, scans, purchases, programs — makes it history instead, and
   * history is disabled rather than deleted.
   */
  inventoryItemDeleteBlockers(this: SqliteDatabase, itemId: string): string[] {
    const count = (sql: string): number => (this.db.prepare(sql).get(itemId) as { n: number } | undefined)?.n ?? 0;
    const blockers: string[] = [];

    const balance = this.db.prepare(
      `SELECT b.quantity_on_hand, u.code AS unit_code FROM inventory_stock_balances b
       LEFT JOIN inventory_units u ON u.id = b.unit_id WHERE b.item_id = ?`
    ).get(itemId) as { quantity_on_hand: number; unit_code: string | null } | undefined;
    if (balance && Number(balance.quantity_on_hand) !== 0) {
      blockers.push(`${Number(balance.quantity_on_hand)} ${balance.unit_code ?? ""}`.trim() + " in stock");
    }

    const add = (n: number, one: string, many: string) => { if (n > 0) blockers.push(`${n} ${n === 1 ? one : many}`); };
    add(count("SELECT COUNT(1) AS n FROM inventory_stock_events WHERE item_id = ?"), "stock movement", "stock movements");
    add(count("SELECT COUNT(1) AS n FROM raw_material_qrs WHERE item_id = ?"), "QR label", "QR labels");
    add(count("SELECT COUNT(1) AS n FROM raw_material_qr_events WHERE item_id = ?"), "scan", "scans");
    add(count("SELECT COUNT(1) AS n FROM purchase_voucher_line_items WHERE item_id = ?"), "purchase line", "purchase lines");
    add(count("SELECT COUNT(1) AS n FROM stock_correction_requests WHERE item_id = ?"), "stock correction", "stock corrections");
    add(count("SELECT COUNT(1) AS n FROM machine_program_lines WHERE item_id = ?"), "machine program line", "machine program lines");
    add(count("SELECT COUNT(1) AS n FROM machine_program_upper_lines WHERE item_id = ?"), "machine program line", "machine program lines");
    return blockers;
  },

  /** Hides a material from pickers and stock without touching anything it took part in. */
  setInventoryItemStatus(this: SqliteDatabase, input: { itemId: string; status: "ACTIVE" | "INACTIVE"; updatedBy?: string }): void {
    if (input.status !== "ACTIVE" && input.status !== "INACTIVE") throw new Error("Unsupported status.");
    const item = this.db.prepare("SELECT id, status FROM inventory_items WHERE id = ?").get(input.itemId) as { id: string; status: string } | undefined;
    if (!item) throw new Error("Raw material not found.");
    this.db.prepare("UPDATE inventory_items SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?")
      .run(input.status, input.updatedBy ?? null, new Date().toISOString(), input.itemId);
    this.writeInventoryAudit(input.itemId, "ITEM", input.itemId, "SET_STATUS", { status: item.status }, { status: input.status }, input.updatedBy);
  },

  /**
   * Erases a material entered by mistake, along with the rows that are only its own definition
   * (its attribute values, its routing, its unused label counter). Refuses whenever
   * `inventoryItemDeleteBlockers` finds anything that records what actually happened, so no
   * stock figure or history can ever lose the row it points at.
   */
  deleteInventoryItem(this: SqliteDatabase, input: { itemId: string; deletedBy?: string }): { itemCode: string; displayName: string } {
    const item = this.db.prepare("SELECT id, item_code, display_name, category_id FROM inventory_items WHERE id = ?")
      .get(input.itemId) as { id: string; item_code: string; display_name: string; category_id: string } | undefined;
    if (!item) throw new Error("Raw material not found.");

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      // Re-checked inside the transaction: the UI's check could be stale by now.
      const blockers = this.inventoryItemDeleteBlockers(input.itemId);
      if (blockers.length > 0) {
        throw new Error(`This material cannot be deleted — it has ${blockers.join(", ")}. Disable it instead to keep its history.`);
      }

      this.db.prepare("DELETE FROM inventory_item_values WHERE item_id = ?").run(input.itemId);
      this.db.prepare("DELETE FROM inventory_stock_balances WHERE item_id = ?").run(input.itemId);
      this.db.prepare("DELETE FROM raw_material_qr_sequences WHERE item_id = ?").run(input.itemId);
      // The audit trail outlives the material, so its rows let go of the id that is about to
      // disappear (foreign keys are enforced) while keeping what was done and to what.
      this.db.prepare("UPDATE inventory_item_audit SET item_id = NULL WHERE item_id = ?").run(input.itemId);
      this.db.prepare("DELETE FROM inventory_items WHERE id = ?").run(input.itemId);

      this.writeInventoryAudit(
        null, "ITEM", input.itemId, "DELETE",
        { itemCode: item.item_code, displayName: item.display_name, categoryId: item.category_id }, null, input.deletedBy
      );
      this.db.exec("COMMIT");
      return { itemCode: item.item_code, displayName: item.display_name };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  /** The materials still carrying a dropdown option's value — what deleting it would orphan. */
  inventoryFieldOptionUsage(this: SqliteDatabase, optionId: string): Array<{ itemCode: string; displayName: string }> {
    const option = this.db.prepare("SELECT field_id, option_value FROM inventory_category_field_options WHERE id = ?")
      .get(optionId) as { field_id: string; option_value: string } | undefined;
    if (!option) return [];
    return (this.db.prepare(
      `SELECT i.item_code AS itemCode, i.display_name AS displayName
       FROM inventory_item_values v JOIN inventory_items i ON i.id = v.item_id
       WHERE v.field_id = ? AND v.text_value = ? ORDER BY i.item_code`
    ).all(option.field_id, option.option_value) as Array<{ itemCode: string; displayName: string }>);
  },

  /**
   * Removes a choice from an attribute's dropdown. Refused while any material still carries
   * that value, so an existing material can never be left describing itself with a choice the
   * category no longer offers. The row is removed outright rather than hidden: items record the
   * chosen text, not this row, so nothing points at it, and hiding it would block ever adding
   * the same value back.
   */
  deleteInventoryFieldOption(this: SqliteDatabase, input: { optionId: string; deletedBy?: string }): { optionValue: string } {
    const option = this.db.prepare(
      `SELECT o.id, o.field_id, o.option_value, f.label AS field_label, f.category_id
       FROM inventory_category_field_options o JOIN inventory_category_fields f ON f.id = o.field_id
       WHERE o.id = ?`
    ).get(input.optionId) as { id: string; field_id: string; option_value: string; field_label: string; category_id: string } | undefined;
    if (!option) throw new Error("Option not found.");

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const used = this.inventoryFieldOptionUsage(input.optionId);
      if (used.length > 0) {
        const names = used.slice(0, 3).map((row) => row.itemCode).join(", ");
        throw new Error(`"${option.option_value}" is still used by ${used.length} material(s) (${names}${used.length > 3 ? ", …" : ""}). Change or delete those first.`);
      }
      this.db.prepare("DELETE FROM inventory_category_field_options WHERE id = ?").run(input.optionId);
      this.writeInventoryAudit(
        null, "CATEGORY_FIELD_OPTION", input.optionId, "DELETE",
        { fieldId: option.field_id, fieldLabel: option.field_label, optionValue: option.option_value }, null, input.deletedBy
      );
      this.db.exec("COMMIT");
      return { optionValue: option.option_value };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  // ─── Store movement configuration ──────────────────────────────────────────────
  // What one printed label of a raw material is physically worth (its packing), and where
  // a packet goes when it leaves the store (its section). Both are master data on the
  // material, so the Store scanner never has to ask the operator anything.

  listWorkSections(this: SqliteDatabase, includeInactive = false): WorkSection[] {
    const rows = this.db
      .prepare(
        `SELECT id, section_code, name, status FROM work_sections
         ${includeInactive ? "" : "WHERE status = 'ACTIVE'"}
         ORDER BY name`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      sectionCode: String(row.section_code),
      name: String(row.name),
      status: String(row.status),
    }));
  },

  /** Idempotent on name: a section that already exists is returned rather than duplicated. */
  createWorkSection(this: SqliteDatabase, input: { name: string }): WorkSection {
    const name = normalizeInventoryText(input.name);
    if (!name) throw new Error("Section name is required.");

    const existing = this.db
      .prepare("SELECT id, section_code, name, status FROM work_sections WHERE name = ? LIMIT 1")
      .get(name) as Record<string, unknown> | undefined;
    if (existing) {
      return {
        id: String(existing.id),
        sectionCode: String(existing.section_code),
        name: String(existing.name),
        status: String(existing.status),
      };
    }

    const next = this.db
      .prepare("SELECT COALESCE(MAX(CAST(SUBSTR(section_code, 4) AS INTEGER)), 0) + 1 as n FROM work_sections WHERE section_code LIKE 'WS-%'")
      .get() as { n: number };
    const sectionCode = `WS-${String(next.n).padStart(3, "0")}`;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO work_sections (id, section_code, name, status, created_at, updated_at) VALUES (?, ?, ?, 'ACTIVE', ?, ?)")
      .run(id, sectionCode, name, now, now);
    return { id, sectionCode, name, status: "ACTIVE" };
  },

  setWorkSectionStatus(this: SqliteDatabase, id: string, status: "ACTIVE" | "INACTIVE"): void {
    this.db.prepare("UPDATE work_sections SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), id);
  },

  /**
   * Sets a material's packing and destination. Passing null to a field clears it, which
   * takes the material back out of Store movement until it is configured again — deliberate,
   * because a packet with no packing has no defensible effect on stock.
   */
  /**
   * Writes a material's pack. Assumes the caller has already opened a transaction.
   *
   * Split out of `setRawMaterialMovementConfig` for the same reason the hops and the stock
   * change were: creating a material and setting up a whole sub-category both write this
   * inside a transaction of their own, and a pack half-written is a pack nobody can trust.
   */
  writeRawMaterialMovementConfig(
    this: SqliteDatabase,
    itemId: string,
    input: {
      packingQuantity: number | null;
      packingUnitId: string | null;
      packName?: string | null;
    }
  ): void {
    const item = this.db.prepare("SELECT id FROM inventory_items WHERE id = ? LIMIT 1").get(itemId) as { id: string } | undefined;
    if (!item) throw new Error("Raw material not found.");

    const quantity = input.packingQuantity;
    if (quantity != null) {
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error("Packing quantity must be greater than zero.");
      }
      if (!input.packingUnitId) {
        throw new Error("Choose the unit the packing quantity is measured in.");
      }
    }
    if (quantity == null && input.packingUnitId) {
      throw new Error("Enter how much is in one packet, or clear the unit as well.");
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE inventory_items
         SET packing_quantity = ?, packing_unit_id = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(quantity ?? null, input.packingUnitId ?? null, now, itemId);

    // The pack's NAME is the store's own word for the container (BAG, ROLL, TIN). It is
    // written only when the caller says something about it: leaving it out of the call
    // leaves whatever was there, and passing an empty string clears it to the default.
    if (input.packName !== undefined) {
      const packName = String(input.packName ?? "").trim().toUpperCase() || null;
      this.db.prepare("UPDATE inventory_items SET pack_name = ?, updated_at = ? WHERE id = ?").run(packName, now, itemId);
    }

  },

  setRawMaterialMovementConfig(
    this: SqliteDatabase,
    itemId: string,
    input: {
      packingQuantity: number | null;
      packingUnitId: string | null;
      packName?: string | null;
    }
  ): void {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      this.writeRawMaterialMovementConfig(itemId, input);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  /**
   * Whether a pack measured in `packingUnitId` can reach a balance held in `stockUnitId`.
   *
   * True when there is nothing to reconcile (no packing yet, or no stock unit yet — the
   * first movement establishes the balance in the pack's own unit), when the two are the
   * same unit, or when a conversion exists either way round. False is a material that looks
   * set up but whose every scan would be refused.
   */
  packingReachesStock(this: SqliteDatabase, packingUnitId: string | null, stockUnitId: string | null): boolean {
    if (!packingUnitId || !stockUnitId) return true;
    if (packingUnitId === stockUnitId) return true;
    return this.convertInventoryUnit(1, packingUnitId, stockUnitId) != null;
  },

  /**
   * One pack, in the unit the material's stock is counted in.
   *
   * A pack of 25 KILOGRAM on a material stocked in KILOGRAM is 25. A pack of 2 DOZEN on a
   * material stocked in PIECE is 24, not 2. That difference is the whole reason this is
   * computed here rather than on a screen: the conversion table is here.
   *
   * Null when there is no packing, or when a pack could never reach the balance — a screen
   * must then show the measured balance rather than invent a pack count.
   */
  packSizeInStockUnit(
    this: SqliteDatabase,
    packingQuantity: number | null,
    packingUnitId: string | null,
    stockUnitId: string | null
  ): number | null {
    if (packingQuantity == null || !Number.isFinite(packingQuantity) || packingQuantity <= 0) return null;
    // No stock unit yet means no balance yet: the first movement establishes it in the
    // pack's own unit, so the pack is its own size.
    if (!packingUnitId || !stockUnitId || packingUnitId === stockUnitId) return packingQuantity;
    return this.convertInventoryUnit(packingQuantity, packingUnitId, stockUnitId);
  },

  /**
   * The setup a new material in this category should start from.
   *
   * DANA — EVA — BLACK, RED and BLUE are one material in three colours: the same unit, the
   * same bag, the same machine. So a sub-category remembers the material in it that was
   * configured most recently, and the next one starts from there.
   *
   * Deliberately DERIVED rather than stored as a category default: there is then no second
   * place to keep the packing, and no way for a "category default" to drift away from what
   * the materials in that category actually use.
   */
  rawMaterialSetupTemplate(this: SqliteDatabase, categoryId: string): RawMaterialSetupTemplate | null {
    const materialCount = (
      this.db
        .prepare("SELECT COUNT(1) AS n FROM inventory_items WHERE category_id = ? AND status = 'ACTIVE'")
        .get(categoryId) as { n: number }
    ).n;

    const row = this.db
      .prepare(
        `SELECT ii.id, ii.display_name, ii.default_unit_id, u.code AS unit_code,
                ii.pack_name, ii.packing_quantity, ii.packing_unit_id, pu.code AS packing_unit_code
         FROM inventory_items ii
         LEFT JOIN inventory_units u ON u.id = ii.default_unit_id
         LEFT JOIN inventory_units pu ON pu.id = ii.packing_unit_id
         WHERE ii.category_id = ? AND ii.status = 'ACTIVE'
           AND ii.packing_quantity IS NOT NULL
         ORDER BY ii.updated_at DESC, ii.created_at DESC
         LIMIT 1`
      )
      .get(categoryId) as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      sourceItemId: String(row.id),
      sourceDisplayName: String(row.display_name ?? ""),
      hops: [],
      unitId: row.default_unit_id ? String(row.default_unit_id) : null,
      unitCode: row.unit_code ? String(row.unit_code) : null,
      packName: row.pack_name ? String(row.pack_name) : null,
      packingQuantity: row.packing_quantity == null ? null : Number(row.packing_quantity),
      packingUnitId: row.packing_unit_id ? String(row.packing_unit_id) : null,
      packingUnitCode: row.packing_unit_code ? String(row.packing_unit_code) : null,
      materialCount,
    };
  },

  /**
   * Gives every material in a category the same pack and route, in one transaction.
   *
   * For the day the bag changes from 25 kg to 50 kg: that is one fact about DANA — EVA, not
   * ten facts about ten colours. The stock UNIT is deliberately NOT part of this — changing
   * what a material is counted in while it holds stock would reinterpret its balance.
   */
  applyRawMaterialSetupToCategory(
    this: SqliteDatabase,
    categoryId: string,
    setup: {
      packName?: string | null;
      /** Left out writes only the route — what a packet holds is now entered per label run. */
      packingQuantity?: number | null;
      packingUnitId?: string | null;
    }
  ): { updated: number } {
    const items = this.db
      .prepare("SELECT id FROM inventory_items WHERE category_id = ? AND status = 'ACTIVE'")
      .all(categoryId) as Array<{ id: string }>;

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      for (const item of items) {
        if (setup.packingQuantity === undefined) continue;
        this.writeRawMaterialMovementConfig(item.id, {
          packName: setup.packName,
          packingQuantity: setup.packingQuantity,
          packingUnitId: setup.packingUnitId ?? null,
        });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { updated: items.length };
  },

  /**
   * How many labelled packets of each material are standing in the store right now.
   *
   * A packet's contents are written on its own label when it is printed (5 DOZEN on one,
   * 3 DOZEN on the next), so the balance cannot be divided into packets — they are counted.
   * Stock that arrived without a label (opening stock, an approved correction) is in the
   * balance but in no packet.
   */
  labelledRawMaterialPackets(
    this: SqliteDatabase,
    db: DatabaseSync,
    itemId?: string
  ): Map<string, { packets: number; contents: number }> {
    // Grouped by what the label says it holds, so a run of 50 labels is one row, not fifty.
    const rows = db
      .prepare(
        `SELECT q.item_id,
                COALESCE(q.packing_quantity, ii.packing_quantity) AS quantity,
                COALESCE(q.packing_unit_id, ii.packing_unit_id) AS unit_id,
                COALESCE(isb.unit_id, ii.default_unit_id) AS stock_unit_id,
                COUNT(1) AS packets
         FROM raw_material_qrs q
         JOIN inventory_items ii ON ii.id = q.item_id
         LEFT JOIN inventory_stock_balances isb ON isb.item_id = q.item_id
         WHERE q.current_status = 'IN_STORE' AND q.status <> 'VOID' AND (? IS NULL OR q.item_id = ?)
         GROUP BY q.item_id, quantity, unit_id, stock_unit_id`
      )
      .all(itemId ?? null, itemId ?? null) as Array<Record<string, unknown>>;

    const byItem = new Map<string, { packets: number; contents: number }>();
    for (const row of rows) {
      const id = String(row.item_id);
      const packets = Number(row.packets ?? 0);
      const each: number | null = this.packSizeInStockUnit(
        row.quantity == null ? null : Number(row.quantity),
        row.unit_id ? String(row.unit_id) : null,
        row.stock_unit_id ? String(row.stock_unit_id) : null
      );
      const current = byItem.get(id) ?? { packets: 0, contents: 0 };
      byItem.set(id, { packets: current.packets + packets, contents: current.contents + (each ?? 0) * packets });
    }
    return byItem;
  },

  /** A material's route, in order. */
  listRawMaterialMovementConfig(this: SqliteDatabase, search = ""): RawMaterialMovementConfigRow[] {
    const needle = normalizeInventoryText(search);
    const rows = this.db
      .prepare(
        `SELECT ii.id, ii.item_code, ii.display_name, ${EFFECTIVE_PACK_NAME_SQL} AS pack_name,
                ii.packing_quantity, ii.packing_unit_id, u.code AS packing_unit_code,
                COALESCE(isb.unit_id, ii.default_unit_id) AS stock_unit_id,
                su.code AS stock_unit_code, COALESCE(isb.quantity_on_hand, 0) AS quantity_on_hand,
                NULL AS default_section_id, NULL AS section_name
         FROM inventory_items ii
         LEFT JOIN inventory_units u ON u.id = ii.packing_unit_id
         LEFT JOIN inventory_stock_balances isb ON isb.item_id = ii.id
         LEFT JOIN inventory_units su ON su.id = COALESCE(isb.unit_id, ii.default_unit_id)
         WHERE ii.status = 'ACTIVE'
           AND (? = '' OR UPPER(ii.display_name) LIKE ? OR UPPER(ii.item_code) LIKE ?)
         ORDER BY ii.display_name`
      )
      .all(needle, `%${needle}%`, `%${needle}%`) as Array<Record<string, unknown>>;

    const labelled: Map<string, { packets: number; contents: number }> = this.labelledRawMaterialPackets(this.db);
    return rows.map((row) => ({
      itemId: String(row.id),
      itemCode: String(row.item_code),
      displayName: String(row.display_name),
      packName: row.pack_name ? String(row.pack_name) : null,
      packingQuantity: row.packing_quantity == null ? null : Number(row.packing_quantity),
      packetsInStore: countPacketsInStore({
        labelledPackets: labelled.get(String(row.id))?.packets ?? 0,
        labelledContents: labelled.get(String(row.id))?.contents ?? 0,
        quantityOnHand: Number(row.quantity_on_hand ?? 0),
        fixedPackSize: this.packSizeInStockUnit(
          row.packing_quantity == null ? null : Number(row.packing_quantity),
          row.packing_unit_id ? String(row.packing_unit_id) : null,
          row.stock_unit_id ? String(row.stock_unit_id) : null
        ),
      }),
      packingUnitId: row.packing_unit_id ? String(row.packing_unit_id) : null,
      packingUnitCode: row.packing_unit_code ? String(row.packing_unit_code) : null,
      stockUnitId: row.stock_unit_id ? String(row.stock_unit_id) : null,
      stockUnitCode: row.stock_unit_code ? String(row.stock_unit_code) : null,
      packingConvertsToStock: this.packingReachesStock(
        row.packing_unit_id ? String(row.packing_unit_id) : null,
        row.stock_unit_id ? String(row.stock_unit_id) : null
      ),
      packSizeInStockUnit: this.packSizeInStockUnit(
        row.packing_quantity == null ? null : Number(row.packing_quantity),
        row.packing_unit_id ? String(row.packing_unit_id) : null,
        row.stock_unit_id ? String(row.stock_unit_id) : null
      ),
      defaultSectionId: null,
      defaultSectionName: null,
      hops: [],
    }));
  },
};

export type RawMaterialsMethods = typeof rawMaterialsMethods;
