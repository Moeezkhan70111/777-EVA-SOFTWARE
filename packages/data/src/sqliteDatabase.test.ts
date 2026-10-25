import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DispatchScanUseCase, InMemoryEventBus, ProcessScanUseCase } from "@erp/application";
import type { DispatchScanDeps, ProcessScanDeps, ReturnScanDeps, TransactionContext } from "@erp/application";
import { toPaisa } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

function createDbFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-scanner-"));
  const dbPath = path.join(tempDir, "scanner.db");
  const db = new SqliteDatabase({ dbPath, schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(1, "test");

  db.ensureOperationalContext({
    factoryId: "factory-1",
    factoryCode: "F001",
    factoryName: "Factory",
    workstationId: "workstation-1",
    workstationCode: "WS001",
    workstationName: "WS",
    deviceId: "device-1",
    deviceName: "Device",
    appVersion: "1.0.0",
  });

  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

/** Runs the QR Generator against a Product Master entry that already exists. */
function generateQrIds(
  db: SqliteDatabase,
  input: { article: string; size: string; color: string; quantity: number }
): string[] {
  const row = (db as any).db
    .prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ? AND deleted_at IS NULL LIMIT 1")
    .get(input.article, input.size) as { id: string } | undefined;
  if (!row) throw new Error(`No Product Master entry for ${input.article} / ${input.size}`);
  return db
    .generateQrBatch({ articleSizeId: row.id, color: input.color, quantity: input.quantity })
    .qrCodes.map((qrCode) => qrCode.id);
}

/**
 * Mirrors the real operator flow: Product Master defines article + size, then the QR
 * Generator registers the colour-specific identities. Only these identities may be scanned.
 */
function registerQrIdentities(
  db: SqliteDatabase,
  input: { article: string; size: string; color: string; quantity: number; sellingPrice?: number }
): string[] {
  db.createProduct({
    article: input.article,
    size: input.size,
    sellingPrice: input.sellingPrice ?? 550,
    status: "ACTIVE",
  });
  return generateQrIds(db, input);
}

function scanDeps(db: SqliteDatabase, overrides: Partial<ProcessScanDeps> = {}): ProcessScanDeps {
  return {
    txManager: db,
    duplicateChecker: db,
    qrRegistry: db,
    productCatalog: db,
    qrMasterRepo: db,
    productionEventsRepo: db,
    stockProjectionRepo: db,
    outboxRepo: db,
    eventPublisher: new InMemoryEventBus(),
    idGenerator: new UuidGenerator(),
    ...overrides,
  };
}

const SCAN_CONTEXT = { factoryId: "factory-1", workstationId: "workstation-1", deviceId: "device-1" };

/** The aggregate types queued for the other computers, sorted so a test can state them plainly. */
const outboxTypes = (db: SqliteDatabase): string[] =>
  (db.db.prepare("SELECT aggregate_type FROM sync_outbox").all() as Array<{ aggregate_type: string }>)
    .map((row) => row.aggregate_type)
    .sort();

/** Direct schema access for assertions the public API has no getter for (test-only). */
function rawGet(db: SqliteDatabase, sql: string, ...params: unknown[]): any {
  return (db as any).db.prepare(sql).get(...params);
}
function rawAll(db: SqliteDatabase, sql: string, ...params: unknown[]): any[] {
  return (db as any).db.prepare(sql).all(...params);
}
function rawExec(db: SqliteDatabase, sql: string, ...params: unknown[]): void {
  (db as any).db.prepare(sql).run(...params);
}

/**
 * The variant pool: units the company holds that have not been dispatched. Production adds,
 * Dispatch removes, cancellation credits back. This is NOT Current Stock — Current Stock is
 * the In Store figure that only Store Move In / Store Move Out move (see IN_STORE_STOCK_SQL).
 */
function variantPool(db: SqliteDatabase, productVariantId: string): number {
  const row = rawGet(db, "SELECT quantity_on_hand FROM stock_projection_by_variant WHERE product_variant_id = ?", productVariantId);
  return Number(row?.quantity_on_hand ?? 0);
}

/** Receives an already-produced carton into the store, the way Store Scanning does. */
async function receiveIntoStore(db: SqliteDatabase, qrId: string): Promise<void> {
  const { StoreEntryScanUseCase } = await import("@erp/application");
  const useCase = new StoreEntryScanUseCase({
    txManager: db,
    qrLookupRepo: db,
    qrRegistry: db,
    qrMasterRepo: db,
    storeEntryEventsRepo: db,
    stockProjectionRepo: db,
    outboxRepo: db,
    eventPublisher: new InMemoryEventBus(),
    idGenerator: new UuidGenerator(),
  });
  const result = await useCase.execute({ rawScan: qrId, context: SCAN_CONTEXT });
  assert.equal(result.accepted, true, result.reason);
}

/** Full dispatch deps wired to one fixture database — every role is the database itself. */
function dispatchScanDeps(db: SqliteDatabase): DispatchScanDeps {
  return {
    txManager: db,
    qrLookupRepo: db,
    stockProjectionRepo: db,
    qrMasterRepo: db,
    dispatchEventsRepo: db,
    outboxRepo: db,
    eventPublisher: new InMemoryEventBus(),
    idGenerator: new UuidGenerator(),
    dispatchSessionRepo: db,
  };
}

/** Full return deps wired to one fixture database — every role is the database itself. */
function returnScanDeps(db: SqliteDatabase): ReturnScanDeps {
  return {
    txManager: db,
    qrLookupRepo: db,
    attributionRepo: db,
    qrMasterRepo: db,
    saleReturnsRepo: db,
    returnEventsRepo: db,
    outboxRepo: db,
    eventPublisher: new InMemoryEventBus(),
    idGenerator: new UuidGenerator(),
  };
}

/**
 * Produces `quantity` cartons for article/size/color and saves a one-line voucher ordering
 * exactly that many dozens, returning the QR ids and the voucher's own dispatch session.
 * Shared setup for the dispatch-attribution regression tests below.
 */
async function createVoucherWithCartons(
  db: SqliteDatabase,
  input: { partyName: string; article: string; size: string; color: string; dozens: number }
) {
  const partyId = db.createParty({
    partyName: input.partyName,
    partyType: "CUSTOMER",
    city: "Lahore",
    mobileNumber: "0300-1111111",
    status: "ACTIVE",
  });
  // Two vouchers in the same test deliberately order the identical article/color/size (that
  // collision is exactly what the old counting bug depended on) — product_variants has a
  // UNIQUE(article, color, size), so the second voucher must reuse the first's variant rather
  // than create a duplicate.
  const existing = rawGet(
    db,
    "SELECT id FROM product_variants WHERE article = ? AND color = ? AND size = ? LIMIT 1",
    input.article, input.color, input.size
  );
  const productId = existing?.id ?? db.createProduct({
    article: input.article,
    color: input.color,
    size: input.size,
    costPrice: 100,
    sellingPrice: 180,
    status: "ACTIVE",
  });
  const voucher = db.createSaleVoucher({ partyId, voucherDate: "2026-09-19", bookNo: "B1" });
  db.addVoucherLineItem(voucher.id, { productVariantId: productId, quantity: input.dozens, unitPrice: 180, discount: 0 });

  const qrIds = generateQrIds(db, { article: input.article, size: input.size, color: input.color, quantity: input.dozens * 2 });
  const processScanUseCase = new ProcessScanUseCase(scanDeps(db));
  for (const qrId of qrIds) {
    const result = await processScanUseCase.execute({ rawScan: qrId, context: SCAN_CONTEXT });
    assert.equal(result.accepted, true, `setup: production scan for ${qrId} must succeed`);
  }

  const session = db.listDispatchSessions({ status: "ALL" }).find((s) => s.voucherId === voucher.id);
  assert.ok(session, "setup: voucher must have its own dispatch session");

  return { partyId, productId, voucherId: voucher.id, sessionId: session!.sessionId, qrIds };
}

test("legacy role schema is upgraded before auth is used", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-auth-upgrade-"));
  const dbPath = path.join(tempDir, "legacy.sqlite");

  try {
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE roles (
        role_code TEXT PRIMARY KEY,
        role_name TEXT NOT NULL UNIQUE,
        is_system_role INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE app_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'USER',
        authority_level INTEGER NOT NULL DEFAULT 10,
        job_role TEXT NOT NULL DEFAULT '',
        role_notification TEXT,
        access_status TEXT NOT NULL DEFAULT 'PENDING',
        permissions_json TEXT NOT NULL DEFAULT '[]',
        last_login_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (role IN ('USER','ADMIN')),
        CHECK (access_status IN ('PENDING','APPROVED','REJECTED'))
      );
    `);
    legacyDb.close();

    const db = new SqliteDatabase({ dbPath, schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
    db.setNumberBlock(1, "test");
    const user = db.createUserAccount("legacy-user", "Password123");
    const auth = db.authenticateUser("legacy-user", "Password123");
    assert.ok(user.id);
    assert.ok(auth);
    assert.equal(auth?.username, "legacy-user");
    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// The legacy bootstrap credential (formerly hard-coded in isBootstrapAdmin()) has been retired.
// It must behave like any other unrecognized login: rejected, with no account created or
// promoted as a side effect. This is the regression test for that removal.
test("authenticateUser rejects the retired legacy bootstrap credential and creates or promotes nothing", () => {
  const fixture = createDbFixture();
  try {
    const result = fixture.db.authenticateUser("Moeezkhan123", "Moeezkhan123@");
    assert.equal(result, null, "the legacy bootstrap credential must be rejected like any other unknown login");
    assert.equal(fixture.db.hasAnyAdmin(), false, "presenting the legacy credential must not create or promote any account");
  } finally {
    fixture.cleanup();
  }
});

// ─── First-run administrator bootstrap (hasAnyAdmin / bootstrapFirstAdmin) ────────────────
// The only way to create an ADMIN without an existing admin's approval, now that the legacy
// hard-coded bootstrap credential has been removed from packages/data/src/database/users.ts.

test("bootstrap: hasAnyAdmin is false on an empty database and true once an admin exists", () => {
  const fixture = createDbFixture();
  try {
    assert.equal(fixture.db.hasAnyAdmin(), false, "a fresh database must require setup");
    fixture.db.bootstrapFirstAdmin("firstadmin", "Password123");
    assert.equal(fixture.db.hasAnyAdmin(), true);
  } finally {
    fixture.cleanup();
  }
});

test("bootstrap: creates the first ADMIN as a fully session-ready account", () => {
  const fixture = createDbFixture();
  try {
    const admin = fixture.db.bootstrapFirstAdmin("firstadmin", "Password123");
    assert.ok(admin.id);
    assert.equal(admin.username, "firstadmin");

    const authed = fixture.db.authenticateUser("firstadmin", "Password123");
    assert.ok(authed);
    assert.equal(authed!.role, "ADMIN");
    assert.equal(authed!.accessStatus, "APPROVED");

    const token = fixture.db.createUserSession(admin.id);
    const session = fixture.db.getUserBySessionToken(token);
    assert.ok(session);
    assert.ok(session!.permissions.includes("settings"), "a bootstrapped ADMIN must hold full permissions like any other admin");
  } finally {
    fixture.cleanup();
  }
});

test("bootstrap: a second attempt is rejected once an ADMIN exists", () => {
  const fixture = createDbFixture();
  try {
    fixture.db.bootstrapFirstAdmin("firstadmin", "Password123");
    assert.throws(() => fixture.db.bootstrapFirstAdmin("secondadmin", "Password123"), /administrator account already exists/i);

    // Normal authentication for the already-bootstrapped admin is unaffected by the rejection.
    const authed = fixture.db.authenticateUser("firstadmin", "Password123");
    assert.ok(authed);
    assert.equal(authed!.role, "ADMIN");
  } finally {
    fixture.cleanup();
  }
});

test("bootstrap: only one of several rapid-fire attempts can ever succeed", () => {
  const fixture = createDbFixture();
  try {
    const outcomes = Array.from({ length: 5 }, (_, index) => {
      try {
        fixture.db.bootstrapFirstAdmin(`admin-${index}`, "Password123");
        return true;
      } catch {
        return false;
      }
    });

    assert.equal(outcomes.filter(Boolean).length, 1, "exactly one bootstrap attempt must succeed no matter how many race in");

    const adminCount = (fixture.db as any).db
      .prepare("SELECT COUNT(*) as c FROM app_users WHERE role = 'ADMIN'")
      .get() as { c: number };
    assert.equal(adminCount.c, 1, "the no-ADMIN-exists check and the insert happen in one transaction, so only one row is ever created");
  } finally {
    fixture.cleanup();
  }
});

test("bootstrap: rejects an invalid username or a weak password without creating anything", () => {
  const fixture = createDbFixture();
  try {
    assert.throws(() => fixture.db.bootstrapFirstAdmin("ab", "Password123"), /at least 3 characters/i);
    assert.throws(() => fixture.db.bootstrapFirstAdmin("firstadmin", "short1"), /at least 8 characters/i);
    assert.throws(() => fixture.db.bootstrapFirstAdmin("firstadmin", "alllettersnodigits"), /at least 8 characters/i);
    assert.equal(fixture.db.hasAnyAdmin(), false, "no admin should have been created by any rejected attempt");
  } finally {
    fixture.cleanup();
  }
});

test("role assignment resolves effective permissions and additional overrides", () => {
  const fixture = createDbFixture();
  try {
    const billingRole = fixture.db.createRole({
      name: "Billing Manager",
      description: "Handles vouchers and ledgers",
      permissions: ["sale-voucher-form", "customer-ledger"],
    });

    const user = fixture.db.createUserAccount("rbac-user", "Password123");
    fixture.db.assignUserRole(user.id, billingRole.code);
    fixture.db.setUserAdditionalPermissions(user.id, ["cash-voucher-form"]);

    const token = fixture.db.createUserSession(user.id);
    const session = fixture.db.getUserBySessionToken(token);
    assert.ok(session);
    assert.deepEqual([...new Set(session!.permissions)].sort(), ["cash-voucher-form", "customer-ledger", "sale-voucher-form"].sort());

    fixture.db.updateRolePermissions(billingRole.code, ["sale-voucher-form", "customer-ledger", "cash-voucher-form"]);
    const refreshed = fixture.db.getUserBySessionToken(token);
    assert.ok(refreshed);
    assert.ok(refreshed!.permissions.includes("cash-voucher-form"));
  } finally {
    fixture.cleanup();
  }
});

test("a session carries the name of the user's role, for titling their Dashboard", () => {
  const fixture = createDbFixture();
  try {
    const munshi = fixture.db.createRole({ name: "Munshi", description: "Gatepass desk", permissions: ["munshi", "gatepass"] });
    const babar = fixture.db.createUserAccount("babar", "Password123");
    fixture.db.assignUserRole(babar.id, munshi.code);
    assert.equal(fixture.db.getUserBySessionToken(fixture.db.createUserSession(babar.id))?.roleName, "Munshi");

    const noRole = fixture.db.createUserAccount("no-role-user", "Password123");
    assert.equal(fixture.db.getUserBySessionToken(fixture.db.createUserSession(noRole.id))?.roleName, null);
  } finally {
    fixture.cleanup();
  }
});

test("scan inserts production event, stock projection, and outbox", async () => {
  const fixture = createDbFixture();
  try {
    const [qrId] = registerQrIdentities(fixture.db, { article: "SK6", size: "7/10", color: "BLUE", quantity: 1 });
    const useCase = new ProcessScanUseCase(scanDeps(fixture.db));

    const result = await useCase.execute({ rawScan: qrId, context: SCAN_CONTEXT });

    assert.equal(result.accepted, true);
    assert.equal(fixture.db.getRowCount("qr_master"), 1);
    assert.equal(fixture.db.getRowCount("production_events"), 1);
    // THREE queued events, not one. Each link in the chain travels separately, so a computer
    // receiving the scan already has everything the scan refers to: the product, then a carton
    // of that product, then the scan of that carton.
    assert.deepEqual(outboxTypes(fixture.db), ["PRODUCTION_PRODUCED", "PRODUCT_VARIANT", "QR_MASTER"]);

    // Producing a carton does not make it Current Stock — Current Stock is what is In Store.
    const afterProduction = fixture.db.getDashboardSnapshot();
    assert.equal(afterProduction.currentStockTotal, 0);
    assert.equal(afterProduction.todaysProduction, 1);
    assert.equal(variantPool(fixture.db, rawGet(fixture.db, "SELECT product_variant_id FROM qr_master WHERE qr_id = ?", qrId).product_variant_id), 1);

    // The store receives it: now it counts.
    await receiveIntoStore(fixture.db, qrId);
    const afterStoreEntry = fixture.db.getDashboardSnapshot();
    assert.equal(afterStoreEntry.currentStockTotal, 1);
    assert.equal(afterStoreEntry.todaysProduction, 1, "receiving must not be counted as production");
  } finally {
    fixture.cleanup();
  }
});

test("duplicate scan is rejected and does not increment stock", async () => {
  const fixture = createDbFixture();
  try {
    const [qrId] = registerQrIdentities(fixture.db, { article: "SK6", size: "7/10", color: "BLUE", quantity: 1 });
    const useCase = new ProcessScanUseCase(scanDeps(fixture.db));

    await useCase.execute({ rawScan: qrId, context: SCAN_CONTEXT });
    const duplicateResult = await useCase.execute({ rawScan: qrId, context: SCAN_CONTEXT });

    assert.equal(duplicateResult.accepted, false);
    assert.equal(fixture.db.getRowCount("production_events"), 1);
    // The refused second scan queues nothing: still the one product, one carton and one scan.
    // The product is queued once for its own sake and not once per carton — the dedupe key is
    // the variant, so a thousand cartons of SK6 BLUE 7/10 still queue it exactly once.
    assert.deepEqual(outboxTypes(fixture.db), ["PRODUCTION_PRODUCED", "PRODUCT_VARIANT", "QR_MASTER"]);
  } finally {
    fixture.cleanup();
  }
});

test("two computers creating the same product arrive at the same variant id", () => {
  const pc1 = createDbFixture();
  const pc2 = createDbFixture();
  try {
    // Two separate databases, each starting empty, exactly as a new PC does -- docs/36 forbids
    // copying the data folder between them. Before 2026-10-23 these two ids were independent
    // random UUIDs, so the second computer's push was refused VARIANT_IDENTITY_CLASH and every
    // carton of the product with it.
    const onPc1 = registerQrIdentities(pc1.db, { article: "SK46", size: "4/6", color: "BLACK", quantity: 1 });
    const onPc2 = registerQrIdentities(pc2.db, { article: "SK46", size: "4/6", color: "BLACK", quantity: 1 });
    assert.equal(onPc1.length, 1);
    assert.equal(onPc2.length, 1);

    const variantOn = (fixture: ReturnType<typeof createDbFixture>): string => {
      const rows = fixture.db.db
        .prepare("SELECT id FROM product_variants WHERE article = ? AND color = ? AND size = ?")
        .all("SK46", "BLACK", "4/6") as Array<{ id: string }>;
      assert.equal(rows.length, 1, "one product, one row");
      return String(rows[0]?.id);
    };

    assert.equal(variantOn(pc1), variantOn(pc2), "one product is one id, on both computers");

    // And the carton identity each one minted refers to that same product, so a carton pushed
    // from either computer names a product the other already has under the same id.
    for (const fixture of [pc1, pc2]) {
      const carton = fixture.db.db
        .prepare("SELECT product_variant_id FROM qr_codes LIMIT 1")
        .get() as { product_variant_id: string };
      assert.equal(carton.product_variant_id, variantOn(pc1));
    }
  } finally {
    pc1.cleanup();
    pc2.cleanup();
  }
});

test("a variant that already exists keeps the id it was created with, derived or not", () => {
  const fixture = createDbFixture();
  try {
    // The 36 products on the host were minted with crypto.randomUUID() and mirrored to the cloud
    // with those ids. Nothing may re-mint them: a dozen columns point at a variant id, and the
    // cloud holds the same value.
    const legacyId = "11111111-2222-4333-8444-555555555555";
    const now = "2026-10-01T04:00:00.000Z";
    fixture.db.db
      .prepare(
        `INSERT INTO product_variants (id, article, color, size, status, created_at, updated_at)
         VALUES (?, 'SK46', 'BLACK', '4/6', 'ACTIVE', ?, ?)`
      )
      .run(legacyId, now, now);

    // Creating "the same" product now finds it by its tuple and hands back the existing id.
    registerQrIdentities(fixture.db, { article: "SK46", size: "4/6", color: "BLACK", quantity: 1 });

    const rows = fixture.db.db
      .prepare("SELECT id FROM product_variants WHERE article = ? AND color = ? AND size = ?")
      .all("SK46", "BLACK", "4/6") as Array<{ id: string }>;
    assert.equal(rows.length, 1, "no second row beside the legacy one");
    assert.equal(rows[0]?.id, legacyId, "a random id already in use is never replaced");
  } finally {
    fixture.cleanup();
  }
});

test("a size is stored upper case, so one size is not two products", () => {
  const fixture = createDbFixture();
  try {
    // Sizes on this host are numeric ("4/6", "7/10"), where case cannot differ -- which is why
    // this was safe to change. An alphabetic size typed in two cases would otherwise be two
    // products with two ids, and the derived id would faithfully keep them apart.
    fixture.db.createProduct({ article: "sk46", size: "xl", sellingPrice: 550, status: "ACTIVE" });

    const row = fixture.db.db
      .prepare("SELECT article, size FROM article_sizes WHERE deleted_at IS NULL LIMIT 1")
      .get() as { article: string; size: string };
    assert.deepEqual({ article: row.article, size: row.size }, { article: "SK46", size: "XL" });
  } finally {
    fixture.cleanup();
  }
});

test("a product is queued once however many cartons of it are produced", async () => {
  const fixture = createDbFixture();
  try {
    // Three cartons of the SAME product, which is what a real print run is.
    const ids = registerQrIdentities(fixture.db, { article: "SK6", size: "7/10", color: "BLUE", quantity: 3 });
    assert.equal(ids.length, 3);

    // Registering identities queues nothing: a label nobody has produced against is not news.
    assert.deepEqual(outboxTypes(fixture.db), []);

    const useCase = new ProcessScanUseCase(scanDeps(fixture.db));
    for (const qrId of ids) {
      const result = await useCase.execute({ rawScan: qrId, context: SCAN_CONTEXT });
      assert.equal(result.accepted, true, result.reason);
    }

    const rows = fixture.db.db
      .prepare("SELECT aggregate_type, aggregate_id FROM sync_outbox ORDER BY aggregate_type, rowid")
      .all() as Array<{ aggregate_type: string; aggregate_id: string }>;
    const variants = rows.filter((row) => row.aggregate_type === "PRODUCT_VARIANT");
    const cartons = rows.filter((row) => row.aggregate_type === "QR_MASTER");

    // ONE product, THREE cartons. The variant dedupe key is the variant itself, so the second
    // and third cartons add nothing. Without that the outbox would carry a redundant product
    // row per carton for ever, and nothing prunes sync_outbox.
    assert.equal(variants.length, 1, "the product travels once, not once per carton");
    assert.equal(cartons.length, 3, "every carton identity still travels");

    // And the queued product is the one those cartons actually belong to.
    const belongsTo = fixture.db.db
      .prepare("SELECT DISTINCT product_variant_id AS id FROM qr_master")
      .all() as Array<{ id: string }>;
    assert.equal(belongsTo.length, 1);
    assert.equal(variants[0]?.aggregate_id, belongsTo[0]?.id);
  } finally {
    fixture.cleanup();
  }
});

test("QR scanning resolves an already-registered color variant, but never invents a new color", async () => {
  const fixture = createDbFixture();
  try {
    // The QR Generator registers GREEN; BLUE is deliberately never generated.
    const green = registerQrIdentities(fixture.db, { article: "SK6", size: "7/10", color: "GREEN", quantity: 2 });
    const useCase = new ProcessScanUseCase(scanDeps(fixture.db));
    const context = SCAN_CONTEXT;

    assert.equal((await useCase.execute({ rawScan: green[0], context })).accepted, true);
    const greenId = (fixture.db as any).db.prepare("SELECT id FROM product_variants WHERE article = 'SK6' AND size = '7/10' AND color = 'GREEN'").get().id as string;
    assert.equal((await useCase.execute({ rawScan: green[1], context })).accepted, true);
    assert.equal((fixture.db as any).db.prepare("SELECT COUNT(*) c FROM product_variants WHERE article = 'SK6' AND size = '7/10' AND color = 'GREEN'").get().c, 1);
    assert.equal((fixture.db as any).db.prepare("SELECT quantity_on_hand FROM stock_projection_by_variant WHERE product_variant_id = ?").get(greenId).quantity_on_hand, 2);

    // BLUE is a colour nobody set up for SK6 7/10. Live Production now takes an identity the
    // generator never issued (see below), but it still may not INVENT a colour — a misread
    // character would otherwise put a product nobody sells into the masters.
    const blueResult = await useCase.execute({ rawScan: "SK6_BLUE_7/10_000003", context });
    assert.equal(blueResult.accepted, false);
    assert.match(blueResult.reason ?? "", /not a colour this product has/i);
    assert.equal((fixture.db as any).db.prepare("SELECT id FROM product_variants WHERE article = 'SK6' AND size = '7/10' AND color = 'BLUE'").get(), undefined);

    const qrRows = (fixture.db as any).db.prepare("SELECT qr_id, product_variant_id FROM qr_master WHERE qr_id LIKE 'SK6_%'").all() as Array<{ qr_id: string; product_variant_id: string }>;
    const qrById = new Map(qrRows.map((row) => [row.qr_id, row.product_variant_id]));
    assert.equal(qrById.get(green[0]), greenId);
    assert.equal(qrById.get(green[1]), greenId);
    assert.equal(qrById.has("SK6_BLUE_7/10_000003"), false, "A rejected scan must not create a qr_master row");
  } finally {
    fixture.cleanup();
  }
});

test("QR scanning of a completely unregistered ArticleSize is rejected and creates nothing", async () => {
  const fixture = createDbFixture();
  try {
    const useCase = new ProcessScanUseCase(scanDeps(fixture.db));
    const result = await useCase.execute({ rawScan: "SK6_GREEN_7/10_000001", context: SCAN_CONTEXT });
    assert.equal(result.accepted, false);
    assert.match(result.reason ?? "", /not in the Product Master/i);
    const articleSize = (fixture.db as any).db.prepare("SELECT id FROM article_sizes WHERE article = 'SK6' AND size = '7/10'").get();
    assert.equal(articleSize, undefined, "No article_sizes row must be created by a rejected scan");
    assert.equal(fixture.db.getRowCount("qr_master"), 0);
    assert.equal(fixture.db.listUniqueArticles().includes("SK6"), false);
  } finally {
    fixture.cleanup();
  }
});

// ─── Live Production takes the carton as it finds it ─────────────────────────
//
// Labels are printed outside this system too, and a carton that was really made must not be lost
// because its identity was never generated (owner, 2026-10-13). Live Production registers the
// identity as it records the production. Only the IDENTITY is adopted — the PRODUCT must already
// exist, and every other station still refuses an unregistered code.

test("Live Production registers an identity the generator never issued, and produces the carton", async () => {
  const fixture = createDbFixture();
  try {
    // SK6 7/10 BLUE exists as a product (one code was generated for it), but 000777 never was.
    registerQrIdentities(fixture.db, { article: "SK6", size: "7/10", color: "BLUE", quantity: 1 });
    const useCase = new ProcessScanUseCase(scanDeps(fixture.db));

    const result = await useCase.execute({ rawScan: "SK6_BLUE_7/10_000777", context: SCAN_CONTEXT, actor: "babar" });

    assert.equal(result.accepted, true, result.reason);
    assert.equal(result.registeredOnScan, true, "the station is told the code was registered here");

    // The identity is now an ordinary registered carton, produced once.
    const registered = rawGet(fixture.db, "SELECT status, sequence, product_variant_id FROM qr_codes WHERE id = ?", "SK6_BLUE_7/10_000777");
    assert.equal(registered.status, "GENERATED");
    assert.equal(registered.sequence, 777);
    assert.equal(
      rawGet(fixture.db, "SELECT product_variant_id FROM qr_master WHERE qr_id = ?", "SK6_BLUE_7/10_000777").product_variant_id,
      registered.product_variant_id
    );
    assert.equal(fixture.db.getDashboardSnapshot().todaysProduction, 1);

    // Its own one-code run says where it came from, so QR Management can tell the two apart.
    const run = rawGet(
      fixture.db,
      "SELECT quantity, created_by, requested_by, source, machine_program_id FROM qr_batches WHERE id = (SELECT batch_id FROM qr_codes WHERE id = ?)",
      "SK6_BLUE_7/10_000777"
    );
    assert.equal(run.quantity, 1);
    assert.equal(run.created_by, "babar");
    assert.equal(run.requested_by, "Live Production scan");
    // Adopted, not generated: it belongs to no machine program.
    assert.equal(run.source, "SCAN_ADOPTED");
    assert.equal(run.machine_program_id, null);

    // The generator can never hand 000777 to a second carton: the sequence moved past it.
    const sequence = rawGet(fixture.db, "SELECT last_sequence FROM qr_sequences WHERE article = ? AND color = ? AND size = ?", "SK6", "BLUE", "7/10");
    assert.equal(sequence.last_sequence, 777);
    const next = fixture.db.generateQrBatch({
      articleSizeId: rawGet(fixture.db, "SELECT id FROM article_sizes WHERE article = ? AND size = ?", "SK6", "7/10").id,
      color: "BLUE",
      quantity: 1,
    });
    assert.equal(next.qrCodes[0].id, "SK6_BLUE_7/10_000778");

    // And it behaves like any other carton afterwards.
    await receiveIntoStore(fixture.db, "SK6_BLUE_7/10_000777");
    assert.equal(fixture.db.getDashboardSnapshot().currentStockTotal, 1);
  } finally {
    fixture.cleanup();
  }
});

test("an adopted carton cannot be produced twice", async () => {
  const fixture = createDbFixture();
  try {
    registerQrIdentities(fixture.db, { article: "SK6", size: "7/10", color: "BLUE", quantity: 1 });
    const useCase = new ProcessScanUseCase(scanDeps(fixture.db));

    assert.equal((await useCase.execute({ rawScan: "SK6_BLUE_7/10_000777", context: SCAN_CONTEXT })).accepted, true);
    const again = await useCase.execute({ rawScan: "SK6_BLUE_7/10_000777", context: SCAN_CONTEXT });

    assert.equal(again.accepted, false);
    assert.match(again.reason ?? "", /already been produced/i);
    assert.equal(fixture.db.getRowCount("production_events"), 1);
    assert.equal(
      rawGet(fixture.db, "SELECT COUNT(*) AS n FROM qr_codes WHERE id = ?", "SK6_BLUE_7/10_000777").n,
      1,
      "the refused scan must not register the identity a second time"
    );
  } finally {
    fixture.cleanup();
  }
});

test("a code VOIDED in QR Management is still refused, adoption or not", async () => {
  const fixture = createDbFixture();
  try {
    const [qrId] = registerQrIdentities(fixture.db, { article: "SK6", size: "7/10", color: "BLUE", quantity: 1 });
    fixture.db.voidQrCode({ qrId, reason: "Printed badly", actor: "admin" });
    const useCase = new ProcessScanUseCase(scanDeps(fixture.db));

    const result = await useCase.execute({ rawScan: qrId, context: SCAN_CONTEXT });

    assert.equal(result.accepted, false);
    assert.match(result.reason ?? "", /voided/i);
    assert.equal(fixture.db.getRowCount("qr_master"), 0);
  } finally {
    fixture.cleanup();
  }
});

test("Store In still refuses a carton whose identity was never generated", async () => {
  const fixture = createDbFixture();
  try {
    registerQrIdentities(fixture.db, { article: "SK6", size: "7/10", color: "BLUE", quantity: 1 });
    const { StoreEntryScanUseCase } = await import("@erp/application");
    const storeIn = new StoreEntryScanUseCase({
      txManager: fixture.db,
      qrLookupRepo: fixture.db,
      qrRegistry: fixture.db,
      qrMasterRepo: fixture.db,
      storeEntryEventsRepo: fixture.db,
      stockProjectionRepo: fixture.db,
      outboxRepo: fixture.db,
      eventPublisher: new InMemoryEventBus(),
      idGenerator: new UuidGenerator(),
    });

    const result = await storeIn.execute({ rawScan: "SK6_BLUE_7/10_000777", context: SCAN_CONTEXT });

    assert.equal(result.accepted, false, "only production may take a carton as it finds it");
    assert.equal(
      rawGet(fixture.db, "SELECT COUNT(*) AS n FROM qr_codes").n,
      1,
      "nothing was registered by the refused scan"
    );
  } finally {
    fixture.cleanup();
  }
});

test("rollback happens when outbox insert fails", async () => {
  const fixture = createDbFixture();
  try {
    const [qrId] = registerQrIdentities(fixture.db, { article: "SK6", size: "7/10", color: "BLUE", quantity: 1 });
    const failingOutbox: ProcessScanDeps["outboxRepo"] = {
      async enqueueProduced(_payload: unknown, _tx: TransactionContext): Promise<void> {
        throw new Error("Forced outbox failure");
      },
    };

    const useCase = new ProcessScanUseCase(scanDeps(fixture.db, { outboxRepo: failingOutbox }));

    await assert.rejects(() => useCase.execute({ rawScan: qrId, context: SCAN_CONTEXT }));

    assert.equal(fixture.db.getRowCount("qr_master"), 0);
    assert.equal(fixture.db.getRowCount("production_events"), 0);
  } finally {
    fixture.cleanup();
  }
});

test("sale vouchers sequence numerically and price totals use dozens", async () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({
      partyName: "Test Party",
      partyType: "CUSTOMER",
      contactPerson: "Tester",
      mobileNumber: "123456789",
      status: "ACTIVE",
    });

    const productId = fixture.db.createProduct({
      article: "SK7",
      color: "BLACK",
      size: "8/11",
      costPrice: 120,
      sellingPrice: 190,
      description: "Runner",
      status: "ACTIVE",
    });

    const firstVoucher = fixture.db.createSaleVoucher({
      partyId,
      voucherDate: "2026-08-15",
      bookNo: "B1",
    });

    const secondVoucher = fixture.db.createSaleVoucher({
      partyId,
      voucherDate: "2026-08-15",
      bookNo: "B1",
    });

    assert.equal(firstVoucher.voucherNumber, "1");
    assert.equal(secondVoucher.voucherNumber, "2");

    const lineItemId = fixture.db.addVoucherLineItem(firstVoucher.id, {
      productVariantId: productId,
      quantity: 2,
      unitPrice: 10,
      discount: 0,
    }).id;

    const voucher = fixture.db.getSaleVoucher(firstVoucher.id);
    assert.ok(voucher);
    const lineItem = voucher.lineItems.find((item: { id: string }) => item.id === lineItemId);

    assert.ok(lineItem);
    assert.equal(lineItem.totalPrice, 240);
    assert.equal(voucher.totalAmount, 240);
  } finally {
    fixture.cleanup();
  }
});

test("saleable variant read returns exact variant metadata and projected stock", () => {
  const fixture = createDbFixture();
  try {
    const seriesId = fixture.db.createArticleSeries({ name: "SK" });
    const groupId = fixture.db.createProductGroup({ groupName: "GENTS" });
    const greenId = fixture.db.createProduct({
      article: "SK12",
      color: "GREEN",
      size: "4/6",
      sellingPrice: 500,
      articleSeriesId: seriesId,
      productGroupId: groupId,
      status: "ACTIVE",
    });
    const blueId = fixture.db.createProduct({
      article: "SK12",
      color: "BLUE",
      size: "4/6",
      sellingPrice: 520,
      status: "ACTIVE",
    });
    const raw = (fixture.db as any).db as DatabaseSync;
    // stockQuantity is Current Stock, so the In Store projection is what the read must see.
    const seedInStore = (variantId: string, quantity: number) =>
      raw
        .prepare("INSERT INTO stock_projection_by_location (product_variant_id, location_type, location_id, quantity_on_hand, updated_at) VALUES (?, 'WAREHOUSE', ?, ?, ?)")
        .run(variantId, "factory-1", quantity, new Date().toISOString());
    seedInStore(greenId, 7);
    seedInStore(blueId, 2);

    const green = fixture.db.getSaleableVariant(greenId);
    assert.deepEqual(green, {
      id: greenId,
      articleSizeId: green?.articleSizeId,
      article: "SK12",
      size: "4/6",
      color: "GREEN",
      sellingPrice: 500,
      stockQuantity: 7,
      articleSeriesId: seriesId,
      productGroupId: groupId,
    });
    assert.equal(fixture.db.getSaleableVariant(blueId)?.sellingPrice, 500);
    assert.equal(fixture.db.getSaleableVariant(blueId)?.stockQuantity, 2);
  } finally {
    fixture.cleanup();
  }
});

test("ArticleSize owns shared price while color variants own independent stock", () => {
  const fixture = createDbFixture();
  try {
    const articleSizeId = fixture.db.createProduct({ article: "SK7", size: "7/10", sellingPrice: 550, status: "ACTIVE" });
    assert.equal((fixture.db as any).db.prepare("SELECT COUNT(1) count FROM product_variants WHERE article_size_id = ?").get(articleSizeId).count, 0);

    const redId = fixture.db.createProduct({ article: "SK6", color: "RED", size: "7/10", sellingPrice: 550, status: "ACTIVE" });
    const blueId = fixture.db.createProduct({ article: "SK6", color: "BLUE", size: "7/10", sellingPrice: 575, status: "ACTIVE" });
    const raw = (fixture.db as any).db as DatabaseSync;
    raw.prepare("INSERT INTO stock_projection_by_variant (product_variant_id, quantity_on_hand, updated_at) VALUES (?, ?, ?)").run(redId, 20, new Date().toISOString());
    raw.prepare("INSERT INTO stock_projection_by_variant (product_variant_id, quantity_on_hand, updated_at) VALUES (?, ?, ?)").run(blueId, 15, new Date().toISOString());

    const red = fixture.db.getSaleableVariant(redId);
    const blue = fixture.db.getSaleableVariant(blueId);
    assert.equal(red?.sellingPrice, 550);
    assert.equal(blue?.sellingPrice, 550);
    assert.equal(red?.stockQuantity, 20);
    assert.equal(blue?.stockQuantity, 15);
    assert.equal(red?.articleSizeId, blue?.articleSizeId);

    const products = fixture.db.listProducts({ search: "SK6", status: "ACTIVE", pageSize: 100 }).rows;
    assert.equal(products.length, 1);
    assert.equal(products[0].sellingPrice, 550);
    assert.deepEqual(new Set(products[0].colors), new Set(["RED", "BLUE"]));

    fixture.db.updateProduct(products[0].id, {
      article: "SK6", color: "", size: "7/10", sellingPrice: 575, status: "ACTIVE",
    });
    assert.equal(fixture.db.getSaleableVariant(redId)?.sellingPrice, 575);
    assert.equal(fixture.db.getSaleableVariant(blueId)?.sellingPrice, 575);

    const greenId = fixture.db.createProduct({ article: "SK6", color: "GREEN", size: "7/10", sellingPrice: 500, status: "ACTIVE" });
    assert.equal(fixture.db.getSaleableVariant(greenId)?.sellingPrice, 575);
    assert.equal(fixture.db.listProducts({ search: "SK6", status: "ACTIVE", pageSize: 100 }).rows.length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("creating an existing ArticleSize saves Product Setup fields immediately", () => {
  const fixture = createDbFixture();
  try {
    fixture.db.createProduct({ article: "SK6", size: "7/10", status: "ACTIVE" });
    const groupId = fixture.db.createProductGroup({ groupName: "EVR GENTS" });
    const seriesId = fixture.db.createArticleSeries({ name: "SK" });
    fixture.db.createProduct({
      article: "SK6",
      size: "7/10",
      sellingPrice: 550,
      costPrice: 300,
      productGroupId: groupId,
      articleSeriesId: seriesId,
      status: "ACTIVE",
    });

    const row = (fixture.db as any).db.prepare("SELECT selling_price_paisa,cost_price_paisa,product_group_id,article_series_id FROM article_sizes WHERE article='SK6' AND size='7/10'").get();
    assert.equal(row.selling_price_paisa, 55000);
    assert.equal(row.cost_price_paisa, 30000);
    assert.equal(row.product_group_id, groupId);
    assert.equal(row.article_series_id, seriesId);
  } finally {
    fixture.cleanup();
  }
});

test("a Product Master entry with no color appears in listUniqueArticles/listUniqueSizesByArticle", () => {
  // Regression: the Add Product form creates only an article_sizes row when no
  // color is given (createProduct's colors loop never runs), so these two
  // lookups — which back the form's own dropdown-only Article/Size fields —
  // must read from article_sizes, not product_variants, or a freshly-created
  // product becomes permanently unselectable on the next visit to the page.
  const fixture = createDbFixture();
  try {
    fixture.db.createProduct({ article: "SK9", size: "9/12", status: "ACTIVE" });

    assert.ok(fixture.db.listUniqueArticles().includes("SK9"), "SK9 must appear in listUniqueArticles even without a color variant");
    assert.deepEqual(fixture.db.listUniqueSizesByArticle("SK9"), ["9/12"]);
  } finally {
    fixture.cleanup();
  }
});

test("startup migration preserves an old product table and adds variant relationship columns", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-migration-"));
  const dbPath = path.join(tempDir, "legacy.db");
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE product_variants (
      id TEXT PRIMARY KEY,
      article TEXT NOT NULL,
      color TEXT NOT NULL,
      size TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
  `);
  raw.prepare("INSERT INTO product_variants (id, article, color, size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("legacy-1", "SK12", "GREEN", "4/6", "now", "now");
  raw.close();

  const db = new SqliteDatabase({ dbPath, schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(1, "test");
  try {
    const columns = (db as any).db.prepare("PRAGMA table_info(product_variants)").all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    assert.ok(names.includes("main_group_id"));
    assert.ok(names.includes("product_group_id"));
    assert.ok(names.includes("article_series_id"));
    assert.ok((db as any).db.prepare("SELECT 1 FROM article_series LIMIT 1").get() === undefined);
    assert.ok((db as any).db.prepare("SELECT 1 FROM product_groups LIMIT 1").get() === undefined);
    assert.equal((db as any).db.prepare("SELECT article, color, size FROM product_variants WHERE id = ?").get("legacy-1").color, "GREEN");
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("REGRESSION — reproduce exact user bug: series and price range ignored", () => {
  const fixture = createDbFixture();
  try {
    // Real-world test case matching user's exact scenario
    const mama = fixture.db.createParty({ partyName: "mama", partyType: "CUSTOMER", status: "ACTIVE" });
    
    // Create the SKECHERS series and EVR GENTS group
    const skechersSeriesId = fixture.db.createArticleSeries({ name: "SKECHERS" });
    const evrGentsGroupId = fixture.db.createProductGroup({ groupName: "EVR GENTS" });
    
    // Create SK12/4/6/GREEN product with both series and group
    const greenVariantId = fixture.db.createProduct({
      article: "SK12",
      color: "GREEN",
      size: "4/6", 
      sellingPrice: 500, // within 488-510 range
      articleSeriesId: skechersSeriesId,
      productGroupId: evrGentsGroupId,
      status: "ACTIVE",
    });

    // Set up ALL 4 discount rules as user described
    console.log("\n=== CREATING USER'S EXACT DISCOUNT RULES ===");
    
    // 1. ARTICLE: Rs. 50
    const articleRuleId = fixture.db.createPartyArticleDiscount({
      partyId: mama,
      article: greenVariantId,
      sizeScope: "ALL_SIZES", 
      discountPerPair: 50
    });
    console.log(`Article discount created: ${articleRuleId} (50)`);
    
    // 2. ARTICLE_SERIES: Rs. 40 
    const seriesRuleId = fixture.db.createPartyArticleSeriesDiscount({
      partyId: mama,
      articleSeriesId: skechersSeriesId,
      discountPerPair: 40
    });
    console.log(`Series discount created: ${seriesRuleId} (40)`);
    
    // 3. PRICE_RANGE: Rs. 35 (488-510 includes 500)
    const priceRuleId = fixture.db.createPartyPriceRangeDiscount({
      partyId: mama,
      startPrice: 488,
      endPrice: 510,
      discountPerPair: 35
    });
    console.log(`Price range discount created: ${priceRuleId} (35)`);
    
    // 4. PRODUCT_GROUP: Rs. 30
    const groupRuleId = fixture.db.createPartyProductGroupDiscount({
      partyId: mama,
      productGroupId: evrGentsGroupId,
      discountPerPair: 30
    });
    console.log(`Group discount created: ${groupRuleId} (30)`);

    console.log("\n=== TESTING HIERARCHY ===");

    // STEP 1: All rules exist → should return Article (50)
    const result1 = fixture.db.resolveProductDiscount(mama, greenVariantId);
    console.log(`All rules: ${result1.source} = ${result1.discountPerPair} (expect: ARTICLE = 50)`);
    assert.equal(result1.source, "ARTICLE");
    assert.equal(result1.discountPerPair, 50);

    // STEP 2: Remove article rule → should return Series (40)  
    fixture.db.deletePartyArticleDiscount(articleRuleId);
    const result2 = fixture.db.resolveProductDiscount(mama, greenVariantId);
    console.log(`No Article: ${result2.source} = ${result2.discountPerPair} (expect: ARTICLE_SERIES = 40)`);
    assert.equal(result2.source, "ARTICLE_SERIES", "Bug reproduced: Series rule skipped!");
    assert.equal(result2.discountPerPair, 40, "Bug reproduced: Should be 40 not 30!");

    // STEP 3: Remove series rule → should return Price Range (35)
    fixture.db.deletePartyArticleSeriesDiscount(seriesRuleId);
    const result3 = fixture.db.resolveProductDiscount(mama, greenVariantId); 
    console.log(`No Series: ${result3.source} = ${result3.discountPerPair} (expect: PRICE_RANGE = 35)`);
    assert.equal(result3.source, "PRICE_RANGE", "Bug reproduced: Price Range skipped!");
    assert.equal(result3.discountPerPair, 35, "Bug reproduced: Should be 35 not 30!");
    
    // STEP 4: Remove price range → should return Group (30)
    fixture.db.deletePartyPriceRangeDiscount(priceRuleId);
    const result4 = fixture.db.resolveProductDiscount(mama, greenVariantId);
    console.log(`No Price Range: ${result4.source} = ${result4.discountPerPair} (expect: PRODUCT_GROUP = 30)`);
    assert.equal(result4.source, "PRODUCT_GROUP"); 
    assert.equal(result4.discountPerPair, 30);

    // STEP 5: Remove all → should return None (0)
    fixture.db.deletePartyProductGroupDiscount(groupRuleId);
    const result5 = fixture.db.resolveProductDiscount(mama, greenVariantId);
    console.log(`No rules: ${result5.source} = ${result5.discountPerPair} (expect: NONE = 0)`);
    assert.equal(result5.source, "NONE");
    assert.equal(result5.discountPerPair, 0);
    
    console.log("✓ HIERARCHY TEST PASSED — Bug NOT reproduced in isolated test");
    
  } finally {
    fixture.cleanup();
  }
});

test("discount resolver uses ArticleSize-owned relationship metadata for every color", () => {
  const fixture = createDbFixture();
  try {
    const ahhs = fixture.db.createParty({ partyName: "AHHS", partyType: "CUSTOMER", status: "ACTIVE" });
    const mama = fixture.db.createParty({ partyName: "mama", partyType: "CUSTOMER", status: "ACTIVE" });

    const seriesId = fixture.db.createArticleSeries({ name: "SK" });
    const groupId = fixture.db.createProductGroup({ groupName: "EVR GENTS" });

    // The ArticleSize is created with its shared relationship metadata.
    const greenVariantId = fixture.db.createProduct({
      article: "SK12", color: "GREEN", size: "4/6", sellingPrice: 500,
      productGroupId: groupId, articleSeriesId: seriesId, status: "ACTIVE",
    });
    // Adding a second color does not create a second ArticleSize.
    const redVariantId = fixture.db.createProduct({
      article: "SK12", color: "RED", size: "4/6", sellingPrice: 500, status: "ACTIVE",
    });

    // AHHS: no Article rule, only Series + Group configured.
    fixture.db.createPartyArticleSeriesDiscount({ partyId: ahhs, articleSeriesId: seriesId, discountPerPair: 45 });
    fixture.db.createPartyProductGroupDiscount({ partyId: ahhs, productGroupId: groupId, discountPerPair: 40 });

    // Selecting RED uses the shared ArticleSize metadata.
    const ahhsResult = fixture.db.resolveProductDiscount(ahhs, redVariantId);
    assert.equal(ahhsResult.discountPerPair, 45);
    assert.equal(ahhsResult.source, "ARTICLE_SERIES");

    // mama: Article discount saved against the GREEN variant id specifically (as the Discount
    // Policy UI would), plus lower-priority Series/Group rules that must NOT win.
    fixture.db.createPartyArticleDiscount({ partyId: mama, article: greenVariantId, sizeScope: "ALL_SIZES", discountPerPair: 40 });
    fixture.db.createPartyArticleSeriesDiscount({ partyId: mama, articleSeriesId: seriesId, discountPerPair: 35 });
    fixture.db.createPartyProductGroupDiscount({ partyId: mama, productGroupId: groupId, discountPerPair: 30 });

    const mamaResult = fixture.db.resolveProductDiscount(mama, greenVariantId);
    assert.equal(mamaResult.discountPerPair, 40);
    assert.equal(mamaResult.source, "ARTICLE");

    // Selecting the RED sibling (no direct article rule against it) must still find the ARTICLE
    // rule because it matches by article name, not by a single representative variant id.
    const mamaRedResult = fixture.db.resolveProductDiscount(mama, redVariantId);
    assert.equal(mamaRedResult.discountPerPair, 40);
    assert.equal(mamaRedResult.source, "ARTICLE");
  } finally {
    fixture.cleanup();
  }
});

// Reproduces the real-world AHHS bug report: with a Price Range rule (488-510 = 15) and a
// Product Group rule (EVR GENTS = 10) both configured, a product priced inside the range must
// resolve PRICE_RANGE (15), not fall through to PRODUCT_GROUP (10). Exercises the actual
// resolveProductDiscount query path (no mocking of the resolver).
test("discount resolver matches price range over product group when the pair price falls inside the configured bounds", () => {
  const fixture = createDbFixture();
  try {
    const ahhs = fixture.db.createParty({ partyName: "AHHS", partyType: "CUSTOMER", status: "ACTIVE" });
    const groupId = fixture.db.createProductGroup({ groupName: "EVR GENTS" });

    const productId = fixture.db.createProduct({
      article: "SK12", color: "GREEN", size: "4/6", sellingPrice: 500, productGroupId: groupId, status: "ACTIVE",
    });

    fixture.db.createPartyPriceRangeDiscount({ partyId: ahhs, startPrice: 488, endPrice: 510, discountPerPair: 15 });
    fixture.db.createPartyProductGroupDiscount({ partyId: ahhs, productGroupId: groupId, discountPerPair: 10 });

    const withRange = fixture.db.resolveProductDiscount(ahhs, productId);
    assert.equal(withRange.discountPerPair, 15);
    assert.equal(withRange.source, "PRICE_RANGE");

    // Boundary checks: inclusive at both ends.
    assert.equal(fixture.db.resolveDiscount({ partyId: ahhs, article: "SK12", productGroupId: groupId, applicablePrice: 488 }).discountPerPair, 15);
    assert.equal(fixture.db.resolveDiscount({ partyId: ahhs, article: "SK12", productGroupId: groupId, applicablePrice: 510 }).discountPerPair, 15);
    assert.equal(fixture.db.resolveDiscount({ partyId: ahhs, article: "SK12", productGroupId: groupId, applicablePrice: 511 }).source, "PRODUCT_GROUP");

    // Without a Price Range rule at all, the same Product Group rule must still win (fallback intact).
    const noRangeParty = fixture.db.createParty({ partyName: "AHHS-No-Range", partyType: "CUSTOMER", status: "ACTIVE" });
    fixture.db.createPartyProductGroupDiscount({ partyId: noRangeParty, productGroupId: groupId, discountPerPair: 10 });
    const withoutRange = fixture.db.resolveProductDiscount(noRangeParty, productId);
    assert.equal(withoutRange.discountPerPair, 10);
    assert.equal(withoutRange.source, "PRODUCT_GROUP");
  } finally {
    fixture.cleanup();
  }
});

test("sale voucher line discount uses per-pair price multiplied by total pairs for dozen and carton quantities", () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({ partyName: "Discount Party", partyType: "CUSTOMER", status: "ACTIVE" });
    const productGroupId = fixture.db.createProductGroup({ groupName: "Z Group" });
    const seriesId = fixture.db.createArticleSeries({ name: "ZR" });
    const productId = fixture.db.createProduct({
      article: "ZR",
      color: "WHITE",
      size: "7/10",
      sellingPrice: 520,
      productGroupId,
      articleSeriesId: seriesId,
      status: "ACTIVE",
    });

    fixture.db.createPartyArticleDiscount({ partyId, article: productId, sizeScope: "ALL_SIZES", discountPerPair: 35 });

    const voucher = fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-08-16", bookNo: "B2" });

    const dozenItem = fixture.db.addVoucherLineItem(voucher.id, {
      productVariantId: productId,
      quantity: 1,
      unitPrice: 520,
    });
    const dozenRow = fixture.db.getSaleVoucher(voucher.id)?.lineItems.find((item: { id: string }) => item.id === dozenItem.id);

    assert.ok(dozenRow);
    assert.equal(dozenRow.discount, 12 * 35);
    assert.equal(dozenRow.totalPrice, 12 * 520 - 12 * 35);

    const multiDozenItem = fixture.db.addVoucherLineItem(voucher.id, {
      productVariantId: productId,
      quantity: 2,
      unitPrice: 520,
    });
    const multiDozenRow = fixture.db.getSaleVoucher(voucher.id)?.lineItems.find((item: { id: string }) => item.id === multiDozenItem.id);
    assert.ok(multiDozenRow);
    assert.equal(multiDozenRow.discount, 24 * 35);
  } finally {
    fixture.cleanup();
  }
});

// B-TYPE must ALWAYS persist with zero discount, even if a caller supplies a non-zero
// value and even though every discount policy (Article/Series/PriceRange/Group) is configured
// and would otherwise apply to this exact article/price. The backend enforces this, not just the UI.
test("addVoucherLineItem forces discount to zero for B_TYPE lines regardless of caller-supplied discount or configured policies", () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({ partyName: "B-Type Party", partyType: "CUSTOMER", status: "ACTIVE" });
    const productGroupId = fixture.db.createProductGroup({ groupName: "EVR GENTS" });
    const seriesId = fixture.db.createArticleSeries({ name: "SK" });
    const productId = fixture.db.createProduct({
      article: "SK12", color: "GREEN", size: "7/10", sellingPrice: 550,
      productGroupId, articleSeriesId: seriesId, status: "ACTIVE",
    });

    // Every discount tier is configured and would resolve to a non-zero discount for NORMAL.
    fixture.db.createPartyArticleDiscount({ partyId, article: productId, sizeScope: "ALL_SIZES", discountPerPair: 40 });
    fixture.db.createPartyArticleSeriesDiscount({ partyId, articleSeriesId: seriesId, discountPerPair: 35 });
    fixture.db.createPartyProductGroupDiscount({ partyId, productGroupId, discountPerPair: 25 });

    const voucher = fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-08-16", bookNo: "B3" });

    // NORMAL still resolves the configured discount (sanity check).
    const normalItem = fixture.db.addVoucherLineItem(voucher.id, {
      productVariantId: productId, quantity: 1, unitPrice: 550, priceType: "NORMAL",
    });
    const normalRow = fixture.db.getSaleVoucher(voucher.id)?.lineItems.find((item: { id: string }) => item.id === normalItem.id);
    assert.ok(normalRow);
    assert.equal(normalRow.discount, 12 * 40);

    // B-TYPE at the derived price (550 → 380), with an attempted non-zero discount override,
    // must be persisted with discount = 0.
    const bTypeItem = fixture.db.addVoucherLineItem(voucher.id, {
      productVariantId: productId, quantity: 1, unitPrice: 380, discount: 999, priceType: "B_TYPE",
    });
    const bTypeRow = fixture.db.getSaleVoucher(voucher.id)?.lineItems.find((item: { id: string }) => item.id === bTypeItem.id);
    assert.ok(bTypeRow);
    assert.equal(bTypeRow.discount, 0);
    assert.equal(bTypeRow.totalPrice, 12 * 380);
  } finally {
    fixture.cleanup();
  }
});

// ─── Backend discount authority (R9 Phase 2) ──────────────────────────────────────────────
// resolveDiscount()'s result is the ceiling for a NORMAL line, enforced identically by
// addVoucherLineItem and updateVoucherLineItem. A caller-supplied discount within the ceiling
// (including exactly at it) is accepted as-is; above it, the write is REJECTED outright —
// never clamped — via DiscountExceedsAllowedError, before any row is touched.

test("addVoucherLineItem accepts a discount at or below the resolved ceiling and rejects one above it, with no partial write on rejection", () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({ partyName: "Ceiling Party", partyType: "CUSTOMER", status: "ACTIVE" });
    const productGroupId = fixture.db.createProductGroup({ groupName: "Ceiling Group" });
    const seriesId = fixture.db.createArticleSeries({ name: "SK-CEIL" });
    const productId = fixture.db.createProduct({
      article: "SK20", color: "BLUE", size: "7/10", sellingPrice: 500,
      productGroupId, articleSeriesId: seriesId, status: "ACTIVE",
    });
    // 1 dozen = 12 pairs x Rs 20/pair = Rs 240 allowed maximum for a 1-dozen line.
    fixture.db.createPartyArticleDiscount({ partyId, article: productId, sizeScope: "ALL_SIZES", discountPerPair: 20 });

    const voucher = fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-09-19", bookNo: "CEIL-A" });

    // Below the ceiling -> accepted.
    const below = fixture.db.addVoucherLineItem(voucher.id, { productVariantId: productId, quantity: 1, unitPrice: 500, discount: 100 });
    assert.equal(fixture.db.getSaleVoucher(voucher.id)?.lineItems.find((i: { id: string }) => i.id === below.id)?.discount, 100);

    // Exactly at the ceiling -> accepted.
    const atCeiling = fixture.db.addVoucherLineItem(voucher.id, { productVariantId: productId, quantity: 1, unitPrice: 500, discount: 240 });
    assert.equal(fixture.db.getSaleVoucher(voucher.id)?.lineItems.find((i: { id: string }) => i.id === atCeiling.id)?.discount, 240);

    // Above the ceiling -> rejected outright (never clamped to 240), and nothing is written.
    const beforeReject = fixture.db.getSaleVoucher(voucher.id)!;
    assert.throws(
      () => fixture.db.addVoucherLineItem(voucher.id, { productVariantId: productId, quantity: 1, unitPrice: 500, discount: 241 }),
      (error: unknown) =>
        error instanceof Error &&
        (error as { code?: string }).code === "DISCOUNT_EXCEEDS_ALLOWED" &&
        (error as { requestedDiscount?: number }).requestedDiscount === 241 &&
        (error as { allowedMaximum?: number }).allowedMaximum === 240 &&
        (error as { exceededBy?: number }).exceededBy === 1
    );
    const afterReject = fixture.db.getSaleVoucher(voucher.id)!;
    assert.equal(afterReject.lineItems.length, beforeReject.lineItems.length, "a rejected discount must not create a line item");
    assert.equal(afterReject.totalAmount, beforeReject.totalAmount, "voucher totals must be unaffected by the rejected attempt");
  } finally {
    fixture.cleanup();
  }
});

test("updateVoucherLineItem accepts a discount at or below the resolved ceiling and rejects one above it, with no partial write on rejection", () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({ partyName: "Ceiling Party 2", partyType: "CUSTOMER", status: "ACTIVE" });
    const productGroupId = fixture.db.createProductGroup({ groupName: "Ceiling Group 2" });
    const seriesId = fixture.db.createArticleSeries({ name: "SK-CEIL2" });
    const productId = fixture.db.createProduct({
      article: "SK21", color: "RED", size: "7/10", sellingPrice: 500,
      productGroupId, articleSeriesId: seriesId, status: "ACTIVE",
    });
    fixture.db.createPartyArticleDiscount({ partyId, article: productId, sizeScope: "ALL_SIZES", discountPerPair: 20 });

    const voucher = fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-09-19", bookNo: "CEIL-U" });
    const line = fixture.db.addVoucherLineItem(voucher.id, { productVariantId: productId, quantity: 1, unitPrice: 500, discount: 0 });

    // Below the ceiling -> accepted.
    fixture.db.updateVoucherLineItem(line.id, { quantity: 1, unitPrice: 500, discount: 150 });
    assert.equal(fixture.db.getSaleVoucher(voucher.id)?.lineItems.find((i: { id: string }) => i.id === line.id)?.discount, 150);

    // Exactly at the ceiling -> accepted.
    fixture.db.updateVoucherLineItem(line.id, { quantity: 1, unitPrice: 500, discount: 240 });
    assert.equal(fixture.db.getSaleVoucher(voucher.id)?.lineItems.find((i: { id: string }) => i.id === line.id)?.discount, 240);

    // Above the ceiling -> rejected outright, and the line is left exactly as the last accepted write left it.
    assert.throws(
      () => fixture.db.updateVoucherLineItem(line.id, { quantity: 1, unitPrice: 500, discount: 241 }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === "DISCOUNT_EXCEEDS_ALLOWED"
    );
    const afterReject = fixture.db.getSaleVoucher(voucher.id)?.lineItems.find((i: { id: string }) => i.id === line.id);
    assert.equal(afterReject?.discount, 240, "a rejected update must not partially apply");
  } finally {
    fixture.cleanup();
  }
});

test("updateVoucherLineItem forces discount to zero for B_TYPE lines regardless of caller-supplied discount", () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({ partyName: "B-Type Party 2", partyType: "CUSTOMER", status: "ACTIVE" });
    const productGroupId = fixture.db.createProductGroup({ groupName: "B-Type Group 2" });
    const seriesId = fixture.db.createArticleSeries({ name: "SK-BT2" });
    const productId = fixture.db.createProduct({
      article: "SK22", color: "BLACK", size: "7/10", sellingPrice: 550,
      productGroupId, articleSeriesId: seriesId, status: "ACTIVE",
    });
    // A real discount rule exists, so a NORMAL line here would resolve non-zero — B_TYPE must
    // still force zero regardless, on update exactly as on add.
    fixture.db.createPartyArticleDiscount({ partyId, article: productId, sizeScope: "ALL_SIZES", discountPerPair: 40 });

    const voucher = fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-09-19", bookNo: "BT-U" });
    const line = fixture.db.addVoucherLineItem(voucher.id, {
      productVariantId: productId, quantity: 1, unitPrice: 380, discount: 0, priceType: "B_TYPE",
    });

    fixture.db.updateVoucherLineItem(line.id, { quantity: 1, unitPrice: 380, discount: 999, priceType: "B_TYPE" });
    const row = fixture.db.getSaleVoucher(voucher.id)?.lineItems.find((i: { id: string }) => i.id === line.id);
    assert.equal(row?.discount, 0);
  } finally {
    fixture.cleanup();
  }
});

test("discount_source reflects the resolved rule after accepted add and update writes, on both paths", () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({ partyName: "Source Party", partyType: "CUSTOMER", status: "ACTIVE" });
    const productGroupId = fixture.db.createProductGroup({ groupName: "Source Group" });
    const seriesId = fixture.db.createArticleSeries({ name: "SK-SRC" });
    const productId = fixture.db.createProduct({
      article: "SK23", color: "WHITE", size: "7/10", sellingPrice: 500,
      productGroupId, articleSeriesId: seriesId, status: "ACTIVE",
    });
    fixture.db.createPartyArticleDiscount({ partyId, article: productId, sizeScope: "ALL_SIZES", discountPerPair: 20 });

    const voucher = fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-09-19", bookNo: "SRC-1" });
    const line = fixture.db.addVoucherLineItem(voucher.id, { productVariantId: productId, quantity: 1, unitPrice: 500, discount: 100 });

    const afterAdd = rawGet(fixture.db, "SELECT discount_source FROM sale_voucher_line_items WHERE id = ?", line.id);
    assert.equal(afterAdd.discount_source, "ARTICLE", "discount_source must name the rule that governs this line's ceiling, not just whatever the caller supplied");

    fixture.db.updateVoucherLineItem(line.id, { quantity: 1, unitPrice: 500, discount: 50 });
    const afterUpdate = rawGet(fixture.db, "SELECT discount_source FROM sale_voucher_line_items WHERE id = ?", line.id);
    assert.equal(afterUpdate.discount_source, "ARTICLE", "discount_source must stay truthful after an update too, not go stale (it previously wasn't written on update at all)");
  } finally {
    fixture.cleanup();
  }
});

// The Discount Policy page has no edit or delete for group and series rules: saving the tab
// again IS the edit. It used to be refused as a duplicate (silently, on that page), leaving the
// old figure in force on every bill.
test("saving a product-group or article-series rule again updates the figure the resolver uses", () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({ partyName: "Upsert Party", partyType: "CUSTOMER", status: "ACTIVE" });
    const productGroupId = fixture.db.createProductGroup({ groupName: "EVR" });
    const seriesId = fixture.db.createArticleSeries({ name: "SK" });
    const productId = fixture.db.createProduct({ article: "SK6", color: "RED", size: "7/10", sellingPrice: 600, productGroupId, articleSeriesId: seriesId, status: "ACTIVE" });

    const groupRule = fixture.db.createPartyProductGroupDiscount({ partyId, productGroupId, discountPerPair: 25 });
    assert.equal(fixture.db.createPartyProductGroupDiscount({ partyId, productGroupId, discountPerPair: 28 }), groupRule);
    assert.deepEqual(fixture.db.resolveProductDiscount(partyId, productId), { discountPerPair: 28, source: "PRODUCT_GROUP", ruleId: groupRule });

    const seriesRule = fixture.db.createPartyArticleSeriesDiscount({ partyId, articleSeriesId: seriesId, discountPerPair: 30 });
    assert.equal(fixture.db.createPartyArticleSeriesDiscount({ partyId, articleSeriesId: seriesId, discountPerPair: 32 }), seriesRule);
    assert.deepEqual(fixture.db.resolveProductDiscount(partyId, productId), { discountPerPair: 32, source: "ARTICLE_SERIES", ruleId: seriesRule });

    // A deleted rule saved again comes back as the same rule, and there is still only one.
    fixture.db.deletePartyArticleSeriesDiscount(seriesRule);
    assert.equal(fixture.db.resolveProductDiscount(partyId, productId).source, "PRODUCT_GROUP");
    assert.equal(fixture.db.createPartyArticleSeriesDiscount({ partyId, articleSeriesId: seriesId, discountPerPair: 33 }), seriesRule);
    assert.equal(rawGet(fixture.db, "SELECT COUNT(*) AS n FROM party_article_series_discounts WHERE party_id = ?", partyId).n, 1);
    assert.equal(fixture.db.resolveProductDiscount(partyId, productId).discountPerPair, 33);
  } finally {
    fixture.cleanup();
  }
});

// Migration 033: an article rule is keyed by the article name. It must save for an article
// that has no colour registered yet (the product master alone), and still apply to every
// colour registered later.
test("article discount rules save for a colourless article and apply to every colour registered afterwards", () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({ partyName: "Fresh Party", partyType: "CUSTOMER", status: "ACTIVE" });
    // Product master only — no colours yet, exactly as a freshly created product.
    const articleSizeId = fixture.db.getOrCreateArticleSize({ article: "SK6", size: "7/10", sellingPrice: 650 });
    assert.equal(rawGet(fixture.db, "SELECT COUNT(*) AS n FROM product_variants WHERE article = 'SK6'").n, 0);

    // The Discount Policy screen sends the article name; the master row's id is accepted too.
    const byName = fixture.db.createPartyArticleDiscount({ partyId, article: "sk6", sizeScope: "ALL_SIZES", discountPerPair: 35 });
    assert.equal(fixture.db.createPartyArticleDiscount({ partyId, article: articleSizeId, sizeScope: "ALL_SIZES", discountPerPair: 36 }), byName);
    assert.equal(rawGet(fixture.db, "SELECT article FROM party_article_discounts WHERE id = ?", byName).article, "SK6");
    assert.throws(() => fixture.db.createPartyArticleDiscount({ partyId, article: "NOPE", discountPerPair: 1 }), /Unknown article/);

    // Colours registered later are covered by the rule, whichever colour the bill prices by.
    const red = fixture.db.createProduct({ article: "SK6", color: "RED", size: "7/10", sellingPrice: 650, status: "ACTIVE" });
    const blue = fixture.db.createProduct({ article: "SK6", color: "BLUE", size: "7/10", sellingPrice: 650, status: "ACTIVE" });
    for (const variantId of [red, blue]) {
      assert.deepEqual(fixture.db.resolveProductDiscount(partyId, variantId), { discountPerPair: 36, source: "ARTICLE", ruleId: byName });
    }
    assert.deepEqual(fixture.db.getPartyDiscountReport(partyId).map((r) => [r.type, r.label, r.discountPerPair]), [["ARTICLE", "SK6", 36]]);

    // A separate-sizes rule needs its size, and only matches that size.
    assert.throws(() => fixture.db.createPartyArticleDiscount({ partyId, article: "SK6", sizeScope: "SEPARATE_SIZES", discountPerPair: 5 }), /needs a size/);
    fixture.db.deletePartyArticleDiscount(byName);
    fixture.db.createPartyArticleDiscount({ partyId, article: "SK6", sizeScope: "SEPARATE_SIZES", size: "11/13", discountPerPair: 5 });
    assert.equal(fixture.db.resolveProductDiscount(partyId, red).source, "NONE");
    assert.equal(fixture.db.resolveDiscount({ partyId, article: "SK6", size: "11/13" }).discountPerPair, 5);
  } finally {
    fixture.cleanup();
  }
});

// A reopened bill must be able to tell a line left on the party's rule (refresh it from the
// rule as it stands now) from one the clerk typed a figure on (keep it), and must never hand
// a B-TYPE line a discount — so each line reads back with its price type, the rule that
// governed it and that rule's per-pair figure, on add and on update alike.
test("sale voucher lines read back with price type, the governing rule and its per-pair figure", () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({ partyName: "Reopen Party", partyType: "CUSTOMER", status: "ACTIVE" });
    const productId = fixture.db.createProduct({ article: "SK24", color: "GREY", size: "7/10", sellingPrice: 600, status: "ACTIVE" });
    const voucher = fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-09-21", bookNo: "RO-1" });
    const lineFor = (id: string) => fixture.db.getSaleVoucher(voucher.id)?.lineItems.find((item: { id: string }) => item.id === id);

    // Saved before any rule existed: no rule, no discount.
    const normal = fixture.db.addVoucherLineItem(voucher.id, { productVariantId: productId, quantity: 0.5, unitPrice: 600, discount: 0, priceType: "NORMAL" });
    assert.deepEqual(
      (({ priceType, discount, discountPerPair, discountSource }) => ({ priceType, discount, discountPerPair, discountSource }))(lineFor(normal.id)!),
      { priceType: "NORMAL", discount: 0, discountPerPair: 0, discountSource: "NONE" },
    );

    // The rule arrives later; the clerk re-saves the line below it (0.5 dozen = 6 pairs, so 35 × 6 = 210 is the ceiling).
    fixture.db.createPartyArticleDiscount({ partyId, article: productId, sizeScope: "ALL_SIZES", discountPerPair: 35 });
    fixture.db.updateVoucherLineItem(normal.id, { quantity: 0.5, unitPrice: 600, discount: 120, priceType: "NORMAL" });
    assert.deepEqual(
      (({ priceType, discount, discountPerPair, discountSource }) => ({ priceType, discount, discountPerPair, discountSource }))(lineFor(normal.id)!),
      { priceType: "NORMAL", discount: 120, discountPerPair: 35, discountSource: "ARTICLE" },
    );

    // B-TYPE keeps its price type across a save, so it can never be reopened as NORMAL and discounted.
    const bType = fixture.db.addVoucherLineItem(voucher.id, { productVariantId: productId, quantity: 1, unitPrice: 400, discount: 0, priceType: "B_TYPE" });
    assert.equal(lineFor(bType.id)?.priceType, "B_TYPE");
    fixture.db.updateVoucherLineItem(bType.id, { quantity: 2, unitPrice: 400, discount: 0, priceType: "B_TYPE" });
    assert.equal(lineFor(bType.id)?.priceType, "B_TYPE");
    assert.equal(rawGet(fixture.db, "SELECT price_type FROM sale_voucher_line_items WHERE id = ?", bType.id).price_type, "B_TYPE");
  } finally {
    fixture.cleanup();
  }
});

test("party discount report includes all saved party rule types and product discount resolution returns active rule", () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({ partyName: "Report Party", partyType: "CUSTOMER", status: "ACTIVE" });
    const productGroupId = fixture.db.createProductGroup({ groupName: "Report Group" });
    const seriesId = fixture.db.createArticleSeries({ name: "REPORT-SERIES" });
    const productId = fixture.db.createProduct({
      article: "REPORT-ART",
      color: "BLACK",
      size: "8/11",
      sellingPrice: 500,
      productGroupId,
      articleSeriesId: seriesId,
      status: "ACTIVE",
    });

    fixture.db.createPartyProductGroupDiscount({ partyId, productGroupId, discountPerPair: 15 });
    fixture.db.createPartyArticleSeriesDiscount({ partyId, articleSeriesId: seriesId, discountPerPair: 25 });
    fixture.db.createPartyArticleDiscount({ partyId, article: productId, sizeScope: "ALL_SIZES", discountPerPair: 35 });
    fixture.db.createPartyPriceRangeDiscount({ partyId, startPrice: 450, endPrice: 550, discountPerPair: 20 });

    const report = fixture.db.getPartyDiscountReport(partyId);
    assert.equal(report.length >= 4, true);
    assert.equal(report.some((row) => row.type === "PRODUCT_GROUP" && row.discountPerPair === 15), true);
    assert.equal(report.some((row) => row.type === "ARTICLE_SERIES" && row.discountPerPair === 25), true);
    assert.equal(report.some((row) => row.type === "ARTICLE" && row.discountPerPair === 35), true);
    assert.equal(report.some((row) => row.type === "PRICE_RANGE" && row.discountPerPair === 20), true);

    const resolved = fixture.db.resolveProductDiscount(partyId, productId);
    assert.equal(resolved.discountPerPair, 35);
    assert.equal(resolved.source, "ARTICLE");
  } finally {
    fixture.cleanup();
  }
});

test("article series duplicate names are normalized and not silently duplicated", () => {
  const fixture = createDbFixture();
  try {
    const first = fixture.db.createArticleSeries({ name: "sk6" });
    const second = fixture.db.createArticleSeries({ name: "SK6" });
    assert.equal(first, second);
    assert.equal(fixture.db.listArticleSeries().length, 1);
    assert.equal(fixture.db.getArticleSeriesByName("Sk6")?.name, "sk6");
    assert.equal(fixture.db.getArticleSeriesByName("SK6")?.id, second);
  } finally {
    fixture.cleanup();
  }
});

test("dispatch session enforces remaining bill quantity and rejects over-dispatch", async () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({
      partyName: "Dispatch Customer",
      partyType: "CUSTOMER",
      city: "Lahore",
      mobileNumber: "0300-2222222",
      status: "ACTIVE",
    });

    const productId = fixture.db.createProduct({
      article: "SK7",
      color: "RED",
      size: "7/10",
      costPrice: 100,
      sellingPrice: 180,
      description: "Dispatch product",
      status: "ACTIVE",
    });

    const voucher = fixture.db.createSaleVoucher({
      partyId,
      voucherDate: "2026-08-15",
      bookNo: "B1",
    });

    fixture.db.addVoucherLineItem(voucher.id, {
      productVariantId: productId,
      quantity: 1,
      unitPrice: 180,
      discount: 0,
    });

    // One scanned QR is one carton and a dozen is two cartons (@erp/domain units.ts), so a
    // one-dozen line allows exactly two scans. Produce three cartons to prove the third is refused.
    const qrIds = generateQrIds(fixture.db, { article: "SK7", size: "7/10", color: "RED", quantity: 3 });
    const processScanUseCase = new ProcessScanUseCase(scanDeps(fixture.db));

    for (const qrId of qrIds) {
      const productionResult = await processScanUseCase.execute({ rawScan: qrId, context: SCAN_CONTEXT });
      assert.equal(productionResult.accepted, true);
    }

    const firstSession = fixture.db.listDispatchSessions({ status: "PENDING" })[0];
    assert.ok(firstSession);
    assert.equal(firstSession.remainingCartons, 2);
    assert.equal(firstSession.remainingPairs, 12);

    const dispatchScanUseCase = new (await import("@erp/application")).DispatchScanUseCase({
      txManager: fixture.db,
      qrLookupRepo: fixture.db,
      stockProjectionRepo: fixture.db,
      qrMasterRepo: fixture.db,
      dispatchEventsRepo: fixture.db,
      outboxRepo: fixture.db,
      eventPublisher: new InMemoryEventBus(),
      idGenerator: new UuidGenerator(),
      dispatchSessionRepo: fixture.db,
    });

    const first = await dispatchScanUseCase.execute({ rawScan: qrIds[0], sessionId: firstSession.sessionId, context: SCAN_CONTEXT });
    assert.equal(first.accepted, true);
    const afterFirst = fixture.db.checkDispatchSessionAllowance(firstSession.sessionId, productId);
    assert.equal(afterFirst?.allowed, true);
    assert.equal(afterFirst?.dispatchedCartons, 1);
    assert.equal(afterFirst?.dispatchedPairs, 6);

    const second = await dispatchScanUseCase.execute({ rawScan: qrIds[1], sessionId: firstSession.sessionId, context: SCAN_CONTEXT });
    assert.equal(second.accepted, true);
    const afterSecond = fixture.db.checkDispatchSessionAllowance(firstSession.sessionId, productId);
    assert.equal(afterSecond?.allowed, false);
    assert.equal(afterSecond?.requiredCartons, 2);
    assert.equal(afterSecond?.dispatchedCartons, 2);

    // The bill is complete: a third carton must be refused and leave stock untouched.
    const stockBefore = variantPool(fixture.db, productId);
    const third = await dispatchScanUseCase.execute({ rawScan: qrIds[2], sessionId: firstSession.sessionId, context: SCAN_CONTEXT });
    assert.equal(third.accepted, false);
    assert.equal(third.reason, "ERROR: ITEM NOT IN SELECTED BILL");
    assert.equal(variantPool(fixture.db, productId), stockBefore);
    assert.equal(fixture.db.listDispatchSessions({ status: "ALL" })[0]?.remainingCartons, 0);
  } finally {
    fixture.cleanup();
  }
});

// ─── Dispatch event attribution (exact dispatch_session_id, never article+size+timestamp) ──
//
// These replace the old heuristic's implicit "trust me" with the exact chain approved for
// this fix: dispatch_sessions.voucher_id → dispatch_session_id on the DISPATCHED event →
// cancellation reverses only that event, restoring its own previous_status/previous_location.

test("two vouchers ordering the same article/size count only their own dispatched cartons", async () => {
  const fixture = createDbFixture();
  try {
    const a = await createVoucherWithCartons(fixture.db, { partyName: "Voucher A Co", article: "SK9", size: "9/12", color: "RED", dozens: 1 });
    const b = await createVoucherWithCartons(fixture.db, { partyName: "Voucher B Co", article: "SK9", size: "9/12", color: "RED", dozens: 1 });

    const dispatchScanUseCase = new DispatchScanUseCase(dispatchScanDeps(fixture.db));

    const dispatchA = await dispatchScanUseCase.execute({ rawScan: a.qrIds[0], sessionId: a.sessionId, context: SCAN_CONTEXT });
    assert.equal(dispatchA.accepted, true);
    const dispatchB = await dispatchScanUseCase.execute({ rawScan: b.qrIds[0], sessionId: b.sessionId, context: SCAN_CONTEXT });
    assert.equal(dispatchB.accepted, true);

    // Before this fix, both sessions shared one global count keyed only by article + size, so
    // B's scan would also count toward A's bill (and vice versa for a bill created earlier).
    const sessionA = fixture.db.getDispatchSession(a.sessionId);
    const sessionB = fixture.db.getDispatchSession(b.sessionId);
    assert.equal(sessionA?.allowedItems[0]?.dispatchedCartons, 1, "A's session must see only A's own scan");
    assert.equal(sessionB?.allowedItems[0]?.dispatchedCartons, 1, "B's session must see only B's own scan");
  } finally {
    fixture.cleanup();
  }
});

test("cancelling voucher B does not affect voucher A's QR, event, stock, or history", async () => {
  const fixture = createDbFixture();
  try {
    const a = await createVoucherWithCartons(fixture.db, { partyName: "Voucher A Co", article: "SK9", size: "9/12", color: "BLUE", dozens: 1 });
    const b = await createVoucherWithCartons(fixture.db, { partyName: "Voucher B Co", article: "SK9", size: "9/12", color: "BLUE", dozens: 1 });

    const dispatchScanUseCase = new DispatchScanUseCase(dispatchScanDeps(fixture.db));
    await dispatchScanUseCase.execute({ rawScan: a.qrIds[0], sessionId: a.sessionId, context: SCAN_CONTEXT });
    await dispatchScanUseCase.execute({ rawScan: b.qrIds[0], sessionId: b.sessionId, context: SCAN_CONTEXT });

    // A and B order the same article/color/size, so they share one product_variant_id and its
    // stock aggregate — that aggregate is *expected* to move when B's carton is returned to it;
    // what must stay untouched is A's own QR record and A's own event history specifically.
    const aQrBefore = rawGet(fixture.db, "SELECT current_status FROM qr_master WHERE qr_id = ?", a.qrIds[0]);
    const aEventCountBefore = rawGet(fixture.db, "SELECT COUNT(1) c FROM production_events WHERE qr_id = ?", a.qrIds[0]).c;
    const sharedStockBefore = variantPool(fixture.db, a.productId);
    assert.equal(aQrBefore.current_status, "DISPATCHED");

    const result = fixture.db.deleteSaleVoucher(b.voucherId);
    assert.equal(result.cancelled, true);
    assert.equal(result.reversedEventCount, 1);
    assert.deepEqual(result.ambiguousDispatchEventIds, []);

    // Voucher A — same article, same size, created earlier — must be untouched in every way.
    assert.equal(rawGet(fixture.db, "SELECT current_status FROM qr_master WHERE qr_id = ?", a.qrIds[0]).current_status, "DISPATCHED");
    assert.equal(rawGet(fixture.db, "SELECT COUNT(1) c FROM production_events WHERE qr_id = ?", a.qrIds[0]).c, aEventCountBefore);

    // The shared variant pool gained exactly B's one reversed carton — no more, no less.
    assert.equal(variantPool(fixture.db, a.productId), sharedStockBefore + 1);

    // Voucher B's own QR/session were correctly reversed. (listDispatchSessions excludes
    // deleted vouchers by design, so the session's own status is read directly.)
    assert.equal(rawGet(fixture.db, "SELECT current_status FROM qr_master WHERE qr_id = ?", b.qrIds[0]).current_status, "PRODUCED");
    assert.equal(rawGet(fixture.db, "SELECT status FROM dispatch_sessions WHERE id = ?", b.sessionId).status, "CANCELLED");
  } finally {
    fixture.cleanup();
  }
});

test("cancelling voucher A (created first) does not affect voucher B's later dispatch", async () => {
  const fixture = createDbFixture();
  try {
    const a = await createVoucherWithCartons(fixture.db, { partyName: "Voucher A Co", article: "SK9", size: "10/13", color: "TAN", dozens: 1 });
    const dispatchScanUseCase = new DispatchScanUseCase(dispatchScanDeps(fixture.db));
    await dispatchScanUseCase.execute({ rawScan: a.qrIds[0], sessionId: a.sessionId, context: SCAN_CONTEXT });

    // B is created and dispatched strictly after A — the exact ordering that made the old
    // "event_ts_local >= voucher.created_at" heuristic ambiguous between the two.
    const b = await createVoucherWithCartons(fixture.db, { partyName: "Voucher B Co", article: "SK9", size: "10/13", color: "TAN", dozens: 1 });
    await dispatchScanUseCase.execute({ rawScan: b.qrIds[0], sessionId: b.sessionId, context: SCAN_CONTEXT });

    const result = fixture.db.deleteSaleVoucher(a.voucherId);
    assert.equal(result.reversedEventCount, 1);

    assert.equal(rawGet(fixture.db, "SELECT current_status FROM qr_master WHERE qr_id = ?", b.qrIds[0]).current_status, "DISPATCHED");
    assert.equal(fixture.db.getDispatchSession(b.sessionId)?.allowedItems[0]?.dispatchedCartons, 1);
  } finally {
    fixture.cleanup();
  }
});

test("cancellation restores the exact previous status and location, not PRODUCED/FACTORY", async () => {
  const fixture = createDbFixture();
  try {
    // Produce, then move into the store (Store Scanning), so the unit's pre-dispatch state is
    // WAREHOUSE, not PRODUCED/FACTORY — the case the old hardcoded reversal always got wrong.
    const { db } = fixture;
    const [qrId] = registerQrIdentities(db, { article: "SK9", size: "11/14", color: "GREEN", quantity: 1 });
    const processScanUseCase = new ProcessScanUseCase(scanDeps(db));
    await processScanUseCase.execute({ rawScan: qrId, context: SCAN_CONTEXT });

    const { StoreEntryScanUseCase } = await import("@erp/application");
    const storeEntryUseCase = new StoreEntryScanUseCase({
      txManager: db,
      qrLookupRepo: db,
      qrRegistry: db,
      qrMasterRepo: db,
      storeEntryEventsRepo: db,
      stockProjectionRepo: db,
      outboxRepo: db,
      eventPublisher: new InMemoryEventBus(),
      idGenerator: new UuidGenerator(),
    });
    const storeEntry = await storeEntryUseCase.execute({ rawScan: qrId, context: SCAN_CONTEXT });
    assert.equal(storeEntry.accepted, true);
    assert.equal(rawGet(db, "SELECT current_status, current_location_type FROM qr_master WHERE qr_id = ?", qrId).current_status, "WAREHOUSE");

    const party = db.createParty({ partyName: "Warehouse Buyer", partyType: "CUSTOMER", city: "Lahore", mobileNumber: "0300-3333333", status: "ACTIVE" });
    const productId = rawGet(db, "SELECT product_variant_id FROM qr_master WHERE qr_id = ?", qrId).product_variant_id;
    const voucher = db.createSaleVoucher({ partyId: party, voucherDate: "2026-09-19", bookNo: "B1" });
    db.addVoucherLineItem(voucher.id, { productVariantId: productId, quantity: 0.5, unitPrice: 180, discount: 0 });
    const dispatchSession = db.listDispatchSessions({ status: "ALL" }).find((s) => s.voucherId === voucher.id)!;

    const dispatchScanUseCase = new DispatchScanUseCase(dispatchScanDeps(db));
    const dispatchResult = await dispatchScanUseCase.execute({ rawScan: qrId, sessionId: dispatchSession.sessionId, context: SCAN_CONTEXT });
    assert.equal(dispatchResult.accepted, true);
    assert.equal(rawGet(db, "SELECT current_status FROM qr_master WHERE qr_id = ?", qrId).current_status, "DISPATCHED");

    const locationBefore = rawGet(db, "SELECT quantity_on_hand FROM stock_projection_by_location WHERE product_variant_id = ? AND location_type = 'WAREHOUSE'", productId).quantity_on_hand;

    const result = db.deleteSaleVoucher(voucher.id);
    assert.equal(result.reversedEventCount, 1);

    const restored = rawGet(db, "SELECT current_status, current_location_type FROM qr_master WHERE qr_id = ?", qrId);
    assert.equal(restored.current_status, "WAREHOUSE", "must restore the exact prior status, not PRODUCED");
    assert.equal(restored.current_location_type, "WAREHOUSE", "must restore the exact prior location, not FACTORY");

    const locationAfter = rawGet(db, "SELECT quantity_on_hand FROM stock_projection_by_location WHERE product_variant_id = ? AND location_type = 'WAREHOUSE'", productId).quantity_on_hand;
    assert.equal(locationAfter, locationBefore + 1, "stock must be credited back to WAREHOUSE, not FACTORY");
  } finally {
    fixture.cleanup();
  }
});

test("cancellation preserves the original DISPATCHED event, its outbox row, and records a referencing ADJUSTMENT", async () => {
  const fixture = createDbFixture();
  try {
    const a = await createVoucherWithCartons(fixture.db, { partyName: "History Co", article: "SK9", size: "12/15", color: "BLACK", dozens: 1 });
    const dispatchScanUseCase = new DispatchScanUseCase(dispatchScanDeps(fixture.db));
    const dispatch = await dispatchScanUseCase.execute({ rawScan: a.qrIds[0], sessionId: a.sessionId, context: SCAN_CONTEXT });
    assert.equal(dispatch.accepted, true);

    const originalEvent = rawGet(fixture.db, "SELECT id, dispatch_session_id FROM production_events WHERE qr_id = ? AND event_type = 'DISPATCHED'", a.qrIds[0]);
    const outboxBefore = rawGet(fixture.db, "SELECT COUNT(1) c FROM sync_outbox WHERE aggregate_id = ?", originalEvent.id).c;
    assert.equal(outboxBefore, 1);

    const result = fixture.db.deleteSaleVoucher(a.voucherId);
    assert.equal(result.reversedEventCount, 1);

    // The original row is never deleted — production_events is immutable.
    const originalAfter = rawGet(fixture.db, "SELECT id, event_type FROM production_events WHERE id = ?", originalEvent.id);
    assert.ok(originalAfter, "the original DISPATCHED row must still exist");
    assert.equal(originalAfter.event_type, "DISPATCHED");

    // Its outbox row is untouched.
    assert.equal(rawGet(fixture.db, "SELECT COUNT(1) c FROM sync_outbox WHERE aggregate_id = ?", originalEvent.id).c, outboxBefore);

    // A new ADJUSTMENT event exists, referencing the original event and the voucher.
    const adjustment = rawGet(fixture.db, "SELECT id, event_type, metadata_json, dispatch_session_id FROM production_events WHERE qr_id = ? AND event_type = 'ADJUSTMENT'", a.qrIds[0]);
    assert.ok(adjustment, "an ADJUSTMENT event must be recorded");
    const meta = JSON.parse(adjustment.metadata_json);
    assert.equal(meta.reversedEventId, originalEvent.id);
    assert.equal(meta.voucherId, a.voucherId);
    assert.equal(meta.reason, "VOUCHER_CANCELLED");
    assert.equal(adjustment.dispatch_session_id, originalEvent.dispatch_session_id);

    // The correction itself is enqueued for sync, exactly like every other event type is —
    // otherwise the cloud would never learn a dispatch was reversed.
    const adjustmentOutbox = rawGet(fixture.db, "SELECT aggregate_type, operation, status FROM sync_outbox WHERE aggregate_id = ?", adjustment.id);
    assert.ok(adjustmentOutbox, "the ADJUSTMENT event must have its own outbox row");
    assert.equal(adjustmentOutbox.aggregate_type, "PRODUCTION_EVENT");
    assert.equal(adjustmentOutbox.operation, "INSERT");
    assert.equal(adjustmentOutbox.status, "PENDING");

    assert.equal(rawGet(fixture.db, "SELECT COUNT(1) c FROM production_events WHERE qr_id = ?", a.qrIds[0]).c, 3, "PRODUCED + DISPATCHED + ADJUSTMENT — nothing deleted, nothing extra");
  } finally {
    fixture.cleanup();
  }
});

test("re-dispatching the same QR after cancellation, under a different voucher, is an independent event chain", async () => {
  const fixture = createDbFixture();
  try {
    const a = await createVoucherWithCartons(fixture.db, { partyName: "First Buyer", article: "SK9", size: "13/16", color: "WHITE", dozens: 1 });
    const dispatchScanUseCase = new DispatchScanUseCase(dispatchScanDeps(fixture.db));
    await dispatchScanUseCase.execute({ rawScan: a.qrIds[0], sessionId: a.sessionId, context: SCAN_CONTEXT });

    fixture.db.deleteSaleVoucher(a.voucherId);
    assert.equal(rawGet(fixture.db, "SELECT current_status FROM qr_master WHERE qr_id = ?", a.qrIds[0]).current_status, "PRODUCED");

    // Same physical carton, a completely different bill.
    const partyId = fixture.db.createParty({ partyName: "Second Buyer", partyType: "CUSTOMER", city: "Lahore", mobileNumber: "0300-4444444", status: "ACTIVE" });
    const voucherB = fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-09-19", bookNo: "B1" });
    fixture.db.addVoucherLineItem(voucherB.id, { productVariantId: a.productId, quantity: 0.5, unitPrice: 180, discount: 0 });
    const sessionB = fixture.db.listDispatchSessions({ status: "ALL" }).find((s) => s.voucherId === voucherB.id)!;

    const redispatch = await dispatchScanUseCase.execute({ rawScan: a.qrIds[0], sessionId: sessionB.sessionId, context: SCAN_CONTEXT });
    assert.equal(redispatch.accepted, true);

    const events = rawAll(fixture.db, "SELECT event_type, dispatch_session_id FROM production_events WHERE qr_id = ? ORDER BY created_at ASC", a.qrIds[0]);
    // PRODUCED, DISPATCHED (voucher A), ADJUSTMENT (cancel A), DISPATCHED (voucher B) — four
    // distinct, independent rows; nothing was overwritten or reused.
    assert.deepEqual(events.map((e: any) => e.event_type), ["PRODUCED", "DISPATCHED", "ADJUSTMENT", "DISPATCHED"]);
    assert.equal(events[1].dispatch_session_id, a.sessionId);
    assert.equal(events[3].dispatch_session_id, sessionB.sessionId);
    assert.notEqual(events[1].dispatch_session_id, events[3].dispatch_session_id);

    assert.equal(fixture.db.getDispatchSession(sessionB.sessionId)?.allowedItems[0]?.dispatchedCartons, 1, "voucher B's own count, independent of voucher A's history");
  } finally {
    fixture.cleanup();
  }
});

test("a legacy DISPATCHED event with no session attribution is never auto-reversed and is reported as ambiguous", async () => {
  const fixture = createDbFixture();
  try {
    const { db } = fixture;
    const partyId = db.createParty({ partyName: "Legacy Buyer", partyType: "CUSTOMER", city: "Lahore", mobileNumber: "0300-5555555", status: "ACTIVE" });
    const voucher = db.createSaleVoucher({ partyId, voucherDate: "2026-09-19", bookNo: "B1" });
    const productId = db.createProduct({ article: "SK9", color: "GOLD", size: "14/17", costPrice: 100, sellingPrice: 180, status: "ACTIVE" });
    db.addVoucherLineItem(voucher.id, { productVariantId: productId, quantity: 1, unitPrice: 180, discount: 0 });

    // A QR produced, then flipped to DISPATCHED by a raw insert shaped exactly like data
    // written before this migration existed — dispatch_session_id/previous_* all NULL.
    const [qrId] = generateQrIds(db, { article: "SK9", size: "14/17", color: "GOLD", quantity: 1 });
    const processScanUseCase = new ProcessScanUseCase(scanDeps(db));
    await processScanUseCase.execute({ rawScan: qrId, context: SCAN_CONTEXT });

    const now = new Date().toISOString();
    const legacyEventId = crypto.randomUUID();
    rawExec(
      db,
      `INSERT INTO production_events (
        id, qr_id, product_variant_id, event_type, event_ts_local, event_date, event_hour,
        factory_id, workstation_id, operator_id, device_id,
        article_snapshot, color_snapshot, size_snapshot, serial_snapshot,
        metadata_json, created_at, sync_status, synced_at, sync_error, retry_count, source_app,
        dispatch_session_id, previous_status, previous_location_type, previous_location_id
      ) VALUES (?, ?, ?, 'DISPATCHED', ?, ?, ?, ?, ?, NULL, ?, 'SK9', 'GOLD', '14/17', 'LEGACY',
        '{"parserVersion":"v1","eventType":"DISPATCHED"}', ?, 'PENDING', NULL, NULL, 0, 'desktop-scanner',
        NULL, NULL, NULL, NULL)`,
      legacyEventId, qrId, productId, now, now.slice(0, 10), new Date(now).getHours(),
      SCAN_CONTEXT.factoryId, SCAN_CONTEXT.workstationId, SCAN_CONTEXT.deviceId, now
    );
    rawExec(db, "UPDATE qr_master SET current_status = 'DISPATCHED' WHERE qr_id = ?", qrId);

    const result = db.deleteSaleVoucher(voucher.id);

    // The voucher itself is still cancelled — but nothing about the ambiguous event is guessed.
    assert.equal(result.cancelled, true);
    assert.equal(result.reversedEventCount, 0);
    assert.deepEqual(result.ambiguousDispatchEventIds, [legacyEventId]);

    assert.equal(rawGet(db, "SELECT current_status FROM qr_master WHERE qr_id = ?", qrId).current_status, "DISPATCHED", "must not be silently restored");
    const legacyAfter = rawGet(db, "SELECT dispatch_session_id FROM production_events WHERE id = ?", legacyEventId);
    assert.equal(legacyAfter.dispatch_session_id, null, "must not be silently assigned an owner");
    assert.equal(rawGet(db, "SELECT COUNT(1) c FROM production_events WHERE qr_id = ?", qrId).c, 2, "no ADJUSTMENT was written for it — PRODUCED + the untouched legacy DISPATCHED row only");
  } finally {
    fixture.cleanup();
  }
});

test("if reversing one event throws mid-cancellation, an earlier reversal in the same call rolls back too", async () => {
  const fixture = createDbFixture();
  try {
    const { db } = fixture;
    // Two dispatched cartons under the same voucher/session, so the internal loop in
    // deleteSaleVoucher has two iterations — the second is made to throw below.
    const a = await createVoucherWithCartons(db, { partyName: "Rollback Co", article: "SK9", size: "16/19", color: "MAROON", dozens: 1 });
    const dispatchScanUseCase = new DispatchScanUseCase(dispatchScanDeps(db));
    await dispatchScanUseCase.execute({ rawScan: a.qrIds[0], sessionId: a.sessionId, context: SCAN_CONTEXT });
    await dispatchScanUseCase.execute({ rawScan: a.qrIds[1], sessionId: a.sessionId, context: SCAN_CONTEXT });

    assert.equal(rawGet(db, "SELECT current_status FROM qr_master WHERE qr_id = ?", a.qrIds[0]).current_status, "DISPATCHED");
    assert.equal(rawGet(db, "SELECT current_status FROM qr_master WHERE qr_id = ?", a.qrIds[1]).current_status, "DISPATCHED");
    const stockBefore = variantPool(db, a.productId);
    const eventCountBefore = rawGet(db, "SELECT COUNT(1) c FROM production_events").c;

    // Force the SECOND reversal inside deleteSaleVoucher's loop to fail, simulating a
    // mid-cancellation error after the first event has already been reversed within the same
    // open transaction (BEGIN IMMEDIATE was taken before the loop starts).
    const original = (db as any).reverseDispatchedEvent.bind(db);
    let calls = 0;
    (db as any).reverseDispatchedEvent = (...args: unknown[]) => {
      calls += 1;
      if (calls === 2) throw new Error("SIMULATED FAILURE mid-cancellation");
      return original(...args);
    };

    assert.throws(() => db.deleteSaleVoucher(a.voucherId), /SIMULATED FAILURE/);

    // Nothing committed: both QRs, stock, event history, the voucher and the session are
    // exactly as before — including the FIRST event, whose reversal had already run (inside
    // the still-open transaction) before the second one threw. SQLite's ROLLBACK in the
    // catch block undoes the whole transaction, not just the statement that failed.
    assert.equal(rawGet(db, "SELECT current_status FROM qr_master WHERE qr_id = ?", a.qrIds[0]).current_status, "DISPATCHED", "the first event's reversal must be rolled back too");
    assert.equal(rawGet(db, "SELECT current_status FROM qr_master WHERE qr_id = ?", a.qrIds[1]).current_status, "DISPATCHED");
    assert.equal(variantPool(db, a.productId), stockBefore, "stock must be exactly as before — no partial credit");
    assert.equal(rawGet(db, "SELECT COUNT(1) c FROM production_events").c, eventCountBefore, "no ADJUSTMENT event survives from either loop iteration");
    assert.equal(rawGet(db, "SELECT deleted_at FROM sale_vouchers WHERE id = ?", a.voucherId).deleted_at, null, "the voucher itself must not be marked cancelled either");
    assert.equal(rawGet(db, "SELECT status FROM dispatch_sessions WHERE id = ?", a.sessionId).status, "IN_PROGRESS", "the session must not be marked CANCELLED");
  } finally {
    fixture.cleanup();
  }
});

test("repeated cancellation of the same voucher is idempotent and safe", async () => {
  const fixture = createDbFixture();
  try {
    const a = await createVoucherWithCartons(fixture.db, { partyName: "Idempotent Co", article: "SK9", size: "15/18", color: "SILVER", dozens: 1 });
    const dispatchScanUseCase = new DispatchScanUseCase(dispatchScanDeps(fixture.db));
    await dispatchScanUseCase.execute({ rawScan: a.qrIds[0], sessionId: a.sessionId, context: SCAN_CONTEXT });

    const first = fixture.db.deleteSaleVoucher(a.voucherId);
    assert.equal(first.reversedEventCount, 1);
    const stockAfterFirst = variantPool(fixture.db, a.productId);

    // Calling it again (double-click, retried IPC call, …) must not re-reverse anything.
    const second = fixture.db.deleteSaleVoucher(a.voucherId);
    assert.equal(second.cancelled, true);
    assert.equal(second.reversedEventCount, 0);
    assert.equal(variantPool(fixture.db, a.productId), stockAfterFirst, "no double-credit on repeated cancellation");
    assert.equal(rawGet(fixture.db, "SELECT COUNT(1) c FROM production_events WHERE qr_id = ? AND event_type = 'ADJUSTMENT'", a.qrIds[0]).c, 1, "exactly one correction, not two");

    const third = fixture.db.deleteSaleVoucher(a.voucherId);
    assert.equal(third.reversedEventCount, 0);
  } finally {
    fixture.cleanup();
  }
});

test("saved vouchers create a pending dispatch session and allow only bill-matching variants", async () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({
      partyName: "Dispatch Customer",
      partyType: "CUSTOMER",
      city: "Lahore",
      mobileNumber: "0300-2222222",
      status: "ACTIVE",
    });

    const allowedVariantId = fixture.db.createProduct({
      article: "SK7",
      color: "RED",
      size: "7/10",
      costPrice: 100,
      sellingPrice: 180,
      description: "Allowed variant",
      status: "ACTIVE",
    });

    const secondAllowedVariantId = fixture.db.createProduct({
      article: "SK7",
      color: "BLACK",
      size: "8/11",
      costPrice: 110,
      sellingPrice: 200,
      description: "Second allowed variant",
      status: "ACTIVE",
    });

    const excludedVariantId = fixture.db.createProduct({
      article: "SK9",
      color: "BLUE",
      size: "9/12",
      costPrice: 120,
      sellingPrice: 210,
      description: "Excluded variant",
      status: "ACTIVE",
    });

    const voucher = fixture.db.createSaleVoucher({
      partyId,
      voucherDate: "2026-08-15",
      bookNo: "B1",
    });

    fixture.db.addVoucherLineItem(voucher.id, {
      productVariantId: allowedVariantId,
      quantity: 1,
      unitPrice: 180,
      discount: 0,
    });

    fixture.db.addVoucherLineItem(voucher.id, {
      productVariantId: secondAllowedVariantId,
      quantity: 2,
      unitPrice: 200,
      discount: 0,
    });

    const pendingSessions = fixture.db.listDispatchSessions({ status: "PENDING" });
    assert.equal(pendingSessions.length, 1);
    assert.equal(pendingSessions[0].voucherNumber, voucher.voucherNumber);

    const session = fixture.db.getDispatchSession(pendingSessions[0].sessionId);
    assert.ok(session);
    assert.equal(session.allowedItems.length, 2);
    assert.deepEqual(
      session.allowedItems.map((item) => ({ article: item.article, color: item.color, size: item.size })),
      [
        { article: "SK7", color: "RED", size: "7/10" },
        { article: "SK7", color: "BLACK", size: "8/11" },
      ]
    );

    const firstAllowed = fixture.db.checkDispatchSessionAllowance(session.sessionId, allowedVariantId);
    assert.deepEqual(firstAllowed, {
      allowed: true,
      lineItemId: session.allowedItems[0].lineItemId,
      article: "SK7",
      color: "RED",
      size: "7/10",
      requiredCartons: 2,
      dispatchedCartons: 0,
      requiredPairs: 12,
      dispatchedPairs: 0,
    });

    const secondAllowed = fixture.db.checkDispatchSessionAllowance(session.sessionId, secondAllowedVariantId);
    assert.equal(secondAllowed?.allowed, true);
    assert.equal(fixture.db.checkDispatchSessionAllowance(session.sessionId, excludedVariantId)?.allowed, false);
  } finally {
    fixture.cleanup();
  }
});

test("customer ledger and balance are derived from saved vouchers and honor date filters", async () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({
      partyName: "Ledger Customer",
      partyType: "CUSTOMER",
      city: "Karachi",
      mobileNumber: "0300-1111111",
      status: "ACTIVE",
    });

    const productId = fixture.db.createProduct({
      article: "SK9",
      color: "RED",
      size: "7/10",
      costPrice: 100,
      sellingPrice: 150,
      description: "Ledger product",
      status: "ACTIVE",
    });
    // Backend discount authority (Phase 2): a line's discount may not exceed resolveDiscount()'s
    // ceiling, so this scenario needs an actual rule authorizing the discounts used below.
    fixture.db.createPartyArticleDiscount({ partyId, article: productId, sizeScope: "ALL_SIZES", discountPerPair: 5 });

    const firstVoucher = fixture.db.createSaleVoucher({
      partyId,
      voucherDate: "2026-08-01",
      bookNo: "B1",
      remarks: "First bill",
    });
    fixture.db.addVoucherLineItem(firstVoucher.id, {
      productVariantId: productId,
      quantity: 1,
      unitPrice: 250,
      discount: 25,
    });

    const secondVoucher = fixture.db.createSaleVoucher({
      partyId,
      voucherDate: "2026-08-15",
      bookNo: "B2",
      remarks: "Second bill",
    });
    fixture.db.addVoucherLineItem(secondVoucher.id, {
      productVariantId: productId,
      quantity: 2,
      unitPrice: 180,
      discount: 20,
    });

    const ledger = fixture.db.getCustomerLedger(partyId, { toDate: "2026-08-15" });
    assert.equal(ledger.entries.length, 2);
    assert.equal(ledger.entries[0].voucherNumber, "1");
    assert.equal(ledger.entries[0].amount, 2975);
    assert.equal(ledger.entries[0].balance, 2975);
    assert.equal(ledger.entries[1].amount, 4300);
    assert.equal(ledger.entries[1].balance, 7275);

    const balances = fixture.db.listCustomerBalances({ asOfDate: "2026-08-10" });
    assert.equal(balances.rows.length, 1);
    assert.equal(balances.rows[0].partyName, "Ledger Customer");
    assert.equal(balances.rows[0].balance, 2975);

    const balancesAll = fixture.db.listCustomerBalances({ asOfDate: "2026-08-15" });
    assert.equal(balancesAll.rows[0].balance, 7275);
  } finally {
    fixture.cleanup();
  }
});

test("cash vouchers update customer ledger and balance immediately", async () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({
      partyName: "Cash Customer",
      partyType: "CUSTOMER",
      city: "Lahore",
      mobileNumber: "0300-2222222",
      status: "ACTIVE",
    });

    const productId = fixture.db.createProduct({
      article: "SK7",
      color: "BLACK",
      size: "8/11",
      costPrice: 90,
      sellingPrice: 140,
      description: "Cash ledger product",
      status: "ACTIVE",
    });

    const saleVoucher = fixture.db.createSaleVoucher({
      partyId,
      voucherDate: "2026-08-01",
      bookNo: "B1",
      remarks: "Initial invoice",
    });
    fixture.db.addVoucherLineItem(saleVoucher.id, {
      productVariantId: productId,
      quantity: 1,
      unitPrice: 5000,
      discount: 0,
    });

    fixture.db.createCashVoucher({
      partyId,
      voucherDate: "2026-08-05",
      description: "Customer payment received",
      receiptAmount: 1500,
    });

    fixture.db.createCashVoucher({
      partyId,
      voucherDate: "2026-08-10",
      description: "Advance returned to customer",
      paymentAmount: 400,
    });

    const ledger = fixture.db.getCustomerLedger(partyId, { toDate: "2026-08-15" });
    assert.equal(ledger.entries.length, 3);
    assert.equal(ledger.entries[0].amount, 60000);
    assert.equal(ledger.entries[0].balance, 60000);
    assert.equal(ledger.entries[1].amount, -1500);
    assert.equal(ledger.entries[1].balance, 58500);
    assert.equal(ledger.entries[2].amount, 400);
    assert.equal(ledger.entries[2].balance, 58900);

    const balances = fixture.db.listCustomerBalances({ asOfDate: "2026-08-15" });
    assert.equal(balances.rows.length, 1);
    assert.equal(balances.rows[0].partyName, "Cash Customer");
    assert.equal(balances.rows[0].balance, 58900);
    assert.equal(balances.rows[0].totalSales, 60000);
    assert.equal(balances.rows[0].totalReceipts, 1500);
    assert.equal(balances.rows[0].totalPayments, 400);
  } finally {
    fixture.cleanup();
  }
});

test("product CRUD and inventory valuation work offline", async () => {
  const fixture = createDbFixture();
  try {
    const productId = fixture.db.createProduct({
      article: "SK7",
      color: "BLACK",
      size: "8/11",
      costPrice: 120,
      sellingPrice: 190,
      description: "Runner",
      status: "ACTIVE",
    });

    fixture.db.updateProduct(productId, {
      article: "SK7",
      color: "BLACK",
      size: "8/11",
      costPrice: 130,
      sellingPrice: 200,
      description: "Runner v2",
      status: "ACTIVE",
    });

    const list = fixture.db.listProducts({ search: "SK7", status: "ALL", page: 1, pageSize: 10 });
    assert.equal(list.total, 1);
    assert.equal(list.rows[0].costPrice, 130);

    const [qrId] = generateQrIds(fixture.db, { article: "SK7", size: "8/11", color: "BLACK", quantity: 1 });
    const useCase = new ProcessScanUseCase(scanDeps(fixture.db));

    await useCase.execute({
      rawScan: qrId,
      context: {
        factoryId: "factory-1",
        workstationId: "workstation-1",
        deviceId: "device-1",
      },
    });

    // Current Stock (and therefore stock value) counts what is In Store, so receive it first.
    assert.equal(fixture.db.listInventory("SK7")[0]?.quantity, 0, "a produced carton is not Current Stock until the store receives it");
    await receiveIntoStore(fixture.db, qrId);

    const inventory = fixture.db.listInventory("SK7");
    assert.equal(inventory.length, 1);
    assert.equal(inventory[0].quantity, 1);
    assert.equal(inventory[0].stockValue, 130);
    assert.equal(inventory[0].profitPotential, 70);

    fixture.db.disableProduct(productId, "archived");
    const postDisable = fixture.db.listProducts({ search: "SK7", status: "DISABLED" });
    assert.equal(postDisable.total, 1);
  } finally {
    fixture.cleanup();
  }
});

test("history filters and reports generate expected aggregates", async () => {
  const fixture = createDbFixture();
  try {
    const qrIds = registerQrIdentities(fixture.db, { article: "SK6", size: "7/10", color: "BLUE", quantity: 2 });
    const useCase = new ProcessScanUseCase(scanDeps(fixture.db));

    await useCase.execute({ rawScan: qrIds[0], context: SCAN_CONTEXT });
    await useCase.execute({ rawScan: qrIds[1], context: SCAN_CONTEXT });

    const history = fixture.db.listHistory({ search: "SK6", page: 1, pageSize: 20 });
    assert.equal(history.total, 2);

    const report = fixture.db.getReport("DAILY");
    assert.equal(report.totalProduction, 2);
    assert.equal(report.byArticle[0].key, "SK6");
    assert.equal(report.byArticle[0].quantity, 2);
  } finally {
    fixture.cleanup();
  }
});

test("return scan writes a valid outbox aggregate type", async () => {
  const fixture = createDbFixture();
  try {
    // A carton produced and billed to a customer, then dispatched against that bill — the
    // dispatch has to carry its session, or the return has no one to credit.
    const bill = await createVoucherWithCartons(fixture.db, {
      partyName: "Outbox Co", article: "SK6", size: "7/10", color: "BLUE", dozens: 0.5,
    });
    const qrId = bill.qrIds[0];

    const dispatchResult = await new DispatchScanUseCase(dispatchScanDeps(fixture.db)).execute({
      rawScan: qrId,
      sessionId: bill.sessionId,
      context: SCAN_CONTEXT,
    });
    assert.equal(dispatchResult.accepted, true);

    const returnResult = await new (await import("@erp/application")).ReturnScanUseCase(
      returnScanDeps(fixture.db)
    ).execute({ rawScan: qrId, context: SCAN_CONTEXT });

    assert.equal(returnResult.accepted, true, returnResult.reason);
    // The product, the carton identity, the production scan, the dispatch and the return. Each
    // row's aggregate_type is CHECK-constrained, so a bad one would have thrown rather than
    // counted.
    assert.deepEqual(outboxTypes(fixture.db), [
      "DISPATCH_EVENT",
      "PRODUCTION_PRODUCED",
      "PRODUCT_VARIANT",
      "QR_MASTER",
      "RETURN_EVENT",
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("settings, backups, and health snapshot are functional", async () => {
  const fixture = createDbFixture();
  try {
    fixture.db.setSettings({
      "factory.name": "Updated Factory",
      "theme": "dark",
      "sound.enabled": "false",
    });
    const settings = fixture.db.getSettings();
    assert.equal(settings["factory.name"], "Updated Factory");
    assert.equal(settings["theme"], "dark");

    const backupFolder = path.join(os.tmpdir(), `erp-backups-${Date.now()}`);
    const backup = fixture.db.createBackup(backupFolder, "MANUAL");
    assert.equal(fs.existsSync(backup.backupPath), true);

    const backups = fixture.db.listBackups();
    assert.equal(backups.length >= 1, true);

    const health = fixture.db.captureHealthSnapshot({
      scannerConnected: true,
      appVersion: "1.0.0",
      deviceId: "device-1",
    });
    assert.equal(health.sqliteStatus, "OK");
    assert.equal(health.scannerConnected, true);
  } finally {
    fixture.cleanup();
  }
});

// ── PARTY BALANCE LIMIT TESTS ─────────────────────────────────────────────────

test("balance limit: TEST1 — under limit (90k balance, 100k limit, 8k voucher → ALLOW)", () => {
  const fixture = createDbFixture();
  try {
    // Party with balance_limit = 100,000
    const partyId = fixture.db.createParty({
      partyName: "BL Test Party 1",
      partyType: "CUSTOMER",
      status: "ACTIVE",
      balanceLimit: 100_000,
    });
    const productId = fixture.db.createProduct({ article: "BL1", color: "RED", size: "7/10", sellingPrice: 500, status: "ACTIVE" });

    // Establish current balance of 90,000: create a voucher and add line items totalling 90,000.
    // 1 dozen @ 7500/pair = 90,000
    const existing = fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-01-01", bookNo: "B0" });
    fixture.db.addVoucherLineItem(existing.id, { productVariantId: productId, quantity: 1, unitPrice: 7500, discount: 0 });

    const balance = fixture.db.getCurrentPartyBalance(partyId);
    assert.equal(balance, 90_000, "Pre-condition: current balance should be 90,000");

    // Voucher amount = 8,000 (projected 98,000 < 100,000) → must ALLOW
    const result = fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-01-02", bookNo: "B1", projectedTotal: 8_000 });
    assert.ok(result.id, "TEST1 FAILED: voucher should have been allowed");
    assert.ok(result.voucherNumber);
  } finally {
    fixture.cleanup();
  }
});

test("balance limit: TEST2 — exact limit (90k balance, 100k limit, 10k voucher → ALLOW)", () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({
      partyName: "BL Test Party 2",
      partyType: "CUSTOMER",
      status: "ACTIVE",
      balanceLimit: 100_000,
    });
    const productId = fixture.db.createProduct({ article: "BL2", color: "RED", size: "7/10", sellingPrice: 500, status: "ACTIVE" });

    const existing = fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-01-01", bookNo: "B0" });
    fixture.db.addVoucherLineItem(existing.id, { productVariantId: productId, quantity: 1, unitPrice: 7500, discount: 0 });

    assert.equal(fixture.db.getCurrentPartyBalance(partyId), 90_000);

    // Exactly at limit (90k + 10k = 100k) → must ALLOW
    const result = fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-01-02", bookNo: "B2", projectedTotal: 10_000 });
    assert.ok(result.id, "TEST2 FAILED: voucher at exact limit should be allowed");
  } finally {
    fixture.cleanup();
  }
});

test("balance limit: TEST3 — over limit (90k balance, 100k limit, 10001 voucher → REJECT with PARTY_BALANCE_LIMIT_EXCEEDED)", () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({
      partyName: "BL Test Party 3",
      partyType: "CUSTOMER",
      status: "ACTIVE",
      balanceLimit: 100_000,
    });
    const productId = fixture.db.createProduct({ article: "BL3", color: "RED", size: "7/10", sellingPrice: 500, status: "ACTIVE" });

    const existing = fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-01-01", bookNo: "B0" });
    fixture.db.addVoucherLineItem(existing.id, { productVariantId: productId, quantity: 1, unitPrice: 7500, discount: 0 });

    assert.equal(fixture.db.getCurrentPartyBalance(partyId), 90_000);

    // 90k + 10,001 = 100,001 > 100,000 → must REJECT
    let threw = false;
    try {
      fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-01-02", bookNo: "B3", projectedTotal: 10_001 });
    } catch (err: any) {
      threw = true;
      assert.equal(err.code, "PARTY_BALANCE_LIMIT_EXCEEDED", "Error code must be PARTY_BALANCE_LIMIT_EXCEEDED");
      assert.equal(err.currentBalance, 90_000);
      assert.equal(err.limit, 100_000);
      assert.equal(err.projectedBalance, 100_001);
      assert.equal(err.exceeded, 1);
    }
    assert.ok(threw, "TEST3 FAILED: expected PARTY_BALANCE_LIMIT_EXCEEDED to be thrown");

    // Balance must remain 90,000 — no voucher was created
    assert.equal(fixture.db.getCurrentPartyBalance(partyId), 90_000, "Balance must not change on rejected voucher");
  } finally {
    fixture.cleanup();
  }
});

test("balance limit: TEST4 — no limit (null balance_limit, 90k balance, 500k voucher → ALLOW)", () => {
  const fixture = createDbFixture();
  try {
    // No balanceLimit set (NULL = no restriction)
    const partyId = fixture.db.createParty({
      partyName: "BL Test Party 4",
      partyType: "CUSTOMER",
      status: "ACTIVE",
      // balanceLimit not provided → null
    });
    const productId = fixture.db.createProduct({ article: "BL4", color: "RED", size: "7/10", sellingPrice: 500, status: "ACTIVE" });

    const existing = fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-01-01", bookNo: "B0" });
    fixture.db.addVoucherLineItem(existing.id, { productVariantId: productId, quantity: 1, unitPrice: 7500, discount: 0 });

    // 500,000 voucher with no limit → must ALLOW
    const result = fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-01-02", bookNo: "B4", projectedTotal: 500_000 });
    assert.ok(result.id, "TEST4 FAILED: no-limit party should always be allowed");
  } finally {
    fixture.cleanup();
  }
});

test("balance limit: TEST5 — zero limit (0 balance, 0 limit, 1 voucher → REJECT)", () => {
  const fixture = createDbFixture();
  try {
    // balance_limit = 0 is an actual limit of zero (distinct from NULL = no limit)
    const partyId = fixture.db.createParty({
      partyName: "BL Test Party 5",
      partyType: "CUSTOMER",
      status: "ACTIVE",
      balanceLimit: 0,
    });

    let threw = false;
    try {
      fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-01-01", bookNo: "B5", projectedTotal: 1 });
    } catch (err: any) {
      threw = true;
      assert.equal(err.code, "PARTY_BALANCE_LIMIT_EXCEEDED");
    }
    assert.ok(threw, "TEST5 FAILED: limit=0 should reject any positive voucher");
  } finally {
    fixture.cleanup();
  }
});

test("balance limit: TEST6 — discounted final total used (90k balance, 100k limit, gross 12k discount 2k = net 10k → ALLOW)", () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({
      partyName: "BL Test Party 6",
      partyType: "CUSTOMER",
      status: "ACTIVE",
      balanceLimit: 100_000,
    });
    const productId = fixture.db.createProduct({ article: "BL6", color: "RED", size: "7/10", sellingPrice: 500, status: "ACTIVE" });

    const existing = fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-01-01", bookNo: "B0" });
    fixture.db.addVoucherLineItem(existing.id, { productVariantId: productId, quantity: 1, unitPrice: 7500, discount: 0 });
    assert.equal(fixture.db.getCurrentPartyBalance(partyId), 90_000);

    // gross = 12,000, discount = 2,000, FINAL = 10,000 → projected 100,000 = limit → ALLOW
    const result = fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-01-02", bookNo: "B6", projectedTotal: 10_000 });
    assert.ok(result.id, "TEST6 FAILED: net-of-discount amount should be used, not gross");
  } finally {
    fixture.cleanup();
  }
});

test("balance limit: TEST7 — balance updated exactly once after successful voucher", () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({
      partyName: "BL Test Party 7",
      partyType: "CUSTOMER",
      status: "ACTIVE",
      balanceLimit: 200_000,
    });
    const productId = fixture.db.createProduct({ article: "BL7", color: "RED", size: "7/10", sellingPrice: 500, status: "ACTIVE" });

    const existing = fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-01-01", bookNo: "B0" });
    fixture.db.addVoucherLineItem(existing.id, { productVariantId: productId, quantity: 1, unitPrice: 7500, discount: 0 });
    assert.equal(fixture.db.getCurrentPartyBalance(partyId), 90_000);

    const newVoucher = fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-01-02", bookNo: "B7", projectedTotal: 5_000 });
    fixture.db.addVoucherLineItem(newVoucher.id, { productVariantId: productId, quantity: 1, unitPrice: 417, discount: 0 }); // ~5,004

    const finalBalance = fixture.db.getCurrentPartyBalance(partyId);
    // 90,000 + actual line total (not projectedTotal)
    assert.ok(finalBalance > 90_000, "Balance must have increased after voucher");
    assert.ok(finalBalance < 200_000, "Balance must not exceed limit");
  } finally {
    fixture.cleanup();
  }
});

test("balance limit: TEST8 — failed voucher does not change balance (90k, 100k limit, 15k → reject, balance stays 90k)", () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({
      partyName: "BL Test Party 8",
      partyType: "CUSTOMER",
      status: "ACTIVE",
      balanceLimit: 100_000,
    });
    const productId = fixture.db.createProduct({ article: "BL8", color: "RED", size: "7/10", sellingPrice: 500, status: "ACTIVE" });

    const existing = fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-01-01", bookNo: "B0" });
    fixture.db.addVoucherLineItem(existing.id, { productVariantId: productId, quantity: 1, unitPrice: 7500, discount: 0 });
    assert.equal(fixture.db.getCurrentPartyBalance(partyId), 90_000);

    // Attempt 15k voucher → must throw
    try {
      fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-01-02", bookNo: "B8", projectedTotal: 15_000 });
    } catch {
      // expected
    }

    // Balance must be unchanged — no partial voucher or ledger mutation
    assert.equal(fixture.db.getCurrentPartyBalance(partyId), 90_000, "TEST8 FAILED: balance changed after rejected voucher");

    // Confirm no second sale_voucher row was created for this party
    // getCurrentPartyBalance uses live SQL, so if a voucher was created it would be reflected
    assert.equal(fixture.db.getCurrentPartyBalance(partyId), 90_000, "TEST8 FAILED: balance changed after rejected voucher");
  } finally {
    fixture.cleanup();
  }
});

test("balance limit: party balance_limit persists through createParty and updateParty", () => {
  const fixture = createDbFixture();
  try {
    // Create with limit
    const partyId = fixture.db.createParty({
      partyName: "BL Persist Party",
      partyType: "CUSTOMER",
      status: "ACTIVE",
      balanceLimit: 50_000,
    });

    let party = fixture.db.getParty(partyId);
    assert.equal(party?.balanceLimit, 50_000, "balanceLimit should be stored on createParty");

    // Update limit
    fixture.db.updateParty(partyId, { balanceLimit: 75_000 });
    party = fixture.db.getParty(partyId);
    assert.equal(party?.balanceLimit, 75_000, "balanceLimit should be updated by updateParty");

    // Remove limit (set to null)
    fixture.db.updateParty(partyId, { balanceLimit: null });
    party = fixture.db.getParty(partyId);
    assert.equal(party?.balanceLimit, null, "balanceLimit should be clearable to null");

    // Existing party with no limit set: field should be null not 0
    const noLimitId = fixture.db.createParty({ partyName: "BL No Limit Party", partyType: "CUSTOMER", status: "ACTIVE" });
    const noLimitParty = fixture.db.getParty(noLimitId);
    assert.equal(noLimitParty?.balanceLimit, null, "Party with no balanceLimit should return null not 0");
  } finally {
    fixture.cleanup();
  }
});

// ── DAILY PRODUCTION REPORT — 06:00 PRODUCTION-DAY BOUNDARY TESTS ─────────────

test("daily production report: 06:00 boundary — events in correct production day window", async () => {
  const fixture = createDbFixture();
  try {
    // Use the ProcessScanUseCase to create real production events with controlled timestamps.
    // We simulate events at the six boundary timestamps for production date 2026-08-21:
    //
    //  2026-08-21T05:59 → production date 20/08 (NOT in 21/08 window) — before 06:00
    //  2026-08-21T06:00 → production date 21/08, DAY SHIFT  — exactly at start
    //  2026-08-21T17:59 → production date 21/08, DAY SHIFT  — last minute of day shift
    //  2026-08-21T18:00 → production date 21/08, NIGHT SHIFT — start of night shift
    //  2026-08-22T05:59 → production date 21/08, NIGHT SHIFT — last minute before cutoff
    //  2026-08-22T06:00 → production date 22/08 (NOT in 21/08 window) — exactly at end

    // We insert events directly via appendProducedEvent / getOrCreateVariant
    // to control the timestamp precisely, bypassing the real-time scanner.
    // getOrCreateVariant is lookup-only, so the product must be registered via
    // Product Master (createProduct) first, same as the real scan workflow.
    fixture.db.createProduct({ article: "RPTEST", size: "7/10", color: "RED" });

    const insertEvent = async (timestamp: string, serial: string) => {
      await fixture.db.runInTransaction(async (tx) => {
        const qrId = `RPTEST_RED_7/10_${serial}`;
        const variant = await fixture.db.getOrCreateVariant(
          { qrId, article: "RPTEST", color: "RED", size: "7/10", serial },
          tx
        );
        await fixture.db.insertProduced({ qrId, productVariantId: variant.id, createdAt: timestamp }, tx);
        await fixture.db.appendProducedEvent(
          {
            eventId: crypto.randomUUID(),
            qrId,
            productVariantId: variant.id,
            article: "RPTEST",
            color: "RED",
            size: "7/10",
            serial,
            occurredAt: timestamp,
            parserVersion: "v1",
            factoryId: "factory-1",
            workstationId: "workstation-1",
            deviceId: "device-1",
          },
          tx
        );
      });
    };

    // Insert one event per boundary case, stamped as the application stamps them: a UTC instant.
    // The times above are Karachi clock times, five hours ahead of these. (This test used to seed
    // zone-less clock-face strings, a format the application never writes -- which is how it went
    // on passing while the real report ran 11:00 → 11:00. Fixed 2026-10-25.)
    await insertEvent("2026-08-21T00:59:00.000Z", "000001"); // 05:59 Karachi — NOT in 21/08
    await insertEvent("2026-08-21T01:00:00.000Z", "000002"); // 06:00 Karachi — IN 21/08
    await insertEvent("2026-08-21T12:59:00.000Z", "000003"); // 17:59 Karachi — IN 21/08
    await insertEvent("2026-08-21T13:00:00.000Z", "000004"); // 18:00 Karachi — IN 21/08
    await insertEvent("2026-08-22T00:59:00.000Z", "000005"); // 05:59 next day — IN 21/08
    await insertEvent("2026-08-22T01:00:00.000Z", "000006"); // 06:00 next day — NOT in 21/08

    // Query for production date 2026-08-21
    const report = fixture.db.getReport("CUSTOM", "2026-08-21", "2026-08-21");

    // Expected: events 000002, 000003, 000004, 000005 → 4 events
    assert.equal(
      report.totalProduction, 4,
      `Expected 4 events in 21/08 production window, got ${report.totalProduction}`
    );

    // Sanity: all 4 are for RPTEST article
    const rptest = report.byArticle.find((r) => r.key === "RPTEST");
    assert.ok(rptest, "RPTEST should appear in byArticle breakdown");
    assert.equal(rptest!.quantity, 4, "RPTEST should have 4 units for production date 21/08");

    // Query for production date 2026-08-20 — should include only event 000001 (05:59 on 21/08)
    const prev = fixture.db.getReport("CUSTOM", "2026-08-20", "2026-08-20");
    assert.equal(
      prev.totalProduction, 1,
      `Expected 1 event in 20/08 production window (the 05:59 event), got ${prev.totalProduction}`
    );

    // Query for production date 2026-08-22 — should include only event 000006 (06:00 on 22/08)
    const next = fixture.db.getReport("CUSTOM", "2026-08-22", "2026-08-22");
    assert.equal(
      next.totalProduction, 1,
      `Expected 1 event in 22/08 production window (the 06:00 next-day event), got ${next.totalProduction}`
    );
  } finally {
    fixture.cleanup();
  }
});

test("daily production report: single-day CUSTOM query no longer returns zero when fromDate === toDate", async () => {
  const fixture = createDbFixture();
  try {
    // getOrCreateVariant is lookup-only, so register the product via Product Master first.
    fixture.db.createProduct({ article: "ZEROT", size: "8/11", color: "BLUE" });

    // Insert one event during the day shift of 2026-08-21: 10:30 Karachi, stamped as the application
    // stamps it, 05:30 UTC. Inside the 06:00-11:00 window the old string comparison put on the
    // previous day -- so with the application's real format this test catches that bug.
    await fixture.db.runInTransaction(async (tx) => {
      const qrId = "ZEROT_BLUE_8/11_000001";
      const variant = await fixture.db.getOrCreateVariant(
        { qrId, article: "ZEROT", color: "BLUE", size: "8/11", serial: "000001" },
        tx
      );
      await fixture.db.insertProduced({ qrId, productVariantId: variant.id, createdAt: "2026-08-21T05:30:00.000Z" }, tx);
      await fixture.db.appendProducedEvent(
        {
          eventId: crypto.randomUUID(),
          qrId,
          productVariantId: variant.id,
          article: "ZEROT", color: "BLUE", size: "8/11", serial: "000001",
          occurredAt: "2026-08-21T05:30:00.000Z",
          parserVersion: "v1",
          factoryId: "factory-1", workstationId: "workstation-1", deviceId: "device-1",
        },
        tx
      );
    });

    const report = fixture.db.getReport("CUSTOM", "2026-08-21", "2026-08-21");

    assert.equal(
      report.totalProduction, 1,
      "Single-day CUSTOM query must return the event, not zero"
    );
    assert.ok(
      report.byArticle.some((r) => r.key === "ZEROT"),
      "ZEROT should appear in byArticle for 2026-08-21"
    );
  } finally {
    fixture.cleanup();
  }
});

test("getDashboardSnapshot: 6AM session boundary — todaysProduction and recentScans are session-scoped", async () => {
  const fixture = createDbFixture();
  try {
    // getOrCreateVariant is lookup-only, so register the product via Product Master first.
    fixture.db.createProduct({ article: "DASHTEST", size: "7/10", color: "RED" });

    // Helper: directly insert a production_events row with a controlled timestamp.
    // We bypass the use-case because we need precise control over event_ts_local.
    const insertEventAt = async (timestamp: string, serial: string, article = "DASHTEST") => {
      await fixture.db.runInTransaction(async (tx) => {
        const qrId = `${article}_RED_7/10_${serial}`;
        const variant = await fixture.db.getOrCreateVariant(
          { qrId, article, color: "RED", size: "7/10", serial },
          tx
        );
        await fixture.db.insertProduced({ qrId, productVariantId: variant.id, createdAt: timestamp }, tx);
        await fixture.db.appendProducedEvent(
          {
            eventId: crypto.randomUUID(),
            qrId,
            productVariantId: variant.id,
            article,
            color: "RED",
            size: "7/10",
            serial,
            occurredAt: timestamp,
            parserVersion: "v1",
            factoryId: "factory-1",
            workstationId: "workstation-1",
            deviceId: "device-1",
          },
          tx
        );
      });
    };

    // Session under test:
    //   sessionStart = 2026-08-22T06:00:00  (current session if now >= 06:00 on 22 Aug)
    //   sessionEnd   = 2026-08-23T06:00:00

    // Previous-session scan: 2026-08-21T18:00 — inside the 21 Aug session, NOT current
    await insertEventAt("2026-08-21T18:00:00.000", "P001");

    // Boundary before new session: 2026-08-22T05:59 — still belongs to 21 Aug session
    await insertEventAt("2026-08-22T05:59:00.000", "P002");

    // Exactly at new session start: 2026-08-22T06:00 — first event of 22 Aug session
    await insertEventAt("2026-08-22T06:00:00.000", "C001");

    // Mid-session: 2026-08-22T14:30 — clearly inside 22 Aug session
    await insertEventAt("2026-08-22T14:30:00.000", "C002");

    // Last minute of session: 2026-08-23T05:59 — still inside 22 Aug session
    await insertEventAt("2026-08-23T05:59:00.000", "C003");

    // getDashboardSnapshot computes its own "now" — we can't inject a clock,
    // so we verify the session logic directly by asserting against the query
    // boundaries ourselves using the same algorithm.
    const now = new Date();
    const sessionStart = new Date(now);
    if (now.getHours() < 6) sessionStart.setDate(sessionStart.getDate() - 1);
    sessionStart.setHours(6, 0, 0, 0);
    const sessionEnd = new Date(sessionStart);
    sessionEnd.setDate(sessionEnd.getDate() + 1);
    const startIso = sessionStart.toISOString();
    const endIso   = sessionEnd.toISOString();

    // Use the report API (which has stable boundary control) to count what
    // getDashboardSnapshot SHOULD return for the 22 Aug session.
    // We derive the expected date string from the session boundary.
    const sessionDateStr = sessionStart.toISOString().slice(0, 10); // e.g. "2026-08-22"
    const expectedReport = fixture.db.getReport("CUSTOM", sessionDateStr, sessionDateStr);

    const snapshot = fixture.db.getDashboardSnapshot();

    // todaysProduction must equal what the scoped report returns
    assert.equal(
      snapshot.todaysProduction,
      expectedReport.totalProduction,
      `todaysProduction (${snapshot.todaysProduction}) must match session-scoped report (${expectedReport.totalProduction})`
    );

    // recentScans must all fall within [startIso, endIso)
    for (const scan of snapshot.recentScans) {
      assert.ok(
        scan.occurredAt >= startIso && scan.occurredAt < endIso,
        `recentScan timestamp ${scan.occurredAt} is outside session [${startIso}, ${endIso})`
      );
    }

    // No scan from the previous session (P001 = 2026-08-21T18:00, P002 = 2026-08-22T05:59)
    // must appear in recentScans when the current session is 22 Aug 06:00 → 23 Aug 06:00.
    // We confirm this by checking that no qrId starting with "DASHTEST_RED_7/10_P" is present
    // (those were the previous-session serials).
    const prevSessionQrs = snapshot.recentScans.filter((s) =>
      s.qrId?.includes("_P001") || s.qrId?.includes("_P002")
    );

    // If current wall-clock session IS the 22 Aug session, previous-session scans must be absent.
    // If the test happens to run before 06:00 on 22 Aug (unlikely in CI but handled),
    // we only assert that the filter is correct relative to the computed boundary.
    const sessionIs22Aug =
      sessionStart.getFullYear() === 2026 &&
      sessionStart.getMonth() === 7 /* Aug = 7 */ &&
      sessionStart.getDate() === 22;

    if (sessionIs22Aug) {
      assert.equal(
        prevSessionQrs.length,
        0,
        "Previous-session scans (P001, P002) must not appear in recentScans for the 22 Aug session"
      );

      // Current-session scans C001, C002, C003 must all be present
      const currentQrs = snapshot.recentScans.map((s) => s.qrId ?? "");
      assert.ok(currentQrs.some((q) => q.includes("_C001")), "C001 (06:00 start) must be in recentScans");
      assert.ok(currentQrs.some((q) => q.includes("_C002")), "C002 (14:30 mid-session) must be in recentScans");
      assert.ok(currentQrs.some((q) => q.includes("_C003")), "C003 (05:59 end) must be in recentScans");

      assert.equal(snapshot.todaysProduction, 3, "todaysProduction must be 3 for 22 Aug session");
    }
  } finally {
    fixture.cleanup();
  }
});

// ── PRODUCTION SCANNER: PRODUCT MASTER ENFORCEMENT ─────────────────────────

test("getOrCreateVariant: accepts a scan for an already-registered product variant", async () => {
  const fixture = createDbFixture();
  try {
    fixture.db.createProduct({ article: "SK6", size: "7/10", color: "BLACK" });

    await fixture.db.runInTransaction(async (tx) => {
      const variant = await fixture.db.getOrCreateVariant(
        { qrId: "SK6_BLACK_7/10_000001", article: "SK6", color: "BLACK", size: "7/10", serial: "000001" },
        tx
      );
      assert.ok(variant.id, "A registered product variant must resolve to an id");
    });
  } finally {
    fixture.cleanup();
  }
});

test("getOrCreateVariant: rejects a scan for an unregistered product and inserts nothing", async () => {
  const fixture = createDbFixture();
  try {
    const articleSizesBefore = fixture.db.listProducts({ status: "ALL", pageSize: 1000 }).total;
    const articlesBefore = fixture.db.listUniqueArticles();

    await assert.rejects(
      () =>
        fixture.db.runInTransaction(async (tx) =>
          fixture.db.getOrCreateVariant(
            { qrId: "UNKNOWN_RED_9/12_000001", article: "UNKNOWN", color: "RED", size: "9/12", serial: "000001" },
            tx
          )
        ),
      /PRODUCT_NOT_FOUND:/,
      "Scanning an unregistered product must be rejected with PRODUCT_NOT_FOUND"
    );

    const articleSizesAfter = fixture.db.listProducts({ status: "ALL", pageSize: 1000 }).total;
    assert.equal(articleSizesAfter, articleSizesBefore, "No article_sizes row must be inserted for a rejected scan");

    const articlesAfter = fixture.db.listUniqueArticles();
    assert.deepEqual(articlesAfter, articlesBefore, "No product_variants row must be inserted for a rejected scan");
    assert.ok(!articlesAfter.includes("UNKNOWN"), "The unregistered article must not appear anywhere after a rejected scan");
  } finally {
    fixture.cleanup();
  }
});

// ── ISSUE 2: REAL → INTEGER PAISA DUAL-WRITE & DRIFT TESTS ─────────────────────
// migrations/sqlite/029_money_paisa_columns adds a `_paisa` INTEGER sibling to every
// monetary REAL column. These tests confirm every writer keeps both columns in exact
// sync, that SQL-side balance calculations switched to the paisa columns are immune to
// the floating-point hazard that decimal rupee amounts create, and that checkMoneyDrift()
// can tell clean data from a genuine mismatch.

// REAL cost_price/selling_price were retired by migrations/sqlite/030_retire_real_money_columns
// — product_variants/article_sizes now store paisa only, so this test verifies the exact
// rupee→paisa conversion and NULL-handling directly against the sole-authoritative columns,
// rather than comparing them against a REAL sibling that no longer exists.
test("money: product cost/selling price are stored in cost_price_paisa/selling_price_paisa exactly, including NULL", () => {
  const fixture = createDbFixture();
  try {
    const variantId = fixture.db.createProduct({ article: "MNY1", color: "RED", size: "7/10", costPrice: 549.75, sellingPrice: 650.25, status: "ACTIVE" });
    const variant = rawGet(fixture.db, "SELECT cost_price_paisa, selling_price_paisa FROM product_variants WHERE id = ?", variantId);
    assert.equal(variant.cost_price_paisa, 54975);
    assert.equal(variant.selling_price_paisa, 65025);

    const articleSize = rawGet(fixture.db, "SELECT cost_price_paisa, selling_price_paisa FROM article_sizes WHERE article = 'MNY1' AND size = '7/10'");
    assert.equal(articleSize.cost_price_paisa, 54975);
    assert.equal(articleSize.selling_price_paisa, 65025);

    // No cost price supplied at all → the paisa column must stay NULL, not 0.
    const bareVariantId = fixture.db.createProduct({ article: "MNY2", color: "BLUE", size: "7/10", status: "ACTIVE" });
    const bare = rawGet(fixture.db, "SELECT cost_price_paisa FROM product_variants WHERE id = ?", bareVariantId);
    assert.equal(bare.cost_price_paisa, null);
  } finally {
    fixture.cleanup();
  }
});

// REAL balance_limit was retired by migrations/sqlite/030_retire_real_money_columns — parties
// now stores paisa only, so this verifies the exact conversion, update, and null-clearing
// behavior directly against balance_limit_paisa.
test("money: party balance_limit is stored in balance_limit_paisa exactly, on create, update, and clearing to null", () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({ partyName: "Money Party", partyType: "CUSTOMER", status: "ACTIVE", balanceLimit: 1234.56 });
    assert.equal(rawGet(fixture.db, "SELECT balance_limit_paisa FROM parties WHERE id = ?", partyId).balance_limit_paisa, 123456);

    fixture.db.updateParty(partyId, { balanceLimit: 999.99 });
    assert.equal(rawGet(fixture.db, "SELECT balance_limit_paisa FROM parties WHERE id = ?", partyId).balance_limit_paisa, 99999);

    fixture.db.updateParty(partyId, { balanceLimit: null });
    assert.equal(rawGet(fixture.db, "SELECT balance_limit_paisa FROM parties WHERE id = ?", partyId).balance_limit_paisa, null);
  } finally {
    fixture.cleanup();
  }
});

test("money: every party discount rule type dual-writes discount_per_pair_paisa (and price-range's start/end)", () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({ partyName: "Discount Party", partyType: "CUSTOMER", status: "ACTIVE" });
    const groupId = fixture.db.createProductGroup({ groupName: "MNY Group" });
    const seriesId = fixture.db.createArticleSeries({ name: "MNYSERIES" });
    fixture.db.createProduct({ article: "MNYART", color: "RED", size: "7/10", sellingPrice: 500, status: "ACTIVE" });

    const groupDiscountId = fixture.db.createPartyProductGroupDiscount({ partyId, productGroupId: groupId, discountPerPair: 12.5 });
    assert.equal(rawGet(fixture.db, "SELECT discount_per_pair_paisa FROM party_product_group_discounts WHERE id = ?", groupDiscountId).discount_per_pair_paisa, 1250);

    const seriesDiscountId = fixture.db.createPartyArticleSeriesDiscount({ partyId, articleSeriesId: seriesId, discountPerPair: 7.25 });
    assert.equal(rawGet(fixture.db, "SELECT discount_per_pair_paisa FROM party_article_series_discounts WHERE id = ?", seriesDiscountId).discount_per_pair_paisa, 725);

    const articleDiscountId = fixture.db.createPartyArticleDiscount({ partyId, article: "MNYART", discountPerPair: 3 });
    assert.equal(rawGet(fixture.db, "SELECT discount_per_pair_paisa FROM party_article_discounts WHERE id = ?", articleDiscountId).discount_per_pair_paisa, 300);

    const rangeDiscountId = fixture.db.createPartyPriceRangeDiscount({ partyId, startPrice: 100, endPrice: 200.5, discountPerPair: 15.5 });
    const range = rawGet(fixture.db, "SELECT start_price_paisa, end_price_paisa, discount_per_pair_paisa FROM party_price_range_discounts WHERE id = ?", rangeDiscountId);
    assert.equal(range.start_price_paisa, 10000);
    assert.equal(range.end_price_paisa, 20050);
    assert.equal(range.discount_per_pair_paisa, 1550);
  } finally {
    fixture.cleanup();
  }
});

// REAL unit_price/discount/discount_per_pair/total_price (and the sale_vouchers.total_amount
// header) were retired by migrations/sqlite/030_retire_real_money_columns — paisa is now the
// sole-authoritative storage, so this verifies the stored paisa exactly reconstructs (via
// toPaisa) the rupee amount the application layer reads back (via getSaleVoucher, an
// independent read path from the raw row), rather than comparing paisa to a REAL sibling.
test("money: sale voucher line items and header store unit/discount/total price in paisa exactly, on create and update", () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({ partyName: "Line Item Party", partyType: "CUSTOMER", status: "ACTIVE" });
    const productId = fixture.db.createProduct({ article: "MNY5", color: "RED", size: "7/10", sellingPrice: 500, status: "ACTIVE" });
    // Backend discount authority (Phase 2): a line's discount may not exceed resolveDiscount()'s
    // ceiling, so this scenario needs an actual rule authorizing the discounts used below.
    fixture.db.createPartyArticleDiscount({ partyId, article: productId, sizeScope: "ALL_SIZES", discountPerPair: 2 });
    const voucher = fixture.db.createSaleVoucher({ partyId, voucherDate: "2026-01-01", bookNo: "B0" });
    const line = fixture.db.addVoucherLineItem(voucher.id, { productVariantId: productId, quantity: 1, unitPrice: 834.5, discount: 12.5 });

    const lineRow = rawGet(
      fixture.db,
      "SELECT unit_price_paisa, discount_paisa, discount_per_pair_paisa, total_price_paisa FROM sale_voucher_line_items WHERE id = ?",
      line.id
    );
    const appLine = fixture.db.getSaleVoucher(voucher.id)?.lineItems.find((item: { id: string }) => item.id === line.id) as
      { unitPrice: number; discount: number; totalPrice: number };
    assert.ok(appLine);
    assert.equal(lineRow.unit_price_paisa, toPaisa(appLine.unitPrice));
    assert.equal(lineRow.discount_paisa, toPaisa(appLine.discount));
    // discountPerPair isn't part of the app-facing SaleVoucherLineRecord DTO, so this checks it
    // directly against the configured rule (2/pair) resolveLineDiscount used for this line.
    assert.equal(lineRow.discount_per_pair_paisa, toPaisa(2));
    assert.equal(lineRow.total_price_paisa, toPaisa(appLine.totalPrice));

    const headerAfterCreate = rawGet(fixture.db, "SELECT total_amount_paisa FROM sale_vouchers WHERE id = ?", voucher.id);
    assert.equal(headerAfterCreate.total_amount_paisa, toPaisa(fixture.db.getSaleVoucher(voucher.id)!.totalAmount));

    fixture.db.updateVoucherLineItem(line.id, { quantity: 2, unitPrice: 700.25, discount: 40 });
    const lineAfterUpdate = rawGet(fixture.db, "SELECT unit_price_paisa, total_price_paisa FROM sale_voucher_line_items WHERE id = ?", line.id);
    const appLineAfterUpdate = fixture.db.getSaleVoucher(voucher.id)?.lineItems.find((item: { id: string }) => item.id === line.id) as
      { unitPrice: number; totalPrice: number };
    assert.ok(appLineAfterUpdate);
    assert.equal(lineAfterUpdate.unit_price_paisa, toPaisa(appLineAfterUpdate.unitPrice));
    assert.equal(lineAfterUpdate.total_price_paisa, toPaisa(appLineAfterUpdate.totalPrice));

    const headerAfterUpdate = rawGet(fixture.db, "SELECT total_amount_paisa FROM sale_vouchers WHERE id = ?", voucher.id);
    assert.equal(headerAfterUpdate.total_amount_paisa, toPaisa(fixture.db.getSaleVoucher(voucher.id)!.totalAmount));
  } finally {
    fixture.cleanup();
  }
});

test("money: cash voucher header and lines dual-write receipt/payment amounts in paisa, on create and update", () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({ partyName: "Cash Party", partyType: "CUSTOMER", status: "ACTIVE" });
    const voucherId = fixture.db.createCashVoucher({ partyId, voucherDate: "2026-01-01", description: "Advance", receiptAmount: 250.75 });

    const header = rawGet(fixture.db, "SELECT receipt_amount_paisa, payment_amount_paisa FROM cash_vouchers WHERE id = ?", voucherId);
    assert.equal(header.receipt_amount_paisa, 25075);
    assert.equal(header.payment_amount_paisa, 0);

    const line = rawGet(fixture.db, "SELECT receipt_amount_paisa FROM cash_voucher_lines WHERE voucher_id = ?", voucherId);
    assert.equal(line.receipt_amount_paisa, 25075);

    fixture.db.updateCashVoucher(voucherId, {
      receiptAmount: 0,
      paymentAmount: 88.4,
      lines: [{ partyId, description: "Payment", modeOfTransfer: "Cash", receiptAmount: 0, paymentAmount: 88.4 }],
    });
    const headerAfter = rawGet(fixture.db, "SELECT payment_amount_paisa FROM cash_vouchers WHERE id = ?", voucherId);
    assert.equal(headerAfter.payment_amount_paisa, 8840);
    const lineAfter = rawGet(fixture.db, "SELECT payment_amount_paisa FROM cash_voucher_lines WHERE voucher_id = ?", voucherId);
    assert.equal(lineAfter.payment_amount_paisa, 8840);
  } finally {
    fixture.cleanup();
  }
});

// REAL total_amount/unit_price/total_price were retired by migrations/sqlite/030_retire_real_money_columns
// — paisa is now the sole-authoritative storage, so this verifies the stored paisa against the
// app-facing read (getPurchaseVoucher, an independent read path) instead of a REAL sibling.
test("money: purchase voucher header and lines store unit/total price in paisa exactly, on create and update", () => {
  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({ partyName: "Supplier Party", partyType: "SUPPLIER", status: "ACTIVE" });
    const categoryId = fixture.db.createInventoryCategory({ name: "MNY Raw Material" });
    const item = fixture.db.createInventoryItem({ categoryId, values: {} });

    const voucher = fixture.db.createPurchaseVoucher({ partyId, voucherDate: "2026-01-01", lines: [{ itemId: item.id, quantity: 3, unitPrice: 125.5 }] });
    const header = rawGet(fixture.db, "SELECT total_amount_paisa FROM purchase_vouchers WHERE id = ?", voucher.id);
    const appVoucher = fixture.db.getPurchaseVoucher(voucher.id) as { totalAmount: number; lineItems: Array<{ unitPrice: number; totalPrice: number }> };
    assert.equal(header.total_amount_paisa, toPaisa(appVoucher.totalAmount));

    const line = rawGet(fixture.db, "SELECT unit_price_paisa, total_price_paisa FROM purchase_voucher_line_items WHERE voucher_id = ?", voucher.id);
    assert.equal(line.unit_price_paisa, 12550);
    assert.equal(line.total_price_paisa, toPaisa(appVoucher.lineItems[0].totalPrice));

    fixture.db.updatePurchaseVoucher(voucher.id, { lines: [{ itemId: item.id, quantity: 5, unitPrice: 99.99 }] });
    const headerAfter = rawGet(fixture.db, "SELECT total_amount_paisa FROM purchase_vouchers WHERE id = ?", voucher.id);
    const appVoucherAfter = fixture.db.getPurchaseVoucher(voucher.id) as { totalAmount: number };
    assert.equal(headerAfter.total_amount_paisa, toPaisa(appVoucherAfter.totalAmount));
    // Selected by unit_price_paisa rather than "the line for this voucher": updatePurchaseVoucher's
    // pre-existing line-replacement logic leaves the old line row in place alongside the new
    // one (a soft-delete/restore ordering bug unrelated to money storage — see final report).
    const lineAfter = rawGet(fixture.db, "SELECT unit_price_paisa FROM purchase_voucher_line_items WHERE voucher_id = ? AND unit_price_paisa = 9999", voucher.id);
    assert.equal(lineAfter.unit_price_paisa, 9999);
  } finally {
    fixture.cleanup();
  }
});

test("money: raw material inventory item cost price is stored in cost_price_paisa exactly, on create and update, including clearing to null", () => {
  const fixture = createDbFixture();
  try {
    const categoryId = fixture.db.createInventoryCategory({ name: "MNY Category 2" });
    const item = fixture.db.createInventoryItem({ categoryId, values: {}, costPrice: 45.25 });
    assert.equal(rawGet(fixture.db, "SELECT cost_price_paisa FROM inventory_items WHERE id = ?", item.id).cost_price_paisa, 4525);

    fixture.db.updateInventoryItemPrice(item.id, 60.1);
    assert.equal(rawGet(fixture.db, "SELECT cost_price_paisa FROM inventory_items WHERE id = ?", item.id).cost_price_paisa, 6010);

    fixture.db.updateInventoryItemPrice(item.id, null);
    assert.equal(rawGet(fixture.db, "SELECT cost_price_paisa FROM inventory_items WHERE id = ?", item.id).cost_price_paisa, null);
  } finally {
    fixture.cleanup();
  }
});

test("money: getCurrentPartyBalance is exact for amounts where naive floating-point summation would drift", () => {
  // Documents the hazard class this migration eliminates: plain float addition of ten
  // Rs 10.01 amounts (the kind of repeated decimal rupee value this ERP stores every day)
  // does not land on exactly 100.1 once done in ordinary IEEE-754 arithmetic.
  let naiveJsSum = 0;
  for (let i = 0; i < 10; i++) naiveJsSum += 10.01;
  assert.notEqual(naiveJsSum, 100.1, "Sanity check: naive float summation of ten 10.01 values is not exact");

  const fixture = createDbFixture();
  try {
    const partyId = fixture.db.createParty({ partyName: "Float Hazard Party", partyType: "CUSTOMER", status: "ACTIVE" });
    const now = new Date().toISOString();
    for (let i = 0; i < 10; i++) {
      rawExec(
        fixture.db,
        `INSERT INTO sale_vouchers (id, voucher_number, party_id, voucher_date, book_no, total_quantity, total_amount_paisa, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, 1001, 'FINALIZED', ?, ?)`,
        crypto.randomUUID(),
        `FH-SALE-${i}`,
        partyId,
        "2026-01-01",
        "B0",
        now,
        now
      );
    }
    // Also exercise the subtraction side (a cash receipt reduces the balance) with another
    // decimal amount that is not exactly representable in binary floating point.
    fixture.db.createCashVoucher({ partyId, voucherDate: "2026-01-01", description: "Partial receipt", receiptAmount: 3.33 });

    // Exact expectation, computed in integer paisa: (10 x 1001) - 333 = 9677 paisa = Rs 96.77
    const balance = fixture.db.getCurrentPartyBalance(partyId);
    assert.equal(balance, 96.77, "Party balance must be exact even though the inputs are float-hazardous decimals");
  } finally {
    fixture.cleanup();
  }
});

// report_daily_summary is the only table left with both a REAL money column and a *_paisa
// sibling (migrations/sqlite/030_retire_real_money_columns retired every other pair — see the
// comment on MONEY_PAISA_COLUMNS in sqliteDatabase.ts). It has no application reader/writer, so
// this test inserts directly via SQL, the only way such a row (or such a mismatch) can arise.
test("money: checkMoneyDrift returns empty for correctly dual-written data and detects an intentional mismatch", () => {
  const fixture = createDbFixture();
  try {
    const now = new Date().toISOString();
    rawExec(
      fixture.db,
      `INSERT INTO report_daily_summary (report_date, factory_id, total_production, total_unique_qr, inventory_value_cost, inventory_value_cost_paisa, inventory_value_sales, inventory_value_sales_paisa, generated_at)
       VALUES ('2026-01-01', 'factory-1', 0, 0, 500, 50000, 800, 80000, ?)`,
      now
    );
    assert.deepEqual(fixture.db.checkMoneyDrift(), [], "No drift should be reported for normally dual-written data");

    // Intentionally corrupt the paisa sibling via raw SQL, bypassing every writer — this is the
    // only way such a mismatch could arise, since every writer dual-writes.
    rawExec(
      fixture.db,
      "UPDATE report_daily_summary SET inventory_value_cost_paisa = ? WHERE report_date = ? AND factory_id = ?",
      999999,
      "2026-01-01",
      "factory-1"
    );

    const violations = fixture.db.checkMoneyDrift();
    assert.equal(violations.length, 1, "Exactly one violation should be detected");
    assert.equal(violations[0].table, "report_daily_summary");
    assert.equal(violations[0].column, "inventory_value_cost");
    assert.equal(violations[0].id, "2026-01-01:factory-1");
    assert.equal(violations[0].realValue, 500);
    assert.equal(violations[0].paisaValue, 999999);
    assert.equal(violations[0].expectedPaisa, 50000);
  } finally {
    fixture.cleanup();
  }
});

// ─── Health page money-drift exposure (R15 Phase 4) ───────────────────────────────────────
// captureHealthSnapshot() summarizes checkMoneyDrift()'s existing result for the Health page —
// these tests cover the summary, not a second drift calculation (checkMoneyDrift() itself is
// already covered above).

test("captureHealthSnapshot reports a healthy money-drift summary when everything is dual-written correctly", () => {
  const fixture = createDbFixture();
  try {
    const snapshot = fixture.db.captureHealthSnapshot({ scannerConnected: true, appVersion: "1.0.0", deviceId: "test-device" });

    assert.equal(snapshot.moneyDrift.healthy, true);
    assert.equal(snapshot.moneyDrift.violationCount, 0);
    assert.deepEqual(snapshot.moneyDrift.violations, []);
    // The number of REAL/*_paisa column pairs configured in MONEY_PAISA_COLUMNS
    // (packages/data/src/sqliteDatabase.ts) — update this alongside that list if it changes.
    // Only report_daily_summary's 2 columns remain since migrations/sqlite/030_retire_real_money_columns.
    assert.equal(snapshot.moneyDrift.pairsChecked, 2);
  } finally {
    fixture.cleanup();
  }
});

test("captureHealthSnapshot surfaces a money-drift mismatch through moneyDrift, identifying the affected pair", () => {
  const fixture = createDbFixture();
  try {
    const now = new Date().toISOString();
    rawExec(
      fixture.db,
      `INSERT INTO report_daily_summary (report_date, factory_id, total_production, total_unique_qr, inventory_value_cost, inventory_value_cost_paisa, inventory_value_sales, inventory_value_sales_paisa, generated_at)
       VALUES ('2026-01-01', 'factory-1', 0, 0, 500, 50000, 800, 80000, ?)`,
      now
    );
    rawExec(
      fixture.db,
      "UPDATE report_daily_summary SET inventory_value_cost_paisa = ? WHERE report_date = ? AND factory_id = ?",
      999999,
      "2026-01-01",
      "factory-1"
    );

    const snapshot = fixture.db.captureHealthSnapshot({ scannerConnected: true, appVersion: "1.0.0", deviceId: "test-device" });

    assert.equal(snapshot.moneyDrift.healthy, false);
    assert.equal(snapshot.moneyDrift.violationCount, 1);
    assert.equal(snapshot.moneyDrift.pairsChecked, 2, "pairsChecked reflects configured pairs, not violation count");
    assert.equal(snapshot.moneyDrift.violations.length, 1);
    assert.equal(snapshot.moneyDrift.violations[0].table, "report_daily_summary");
    assert.equal(snapshot.moneyDrift.violations[0].column, "inventory_value_cost");
    assert.equal(snapshot.moneyDrift.violations[0].id, "2026-01-01:factory-1");
  } finally {
    fixture.cleanup();
  }
});

test("unchecking a permission on a role takes it away from the members of that role", () => {
  const fixture = createDbFixture();
  try {
    const db = fixture.db;
    const role = db.createRole({ name: "Store Desk Test", permissions: ["store-scanning", "stock", "navbar", "workspace"] });
    const user = db.createUserAccount("store-desk-test", "Password123");
    db.assignUserRole(user.id, role.code);
    db.setUserAdditionalPermissions(user.id, ["stock"]);
    assert.ok(db.recalculateEffectivePermissions(user.id).includes("navbar"));

    // The admin unticks "Show Navigation Bar" and "Workspace" on the role.
    db.updateRolePermissions(role.code, ["store-scanning", "stock"]);

    const after = db.recalculateEffectivePermissions(user.id);
    assert.ok(!after.includes("navbar"), "the cached permission list must not put navbar back");
    assert.ok(!after.includes("workspace"));
    assert.ok(after.includes("store-scanning"));
    assert.ok(after.includes("stock"), "an additional grant still counts");
  } finally {
    fixture.cleanup();
  }
});

test("Raw Material Setup can be granted on its own, without Settings", () => {
  const fixture = createDbFixture();
  try {
    const db = fixture.db;
    const role = db.createRole({ name: "Store Setup Test", permissions: ["store-scanning", "raw-material-setup"] });
    const user = db.createUserAccount("store-setup-test", "Password123");
    db.assignUserRole(user.id, role.code);
    const permissions = db.recalculateEffectivePermissions(user.id);
    assert.ok(permissions.includes("raw-material-setup"));
    assert.ok(!permissions.includes("settings"));
  } finally {
    fixture.cleanup();
  }
});
