import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteDatabase } from "./sqliteDatabase.js";

// 1b-2: the product code is allocated where the product is WRITTEN, not where it is previewed.
//
// Reported shape of the bug: the Product form fills its read-only Product Code field from
// getNextProductCode as a preview, and that preview was sent back with the save and used as the
// code. Two forms opened together previewed the same number, so the second save died on
// "UNIQUE constraint failed: article_sizes.product_code" — no concurrency at the database level
// needed, just two tabs.
//
// The fix is in two halves: the createProduct IPC handler no longer accepts a code from the
// renderer, and createProduct now writes inside BEGIN IMMEDIATE, so MAX+1 is read with the write
// lock already held. These tests pin the data-layer half — the format and sequence that must not
// drift, that a second create cannot reuse a code, that an explicitly supplied code is still
// honoured, and that a failed create leaves nothing behind.

const SCHEMA = path.resolve(process.cwd(), "src/local-schema.sql");

function createFixture(prefix: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-${prefix}-`));
  const dbPath = path.join(tempDir, "products.db");
  const db = new SqliteDatabase({ dbPath, schemaPath: SCHEMA });
  db.setNumberBlock(1, "test");
  return {
    db,
    raw: db.db,
    dbPath,
    cleanup: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

const codes = (raw: DatabaseSync): string[] =>
  (raw.prepare("SELECT product_code FROM article_sizes ORDER BY product_code").all() as Array<{ product_code: string }>)
    .map((row) => row.product_code);

const codeOf = (raw: DatabaseSync, article: string, size: string): string | undefined => {
  const row = raw
    .prepare("SELECT product_code FROM article_sizes WHERE article = ? AND size = ? LIMIT 1")
    .get(article, size) as { product_code: string } | undefined;
  return row?.product_code;
};

const countArticleSizes = (raw: DatabaseSync) =>
  (raw.prepare("SELECT COUNT(*) AS c FROM article_sizes").get() as { c: number }).c;

/** Fails the colour-variant write, so the failure lands AFTER the article_size insert. */
function blockVariantInserts(raw: DatabaseSync): () => void {
  raw.exec(
    `CREATE TRIGGER block_variant_insert BEFORE INSERT ON product_variants
     BEGIN SELECT RAISE(ABORT, 'simulated variant write failure'); END`
  );
  return () => raw.exec("DROP TRIGGER block_variant_insert");
}

// ─── 1. Format and sequence ──────────────────────────────────────────────────

test("automatic codes keep the PRD-000000 format and run in sequence", () => {
  const f = createFixture("prd-format");
  try {
    assert.equal(f.db.getNextProductCode(), "PRD-000001", "the preview starts the series");

    f.db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 600, status: "ACTIVE" });
    f.db.createProduct({ article: "SK9", size: "7/10", sellingPrice: 650, status: "ACTIVE" });
    f.db.createProduct({ article: "DC3", size: "6/9", sellingPrice: 700, status: "ACTIVE" });

    assert.deepEqual(codes(f.raw), ["PRD-000001", "PRD-000002", "PRD-000003"]);
    assert.equal(f.db.getNextProductCode(), "PRD-000004");
  } finally {
    f.cleanup();
  }
});

test("an existing product series is continued, never restarted", () => {
  const f = createFixture("prd-continue");
  try {
    const now = new Date().toISOString();
    f.raw
      .prepare(
        `INSERT INTO article_sizes (id, product_code, article, size, status, created_at, updated_at)
         VALUES ('legacy', 'PRD-000042', 'LEGACY', '7/10', 'ACTIVE', ?, ?)`
      )
      .run(now, now);

    f.db.createProduct({ article: "SK6", size: "7/10", status: "ACTIVE" });
    assert.equal(codeOf(f.raw, "SK6", "7/10"), "PRD-000043");
  } finally {
    f.cleanup();
  }
});

// ─── 2. Two creates cannot persist the same automatic code ───────────────────

test("a stale preview is not an allocation: two creates after one preview get two codes", () => {
  const f = createFixture("prd-stale-preview");
  try {
    // Exactly the reported bug: two forms open, both showing this number.
    const previewed = f.db.getNextProductCode();
    assert.equal(previewed, "PRD-000001");

    f.db.createProduct({ article: "SK6", size: "7/10", status: "ACTIVE" });
    f.db.createProduct({ article: "SK9", size: "7/10", status: "ACTIVE" });

    assert.deepEqual(codes(f.raw), ["PRD-000001", "PRD-000002"], "the second save is not the first code again");
    assert.equal(countArticleSizes(f.raw), 2);
  } finally {
    f.cleanup();
  }
});

test("two connections creating at once persist two distinct codes", async () => {
  const f = createFixture("prd-two-connections");
  const second = new SqliteDatabase({ dbPath: f.dbPath, schemaPath: SCHEMA });
  second.setNumberBlock(1, "test");
  try {
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => f.db.createProduct({ article: "SK6", size: "7/10", status: "ACTIVE" })),
      Promise.resolve().then(() => second.createProduct({ article: "SK9", size: "7/10", status: "ACTIVE" })),
    ]);
    assert.notEqual(a, b);

    const persisted = codes(f.raw);
    assert.equal(persisted.length, 2);
    assert.equal(new Set(persisted).size, 2, "no two products share a code");
    assert.deepEqual(persisted, ["PRD-000001", "PRD-000002"]);
  } finally {
    second.close();
    f.cleanup();
  }
});

// ─── 3. An explicitly supplied code is still honoured ────────────────────────

test("a code supplied by the caller is used as given, never silently replaced", () => {
  const f = createFixture("prd-explicit");
  try {
    // The data-layer contract is unchanged: productCode is still accepted. What changed is that
    // the IPC handler no longer forwards one from the renderer, because no user can type one.
    f.db.createProduct({ article: "SK6", size: "7/10", productCode: "PRD-000500", status: "ACTIVE" });
    assert.equal(codeOf(f.raw, "SK6", "7/10"), "PRD-000500");

    // And the series carries on from it rather than handing out a code already taken.
    f.db.createProduct({ article: "SK9", size: "7/10", status: "ACTIVE" });
    assert.equal(codeOf(f.raw, "SK9", "7/10"), "PRD-000501");
  } finally {
    f.cleanup();
  }
});

// ─── 4. A failed create leaves no partial product ────────────────────────────

test("a failure part-way through creation leaves no article_size and no variant", () => {
  const f = createFixture("prd-partial");
  try {
    const unblock = blockVariantInserts(f.raw);

    // The article_size is written first, the colour variant second. Before the transaction, the
    // failed variant left the article_size behind: a product on the Product List that no scan
    // could resolve, holding a product code for good.
    assert.throws(
      () => f.db.createProduct({ article: "SK6", size: "7/10", colors: ["RED"], status: "ACTIVE" }),
      /simulated variant write failure/
    );

    assert.equal(countArticleSizes(f.raw), 0, "the article_size was rolled back with the variant");
    assert.equal((f.raw.prepare("SELECT COUNT(*) AS c FROM product_variants").get() as { c: number }).c, 0);
    assert.equal(f.db.getNextProductCode(), "PRD-000001", "and the code was not consumed");

    unblock();
    f.db.createProduct({ article: "SK6", size: "7/10", colors: ["RED"], status: "ACTIVE" });
    assert.equal(codeOf(f.raw, "SK6", "7/10"), "PRD-000001");
  } finally {
    f.cleanup();
  }
});

// ─── 5. Uniqueness and existing behaviour are intact ─────────────────────────

test("the unique index still refuses a duplicate product code", () => {
  const f = createFixture("prd-unique");
  try {
    f.db.createProduct({ article: "SK6", size: "7/10", status: "ACTIVE" });
    const taken = codeOf(f.raw, "SK6", "7/10");
    assert.equal(taken, "PRD-000001");

    // The constraint is the last line of defence and must stay that way.
    assert.throws(
      () => f.db.createProduct({ article: "SK9", size: "7/10", productCode: taken, status: "ACTIVE" }),
      /UNIQUE constraint failed: article_sizes\.product_code/
    );
    assert.equal(countArticleSizes(f.raw), 1, "the refused product left nothing behind");
  } finally {
    f.cleanup();
  }
});

test("making the same article and size again keeps one row and its code", () => {
  const f = createFixture("prd-same-again");
  try {
    f.db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 600, status: "ACTIVE" });
    const first = codeOf(f.raw, "SK6", "7/10");

    f.db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 650, status: "ACTIVE" });

    assert.equal(countArticleSizes(f.raw), 1, "one row for one article and size");
    assert.equal(codeOf(f.raw, "SK6", "7/10"), first, "and it keeps the code everything points at");
    assert.equal(f.db.getNextProductCode(), "PRD-000002", "no code was burned by the second call");
  } finally {
    f.cleanup();
  }
});
