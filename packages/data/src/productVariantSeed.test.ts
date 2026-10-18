import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase, PRODUCT_VARIANT_SEED_FORMAT, PRODUCT_VARIANT_SEED_VERSION } from "./sqliteDatabase.js";
import type { ProductVariantSeedFile } from "./sqliteDatabase.js";

// SEEDING ONE INSTALLATION'S PRODUCT MASTER INTO ANOTHER, IDS INTACT.
//
// A carton names its product by id, so a second computer cannot hold the carton until it holds a
// product_variants row with the SAME id. These tests pin what that move must and must not do:
//
//   * the id survives — that is the whole point
//   * the parents a variant needs travel with it, and a variant whose parents are missing is
//     REFUSED rather than imported half-formed or with its links nulled
//   * running the same bundle twice changes nothing
//   * a product that already exists differently is a CONFLICT, and a conflict refuses the WHOLE
//     bundle — half a product master is worse than none
//   * a malformed file is rejected before a single row is examined
//
// Every database here is created in the OS temp folder and deleted. The production database is
// never opened, and every record is synthetic.

const SCHEMA = path.resolve(process.cwd(), "src/local-schema.sql");

interface Fixture {
  readonly db: SqliteDatabase;
  cleanup(): void;
}

function createDb(prefix: string): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-seed-${prefix}-`));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "x.db"), schemaPath: SCHEMA });
  db.setNumberBlock(1, "test");
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const AT = "2026-10-01T04:00:00.000Z";

interface SeedIds {
  mainGroup: string;
  productGroup: string;
  series: string;
  subGroup: string;
  articleSize: string;
  variant: string;
}

/** A complete synthetic product, from its groups down to one colour variant. */
function seedProduct(db: SqliteDatabase, article: string, color: string, size: string): SeedIds {
  const ids: SeedIds = {
    mainGroup: crypto.randomUUID(),
    productGroup: crypto.randomUUID(),
    series: crypto.randomUUID(),
    subGroup: crypto.randomUUID(),
    articleSize: crypto.randomUUID(),
    variant: crypto.randomUUID(),
  };
  const raw = db.db;
  raw.prepare("INSERT INTO main_groups (id, group_name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(ids.mainGroup, `MG-${article}`, AT, AT);
  raw.prepare("INSERT INTO product_groups (id, group_name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(ids.productGroup, `PG-${article}`, AT, AT);
  raw.prepare("INSERT INTO article_series (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(ids.series, `SER-${article}`, AT, AT);
  raw
    .prepare("INSERT INTO product_sub_groups (id, product_group_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(ids.subGroup, ids.productGroup, `SUB-${article}`, AT, AT);
  raw
    .prepare(
      `INSERT INTO article_sizes (id, article, size, main_group_id, product_group_id, article_series_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`
    )
    .run(ids.articleSize, article, size, ids.mainGroup, ids.productGroup, ids.series, AT, AT);
  raw
    .prepare(
      `INSERT INTO product_variants (id, article, color, size, main_group_id, product_group_id,
         article_series_id, article_size_id, product_sub_group_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`
    )
    .run(ids.variant, article, color, size, ids.mainGroup, ids.productGroup, ids.series, ids.articleSize, ids.subGroup, AT, AT);
  return ids;
}

const variantRow = (db: SqliteDatabase, id: string) =>
  db.db.prepare("SELECT * FROM product_variants WHERE id = ?").get(id) as Record<string, unknown> | undefined;

const count = (db: SqliteDatabase, table: string): number =>
  Number((db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

// ─── the bundle is closed ───────────────────────────────────────────────────

test("the export carries the variant and exactly the parents it needs", () => {
  const source = createDb("export");
  try {
    const ids = seedProduct(source.db, "ZZ1", "BLACK", "7/10");
    // A second, unrelated product must NOT be dragged along.
    seedProduct(source.db, "ZZ2", "WHITE", "6/9");

    const result = source.db.exportProductVariantSeed([ids.variant]);

    assert.deepEqual(result.missingVariantIds, []);
    assert.equal(result.counts.product_variants, 1);
    assert.equal(result.counts.article_sizes, 1);
    assert.equal(result.counts.main_groups, 1);
    assert.equal(result.counts.product_groups, 1);
    assert.equal(result.counts.article_series, 1);
    assert.equal(result.counts.product_sub_groups, 1);
    assert.equal(result.counts.product_types, 0, "nothing this variant does not point at");
    assert.equal(result.file.format, PRODUCT_VARIANT_SEED_FORMAT);
    assert.equal(result.file.version, PRODUCT_VARIANT_SEED_VERSION);
  } finally {
    source.cleanup();
  }
});

test("a variant id that is not here is reported, not invented", () => {
  const source = createDb("export-missing");
  try {
    const result = source.db.exportProductVariantSeed(["no-such-variant"]);
    assert.deepEqual(result.missingVariantIds, ["no-such-variant"]);
    assert.equal(result.counts.product_variants, 0);
  } finally {
    source.cleanup();
  }
});

// ─── the id survives the journey ────────────────────────────────────────────

test("importing into a different database keeps every id exactly", () => {
  const source = createDb("src-ids");
  const target = createDb("tgt-ids");
  try {
    const ids = seedProduct(source.db, "ZZ1", "BLACK", "7/10");
    const bundle = source.db.exportProductVariantSeed([ids.variant]).file;

    const preview = target.db.importProductVariantSeed(bundle, { dryRun: true });
    assert.equal(preview.accepted, true);
    assert.equal(preview.imported, 6, "six rows across the chain");
    assert.equal(count(target.db, "product_variants"), 0, "a preview writes nothing");

    const done = target.db.importProductVariantSeed(bundle, { dryRun: false });
    assert.equal(done.accepted, true);
    assert.equal(done.imported, 6);

    const landed = variantRow(target.db, ids.variant);
    assert.ok(landed, "the variant arrived under its original id");
    assert.equal(landed?.article, "ZZ1");
    assert.equal(landed?.color, "BLACK");
    assert.equal(landed?.article_size_id, ids.articleSize, "and still points at its own article size");
    assert.equal(landed?.main_group_id, ids.mainGroup);
    assert.equal(landed?.product_sub_group_id, ids.subGroup);
    // Nothing was nulled to make it fit.
    for (const column of ["main_group_id", "product_group_id", "article_series_id", "article_size_id", "product_sub_group_id"]) {
      assert.notEqual(landed?.[column], null, `${column} must not be nulled`);
    }
  } finally {
    source.cleanup();
    target.cleanup();
  }
});

test("running the same bundle twice changes nothing", () => {
  const source = createDb("src-twice");
  const target = createDb("tgt-twice");
  try {
    const ids = seedProduct(source.db, "ZZ1", "BLACK", "7/10");
    const bundle = source.db.exportProductVariantSeed([ids.variant]).file;

    target.db.importProductVariantSeed(bundle, { dryRun: false });
    const again = target.db.importProductVariantSeed(bundle, { dryRun: false });

    assert.equal(again.accepted, true);
    assert.equal(again.imported, 0);
    assert.equal(again.alreadyPresent, 6, "identical rows are a no-op, not a conflict");
    assert.equal(count(target.db, "product_variants"), 1);
    assert.equal(count(target.db, "article_sizes"), 1);
  } finally {
    source.cleanup();
    target.cleanup();
  }
});

// ─── refusals ───────────────────────────────────────────────────────────────

test("a variant whose parents are missing is refused, never imported half-formed", () => {
  const source = createDb("src-orphan");
  const target = createDb("tgt-orphan");
  try {
    const ids = seedProduct(source.db, "ZZ1", "BLACK", "7/10");
    const bundle = source.db.exportProductVariantSeed([ids.variant]).file;
    // Strip the parents, as a hand-edited file might.
    const broken: ProductVariantSeedFile = {
      ...bundle,
      tables: { ...bundle.tables, article_sizes: [], main_groups: [], product_groups: [], article_series: [], product_sub_groups: [] },
    };

    const result = target.db.importProductVariantSeed(broken, { dryRun: false });

    assert.equal(result.accepted, false);
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0]?.reason ?? "", /needs (main_groups|product_groups|article_series|article_sizes|product_sub_groups)/);
    assert.equal(count(target.db, "product_variants"), 0, "nothing was written");
  } finally {
    source.cleanup();
    target.cleanup();
  }
});

test("the same product already here under a different id is a conflict, and nothing is written", () => {
  const source = createDb("src-clash");
  const target = createDb("tgt-clash");
  try {
    const ids = seedProduct(source.db, "ZZ1", "BLACK", "7/10");
    // The target made the same product itself, so it carries different ids throughout.
    seedProduct(target.db, "ZZ1", "BLACK", "7/10");
    const bundle = source.db.exportProductVariantSeed([ids.variant]).file;

    const result = target.db.importProductVariantSeed(bundle, { dryRun: false });

    assert.equal(result.accepted, false);
    assert.ok(result.conflicts.length > 0, "the natural keys collide");
    assert.match(result.conflicts.map((c) => c.reason ?? "").join(" "), /already belongs to/);
    assert.equal(variantRow(target.db, ids.variant), undefined, "the incoming variant was not written");
    assert.equal(count(target.db, "product_variants"), 1, "and the target's own product is untouched");
  } finally {
    source.cleanup();
    target.cleanup();
  }
});

test("the same id holding different content is a conflict, and overwrites nothing", () => {
  const source = createDb("src-diff");
  const target = createDb("tgt-diff");
  try {
    const ids = seedProduct(source.db, "ZZ1", "BLACK", "7/10");
    const bundle = source.db.exportProductVariantSeed([ids.variant]).file;
    target.db.importProductVariantSeed(bundle, { dryRun: false });

    // The target's copy is edited afterwards — the two have diverged.
    target.db.db.prepare("UPDATE product_variants SET description = 'edited on PC2' WHERE id = ?").run(ids.variant);

    const result = target.db.importProductVariantSeed(bundle, { dryRun: false });

    assert.equal(result.accepted, false);
    assert.equal(result.conflicts.length, 1);
    assert.match(result.conflicts[0]?.reason ?? "", /already here with a different description/);
    assert.equal(
      variantRow(target.db, ids.variant)?.description,
      "edited on PC2",
      "the target's own edit survives: a seed never merges"
    );
  } finally {
    source.cleanup();
    target.cleanup();
  }
});

test("one bad row refuses the whole bundle — no partial product master", () => {
  const source = createDb("src-partial");
  const target = createDb("tgt-partial");
  try {
    const first = seedProduct(source.db, "ZZ1", "BLACK", "7/10");
    const second = seedProduct(source.db, "ZZ2", "WHITE", "6/9");
    const bundle = source.db.exportProductVariantSeed([first.variant, second.variant]).file;
    // The target already owns ZZ2 under its own ids, so exactly one of the two collides.
    seedProduct(target.db, "ZZ2", "WHITE", "6/9");

    const result = target.db.importProductVariantSeed(bundle, { dryRun: false });

    assert.equal(result.accepted, false);
    assert.ok(result.conflicts.length > 0);
    assert.equal(variantRow(target.db, first.variant), undefined, "the clean product did NOT slip in");
    assert.equal(count(target.db, "product_variants"), 1, "only the target's own product remains");
  } finally {
    source.cleanup();
    target.cleanup();
  }
});

// ─── the file itself ────────────────────────────────────────────────────────

test("a file that is not a seed is refused before any row is read", () => {
  const target = createDb("tgt-malformed");
  try {
    const cases: Array<[string, unknown]> = [
      ["not an object", "{}"],
      ["wrong format", { format: "something-else", version: 1, tables: {} }],
      ["wrong version", { format: PRODUCT_VARIANT_SEED_FORMAT, version: 99, tables: {} }],
      ["no tables", { format: PRODUCT_VARIANT_SEED_FORMAT, version: PRODUCT_VARIANT_SEED_VERSION }],
      [
        "a table this seed does not carry",
        { format: PRODUCT_VARIANT_SEED_FORMAT, version: PRODUCT_VARIANT_SEED_VERSION, tables: { sale_vouchers: [] } },
      ],
      [
        "a row with no id",
        {
          format: PRODUCT_VARIANT_SEED_FORMAT,
          version: PRODUCT_VARIANT_SEED_VERSION,
          tables: { main_groups: [{ group_name: "x" }] },
        },
      ],
    ];

    for (const [name, value] of cases) {
      const result = target.db.importProductVariantSeed(value, { dryRun: false });
      assert.equal(result.accepted, false, name);
      assert.ok(result.fileError, `${name} must say what is wrong with the file`);
      assert.equal(result.verdicts.length, 0, `${name}: no row should have been judged`);
    }
    assert.equal(count(target.db, "main_groups"), 0);
  } finally {
    target.cleanup();
  }
});

test("a column this installation does not have is refused rather than dropped", () => {
  const source = createDb("src-column");
  const target = createDb("tgt-column");
  try {
    const ids = seedProduct(source.db, "ZZ1", "BLACK", "7/10");
    const bundle = source.db.exportProductVariantSeed([ids.variant]).file;
    const withExtra: ProductVariantSeedFile = {
      ...bundle,
      tables: {
        ...bundle.tables,
        product_variants: bundle.tables.product_variants.map((row) => ({ ...row, invented_column: "x" })),
      },
    };

    const result = target.db.importProductVariantSeed(withExtra, { dryRun: false });

    assert.equal(result.accepted, false);
    assert.match(result.rejected[0]?.reason ?? "", /has no column invented_column/);
    assert.equal(count(target.db, "product_variants"), 0);
  } finally {
    source.cleanup();
    target.cleanup();
  }
});

// ─── what it must not touch ─────────────────────────────────────────────────

test("a refused import leaves unrelated business data alone", () => {
  const source = createDb("src-unrelated");
  const target = createDb("tgt-unrelated");
  try {
    const ids = seedProduct(source.db, "ZZ1", "BLACK", "7/10");
    seedProduct(target.db, "ZZ1", "BLACK", "7/10"); // guarantees a conflict
    const party = target.db.createParty({ partyName: "Al-Madina Traders", partyType: "CUSTOMER", city: "Lahore", status: "ACTIVE" });

    const result = target.db.importProductVariantSeed(source.db.exportProductVariantSeed([ids.variant]).file, {
      dryRun: false,
    });

    assert.equal(result.accepted, false);
    assert.equal(target.db.getParty(party)?.partyName, "Al-Madina Traders", "the party is untouched");
    assert.equal(count(target.db, "parties"), 1);
  } finally {
    source.cleanup();
    target.cleanup();
  }
});
