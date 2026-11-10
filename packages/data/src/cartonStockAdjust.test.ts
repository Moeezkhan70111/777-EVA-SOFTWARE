import test from "node:test";
import { activateCartonCloudForTest } from "./testing/cartonCloud.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddMachineUseCase, CreateGatepassUseCase, InMemoryEventBus } from "@erp/application";
import { buildCartonStockEvents, readCartonStockEventPayload } from "./database/cartonStock.js";
import { applyCartonStockReset, planCartonStockReset, verifyCartonStockReset } from "./database/cartonStockReset.js";
import { SqliteDatabase } from "./sqliteDatabase.js";

// CARTON STOCK AS ONE COMPUTER SEES IT (docs/42 sections 11 to 13): the administrator's adjustment, a
// void from before the fresh start, the reconciliation, the QR hold on a gatepass, and the reset.

const STORE = "factory-777";
const idGen = { nextId: () => crypto.randomUUID() };

interface Fixture {
  readonly db: SqliteDatabase;
  readonly variantId: string;
  readonly skuId: string;
  readonly machineId: string;
}

async function withFixture(run: (fixture: Fixture) => void | Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-carton-adjust-"));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(1, "test");
  db.ensureOperationalContext({
    factoryId: STORE, factoryCode: "F777", factoryName: "777", workstationId: "ws-1", workstationCode: "WS1", workstationName: "1",
    deviceId: "dev-1", deviceName: "1", appVersion: "1.0.0",
  });
  db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 550, machineRate: 70, packingRate: 30, colors: ["RED"], createdBy: "owner" } as never);
  const skuId = (db.db.prepare("SELECT id FROM article_sizes WHERE article = 'SK6'").get() as { id: string }).id;
  const variantId = (db.db.prepare("SELECT id FROM product_variants WHERE article = 'SK6' AND color = 'RED'").get() as { id: string }).id;
  const contractor = db.createParty({ partyName: "ASLAM", partyType: "CONTRACTOR", city: "Lahore", mobileNumber: "0300-1111111", status: "ACTIVE" });
  const packer = db.createParty({ partyName: "BABAR", partyType: "CONTRACTOR", city: "Lahore", mobileNumber: "0300-2222222", status: "ACTIVE" });
  const deps = { txManager: db, repo: db, eventPublisher: new InMemoryEventBus(), idGenerator: idGen };
  const machineId = (await new AddMachineUseCase(deps).execute({ name: "Machine 1", contractorPartyId: contractor, packingContractorPartyId: packer, actor: "admin" })).machineId ?? "";
  try {
    await run({ db, variantId, skuId, machineId });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const adjustment = (fixture: Fixture, over: Record<string, unknown> = {}) => ({
  requestId: crypto.randomUUID(), articleSizeId: fixture.skuId, color: "RED", direction: "IN", cartons: 5,
  reason: "counted in the store", adjustedBy: "owner", storeLocationId: STORE, ...over,
});
const figure = (db: SqliteDatabase) =>
  Number((db.db.prepare("SELECT COALESCE(SUM(quantity_on_hand), 0) AS n FROM stock_projection_by_location WHERE location_type = 'WAREHOUSE'").get() as { n: number }).n);
const total = (db: SqliteDatabase) =>
  Number((db.db.prepare("SELECT COALESCE(SUM(quantity_on_hand), 0) AS n FROM stock_projection_by_variant").get() as { n: number }).n);
const events = (db: SqliteDatabase) => Number((db.db.prepare("SELECT COUNT(1) AS n FROM carton_stock_events").get() as { n: number }).n);
const produce = (fixture: Fixture) =>
  fixture.db.recordManualProduction({ requestId: crypto.randomUUID(), machineId: fixture.machineId, articleSizeId: fixture.skuId, color: "RED", dozens: "10", storeLocationId: STORE, createdBy: "aslam" });

/** Figures with no movement behind them, as a computer holds them before the fresh start. */
function oldStock(db: SqliteDatabase, variantId: string, cartons: number): void {
  const now = "2026-10-01T00:00:00.000Z";
  db.db.prepare("INSERT OR REPLACE INTO stock_projection_by_variant (product_variant_id, quantity_on_hand, last_event_ts, updated_at) VALUES (?, ?, ?, ?)").run(variantId, cartons, now, now);
  db.db.prepare("INSERT OR REPLACE INTO stock_projection_by_location (product_variant_id, location_type, location_id, quantity_on_hand, updated_at) VALUES (?, 'WAREHOUSE', ?, ?, ?)").run(variantId, STORE, cartons, now);
}

/** A Manual Production entry from before the fresh start: the row, with no movement. */
function oldEntry(fixture: Fixture): string {
  const entry = produce(fixture).entry;
  assert.ok(entry);
  fixture.db.db.prepare("DELETE FROM carton_stock_events WHERE manual_production_entry_id = ?").run(entry.id);
  fixture.db.db.prepare("DELETE FROM sync_dirty_records").run();
  return entry.id;
}

test("an adjustment moves the figure by its type's sign, with who and why, as one movement", async () => {
  await withFixture((fixture) => {
    const { db } = fixture;
    assert.equal(db.adjustCartonStock(adjustment(fixture, { cartons: 9 })).balanceDelta, 9);
    assert.equal(db.adjustCartonStock(adjustment(fixture, { direction: "OUT", cartons: 4 })).balanceDelta, -4);
    assert.equal(figure(db), 5);
    assert.equal(total(db), 5);
    const row = db.db.prepare("SELECT event_type, quantity, balance_delta, created_by, reason FROM carton_stock_events WHERE event_type = 'CARTON_ADJUST_OUT'").get();
    assert.deepEqual({ ...(row as object) }, { event_type: "CARTON_ADJUST_OUT", quantity: 4, balance_delta: -4, created_by: "owner", reason: "counted in the store" });
  });
});

test("an adjustment with no reason, a bad quantity or an unknown direction changes nothing", async () => {
  await withFixture((fixture) => {
    const { db } = fixture;
    for (const [over, refusal] of [
      [{ reason: "   " }, /Give a reason/],
      [{ cartons: 0 }, /whole number/],
      [{ cartons: -3 }, /whole number/],
      [{ cartons: 1.5 }, /whole number/],
      [{ direction: "SIDEWAYS" }, /adds cartons or takes/],
      [{ requestId: "not-a-uuid" }, /identified/],
      [{ adjustedBy: " " }, /who made it/],
    ] as const) {
      assert.throws(() => db.adjustCartonStock(adjustment(fixture, over)), refusal);
    }
    assert.equal(events(db), 0);
    assert.equal(figure(db), 0);
  });
});

test("the database itself refuses an adjustment that does not say why", async () => {
  await withFixture((fixture) => {
    assert.throws(() => fixture.db.db.prepare(
      `INSERT INTO carton_stock_events (id, product_variant_id, event_type, quantity, balance_delta, location_type, location_id, created_by, created_at)
       VALUES ('x', ?, 'CARTON_ADJUST_IN', 1, 1, 'WAREHOUSE', ?, 'owner', '2026-11-06T00:00:00.000Z')`
    ).run(fixture.variantId, STORE), /CHECK/);
  });
});

test("taking out more than the store holds is refused whole: no movement, no product queued, no change", async () => {
  await withFixture((fixture) => {
    const { db } = fixture;
    db.adjustCartonStock(adjustment(fixture, { cartons: 2 }));
    const queued = () => Number((db.db.prepare("SELECT COUNT(1) AS n FROM sync_outbox").get() as { n: number }).n);
    const before = queued();
    assert.throws(() => db.adjustCartonStock(adjustment(fixture, { direction: "OUT", cartons: 3 })), /does not hold 3/);
    assert.equal(figure(db), 2);
    assert.equal(events(db), 1);
    assert.equal(queued(), before);
    assert.equal(db.db.isTransaction, false);
  });
});

test("the same request id adjusts once", async () => {
  await withFixture((fixture) => {
    const request = adjustment(fixture);
    assert.equal(fixture.db.adjustCartonStock(request).duplicate, false);
    assert.equal(fixture.db.adjustCartonStock(request).duplicate, true);
    assert.equal(figure(fixture.db), 5);
    assert.equal(events(fixture.db), 1);
  });
});

test("an adjustment queues its product in the same transaction, once", async () => {
  await withFixture((fixture) => {
    fixture.db.adjustCartonStock(adjustment(fixture));
    fixture.db.adjustCartonStock(adjustment(fixture));
    const rows = fixture.db.db.prepare("SELECT COUNT(1) AS n FROM sync_outbox WHERE aggregate_type = 'PRODUCT_VARIANT'").get() as { n: number };
    assert.equal(Number(rows.n), 1);
  });
});

test("an adjustment off the wire with no reason or no name is a broken event, never applied", () => {
  const event = {
    eventId: "e-1", productVariantId: "v-1", eventType: "CARTON_ADJUST_IN", quantity: 2, balanceDelta: 2, locationType: "WAREHOUSE",
    locationId: STORE, createdBy: "owner", createdAt: "2026-11-06T00:00:00.000Z", manualProductionEntryId: null, gatepassId: null, gatepassLineId: null, reason: "counted",
  };
  assert.ok(readCartonStockEventPayload(event));
  assert.equal(readCartonStockEventPayload({ ...event, reason: null }), null);
  assert.equal(readCartonStockEventPayload({ ...event, reason: "  " }), null);
  assert.equal(readCartonStockEventPayload({ ...event, createdBy: null }), null);
  assert.equal(readCartonStockEventPayload({ ...event, balanceDelta: -2 }), null);
});

test("movements leave in the order they were recorded, even all marked in one millisecond", async () => {
  await withFixture((fixture) => {
    const { db } = fixture;
    db.db.prepare(`INSERT INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
       VALUES ('CARTON_STOCK', 'dev-1', 'x', 1, 0, 'x', 'p', 'x')`).run();
    activateCartonCloudForTest(db.db, "p"); // after go-live (stockProtection.ts)
    const recorded: string[] = [];
    for (let i = 0; i < 20; i += 1) recorded.push(db.adjustCartonStock(adjustment(fixture, { direction: i % 2 === 0 ? "IN" : "OUT" })).eventId);
    db.db.prepare("UPDATE sync_dirty_records SET marked_at = '2026-11-07T00:00:00.000Z'").run();

    assert.equal(buildCartonStockEvents(db.db, "2026-11-07T00:00:00.000Z").queued, 20);

    const queued = db.db.prepare("SELECT aggregate_id FROM sync_outbox WHERE aggregate_type = 'CARTON_STOCK_EVENT' ORDER BY rowid").all() as Array<{ aggregate_id: string }>;
    assert.deepEqual(queued.map((row) => row.aggregate_id), recorded);
  });
});

// ─── G3: voids ───

test("a void of an entry from before the fresh start is refused whole: its ledger line and the figure stay", async () => {
  await withFixture((fixture) => {
    const { db } = fixture;
    const entryId = oldEntry(fixture);
    const before = figure(db);
    assert.throws(() => db.voidManualProduction({ entryId, reason: "mistake", voidedBy: "owner", mayVoidEarlierDays: true }), /before carton stock started fresh/);
    assert.equal(figure(db), before);
    const entry = db.db.prepare("SELECT voided_at FROM manual_production_entries WHERE id = ?").get(entryId) as { voided_at: string | null };
    assert.equal(entry.voided_at, null);
    assert.equal(db.db.isTransaction, false);
  });
});

test("a void of an entry with its movement still goes through", async () => {
  await withFixture((fixture) => {
    const entry = produce(fixture).entry;
    fixture.db.voidManualProduction({ entryId: entry?.id ?? "", reason: "mistake", voidedBy: "owner", mayVoidEarlierDays: true });
    assert.equal(figure(fixture.db), 0);
  });
});

// ─── G4: reconciliation ───

test("the reconciliation agrees with the movements, by kind, and reads only", async () => {
  await withFixture((fixture) => {
    const { db } = fixture;
    const entry = produce(fixture).entry;
    produce(fixture);
    db.voidManualProduction({ entryId: entry?.id ?? "", reason: "twice", voidedBy: "owner", mayVoidEarlierDays: true });
    db.adjustCartonStock(adjustment(fixture, { direction: "OUT", cartons: 3 }));
    const changes = db.db.prepare("SELECT total_changes() AS n").get() as { n: number };

    const seen = db.cartonStockReconciliation();

    assert.equal((db.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n, changes.n, "reads only");
    assert.equal(seen.differences, 0);
    assert.equal(seen.movements, 4);
    assert.deepEqual(
      { produced: seen.rows[0]?.produced, adjusted: seen.rows[0]?.adjusted, issued: seen.rows[0]?.issued, stock: seen.rows[0]?.movementStock, figure: seen.rows[0]?.storeFigure },
      { produced: 20, adjusted: -3, issued: 0, stock: 17, figure: 17 }
    );
  });
});

test("a figure no movement explains is named, and QR cartons are counted apart", async () => {
  await withFixture((fixture) => {
    const { db, variantId } = fixture;
    produce(fixture);
    db.db.prepare("UPDATE stock_projection_by_location SET quantity_on_hand = quantity_on_hand + 7 WHERE product_variant_id = ?").run(variantId);
    const off = db.cartonStockReconciliation();
    assert.equal(off.differences, 1);
    assert.equal(off.rows[0]?.difference, 7);

    db.db.prepare("INSERT INTO qr_master (qr_id, product_variant_id, current_status, current_location_type, first_event_id, created_at, updated_at) VALUES ('qr-1', ?, 'WAREHOUSE', 'WAREHOUSE', 'e', 'x', 'x')").run(variantId);
    const withQr = db.cartonStockReconciliation();
    assert.equal(withQr.rows[0]?.qrInStore, 1);
    assert.equal(withQr.rows[0]?.difference, 6, "a QR carton explains one of them, and stays out of the shared stock");
    assert.equal(withQr.rows[0]?.movementStock, 20);
  });
});

test("the fingerprint depends on the movements, not the order they were read in", async () => {
  await withFixture((fixture) => {
    const { db } = fixture;
    const empty = db.cartonStockReconciliation().fingerprint;
    db.adjustCartonStock(adjustment(fixture));
    assert.notEqual(db.cartonStockReconciliation().fingerprint, empty);
    const same = db.cartonStockReconciliation().fingerprint;
    assert.equal(db.cartonStockReconciliation().fingerprint, same);
    // One id, another amount: what the fingerprint must tell apart. Past the CHECK only by force.
    db.db.exec("PRAGMA ignore_check_constraints = ON");
    db.db.prepare("UPDATE carton_stock_events SET balance_delta = balance_delta + 1").run();
    db.db.exec("PRAGMA ignore_check_constraints = OFF");
    assert.notEqual(db.cartonStockReconciliation().fingerprint, same);
  });
});

test("the reconciliation counts entries from before the fresh start, and what has not gone yet", async () => {
  await withFixture((fixture) => {
    oldEntry(fixture);
    fixture.db.db.prepare("DELETE FROM stock_projection_by_location").run();
    fixture.db.db.prepare("DELETE FROM stock_projection_by_variant").run();
    fixture.db.db.prepare(`INSERT INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
       VALUES ('CARTON_STOCK', 'dev-1', 'x', 1, 0, 'x', 'p', 'x')`).run();
    fixture.db.adjustCartonStock(adjustment(fixture));
    const seen = fixture.db.cartonStockReconciliation();
    assert.equal(seen.entriesBeforeFreshStart, 1);
    assert.equal(seen.unsent, 1);
  });
});

// ─── G5: a gatepass while QR is on hold ───

const gatepass = async (fixture: Fixture, quantity: number) => {
  const customer = fixture.db.createParty({ partyName: "MAMA", partyType: "CUSTOMER", city: "Lahore", mobileNumber: "0300-3333333", status: "ACTIVE" });
  return new CreateGatepassUseCase({ txManager: fixture.db, repo: fixture.db, idGenerator: idGen }).execute({ partyId: customer, lines: [{ productVariantId: fixture.variantId, quantity }], actor: "clerk" });
};
const qrCarton = (fixture: Fixture, id: string) =>
  fixture.db.db.prepare("INSERT INTO qr_master (qr_id, product_variant_id, current_status, current_location_type, first_event_id, created_at, updated_at) VALUES (?, ?, 'WAREHOUSE', 'WAREHOUSE', 'e', 'x', 'x')").run(id, fixture.variantId);

test("while QR is on hold a gatepass reserves nothing for scanners: the whole line leaves as a movement", async () => {
  await withFixture(async (fixture) => {
    fixture.db.cartonQrOnHold = true;
    produce(fixture);
    qrCarton(fixture, "qr-1");
    await gatepass(fixture, 5);
    const issued = fixture.db.db.prepare("SELECT SUM(quantity) AS n FROM carton_stock_events WHERE event_type = 'GATEPASS_ISSUE'").get() as { n: number };
    assert.equal(Number(issued.n), 5);
    assert.equal(figure(fixture.db), 15);
  });
});

test("with the hold lifted a gatepass still reserves QR cartons first: QR behaviour is kept, not removed", async () => {
  await withFixture(async (fixture) => {
    produce(fixture);
    qrCarton(fixture, "qr-1");
    await gatepass(fixture, 5);
    const issued = fixture.db.db.prepare("SELECT SUM(quantity) AS n FROM carton_stock_events WHERE event_type = 'GATEPASS_ISSUE'").get() as { n: number };
    assert.equal(Number(issued.n), 4);
  });
});

// ─── G3: the reset ───

const hashAll = (db: SqliteDatabase) => {
  const out: Record<string, string> = {};
  const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  for (const { name } of tables) out[name] = JSON.stringify(db.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all());
  return out;
};

test("the plan changes nothing, says what it would clear and what stays", async () => {
  await withFixture((fixture) => {
    const { db, variantId } = fixture;
    oldStock(db, variantId, 30);
    const before = hashAll(db);
    const plan = planCartonStockReset(db.db);
    assert.deepEqual(hashAll(db), before);
    assert.deepEqual(plan.refusals, []);
    assert.equal(plan.cartonsCleared, 30);
    assert.equal(plan.variants[0]?.variantAfter, 0);
  });
});

test("the reset clears the store figures and proves nothing else moved, entries and ledger kept", async () => {
  await withFixture((fixture) => {
    const { db, variantId } = fixture;
    oldEntry(fixture);
    oldStock(db, variantId, 30);
    db.db.prepare("INSERT INTO stock_projection_by_location (product_variant_id, location_type, location_id, quantity_on_hand, updated_at) VALUES (?, 'FACTORY', ?, 4, 'x')").run(variantId, STORE);
    db.db.prepare("UPDATE stock_projection_by_variant SET quantity_on_hand = 34 WHERE product_variant_id = ?").run(variantId);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-carton-reset-"));
    const copyPath = path.join(dir, "before.db");
    db.db.exec(`VACUUM INTO '${copyPath.replace(/\\/g, "/")}'`);
    const before = new SqliteDatabase({ dbPath: copyPath, schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
    const entriesBefore = hashAll(db).manual_production_entries;

    try {
      const plan = applyCartonStockReset(db.db, "2026-11-07T00:00:00.000Z");
      assert.equal(figure(db), 0);
      assert.equal(total(db), 4, "the factory's four stay on the product's total");
      assert.equal(hashAll(db).manual_production_entries, entriesBefore);
      const checks = verifyCartonStockReset(before.db, db.db, plan);
      assert.deepEqual(checks.filter((check) => !check.ok), []);
      assert.equal(checks.length, 4);

      db.db.prepare("UPDATE manual_production_entries SET cartons = cartons + 1").run();
      const noticed = verifyCartonStockReset(before.db, db.db, plan).filter((check) => !check.ok).map((check) => check.detail);
      assert.deepEqual(noticed, ["manual_production_entries, sync_dirty_records"], "a change anywhere else is noticed, and the capture that marks it");

      db.db.prepare("UPDATE stock_projection_by_variant SET quantity_on_hand = 5 WHERE product_variant_id = ?").run(variantId);
      assert.equal(verifyCartonStockReset(before.db, db.db, plan).find((check) => check.name === "Product totals")?.ok, false, "and a wrong total");
    } finally {
      before.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

for (const [name, setUp, refusal] of [
  ["a movement that came from the cloud", (f: Fixture) => {
    f.db.adjustCartonStock(adjustment(f));
    f.db.db.prepare("UPDATE carton_stock_events SET replicated_at = '2026-11-09T00:00:01.000Z', origin_device_id = 'dev-other'").run();
  }, /came from the cloud/],
  ["QR cartons in the store", (f: Fixture) => void qrCarton(f, "qr-1"), /QR carton\(s\) are in the store/],
  ["a product total below its store rows", (f: Fixture) => {
    oldStock(f.db, f.variantId, 9);
    f.db.db.prepare("UPDATE stock_projection_by_variant SET quantity_on_hand = 2").run();
  }, /already disagree/],
] as const) {
  test(`the reset stops, changing nothing, at ${name}`, async () => {
    await withFixture((fixture) => {
      setUp(fixture);
      const before = hashAll(fixture.db);
      assert.ok(planCartonStockReset(fixture.db.db).refusals.some((reason) => refusal.test(reason)));
      assert.throws(() => applyCartonStockReset(fixture.db.db, "x"), refusal);
      assert.deepEqual(hashAll(fixture.db), before);
      assert.equal(fixture.db.db.isTransaction, false);
    });
  });
}

test("the reset stops at a live gatepass still owed cartons", async () => {
  await withFixture(async (fixture) => {
    produce(fixture);
    qrCarton(fixture, "qr-1");
    await gatepass(fixture, 1);
    fixture.db.db.prepare("DELETE FROM qr_master").run();
    fixture.db.db.prepare("DELETE FROM carton_stock_events").run();
    fixture.db.db.prepare("DELETE FROM sync_outbox WHERE aggregate_type = 'CARTON_STOCK_EVENT'").run();
    assert.ok(planCartonStockReset(fixture.db.db).refusals.some((reason) => /owe 1 carton/.test(reason)));
  });
});

// ─── the fresh start and Carton Cloud activation (stockProtection.ts) ───

test("before activation, carton movements made here are test data: they do not stop the fresh start, and stay as history", async () => {
  await withFixture((fixture) => {
    const { db } = fixture;
    produce(fixture);
    const plan = planCartonStockReset(db.db);
    assert.deepEqual(plan.refusals, []);
    assert.ok(plan.kept.localTestMovements >= 1, "counted as kept, never sent");
    applyCartonStockReset(db.db, "2026-11-09T00:00:00.000Z");
    assert.ok(Number((db.db.prepare("SELECT COUNT(*) AS n FROM carton_stock_events").get() as { n: number }).n) >= 1, "the rows are not deleted");
  });
});

test("after Carton Cloud is activated, the fresh start is refused outright", async () => {
  await withFixture((fixture) => {
    const { db } = fixture;
    activateCartonCloudForTest(db.db, "p");
    assert.deepEqual(planCartonStockReset(db.db).refusals, ["Carton Cloud has been activated on this computer: its carton figure is shared with the cloud and is never reset."]);
    assert.throws(() => applyCartonStockReset(db.db, "2026-11-09T00:00:00.000Z"), /REFUSED, nothing changed/);
  });
});

// ─── The Carton Stock page's matrix ───

test("the matrix shows the reconciliation's store figure, by article, size and colour, and reads only", async () => {
  await withFixture((fixture) => {
    const { db } = fixture;
    produce(fixture);
    db.adjustCartonStock(adjustment(fixture, { direction: "OUT", cartons: 3 }));
    const changes = (db.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;

    const matrix = db.cartonStockMatrix();
    const [row] = db.cartonStockReconciliation().rows;

    assert.equal((db.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n, changes, "reads only");
    assert.equal(matrix.articleCount, 1);
    const [article] = matrix.articles;
    assert.equal(article?.article, row?.article.toUpperCase());
    assert.deepEqual(article?.rows.map((line) => [line.size, line.total]), [[row?.size.toUpperCase(), row?.storeFigure]]);
    assert.deepEqual(article?.colours, [row?.color.toUpperCase()]);
    // The fixture's product has no series: it shows under All, and offers no series to pick.
    assert.deepEqual(matrix.seriesOptions, []);
  });
});
