// ONE-TIME SEEDING OF PRODUCT MASTER DATA FROM ONE INSTALLATION INTO ANOTHER.
//
// A carton's identity names a product variant by id. A second computer cannot hold that carton
// until it holds a product_variants row with THE SAME id — and ids are minted with
// crypto.randomUUID(), so creating "the same" product through the Product form produces a
// different one. This moves the rows across with their ids intact.
//
// WHY SEVEN TABLES AND NOT ONE. product_variants is not standalone. Every variant the ERP
// creates points at an article_sizes row, and copies that row's group and series links:
//
//   main_groups ─┐
//   product_groups ─┬─→ article_sizes ─┐
//   article_series ─┘                  ├─→ product_variants
//   product_types ─────────────────────┤
//   product_sub_groups ────────────────┘   (product_sub_groups also needs product_groups)
//
// Exporting the variant alone would produce a row the target must refuse, so the export walks
// up and takes exactly the parents the chosen variants need — nothing else.
//
// WHAT THIS DELIBERATELY IS NOT. It is a one-time seed, not synchronisation: no deltas, no
// cursors, no schedule, and no merging. It never updates or deletes an existing row. A product
// that already differs on the two computers is reported as a conflict and the whole import is
// refused — reconciling master data is a decision for a person, not for this file.
//
// IT IS FOR A FRESH TARGET. Running it into an installation that already has its own products is
// how you get conflicts, which is the correct outcome rather than a merge.

import type { SqliteDatabase } from "../sqliteDatabase.js";

export const PRODUCT_VARIANT_SEED_FORMAT = "777-erp.product-variant-seed";
export const PRODUCT_VARIANT_SEED_VERSION = 1;

/** One row as it travels: column name to value, exactly as SQLite returned it. */
export type SeedRow = Record<string, string | number | null>;

export interface ProductVariantSeedFile {
  readonly format: string;
  readonly version: number;
  readonly generatedAt: string;
  /** Keyed by table name, in dependency order. */
  readonly tables: Record<string, SeedRow[]>;
}

interface SeedTable {
  readonly table: string;
  /** The natural key, so a row that already exists under a DIFFERENT id is caught. */
  readonly uniqueKey: readonly string[] | null;
  /** Columns that point at another table in this bundle. */
  readonly parents: readonly { readonly column: string; readonly table: string }[];
}

/**
 * The bundle, in the order rows must be inserted. Fixed and audited: nothing a caller passes
 * ever becomes a table name.
 */
export const SEED_TABLES: readonly SeedTable[] = [
  { table: "main_groups", uniqueKey: ["group_name"], parents: [] },
  { table: "product_groups", uniqueKey: ["group_name"], parents: [] },
  { table: "article_series", uniqueKey: ["name"], parents: [] },
  { table: "product_types", uniqueKey: ["name"], parents: [] },
  {
    table: "product_sub_groups",
    uniqueKey: null,
    parents: [{ column: "product_group_id", table: "product_groups" }],
  },
  {
    table: "article_sizes",
    uniqueKey: ["article", "size"],
    parents: [
      { column: "main_group_id", table: "main_groups" },
      { column: "product_group_id", table: "product_groups" },
      { column: "article_series_id", table: "article_series" },
    ],
  },
  {
    table: "product_variants",
    uniqueKey: ["article", "color", "size"],
    parents: [
      { column: "main_group_id", table: "main_groups" },
      { column: "product_group_id", table: "product_groups" },
      { column: "article_series_id", table: "article_series" },
      { column: "article_size_id", table: "article_sizes" },
      { column: "product_type_id", table: "product_types" },
      { column: "product_sub_group_id", table: "product_sub_groups" },
    ],
  },
];

const SEED_TABLE_NAMES: readonly string[] = SEED_TABLES.map((spec) => spec.table);

// ─── Reading the shape of a table, rather than assuming it ──────────────────
//
// Columns are read from the database instead of being written out here, so a migration that
// adds one does not quietly make the export lose a field. The TABLE names are still fixed.

interface ColumnInfo {
  readonly name: string;
  readonly required: boolean;
}

function columnsOf(db: SqliteDatabase, table: string): ColumnInfo[] {
  const rows = db.db.prepare(`SELECT name, "notnull" AS required, dflt_value FROM pragma_table_info(?)`).all(table) as
    Array<{ name: string; required: number; dflt_value: string | null }>;
  return rows.map((row) => ({
    name: String(row.name),
    // A NOT NULL column with a default can be left out of a file; one without cannot.
    required: Number(row.required) === 1 && row.dflt_value === null,
  }));
}

// ─── Export ─────────────────────────────────────────────────────────────────

export interface SeedExportResult {
  readonly file: ProductVariantSeedFile;
  /** Variant ids that were asked for and do not exist here. */
  readonly missingVariantIds: readonly string[];
  readonly counts: Record<string, number>;
}

/**
 * The chosen variants plus exactly the parent rows they need.
 *
 * Parents are gathered by following each row's own foreign keys, so the bundle is closed: every
 * id any row points at is either in the bundle or was null to begin with.
 */
export function exportProductVariantSeed(db: SqliteDatabase, variantIds: readonly string[]): SeedExportResult {
  const wanted = [...new Set(variantIds.map((id) => id.trim()).filter((id) => id !== ""))];
  const collected = new Map<string, Map<string, SeedRow>>();
  for (const name of SEED_TABLE_NAMES) collected.set(name, new Map());

  const variants = wanted
    .map((id) => readRow(db, "product_variants", id))
    .filter((row): row is SeedRow => row !== null);
  const found = new Set(variants.map((row) => String(row.id)));
  for (const row of variants) collected.get("product_variants")?.set(String(row.id), row);

  // Walk upwards until nothing new is needed. The graph is small, fixed and acyclic.
  let frontier: Array<{ table: string; row: SeedRow }> = variants.map((row) => ({ table: "product_variants", row }));
  while (frontier.length > 0) {
    const next: Array<{ table: string; row: SeedRow }> = [];
    for (const { table, row } of frontier) {
      const spec = SEED_TABLES.find((candidate) => candidate.table === table);
      for (const parent of spec?.parents ?? []) {
        const parentId = row[parent.column];
        if (typeof parentId !== "string" || parentId === "") continue;
        const bucket = collected.get(parent.table);
        if (bucket === undefined || bucket.has(parentId)) continue;
        const parentRow = readRow(db, parent.table, parentId);
        if (parentRow === null) continue; // A dangling link here is the source's problem, not ours.
        bucket.set(parentId, parentRow);
        next.push({ table: parent.table, row: parentRow });
      }
    }
    frontier = next;
  }

  const tables: Record<string, SeedRow[]> = {};
  const counts: Record<string, number> = {};
  for (const name of SEED_TABLE_NAMES) {
    const rows = [...(collected.get(name)?.values() ?? [])];
    tables[name] = rows;
    counts[name] = rows.length;
  }

  return {
    file: {
      format: PRODUCT_VARIANT_SEED_FORMAT,
      version: PRODUCT_VARIANT_SEED_VERSION,
      generatedAt: new Date().toISOString(),
      tables,
    },
    missingVariantIds: wanted.filter((id) => !found.has(id)),
    counts,
  };
}

function readRow(db: SqliteDatabase, table: string, id: string): SeedRow | null {
  const names = columnsOf(db, table).map((column) => column.name);
  if (names.length === 0) return null;
  const row = db.db.prepare(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`).get(id) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  const copy: SeedRow = {};
  for (const name of names) copy[name] = normalize(row[name]);
  return copy;
}

const normalize = (value: unknown): string | number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "bigint") return Number(value);
  return String(value);
};

// ─── Import ─────────────────────────────────────────────────────────────────

export type SeedOutcome = "IMPORTED" | "ALREADY_PRESENT" | "CONFLICT" | "REJECTED";

export interface SeedVerdict {
  readonly table: string;
  readonly id: string;
  readonly outcome: SeedOutcome;
  readonly reason?: string;
}

export interface SeedImportResult {
  /** True when the bundle was clean. On false, NOTHING was written. */
  readonly accepted: boolean;
  readonly dryRun: boolean;
  readonly imported: number;
  readonly alreadyPresent: number;
  readonly conflicts: readonly SeedVerdict[];
  readonly rejected: readonly SeedVerdict[];
  readonly verdicts: readonly SeedVerdict[];
  /** Set when the file itself could not be read. Nothing was examined.  */
  readonly fileError?: string;
}

const refuse = (fileError: string): SeedImportResult => ({
  accepted: false,
  dryRun: true,
  imported: 0,
  alreadyPresent: 0,
  conflicts: [],
  rejected: [],
  verdicts: [],
  fileError,
});

/** The file, checked before a single row is looked at. */
export function readSeedFile(value: unknown): ProductVariantSeedFile | string {
  if (typeof value !== "object" || value === null) return "the file is not an object";
  const record = value as Record<string, unknown>;
  if (record.format !== PRODUCT_VARIANT_SEED_FORMAT) return "the file is not a product variant seed";
  if (record.version !== PRODUCT_VARIANT_SEED_VERSION) {
    return `this build reads seed version ${String(PRODUCT_VARIANT_SEED_VERSION)}, the file is version ${String(record.version)}`;
  }
  if (typeof record.tables !== "object" || record.tables === null) return "the file has no tables";

  const tables = record.tables as Record<string, unknown>;
  for (const name of Object.keys(tables)) {
    if (!SEED_TABLE_NAMES.includes(name)) return `the file contains a table this seed does not carry: ${name}`;
  }
  for (const name of SEED_TABLE_NAMES) {
    const rows = tables[name];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) return `${name} is not a list of rows`;
    for (const row of rows) {
      if (typeof row !== "object" || row === null) return `${name} contains something that is not a row`;
      const id = (row as Record<string, unknown>).id;
      if (typeof id !== "string" || id.trim() === "") return `${name} contains a row with no id`;
    }
  }
  return value as ProductVariantSeedFile;
}

/**
 * Brings a bundle in, or explains why it will not.
 *
 * ALL OR NOTHING. Every row is judged first; a single conflict or rejection refuses the whole
 * bundle and writes nothing, because half a product master is worse than none. `dryRun` performs
 * exactly the same judging and is the honest preview of what a real run would do.
 */
export function importProductVariantSeed(
  db: SqliteDatabase,
  value: unknown,
  options: { dryRun: boolean }
): SeedImportResult {
  const file = readSeedFile(value);
  if (typeof file === "string") return refuse(file);

  const verdicts: SeedVerdict[] = [];
  /** Ids this bundle will have created by the time a later table is inserted. */
  const willExist = new Map<string, Set<string>>();
  for (const name of SEED_TABLE_NAMES) willExist.set(name, new Set());

  for (const spec of SEED_TABLES) {
    const rows = file.tables[spec.table] ?? [];
    const columns = columnsOf(db, spec.table);
    if (columns.length === 0 && rows.length > 0) {
      for (const row of rows) {
        verdicts.push({ table: spec.table, id: String(row.id), outcome: "REJECTED", reason: "this installation has no such table" });
      }
      continue;
    }
    for (const row of rows) {
      const verdict = judge(db, spec, row, columns, willExist);
      verdicts.push(verdict);
      if (verdict.outcome === "IMPORTED" || verdict.outcome === "ALREADY_PRESENT") {
        willExist.get(spec.table)?.add(String(row.id));
      }
    }
  }

  const conflicts = verdicts.filter((verdict) => verdict.outcome === "CONFLICT");
  const rejected = verdicts.filter((verdict) => verdict.outcome === "REJECTED");
  const toImport = verdicts.filter((verdict) => verdict.outcome === "IMPORTED");
  const alreadyPresent = verdicts.filter((verdict) => verdict.outcome === "ALREADY_PRESENT").length;

  const clean = conflicts.length === 0 && rejected.length === 0;
  if (clean && !options.dryRun && toImport.length > 0) {
    writeAll(db, file);
  }

  return {
    accepted: clean,
    dryRun: options.dryRun,
    imported: toImport.length,
    alreadyPresent,
    conflicts,
    rejected,
    verdicts,
  };
}

function judge(
  db: SqliteDatabase,
  spec: SeedTable,
  row: SeedRow,
  columns: readonly ColumnInfo[],
  willExist: Map<string, Set<string>>
): SeedVerdict {
  const id = String(row.id);
  const here = { table: spec.table, id };
  const known = new Set(columns.map((column) => column.name));

  for (const name of Object.keys(row)) {
    if (!known.has(name)) {
      return { ...here, outcome: "REJECTED", reason: `this installation's ${spec.table} has no column ${name}` };
    }
  }
  for (const column of columns) {
    if (column.required && (row[column.name] === undefined || row[column.name] === null)) {
      return { ...here, outcome: "REJECTED", reason: `${column.name} is required and the file does not supply it` };
    }
  }

  // Every parent must already be here, or be arriving earlier in this same bundle.
  for (const parent of spec.parents) {
    const parentId = row[parent.column];
    if (typeof parentId !== "string" || parentId === "") continue;
    const arriving = willExist.get(parent.table)?.has(parentId) === true;
    if (!arriving && readRow(db, parent.table, parentId) === null) {
      return {
        ...here,
        outcome: "REJECTED",
        reason: `needs ${parent.table} ${parentId}, which is neither here nor in the file`,
      };
    }
  }

  const existing = readRow(db, spec.table, id);
  if (existing !== null) {
    const differing = Object.keys(row).filter((name) => !sameValue(row[name], existing[name]));
    return differing.length === 0
      ? { ...here, outcome: "ALREADY_PRESENT" }
      : { ...here, outcome: "CONFLICT", reason: `already here with a different ${differing.join(", ")}` };
  }

  // A new id, but the natural key may already belong to a different row — the same product
  // created separately on both computers. Importing would breach UNIQUE, and overwriting would
  // be the silent merge this file refuses to do.
  if (spec.uniqueKey !== null) {
    const clash = findByUniqueKey(db, spec, row);
    if (clash !== null) {
      return {
        ...here,
        outcome: "CONFLICT",
        reason: `${spec.uniqueKey.join("/")} already belongs to ${clash}`,
      };
    }
  }

  return { ...here, outcome: "IMPORTED" };
}

function findByUniqueKey(db: SqliteDatabase, spec: SeedTable, row: SeedRow): string | null {
  const key = spec.uniqueKey;
  if (key === null) return null;
  const where = key.map((column) => `${column} IS ?`).join(" AND ");
  const found = db.db
    .prepare(`SELECT id FROM ${spec.table} WHERE ${where} LIMIT 1`)
    .get(...key.map((column) => row[column] ?? null)) as { id: string } | undefined;
  return found === undefined ? null : String(found.id);
}

/** SQLite hands back 1 where JSON carried 1; a stored "1" and a sent 1 mean the same thing. */
const sameValue = (a: unknown, b: unknown): boolean => {
  const left = a === undefined ? null : a;
  const right = b === undefined ? null : b;
  if (left === null || right === null) return left === right;
  return String(left) === String(right);
};

/**
 * Writes the whole bundle in dependency order, inside one transaction.
 *
 * `ON CONFLICT(id) DO NOTHING` covers the rows already judged ALREADY_PRESENT, so re-running a
 * bundle is a no-op rather than an error. Any failure rolls the lot back: there is no state in
 * which half the products arrived.
 */
function writeAll(db: SqliteDatabase, file: ProductVariantSeedFile): void {
  db.db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    for (const spec of SEED_TABLES) {
      for (const row of file.tables[spec.table] ?? []) {
        const names = Object.keys(row);
        const placeholders = names.map(() => "?").join(", ");
        db.db
          .prepare(
            `INSERT INTO ${spec.table} (${names.join(", ")}) VALUES (${placeholders})
             ON CONFLICT(id) DO NOTHING`
          )
          .run(...names.map((name) => row[name]));
      }
    }
    db.db.exec("COMMIT");
  } catch (error) {
    db.db.exec("ROLLBACK");
    throw error;
  }
}

export const productVariantSeedMethods = {
  /** The chosen variants and every parent row they need, ids intact. */
  exportProductVariantSeed(this: SqliteDatabase, variantIds: readonly string[]): SeedExportResult {
    return exportProductVariantSeed(this, variantIds);
  },

  /** Judges a bundle and, unless `dryRun`, writes it in one transaction. */
  importProductVariantSeed(
    this: SqliteDatabase,
    value: unknown,
    options: { dryRun: boolean } = { dryRun: true }
  ): SeedImportResult {
    return importProductVariantSeed(this, value, options);
  },
};

export type ProductVariantSeedMethods = typeof productVariantSeedMethods;
