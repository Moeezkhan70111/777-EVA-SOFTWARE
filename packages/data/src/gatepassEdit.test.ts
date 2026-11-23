import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AddMachineUseCase,
  CancelGatepassUseCase,
  CreateGatepassUseCase,
  DeleteGatepassUseCase,
  EditGatepassUseCase,
  InMemoryEventBus,
  ProcessScanUseCase,
  StoreEntryScanUseCase,
  StoreExitScanUseCase,
  type EditGatepassInput,
} from "@erp/application";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

// EDITING A GATEPASS AND DELETING A CANCELLED ONE (owner, 23 Nov 2026, local migration 118), against the real database,
// the real stock movements and the real bill. An edit keeps the number, keeps what it was, puts back exactly what the
// old lines took and takes exactly what the new ones need; a billed gatepass's bill follows; a deleted gatepass leaves
// every list and is kept.

type Raw = import("node:sqlite").DatabaseSync;
const FACTORY = "factory-777";
const CONTEXT = { factoryId: FACTORY, workstationId: "ws-01", deviceId: "desktop-main" };
const ids = () => new UuidGenerator();

function openDb(dbPath: string) {
  const db = new SqliteDatabase({ dbPath, schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(1, "test");
  db.ensureOperationalContext({
    factoryId: FACTORY, factoryCode: "777", factoryName: "777", workstationId: "ws-01", workstationCode: "WS-01",
    workstationName: "WS", deviceId: "desktop-main", deviceName: "Desktop", appVersion: "1.0.0",
  });
  return db;
}

const scanDeps = (db: SqliteDatabase) => ({
  txManager: db, qrLookupRepo: db, gatepassRepo: db, qrRegistry: db, qrMasterRepo: db, stockProjectionRepo: db, outboxRepo: db,
  eventPublisher: new InMemoryEventBus(), idGenerator: ids(),
});

async function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-gatepass-edit-"));
  const db = openDb(path.join(tempDir, "edit.db"));
  const raw = (db as unknown as { db: Raw }).db;
  const contractor = (name: string, mobile: string) => db.createParty({ partyName: name, partyType: "CONTRACTOR", city: "Lahore", mobileNumber: mobile, status: "ACTIVE" });
  const machineId = (await new AddMachineUseCase({ txManager: db, repo: db, eventPublisher: new InMemoryEventBus(), idGenerator: ids() }).execute({
    name: "Machine 1", contractorPartyId: contractor("ASLAM", "0300-1111111"), packingContractorPartyId: contractor("BABAR", "0300-2222222"), actor: "admin",
  })).machineId!;
  const customer = db.createParty({ partyName: "MAMA CHAPPAL", partyType: "CUSTOMER", city: "Lahore", mobileNumber: "0300-3333333", status: "ACTIVE" });
  const other = db.createParty({ partyName: "BEHRAAM SHOES", partyType: "CUSTOMER", city: "Karachi", mobileNumber: "0300-4444444", status: "ACTIVE" });
  db.createProduct({ article: "SK46", size: "11/13", sellingPrice: 550, machineRate: 70, packingRate: 30, colors: ["BLACKGREY", "NAVY"], status: "ACTIVE" });
  db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 450, machineRate: 70, packingRate: 30, colors: ["RED"], status: "ACTIVE" });
  const articleSize = (article: string) => (raw.prepare("SELECT id FROM article_sizes WHERE article = ?").get(article) as { id: string }).id;
  const variant = (article: string, color: string) => (raw.prepare("SELECT id FROM product_variants WHERE article = ? AND color = ?").get(article, color) as { id: string }).id;
  return {
    db, raw, tempDir, machineId, customer, other,
    sk46: articleSize("SK46"), sk6: articleSize("SK6"),
    blackGrey: variant("SK46", "BLACKGREY"), navy: variant("SK46", "NAVY"), red: variant("SK6", "RED"),
  };
}
type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function withFixture(work: (f: Fixture) => Promise<void>): Promise<void> {
  const f = await createFixture();
  try {
    await work(f);
  } finally {
    f.db.close();
    fs.rmSync(f.tempDir, { recursive: true, force: true });
  }
}

/** Manual Production cartons (no QR): a gatepass issues them at once. */
const stockManual = (f: Fixture, articleSizeId: string, color: string, cartons: number) =>
  f.db.recordManualProduction({ requestId: crypto.randomUUID(), machineId: f.machineId, articleSizeId, color, dozens: String(cartons / 2), storeLocationId: FACTORY, createdBy: "admin" });

/** QR cartons through the real production scan and Store In. */
async function stockQr(f: Fixture, articleSizeId: string, color: string, quantity: number): Promise<string[]> {
  const qrIds = f.db.generateQrBatch({ articleSizeId, color, quantity, createdBy: "admin" }).qrCodes.map((b) => b.id);
  for (const id of qrIds) {
    assert.equal((await new ProcessScanUseCase({ ...scanDeps(f.db), duplicateChecker: f.db, productCatalog: f.db, productionEventsRepo: f.db }).execute({ rawScan: id, context: CONTEXT })).accepted, true);
    assert.equal((await new StoreEntryScanUseCase({ ...scanDeps(f.db), storeEntryEventsRepo: f.db }).execute({ rawScan: id, context: CONTEXT })).outcome, "RECEIVED");
  }
  return qrIds;
}

async function makeGatepass(f: Fixture, lines: Array<[string, number]>, partyId = f.customer) {
  const made = await new CreateGatepassUseCase({ txManager: f.db, repo: f.db, idGenerator: ids() }).execute({
    partyId, lines: lines.map(([productVariantId, quantity]) => ({ productVariantId, quantity })), actor: "clerk",
  });
  assert.equal(made.accepted, true, made.reason);
  return made;
}

const edit = (f: Fixture, input: Partial<Omit<EditGatepassInput, "lines">> & { gatepassId: string; lines: Array<[string, number]> }) =>
  new EditGatepassUseCase({ txManager: f.db, repo: f.db, idGenerator: ids() }).execute({
    revisionNo: 1, partyId: f.customer, reason: "typed cartons, meant dozens", actor: "owner", ...input,
    lines: input.lines.map(([productVariantId, quantity]) => ({ productVariantId, quantity })),
  });
const cancel = (f: Fixture, gatepassId: string) => new CancelGatepassUseCase({ txManager: f.db, repo: f.db, idGenerator: ids() }).execute({ gatepassId, reason: "wrong party", actor: "owner" });
const remove = (f: Fixture, gatepassId: string, reason = "made in error") =>
  new DeleteGatepassUseCase({ txManager: f.db, repo: f.db, idGenerator: ids() }).execute({ gatepassId, reason, actor: "owner" });

/** In Store / Reserved for one colour, as the Gatepass screen reads them. */
function inStore(f: Fixture, article: string, color: string) {
  const row = f.db.listStoreStockByArticle(article).find((r) => r.color === color);
  return { current: row?.storeQuantity ?? 0, reserved: row?.reservedQuantity ?? 0 };
}
const movements = (f: Fixture, gatepassId: string) =>
  (f.raw.prepare("SELECT event_type, quantity FROM carton_stock_events WHERE gatepass_id = ? ORDER BY rowid").all(gatepassId) as Array<Record<string, unknown>>)
    .map((row) => `${String(row.event_type)} ${String(row.quantity)}`);
const linesOf = (f: Fixture, gatepassId: string) => (f.db.getGatepass(gatepassId)?.lines ?? []).map((line) => [line.color, line.quantity, line.issuedDirectlyQuantity]);

test("an edit keeps the number, keeps what it was, puts back what the old lines took and takes what the new ones need", async () => {
  await withFixture(async (f) => {
    stockManual(f, f.sk46, "BLACKGREY", 20);
    // The owner's case: 5 typed, meaning dozens, but saved as 5 cartons. The edit makes it 10 cartons (5 dozen).
    const made = await makeGatepass(f, [[f.blackGrey, 5]]);
    assert.deepEqual(inStore(f, "SK46", "BLACKGREY"), { current: 15, reserved: 0 });

    const edited = await edit(f, { gatepassId: made.gatepassId!, lines: [[f.blackGrey, 10]] });
    assert.equal(edited.accepted, true, edited.reason);
    assert.deepEqual([edited.outcome, edited.code, edited.revisionNo, edited.totalQuantity], ["EDITED", made.code, 2, 10]);

    assert.deepEqual(inStore(f, "SK46", "BLACKGREY"), { current: 10, reserved: 0 }, "20 made, 10 on the gatepass");
    assert.deepEqual(movements(f, made.gatepassId!), ["GATEPASS_ISSUE 5", "GATEPASS_CANCEL 5", "GATEPASS_ISSUE 10"]);
    assert.deepEqual(linesOf(f, made.gatepassId!), [["BLACKGREY", 10, 10]]);

    const after = f.db.getGatepass(made.gatepassId!)!;
    assert.deepEqual([after.gatepassNumber, after.revisionNo, after.editedBy, after.totalQuantity], [made.gatepassNumber, 2, "owner", 10]);
    assert.equal(after.versions.length, 1);
    assert.deepEqual(
      { versionNo: after.versions[0].versionNo, totalQuantity: after.versions[0].totalQuantity, reason: after.versions[0].reason, by: after.versions[0].replacedBy },
      { versionNo: 1, totalQuantity: 5, reason: "typed cartons, meant dozens", by: "owner" }
    );
    assert.deepEqual(after.versions[0].lines.map((line) => [line.color, line.quantity]), [["BLACKGREY", 5]]);
    const audit = f.raw.prepare("SELECT COUNT(1) AS n FROM audit_log WHERE event_type = 'GATEPASS_EDITED' AND entity_id = ?").get(made.gatepassId!) as { n: number };
    assert.equal(audit.n, 1);
  });
});

test("an edit may take a colour off and put one on, and a second edit is a third revision", async () => {
  await withFixture(async (f) => {
    stockManual(f, f.sk46, "BLACKGREY", 20);
    stockManual(f, f.sk46, "NAVY", 20);
    const made = await makeGatepass(f, [[f.blackGrey, 6]]);

    assert.equal((await edit(f, { gatepassId: made.gatepassId!, lines: [[f.navy, 4]] })).accepted, true);
    assert.deepEqual(linesOf(f, made.gatepassId!), [["NAVY", 4, 4]]);
    assert.deepEqual([inStore(f, "SK46", "BLACKGREY").current, inStore(f, "SK46", "NAVY").current], [20, 16], "BLACKGREY back in full");

    const second = await edit(f, { gatepassId: made.gatepassId!, revisionNo: 2, lines: [[f.navy, 2], [f.blackGrey, 2]] });
    assert.equal(second.accepted, true, second.reason);
    assert.equal(second.revisionNo, 3);
    assert.deepEqual([inStore(f, "SK46", "BLACKGREY").current, inStore(f, "SK46", "NAVY").current], [18, 18]);
    assert.deepEqual(f.db.getGatepass(made.gatepassId!)!.versions.map((v) => v.versionNo), [1, 2]);
  });
});

test("an edit is refused when it was changed since it was opened, and nothing moves", async () => {
  await withFixture(async (f) => {
    stockManual(f, f.sk46, "BLACKGREY", 20);
    const made = await makeGatepass(f, [[f.blackGrey, 5]]);
    assert.equal((await edit(f, { gatepassId: made.gatepassId!, lines: [[f.blackGrey, 10]] })).accepted, true);

    const stale = await edit(f, { gatepassId: made.gatepassId!, revisionNo: 1, lines: [[f.blackGrey, 2]] });
    assert.deepEqual([stale.accepted, stale.outcome], [false, "EDITED_ELSEWHERE"]);
    assert.deepEqual(linesOf(f, made.gatepassId!), [["BLACKGREY", 10, 10]]);
    assert.equal(inStore(f, "SK46", "BLACKGREY").current, 10);
  });
});

test("an edit is refused once a carton has been scanned out of the store for it", async () => {
  await withFixture(async (f) => {
    const [first] = await stockQr(f, f.sk46, "BLACKGREY", 3);
    const made = await makeGatepass(f, [[f.blackGrey, 3]]);
    // Billed so Store Move Out may take it, then one carton scanned out.
    const bill = f.db.enterGatepassBill(made.billId!, { bookNo: "1", lines: [{ productVariantId: f.blackGrey, quantity: 1.5, unitPrice: 50 }] });
    assert.equal(bill.duplicate, false);
    assert.equal((await new StoreExitScanUseCase({ ...scanDeps(f.db), storeExitEventsRepo: f.db }).execute({ rawScan: first, context: CONTEXT })).accepted, true);

    const refused = await edit(f, { gatepassId: made.gatepassId!, lines: [[f.blackGrey, 2]] });
    assert.deepEqual([refused.accepted, refused.outcome], [false, "ALREADY_MOVED"]);
    assert.match(refused.reason ?? "", /1 carton\(s\) have already been scanned out/);
  });
});

test("a billed gatepass's bill follows the edit: same rate, new dozens, new total; a new article + size is refused whole", async () => {
  await withFixture(async (f) => {
    stockManual(f, f.sk46, "BLACKGREY", 20);
    stockManual(f, f.sk46, "NAVY", 20);
    stockManual(f, f.sk6, "RED", 20);
    const made = await makeGatepass(f, [[f.blackGrey, 5]]);
    f.db.enterGatepassBill(made.billId!, { bookNo: "1", lines: [{ productVariantId: f.blackGrey, quantity: 2.5, unitPrice: 50 }] });
    const billLines = () => f.db.getSaleVoucher(made.billId!)!.lineItems.map((line) => [line.article, line.size, line.quantity, line.unitPrice]);
    assert.deepEqual(billLines(), [["SK46", "11/13", 2.5, 50]]);

    // 5 cartons became 10, across two colours of the same article + size: the bill's one line becomes 5 dozen.
    const edited = await edit(f, { gatepassId: made.gatepassId!, lines: [[f.blackGrey, 6], [f.navy, 4]] });
    assert.equal(edited.accepted, true, edited.reason);
    assert.equal(edited.billNumber, f.db.getSaleVoucher(made.billId!)!.voucherNumber);
    assert.deepEqual(billLines(), [["SK46", "11/13", 5, 50]]);
    assert.equal(f.db.getSaleVoucher(made.billId!)!.totalAmount, 5 * 12 * 50, "5 dozen of 12 pairs at 50");

    // SK6 7/10 is not on the bill: refused, and the gatepass, the stock and the bill stay as they were.
    const added = await edit(f, { gatepassId: made.gatepassId!, revisionNo: 2, lines: [[f.blackGrey, 6], [f.navy, 4], [f.red, 2]] });
    assert.deepEqual([added.accepted, added.outcome], [false, "NEW_LINE_ON_BILL"]);
    assert.match(added.reason ?? "", /no rate for SK6 7\/10/);
    assert.deepEqual(linesOf(f, made.gatepassId!), [["BLACKGREY", 6, 6], ["NAVY", 4, 4]]);
    assert.equal(inStore(f, "SK6", "RED").current, 20);
    assert.deepEqual(billLines(), [["SK46", "11/13", 5, 50]]);
  });
});

test("the party may change before the bill is entered (the bill follows), and not after", async () => {
  await withFixture(async (f) => {
    stockManual(f, f.sk46, "BLACKGREY", 20);
    const made = await makeGatepass(f, [[f.blackGrey, 4]]);
    const moved = await edit(f, { gatepassId: made.gatepassId!, partyId: f.other, lines: [[f.blackGrey, 4]] });
    assert.equal(moved.accepted, true, moved.reason);
    assert.equal(f.db.getGatepass(made.gatepassId!)!.partyId, f.other);
    assert.equal(f.db.getSaleVoucher(made.billId!)!.partyId, f.other, "the unentered bill goes with it");

    f.db.enterGatepassBill(made.billId!, { bookNo: "1", lines: [{ productVariantId: f.blackGrey, quantity: 2, unitPrice: 50 }] });
    const locked = await edit(f, { gatepassId: made.gatepassId!, revisionNo: 2, partyId: f.customer, lines: [[f.blackGrey, 4]] });
    assert.deepEqual([locked.accepted, locked.outcome], [false, "PARTY_LOCKED"]);
  });
});

test("an edit needs a reason, and the new lines must fit the store as a new gatepass's must", async () => {
  await withFixture(async (f) => {
    stockManual(f, f.sk46, "BLACKGREY", 20);
    const made = await makeGatepass(f, [[f.blackGrey, 5]]);
    const noReason = await edit(f, { gatepassId: made.gatepassId!, reason: "  ", lines: [[f.blackGrey, 10]] });
    assert.deepEqual([noReason.accepted, noReason.outcome], [false, "REASON_REQUIRED"]);
    const noLines = await edit(f, { gatepassId: made.gatepassId!, lines: [] });
    assert.deepEqual([noLines.accepted, noLines.outcome], [false, "NO_LINES"]);
    assert.deepEqual(linesOf(f, made.gatepassId!), [["BLACKGREY", 5, 5]]);
  });
});

test("only a cancelled gatepass may be deleted: it leaves every list, keeps everything, and cannot be edited or deleted again", async () => {
  await withFixture(async (f) => {
    stockManual(f, f.sk46, "BLACKGREY", 20);
    const made = await makeGatepass(f, [[f.blackGrey, 5]]);
    const live = await remove(f, made.gatepassId!);
    assert.deepEqual([live.accepted, live.outcome], [false, "NOT_CANCELLED"]);

    assert.equal((await cancel(f, made.gatepassId!)).accepted, true);
    const noReason = await remove(f, made.gatepassId!, " ");
    assert.equal(noReason.outcome, "REASON_REQUIRED");
    const deleted = await remove(f, made.gatepassId!);
    assert.deepEqual([deleted.accepted, deleted.outcome, deleted.code], [true, "DELETED", made.code]);

    assert.equal(f.db.listGatepasses({}).rows.some((row) => row.id === made.gatepassId), false, "off the list");
    const log = f.db.listGatepasses({ deleted: true }).rows;
    assert.deepEqual(log.map((row) => [row.code, row.deletedBy, row.deleteReason]), [[made.code, "owner", "made in error"]]);
    const kept = f.db.getGatepass(made.gatepassId!)!;
    assert.deepEqual([kept.status, kept.deletedBy, kept.lines.length], ["CANCELLED", "owner", 1], "kept whole, read-only");

    assert.equal((await remove(f, made.gatepassId!)).outcome, "ALREADY_DELETED");
    assert.equal((await edit(f, { gatepassId: made.gatepassId!, lines: [[f.blackGrey, 2]] })).outcome, "DELETED");
    // Its number is never used again.
    const next = await makeGatepass(f, [[f.blackGrey, 2]]);
    assert.equal(next.gatepassNumber, made.gatepassNumber! + 1);
  });
});
