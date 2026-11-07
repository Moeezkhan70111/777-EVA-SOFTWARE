import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddMachineUseCase, InMemoryEventBus } from "@erp/application";
import { CARTON_RESET_MIN_SCHEMA, planCartonStockReset } from "./database/cartonStockReset.js";
import { DISPOSABLE_DEVICE_IDS, applyCartonQrCleanup, planCartonQrCleanup, verifyCartonQrCleanup } from "./database/cartonQrCleanup.js";
import { SqliteDatabase } from "./sqliteDatabase.js";

// CLEARING LOCAL CARTON QR TEST DATA (docs/42 section 15). A real database at the newest migration, with a
// QR population seeded the shape W1's has: a run under a program, cartons stored, one dispatched against a
// voucher, the four named documents, and everything that must stay beside them.

const DEVICE = "dev-gate-holder";
const PC2 = "47c0dace-fe68-42cb-989c-e94f69c62c0f";
const NOW = "2026-10-06T06:00:00.000Z";
const idGen = { nextId: () => crypto.randomUUID() };
const YEAR = { fromDate: "2026-01-01", toDate: "2026-12-31" };
const repoFile = (...parts: string[]) => path.resolve(process.cwd(), "../..", ...parts);

type Db = SqliteDatabase["db"];

/** A row with the columns given and a plain value in every other NOT NULL column. Seeding only. */
function seed(db: Db, table: string, values: Record<string, string | number | null>): void {
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>;
  const known = new Set(columns.map((column) => column.name));
  const row: Record<string, string | number | null> = Object.fromEntries(Object.entries(values).filter(([name]) => known.has(name)));
  for (const column of columns) {
    if (column.name in row || !column.notnull || column.dflt_value !== null) continue;
    row[column.name] = /INT|REAL|NUM/i.test(column.type) ? 1 : `${column.name}-${crypto.randomUUID()}`;
  }
  const names = Object.keys(row);
  db.prepare(`INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...names.map((name) => row[name] ?? null));
}

interface Fixture {
  readonly db: SqliteDatabase;
  readonly dbPath: string;
  readonly contractor: string;
  readonly packer: string;
  readonly variantId: string;
  readonly manualEntryId: string;
  readonly customer: string;
  readonly programId: string;
  readonly keptRun: string;
  readonly loneRun: string;
}

const count = (db: SqliteDatabase, table: string, where = "1 = 1") =>
  Number((db.db.prepare(`SELECT COUNT(1) AS n FROM "${table}" WHERE ${where}`).get() as { n: number }).n);
const rowsOf = (db: SqliteDatabase, table: string) => JSON.stringify(db.db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all());

async function open(device: string): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-qr-clean-"));
  const dbPath = path.join(dir, "erp.db");
  const db = new SqliteDatabase({ dbPath, schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(1, "test");
  db.ensureOperationalContext({ factoryId: "factory-777", factoryCode: "F", factoryName: "777", workstationId: "ws", workstationCode: "WS", workstationName: "w", deviceId: device, deviceName: "d", appVersion: "1" });
  db.db.prepare("INSERT OR REPLACE INTO app_settings (setting_key, setting_value, updated_at) VALUES ('device.id', ?, ?)").run(device, NOW);
  db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 550, machineRate: 70, packingRate: 30, colors: ["RED"], createdBy: "o" } as never);
  const skuId = (db.db.prepare("SELECT id FROM article_sizes").get() as { id: string }).id;
  const variantId = (db.db.prepare("SELECT id FROM product_variants WHERE color = 'RED'").get() as { id: string }).id;
  const party = (name: string, type: string, mobile: string) => db.createParty({ partyName: name, partyType: type, city: "Lahore", mobileNumber: mobile, status: "ACTIVE" } as never);
  const contractor = party("ASLAM", "CONTRACTOR", "0300-1111111");
  const packer = party("BABAR", "CONTRACTOR", "0300-2222222");
  const customer = party("MAMA CHAPPAL KARACHI", "CUSTOMER", "0300-3333333");
  const deps = { txManager: db, repo: db, eventPublisher: new InMemoryEventBus(), idGenerator: idGen };
  const machineId = (await new AddMachineUseCase(deps).execute({ name: "Machine 1", contractorPartyId: contractor, packingContractorPartyId: packer, actor: "admin" })).machineId ?? "";
  const manual = db.recordManualProduction({ requestId: crypto.randomUUID(), machineId, articleSizeId: skuId, color: "RED", dozens: "10", storeLocationId: "factory-777", createdBy: "aslam" });
  const manualEntryId = manual.entry?.id ?? "";
  const programId = (db.db.prepare("SELECT machine_program_id AS id FROM manual_production_entries").get() as { id: string }).id;
  // The fresh start's own rule: a movement stops this tool, so this entry is as one from before it.
  db.db.prepare("DELETE FROM carton_stock_events").run();
  db.db.prepare("DELETE FROM sync_outbox WHERE aggregate_type IN ('CARTON_STOCK_EVENT', 'PRODUCT_VARIANT')").run();

  const raw = db.db;
  raw.exec("PRAGMA foreign_keys = OFF");
  raw.exec("PRAGMA ignore_check_constraints = ON");
  const keptRun = "run-labelled";
  const loneRun = "run-alone";
  seed(raw, "qr_batches", { id: keptRun, machine_program_id: null, article_size_id: skuId, article: "SK6", size: "7/10", grade: null, created_at: NOW });
  seed(raw, "qr_batches", { id: loneRun, machine_program_id: programId, article_size_id: skuId, article: "SK6", size: "7/10", grade: null, created_at: NOW });
  seed(raw, "machine_program_carton_labels", { id: "label-1", program_id: programId, qr_batch_id: keptRun, store_exit_event_id: "raw-exit-1", carton_count: 2 });
  seed(raw, "machine_program_fix_carton_labels", { id: "fix-1", program_id: programId, qr_batch_id: loneRun, carton_count: 1 });
  seed(raw, "machine_program_closures", { id: "closure-1", program_id: programId, cartons_due: 5, cartons_back: 2 });
  seed(raw, "qr_sequences", { id: "seq-1", article: "SK6", color: "RED", size: "7/10", last_sequence: 500, updated_at: NOW });
  for (const [qr, run, status] of [["qr-1", keptRun, "WAREHOUSE"], ["qr-2", keptRun, "DISPATCHED"], ["qr-3", loneRun, "WAREHOUSE"]] as const) {
    seed(raw, "qr_codes", { id: qr, batch_id: run, created_at: NOW });
    seed(raw, "qr_master", { qr_id: qr, product_variant_id: variantId, current_status: status, current_location_type: "WAREHOUSE", first_event_id: `e-${qr}`, created_at: NOW, updated_at: NOW });
    seed(raw, "production_events", { id: `e-${qr}`, qr_id: qr, product_variant_id: variantId, event_type: "MOVED", event_ts_local: NOW, metadata_json: JSON.stringify({ eventType: "STORE_ENTRY" }), created_at: NOW });
  }
  raw.prepare("UPDATE stock_projection_by_variant SET quantity_on_hand = 23").run();
  raw.prepare("INSERT OR REPLACE INTO stock_projection_by_location (product_variant_id, location_type, location_id, quantity_on_hand, updated_at) VALUES (?, 'FACTORY', 'factory-777', 4, ?)").run(variantId, NOW);
  seed(raw, "store_receiving_sessions", { id: "srs-1", created_at: NOW });
  seed(raw, "store_move_out_sessions", { id: "sms-1", created_at: NOW });

  seed(raw, "gatepasses", { id: "gp-1", gatepass_number: 1, status: "BILLED", party_id: customer, created_at: NOW });
  seed(raw, "gatepasses", { id: "gp-2", gatepass_number: 2, status: "AT_GATE", party_id: customer, created_at: NOW });
  seed(raw, "gatepass_lines", { id: "gl-1", gatepass_id: "gp-1", product_variant_id: variantId, quantity: 1 });
  seed(raw, "gatepass_lines", { id: "gl-2", gatepass_id: "gp-2", product_variant_id: variantId, quantity: 1 });
  seed(raw, "sale_vouchers", { id: "sv-1", voucher_number: "1", status: "DRAFT", party_id: customer, gatepass_id: "gp-1", created_at: NOW });
  seed(raw, "sale_vouchers", { id: "sv-2", voucher_number: "2", status: "DRAFT", party_id: customer, gatepass_id: "gp-2", created_at: NOW });
  seed(raw, "sale_voucher_line_items", { id: "li-1", voucher_id: "sv-1" });
  seed(raw, "sale_voucher_line_items", { id: "li-2", voucher_id: "sv-2" });
  seed(raw, "dispatch_sessions", { id: "ds-1", voucher_id: "sv-1", status: "PENDING", created_at: NOW });
  raw.prepare("UPDATE production_events SET dispatch_session_id = 'ds-1', gatepass_id = 'gp-2' WHERE id = 'e-qr-2'").run();
  seed(raw, "user_notifications", { id: "note-gp", user_id: "u", title: "t", message: "m", created_at: NOW, entity_id: "gp-1" });
  seed(raw, "user_notifications", { id: "note-other", user_id: "u", title: "t", message: "m", created_at: NOW, entity_id: "something-else" });

  // What stays: raw material, and queued work that is not carton QR.
  seed(raw, "inventory_stock_events", { id: "raw-1", item_id: "item-1", event_type: "RECEIVE", quantity: 10, unit_id: "u-kg", created_at: NOW });
  seed(raw, "inventory_stock_balances", { item_id: "item-1", quantity_on_hand: 10, unit_id: "u-kg", updated_at: NOW });
  const outbox = (id: string, type: string) => seed(raw, "sync_outbox", { id, aggregate_type: type, aggregate_id: id, operation: "INSERT", dedupe_key: `${type}:${id}`, payload_json: "{}", status: "PENDING", available_at: NOW, created_at: NOW, updated_at: NOW });
  outbox("o-qr", "QR_MASTER");
  outbox("o-prod", "PRODUCTION_EVENT");
  outbox("o-stock", "STOCK_EVENT");
  raw.exec("PRAGMA ignore_check_constraints = OFF");
  raw.exec("PRAGMA foreign_keys = ON");
  return { db, dbPath, contractor, packer, variantId, manualEntryId, customer, programId, keptRun, loneRun };
}

async function withFixture(run: (fixture: Fixture) => void | Promise<void>, device = DEVICE): Promise<void> {
  const fixture = await open(device);
  try {
    await run(fixture);
  } finally {
    fixture.db.close();
    fs.rmSync(path.dirname(fixture.dbPath), { recursive: true, force: true });
  }
}

/** A frozen copy of the database as it stood, to verify against. */
function snapshot(fixture: Fixture): SqliteDatabase {
  const copyPath = `${fixture.dbPath}.before-${crypto.randomUUID()}`;
  fixture.db.db.exec(`VACUUM INTO '${copyPath.replace(/\\/g, "/")}'`);
  return new SqliteDatabase({ dbPath: copyPath, schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
}

const STAYS = ["inventory_stock_events", "inventory_stock_balances", "machine_program_carton_labels", "machine_program_closures", "machine_programs", "qr_sequences", "manual_production_entries", "cash_vouchers", "cash_voucher_lines", "party_claims", "parties"];

test("the plan changes nothing, and counts exactly what would go", async () => {
  await withFixture(({ db }) => {
    const before = STAYS.concat("qr_master", "production_events", "gatepasses").map((table) => rowsOf(db, table));
    const plan = planCartonQrCleanup(db.db);
    assert.deepEqual(STAYS.concat("qr_master", "production_events", "gatepasses").map((table) => rowsOf(db, table)), before);
    assert.deepEqual(plan.refusals, []);
    assert.equal(plan.removes.qr_master, 3);
    assert.equal(plan.removes.production_events, 3);
    assert.equal(plan.removes.qr_batches, 1, "only the run no kept label names");
    assert.equal(plan.removes.gatepasses, 2);
    assert.equal(plan.removes.sale_vouchers, 2);
    assert.equal(plan.removes.sync_outbox, 2, "carton QR rows only");
    assert.equal(plan.earnings.cartons, 3);
  });
});

test("QR records, journeys, runs and figures are cleared", async () => {
  await withFixture((fixture) => {
    const { db } = fixture;
    applyCartonQrCleanup(db.db);
    for (const table of ["qr_master", "qr_codes", "production_events", "machine_program_fix_carton_labels", "store_receiving_sessions", "store_move_out_sessions", "stock_projection_by_variant", "stock_projection_by_location"]) {
      assert.equal(count(db, table), 0, table);
    }
    assert.equal(count(db, "qr_batches", `id = '${fixture.loneRun}'`), 0);
    assert.deepEqual(planCartonStockReset(db.db).refusals, [], "and the fresh start has nothing left to stop at");
    assert.equal(CARTON_RESET_MIN_SCHEMA, 103);
  });
});

test("the four named documents go with every line, session and notice, and nothing is left owed", async () => {
  await withFixture(({ db }) => {
    applyCartonQrCleanup(db.db);
    for (const table of ["gatepasses", "gatepass_lines", "sale_vouchers", "sale_voucher_line_items", "dispatch_sessions"]) assert.equal(count(db, table), 0, table);
    assert.equal(count(db, "user_notifications", "id = 'note-gp'"), 0);
    assert.equal(count(db, "user_notifications", "id = 'note-other'"), 1, "a notice about something else stays");
    const broken = db.db.prepare("PRAGMA foreign_key_check").all() as Array<{ table: string }>;
    const scope = new Set(["gatepass_lines", "sale_vouchers", "sale_voucher_line_items", "dispatch_sessions", "production_events", "machine_program_fix_carton_labels"]);
    assert.deepEqual(broken.filter((row) => scope.has(row.table)), [], "nothing left pointing at what went");
  });
});

test("raw material, closures, the labels, sequences, programs, manual production and contractors do not change", async () => {
  await withFixture(({ db }) => {
    const before = STAYS.map((table) => rowsOf(db, table));
    applyCartonQrCleanup(db.db);
    assert.deepEqual(STAYS.map((table) => rowsOf(db, table)), before);
    assert.equal(count(db, "sync_outbox", "aggregate_type = 'STOCK_EVENT'"), 1, "other queued work stays");
    assert.equal(count(db, "sync_outbox", "aggregate_type IN ('QR_MASTER', 'PRODUCTION_EVENT')"), 0);
  });
});

test("a kept label keeps the run it names, with no codes under it", async () => {
  await withFixture((fixture) => {
    applyCartonQrCleanup(fixture.db.db);
    assert.equal(count(fixture.db, "qr_batches", `id = '${fixture.keptRun}'`), 1);
    assert.equal(count(fixture.db, "machine_program_carton_labels", `qr_batch_id = '${fixture.keptRun}'`), 1);
    assert.equal(count(fixture.db, "qr_codes"), 0);
  });
});

test("QR earnings leave the contractor's ledger, and manual production stays on it", async () => {
  await withFixture(({ db, contractor }) => {
    const cartons = () => db.getContractorLedger(contractor, YEAR).entries.reduce((sum, entry) => sum + (entry.kind === "WORK" ? entry.work.cartons : 0), 0);
    assert.equal(cartons(), 23, "20 manual and 3 QR");
    applyCartonQrCleanup(db.db);
    assert.equal(cartons(), 20, "the manual 20");
    assert.equal(planCartonQrCleanup(db.db).earnings.cartons, 0);
  });
});

test("a cash voucher to a contractor stops it, by number, amount and contractor, changing nothing", async () => {
  await withFixture(({ db, contractor }) => {
    seed(db.db, "cash_vouchers", { id: "cv-1", voucher_number: "CV-7", party_id: contractor, payment_amount_paisa: 500000, status: "ACTIVE", created_at: NOW, updated_at: NOW });
    const before = rowsOf(db, "qr_master");
    const plan = planCartonQrCleanup(db.db);
    assert.deepEqual(plan.payments, [{ kind: "CASH_VOUCHER", id: "cv-1", number: "CV-7", contractor: "ASLAM", amountPaisa: 500000 }]);
    assert.throws(() => applyCartonQrCleanup(db.db), /CV-7 \(cv-1\) on ASLAM, 500000 paisa/);
    assert.equal(rowsOf(db, "qr_master"), before);
    assert.equal(count(db, "cash_vouchers"), 1);
  });
});

test("a payment on a voucher's line stops it too, as does one to a packing contractor", async () => {
  await withFixture(({ db, packer, customer }) => {
    seed(db.db, "cash_vouchers", { id: "cv-2", voucher_number: "CV-8", party_id: customer, payment_amount_paisa: 0, status: "ACTIVE", created_at: NOW, updated_at: NOW });
    seed(db.db, "cash_voucher_lines", { id: "cl-1", voucher_id: "cv-2", party_id: packer, payment_amount_paisa: 7000 });
    assert.deepEqual(planCartonQrCleanup(db.db).payments.map((payment) => [payment.contractor, payment.amountPaisa]), [["BABAR", 7000]]);
    assert.throws(() => applyCartonQrCleanup(db.db), /REFUSED/);
  });
});

test("a claim on a contractor stops it", async () => {
  await withFixture(({ db, contractor }) => {
    db.db.exec("PRAGMA foreign_keys = OFF");
    seed(db.db, "party_claims", { id: "claim-1", claim_number: "CL-1", party_id: contractor, party_role: "MACHINE", quantity_pairs: 9, rate_paisa: 100, amount_paisa: 900, status: "POSTED" });
    db.db.exec("PRAGMA foreign_keys = ON");
    assert.throws(() => applyCartonQrCleanup(db.db), /CLAIM CL-1/);
  });
});

for (const [name, change, refusal] of [
  ["a gatepass 1 of another customer", "UPDATE gatepasses SET party_id = (SELECT id FROM parties WHERE party_name = 'ASLAM') WHERE gatepass_number = 1", /Gatepass 1 here/],
  ["a gatepass 2 of another date", "UPDATE gatepasses SET created_at = '2026-10-07T00:00:00.000Z' WHERE gatepass_number = 2", /Gatepass 2 here/],
  ["a sale voucher 1 no longer a draft", "UPDATE sale_vouchers SET status = 'POSTED' WHERE voucher_number = '1'", /Sale voucher 1 here/],
] as const) {
  test(`${name} is not the record named: it stops, never going by the number alone`, async () => {
    await withFixture(({ db }) => {
      db.db.exec("PRAGMA ignore_check_constraints = ON");
      db.db.prepare(change).run();
      db.db.exec("PRAGMA ignore_check_constraints = OFF");
      const before = rowsOf(db, "gatepasses") + rowsOf(db, "sale_vouchers");
      assert.throws(() => applyCartonQrCleanup(db.db), refusal);
      assert.equal(rowsOf(db, "gatepasses") + rowsOf(db, "sale_vouchers"), before);
      assert.equal(count(db, "qr_master"), 3);
    });
  });
}

test("another gatepass, voucher or carton movement here stops it: only what was named goes", async () => {
  await withFixture(({ db, customer, variantId }) => {
    seed(db.db, "gatepasses", { id: "gp-3", gatepass_number: 3, status: "CREATED", party_id: customer, created_at: NOW });
    seed(db.db, "sale_vouchers", { id: "sv-3", voucher_number: "3", status: "DRAFT", party_id: customer, created_at: NOW });
    db.adjustCartonStock({ requestId: crypto.randomUUID(), articleSizeId: (db.db.prepare("SELECT id FROM article_sizes").get() as { id: string }).id, color: "RED", direction: "IN", cartons: 1, reason: "r", adjustedBy: "o", storeLocationId: "factory-777" });
    assert.ok(variantId);
    const reasons = planCartonQrCleanup(db.db).refusals.join("\n");
    assert.match(reasons, /1 other gatepass/);
    assert.match(reasons, /1 other sale voucher/);
    assert.match(reasons, /carton movement/);
  });
});

test("a database that is not a disposable rehearsal one is refused, whatever it holds: PC2 cannot be cleared", async () => {
  assert.equal(DISPOSABLE_DEVICE_IDS.has(PC2), false);
  await withFixture(({ db }) => {
    assert.throws(() => applyCartonQrCleanup(db.db), /not a disposable rehearsal database/);
    assert.equal(count(db, "qr_master"), 3);
    assert.equal(db.db.isTransaction, false);
    assert.deepEqual(planCartonQrCleanup(db.db).refusals, [], "it can still be planned against, read-only");
  }, PC2);
});

test("it can be repeated: a second run clears nothing and changes nothing", async () => {
  await withFixture(({ db }) => {
    applyCartonQrCleanup(db.db);
    const tables = ["qr_batches", "sync_outbox", "user_notifications", ...STAYS];
    const after = tables.map((table) => rowsOf(db, table));
    const second = applyCartonQrCleanup(db.db);
    assert.equal(second.removes.qr_master, 0);
    assert.equal(second.removes.gatepasses, 0);
    assert.deepEqual(tables.map((table) => rowsOf(db, table)), after);
  });
});

test("it does not come back when the database opens again", async () => {
  await withFixture((fixture) => {
    applyCartonQrCleanup(fixture.db.db);
    fixture.db.close();
    const reopened = new SqliteDatabase({ dbPath: fixture.dbPath, schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
    try {
      for (const table of ["qr_master", "production_events", "qr_codes", "stock_projection_by_location", "stock_projection_by_variant", "gatepasses", "sale_vouchers"]) assert.equal(count(reopened, table), 0, table);
    } finally {
      reopened.close();
      (fixture as { db: SqliteDatabase }).db = new SqliteDatabase({ dbPath: fixture.dbPath, schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
    }
  });
});

test("the checks pass on a real run, and notice a kept table changed or a row left behind", async () => {
  await withFixture((fixture) => {
    const before = snapshot(fixture);
    try {
      const plan = applyCartonQrCleanup(fixture.db.db);
      const failed = () => verifyCartonQrCleanup(before.db, fixture.db.db, plan).filter((check) => !check.ok).map((check) => check.name);
      assert.deepEqual(failed(), []);
      fixture.db.db.prepare("UPDATE machine_program_closures SET cartons_back = 1").run();
      assert.deepEqual(failed(), ["Every other table"]);
      fixture.db.db.exec("PRAGMA foreign_keys = OFF");
      seed(fixture.db.db, "qr_codes", { id: "late", batch_id: fixture.keptRun, created_at: NOW });
      assert.ok(failed().includes("QR data and carton figures"));
    } finally {
      before.close();
    }
  });
});

test("it opens no connection: nothing in the tool or its script can reach a cloud", () => {
  const sources = [fs.readFileSync(repoFile("packages/data/src/database/cartonQrCleanup.ts"), "utf8"), fs.readFileSync(repoFile("scripts/clear-carton-qr-test-data.mjs"), "utf8")].join("\n");
  const code = sources.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /supabase|https?:|fetch\(|node:https?|node:net|@erp\/sync|requestJson/i);
  const imports = [...code.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(imports)].sort(), ["../packages/data/dist/database/cartonQrCleanup.js", "node:crypto", "node:fs", "node:path", "node:sqlite", "node:util"].sort());
});
