// Bulk creation of raw materials from a spreadsheet.
//
// This is the ONE import in the Raw Material module, and it is deliberately narrow: master
// data only. Stock movements, receipts, issues, packing scans and QR history are records of
// things that physically happened, and a spreadsheet cannot testify to that — importing them
// would let a typo rewrite what the store did. Those stay export-only.
//
// Everything a row can do here, the UI can already do one material at a time, through the
// same `insertInventoryItem`: the same required-attribute rules, the same signature-based
// duplicate rule, the same audit write. The import adds no way to create a material that the
// single-material form could not; it only does it 200 times in one transaction.
//
//   validate → verdict per row → preview → confirm → one transaction → summary
//
// `dryRun` runs exactly the same validation as the real thing, so the preview cannot promise
// something the import then refuses.

import type { SqliteDatabase } from "../sqliteDatabase.js";
import { normalizeInventoryText } from "./shared.js";
import type { InventoryImportOutcome, InventoryImportResult, InventoryImportRowResult } from "./types.js";

/** One spreadsheet row, already parsed into `column heading → cell text`. */
export type ImportRow = Record<string, string>;

const MAX_IMPORT_ROWS = 2000;

/** Headings are matched case- and space-insensitively; operators will not type them exactly. */
const normalizeHeader = (header: string): string => header.trim().toUpperCase().replace(/\s+/g, " ");

export const inventoryImportMethods = {
  /**
   * The columns a spreadsheet must have to create materials in this category.
   *
   * Generated from the category itself rather than fixed, because attributes are per-category:
   * a template for RUBBER UPPER asks for ARTICLE / COLOR / SIZE, one for BUCKLE does not.
   */
  getInventoryImportColumns(
    this: SqliteDatabase,
    categoryId: string
  ): Array<{ header: string; required: boolean; hint: string }> {
    const category = this.db
      .prepare("SELECT id, name FROM inventory_categories WHERE id = ? AND status = 'ACTIVE'")
      .get(categoryId) as { id: string; name: string } | undefined;
    if (!category) throw new Error("Category not found");

    // Everything the category asks for, its parent's attributes included.
    const fields = this.effectiveCategoryFields(categoryId) as unknown as Array<{
      field_key: string;
      label: string;
      field_type: string;
      is_required: number;
    }>;

    const columns = fields
      .filter((field) => field.field_type !== "UNIT")
      .map((field) => ({
        header: field.label,
        required: Boolean(field.is_required),
        hint:
          field.field_type === "NUMBER"
            ? "A number"
            : field.field_type === "DROPDOWN"
              ? this.describeInventoryFieldOptions(categoryId, field.field_key)
              : "Text",
      }));

    return [
      ...columns,
      { header: "Unit", required: false, hint: "The unit code stock is counted in, e.g. DZN" },
      { header: "Opening stock", required: false, hint: "A number. Needs a Unit. Leave blank for none" },
      { header: "Cost price", required: false, hint: "Rupees per unit. A number" },
      { header: "Pack name", required: false, hint: "What one label goes on, e.g. BAG, PACKET, ROLL" },
      { header: "One pack holds", required: false, hint: "How much is inside one pack. A number" },
      { header: "Packing unit", required: false, hint: "The unit the pack is measured in, e.g. KG" },
    ];
  },

  /** "RED, BLACK, BROWN" — the saved options, so the template can show what is valid. */
  describeInventoryFieldOptions(this: SqliteDatabase, categoryId: string, fieldKey: string): string {
    // The attribute may be defined on this category or inherited from its parent.
    const options = this.db
      .prepare(
        `SELECT o.option_value FROM inventory_category_field_options o
         JOIN inventory_category_fields f ON f.id = o.field_id
         WHERE f.field_key = ? AND o.is_active = 1 AND f.is_active = 1
           AND f.category_id IN (?, (SELECT parent_id FROM inventory_categories WHERE id = ?))
         ORDER BY o.sort_order, o.display_label LIMIT 20`
      )
      .all(fieldKey, categoryId, categoryId) as Array<{ option_value: string }>;
    if (options.length === 0) return "Any value (no saved options yet)";
    return `One of: ${options.map((option) => option.option_value).join(", ")}`;
  },

  /**
   * Checks a whole file and, unless `dryRun`, creates every valid row in ONE transaction.
   *
   * A row is rejected rather than guessed at. A row that already exists is reported as a
   * duplicate and left alone — the import never overwrites a material, because an existing
   * material carries stock, labels and history that a spreadsheet knows nothing about.
   */
  importInventoryItems(
    this: SqliteDatabase,
    input: { categoryId: string; rows: ImportRow[]; createdBy?: string; dryRun?: boolean }
  ): InventoryImportResult {
    const category = this.db
      .prepare("SELECT id, name FROM inventory_categories WHERE id = ? AND status = 'ACTIVE'")
      .get(input.categoryId) as { id: string; name: string } | undefined;
    if (!category) throw new Error("Category not found");
    if (!Array.isArray(input.rows) || input.rows.length === 0) throw new Error("The file has no rows.");
    if (input.rows.length > MAX_IMPORT_ROWS) {
      throw new Error(`A file may hold at most ${MAX_IMPORT_ROWS.toLocaleString()} rows. Split it and import again.`);
    }

    const fields = this.effectiveCategoryFields(input.categoryId) as unknown as Array<{
      id: string;
      field_key: string;
      label: string;
      field_type: string;
      is_required: number;
    }>;
    const attributeFields = fields.filter((field) => field.field_type !== "UNIT");

    const units = this.db.prepare("SELECT id, code FROM inventory_units WHERE is_active = 1").all() as Array<{ id: string; code: string }>;
    const unitByCode = new Map(units.map((unit) => [normalizeHeader(unit.code), unit.id]));

    // A missing REQUIRED column is a problem with the file, not with a row: report it once
    // and refuse the whole thing rather than rejecting every row for the same reason.
    const present = new Set(Object.keys(input.rows[0] ?? {}).map(normalizeHeader));
    const missingColumns = attributeFields
      .filter((field) => field.is_required && !present.has(normalizeHeader(field.label)))
      .map((field) => field.label);
    if (missingColumns.length > 0) {
      return {
        categoryName: category.name,
        totalRows: input.rows.length,
        created: 0,
        duplicates: 0,
        rejected: input.rows.length,
        missingColumns,
        applied: false,
        rows: [],
      };
    }

    const cellOf = (row: ImportRow, header: string): string => {
      const wanted = normalizeHeader(header);
      for (const [key, value] of Object.entries(row)) {
        if (normalizeHeader(key) === wanted) return String(value ?? "").trim();
      }
      return "";
    };

    const seenSignatures = new Map<string, number>();
    const results: InventoryImportRowResult[] = [];

    for (let index = 0; index < input.rows.length; index += 1) {
      const row = input.rows[index];
      const rowNumber = index + 1;
      const values: Record<string, string> = {};
      const problems: string[] = [];

      for (const field of attributeFields) {
        const raw = cellOf(row, field.label);
        if (!raw) {
          if (field.is_required) problems.push(`${field.label} is required`);
          continue;
        }
        if (field.field_type === "NUMBER" && !Number.isFinite(Number(raw))) {
          problems.push(`${field.label} must be a number, not "${raw}"`);
          continue;
        }
        values[field.field_key] = raw;
      }

      const unitCode = cellOf(row, "Unit");
      const unitId = unitCode ? unitByCode.get(normalizeHeader(unitCode)) : undefined;
      if (unitCode && !unitId) problems.push(`There is no unit "${unitCode}" — add it under Setup first`);

      const number = (header: string, label: string): number | undefined => {
        const raw = cellOf(row, header);
        if (!raw) return undefined;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          problems.push(`${label} must be a number, not "${raw}"`);
          return undefined;
        }
        return parsed;
      };

      const openingStock = number("Opening stock", "Opening stock");
      const costPrice = number("Cost price", "Cost price");
      const packingQuantity = number("One pack holds", "One pack holds");
      const packNameCell = cellOf(row, "Pack name");
      const packingUnitCode = cellOf(row, "Packing unit");
      const packingUnitId = packingUnitCode ? unitByCode.get(normalizeHeader(packingUnitCode)) : undefined;

      if (packingUnitCode && !packingUnitId) problems.push(`There is no unit "${packingUnitCode}" — add it under Setup first`);
      if (openingStock != null && !unitId) problems.push("Opening stock needs a Unit on the same row");
      if (packingQuantity != null && packingQuantity <= 0) problems.push("One pack holds must be greater than zero");
      if (packingQuantity != null && !packingUnitId) problems.push("One pack holds needs a Packing unit on the same row");
      if (packingQuantity == null && packingUnitId) problems.push("Packing unit needs One pack holds on the same row");

      const categoryPath = this.categoryPathName(input.categoryId) || category.name;
      const describe = () =>
        [categoryPath, ...attributeFields.map((field) => values[field.field_key]).filter(Boolean)].join(" — ");

      if (problems.length > 0) {
        results.push({ rowNumber, outcome: "REJECTED", displayName: describe(), problems });
        continue;
      }

      // Two kinds of duplicate: the same material twice in this file, and a material the
      // database already holds. Both are reported, neither is created.
      const signature = this.inventorySignature(input.categoryId, fields, values);
      const twinRow = seenSignatures.get(signature.hash);
      if (twinRow) {
        results.push({
          rowNumber,
          outcome: "REJECTED",
          displayName: describe(),
          problems: [`The same material is already on row ${twinRow} of this file`],
        });
        continue;
      }
      seenSignatures.set(signature.hash, rowNumber);

      const existing = this.db
        .prepare("SELECT item_code, display_name FROM inventory_items WHERE category_id = ? AND signature_hash = ? AND status = 'ACTIVE' LIMIT 1")
        .get(input.categoryId, signature.hash) as { item_code: string; display_name: string } | undefined;
      if (existing) {
        results.push({
          rowNumber,
          outcome: "DUPLICATE",
          displayName: existing.display_name,
          itemCode: existing.item_code,
          problems: ["Already in the system — left untouched"],
        });
        continue;
      }

      results.push({
        rowNumber,
        outcome: "CREATE",
        displayName: describe(),
        problems: [],
        draft: { values, unitId, openingStock, costPrice, packingQuantity, packingUnitId, packName: packNameCell || undefined },
      });
    }

    const creatable = results.filter((result) => result.outcome === "CREATE");
    const summary = (applied: boolean, rows: InventoryImportRowResult[]): InventoryImportResult => ({
      categoryName: category.name,
      totalRows: input.rows.length,
      created: applied ? creatable.length : 0,
      duplicates: results.filter((result) => result.outcome === "DUPLICATE").length,
      rejected: results.filter((result) => result.outcome === "REJECTED").length,
      missingColumns: [],
      applied,
      rows: rows.map(({ draft: _draft, ...rest }) => rest),
    });

    if (input.dryRun || creatable.length === 0) return summary(false, results);

    // One transaction for the whole file: a spreadsheet either lands completely or not at all.
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      for (const result of creatable) {
        const draft = result.draft!;
        const created = this.insertInventoryItem({
          categoryId: input.categoryId,
          values: draft.values,
          unitId: draft.unitId,
          stockQuantity: draft.openingStock,
          costPrice: draft.costPrice,
          createdBy: input.createdBy,
          packName: draft.packName ?? null,
          packingQuantity: draft.packingQuantity,
          packingUnitId: draft.packingUnitId,
          // The route is a per-material decision with real destinations behind it, so it is
          // never set from a spreadsheet — the Stock tab flags what still needs one.
        });
        result.itemCode = created.code;
        result.displayName = created.displayName;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return summary(true, results);
  },
};

export type InventoryImportMethods = typeof inventoryImportMethods;
export type { InventoryImportOutcome };
export const normalizeImportText = normalizeInventoryText;
