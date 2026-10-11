// DEMO DATA for testing the Machine Program flow end to end on a FRESH local database.
//
//   npm run seed:demo
//
// Run it once, after the app has been started on the fresh database, the first admin account has
// been created, and the app has been CLOSED again. It refuses to run while the app is open, on a
// database that already has machines, or before an admin exists.
//
// Nothing here writes a table directly. Every record goes through the same data-layer methods and
// application use cases the app itself calls — the uppers are received by scanning their own
// labels, the Dana is moved in by hand, the program is saved line by line — so the demo data
// obeys every rule real data does, and stamps the same device the app will run as.
//
// What it creates:
//   units          DOZEN, KILOGRAM
//   parties        2 suppliers, 4 contractors
//   machines       MACHINE 1 and 2 (both contractors set), MACHINE 3 (none — to test assigning)
//   products       SK6 and SK12 (uppers) and EVR9 (EVR FIX: two soles, no upper), sizes 7/10 + 8/11
//   uppers         SK6 / SK12 × 7/10, 8/11 × BLACK, RED, BROWN — 6 labelled PACKETS of 2 DOZEN each,
//                  received into the store (2 DOZEN out = 4 cartons back)
//   dana           EVA BLACK, EVA RED, EVA WHITE, PVC BLACK — 200 KG each, in 25 KG BAGs, moved in by hand
//   program        MACHINE 1, today: uppers on both injectors and one EVR9 fix run
//
// The raw material labels it received are listed in seed-demo-labels.txt beside the database, so
// they can be typed into the scan boxes when there is no printed label to hand.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SqliteDatabase, UuidGenerator } from "@erp/data";
import {
  AssignMachineContractorUseCase,
  InMemoryEventBus,
  ReceiveRawMaterialScanUseCase,
  SaveMachineProgramFixRunUseCase,
  SaveMachineProgramLineUseCase,
} from "@erp/application";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultDataRoot = path.join(process.env.LOCALAPPDATA ?? "", "777-erp");
// ERP_DATA_DIR is the same override the app reads (main/runtimePaths.ts).
const dataRoot = process.env.ERP_DATA_DIR?.trim() || defaultDataRoot;
const databaseFile = path.join(dataRoot, "erp.local.sqlite");
const identityFile = path.join(dataRoot, "device-identity.json");

const fail = (message) => {
  console.error(`\n✕ ${message}\n`);
  process.exit(1);
};

/** Today in the computer's own time zone (Asia/Karachi on the factory PCs), as YYYY-MM-DD. */
const localToday = () => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

// ─── Preconditions ────────────────────────────────────────────────────────────

/** The app writes the default data folder; a seed aimed at another folder cannot collide with it. */
const assertAppClosed = () => {
  if (process.platform !== "win32" || path.resolve(dataRoot) !== path.resolve(defaultDataRoot)) return;
  const running = execSync('tasklist /FI "IMAGENAME eq electron.exe" /NH', { encoding: "utf8" });
  if (running.toLowerCase().includes("electron.exe")) fail("Close the 777 ERP app first — two programs must never write one database at once.");
};

const openDatabase = () => {
  if (!fs.existsSync(databaseFile) || !fs.existsSync(identityFile)) {
    fail(`No database at ${dataRoot}. Start the app once, create the admin account, close the app, then run this again.`);
  }
  const db = new SqliteDatabase({ dbPath: databaseFile, schemaPath: path.join(repoRoot, "packages", "data", "src", "local-schema.sql") });
  const raw = db.db;
  const admin = raw.prepare("SELECT username FROM app_users WHERE role = 'ADMIN' AND access_status = 'APPROVED' LIMIT 1").get();
  if (!admin) fail("No admin account yet. Start the app, create the first admin, close the app, then run this again.");
  if (raw.prepare("SELECT COUNT(*) AS n FROM machines").get().n > 0) {
    fail("This database already has machines, so it is not fresh. The demo data is only for an empty database.");
  }
  const identity = JSON.parse(fs.readFileSync(identityFile, "utf8"));
  const context = { factoryId: identity.factoryId, workstationId: identity.workstationId, deviceId: identity.deviceId };
  return { db, actor: String(admin.username), context };
};

// ─── Masters ──────────────────────────────────────────────────────────────────

const createUnits = (db) => ({
  dozen: db.createInventoryUnit({ code: "DOZEN", name: "Dozen", unitFamily: "COUNT" }),
  kilogram: db.createInventoryUnit({ code: "KILOGRAM", name: "Kilogram", symbol: "KG", unitFamily: "WEIGHT" }),
});

const createParties = (db) => {
  const party = (partyName, partyType, mobileNumber, city) => db.createParty({ partyName, partyType, city, mobileNumber, status: "ACTIVE" });
  return {
    upperSupplier: party("SHEHZAD RUBBER", "SUPPLIER", "0300-1000001", "Lahore"),
    danaSupplier: party("ABC CHEMICALS", "SUPPLIER", "0300-1000002", "Karachi"),
    alamgir: party("ALAMGIR", "CONTRACTOR", "0300-2000001", "Lahore"),
    daniyal: party("DANIYAL", "CONTRACTOR", "0300-2000002", "Lahore"),
    shahid: party("SHAHID", "CONTRACTOR", "0300-2000003", "Kasur"),
    rashid: party("RASHID", "CONTRACTOR", "0300-2000004", "Kasur"),
  };
};

const ARTICLES = [
  { article: "SK6", sellingPrice: 650, machineRate: 40, packingRate: 16, printingRate: 0, fix: false },
  { article: "SK12", sellingPrice: 720, machineRate: 45, packingRate: 18, printingRate: 6, fix: false },
  { article: "EVR9", sellingPrice: 580, machineRate: 35, packingRate: 15, printingRate: 0, fix: true },
];
const SIZES = ["7/10", "8/11"];
const UPPER_COLOURS = ["BLACK", "RED", "BROWN"];

/** Product Master: one group, a normal sub group, and EVR FIX flagged as having no upper. */
const createProducts = (db) => {
  const productGroupId = db.createProductGroup({ groupName: "SLIPPERS" });
  const productTypeId = db.createProductType({ name: "CHAPPAL" });
  const normalSubGroup = db.createProductSubGroup({ productGroupId, name: "EVA" });
  const fixSubGroup = db.createProductSubGroup({ productGroupId, name: "EVR FIX", hasNoUpper: true });

  // createProduct answers with the first colour VARIANT; programs are planned against the article +
  // size row, so that id is read back by its natural key.
  const articleSizeOf = (article, size) =>
    db.db.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ? AND deleted_at IS NULL").get(article, size).id;

  const articleSizeIds = {};
  for (const spec of ARTICLES) {
    for (const size of SIZES) {
      db.createProduct({
        article: spec.article,
        size,
        sellingPrice: spec.sellingPrice,
        machineRate: spec.machineRate,
        packingRate: spec.packingRate,
        printingRate: spec.printingRate,
        productGroupId,
        productTypeId,
        productSubGroupId: spec.fix ? fixSubGroup : normalSubGroup,
        colors: spec.fix ? ["BLACK"] : UPPER_COLOURS,
        status: "ACTIVE",
      });
      articleSizeIds[`${spec.article} ${size}`] = articleSizeOf(spec.article, size);
    }
  }
  return articleSizeIds;
};

// ─── Raw materials ────────────────────────────────────────────────────────────

/** A sub category with its own attribute fields, under a top-level kind (UPPER or DANA). */
const createCategory = (db, parentId, name, fieldKeys) => {
  const categoryId = db.createInventoryCategory({ name, parentId });
  fieldKeys.forEach((fieldKey, index) =>
    db.addInventoryCategoryField({ categoryId, fieldKey, label: fieldKey.toUpperCase(), fieldType: "TEXT", required: fieldKey !== "type", sortOrder: index + 1 })
  );
  return categoryId;
};

/** Every SK upper in every size and colour, packed 2 DOZEN to a PACKET. */
const createUppers = (db, units) => {
  const ragzine = createCategory(db, db.createInventoryCategory({ name: "UPPER" }), "RAGZINE UPPER", ["article", "color", "size", "type"]);
  const uppers = [];
  for (const { article } of ARTICLES.filter((spec) => !spec.fix)) {
    for (const size of SIZES) {
      for (const color of UPPER_COLOURS) {
        const { id, displayName } = db.createInventoryItem({ categoryId: ragzine, values: { article, color, size, type: "SILAI" }, unitId: units.dozen });
        db.setRawMaterialMovementConfig(id, { packName: "PACKET", packingQuantity: 2, packingUnitId: units.dozen });
        uppers.push({ id, displayName, article, size, color });
      }
    }
  }
  return uppers;
};

/** The Dana the soles are moulded from. Its colours ARE the sole colours a program can choose. */
const createDana = (db, units) => {
  const dana = db.createInventoryCategory({ name: "DANA" });
  const eva = createCategory(db, dana, "EVA", ["color"]);
  const pvc = createCategory(db, dana, "PVC", ["color"]);
  return [
    [eva, "BLACK"],
    [eva, "RED"],
    [eva, "WHITE"],
    [pvc, "BLACK"],
  ].map(([categoryId, color]) => {
    const { id, displayName } = db.createInventoryItem({ categoryId, values: { color }, unitId: units.kilogram });
    db.setRawMaterialMovementConfig(id, { packName: "BAG", packingQuantity: 25, packingUnitId: units.kilogram });
    return { id, displayName };
  });
};

// ─── Stock ────────────────────────────────────────────────────────────────────

const PACKETS_PER_UPPER = 6;

/** Prints each upper's labels and receives every one by scanning it — the Raw Material Input path. */
const receiveUppers = async (db, uppers, partyId, useCases, context, actor) => {
  const session = db.startRawMaterialReceivingSession({ partyId, deviceId: context.deviceId, startedBy: actor });
  const labels = [];
  for (const upper of uppers) {
    const qrIds = db.generateRawMaterialQrBatch({ partyId, itemId: upper.id, quantity: PACKETS_PER_UPPER, packingQuantity: 2 }).qrCodes.map((qr) => qr.id);
    for (const qrId of qrIds) {
      const result = await useCases.receive.execute({ rawScan: qrId, partyId, sessionId: session.id, context, actor });
      if (result.outcome !== "RECEIVED") fail(`Could not receive ${qrId}: ${result.reason ?? result.outcome}`);
    }
    labels.push({ name: upper.displayName, qrIds });
  }
  db.closeRawMaterialReceivingSession(session.id);
  return labels;
};

/** 200 KG of each Dana, moved in by hand — loose Dana has no labels, and Dana Issue needs it so. */
const receiveDana = (db, danas, partyId, actor) => {
  for (const dana of danas) {
    const moved = db.moveRawMaterialByHand({ itemId: dana.id, direction: "IN", quantity: 200, unitCode: "KILOGRAM", partyId, note: "Demo data", actor });
    if (moved.outcome !== "MOVED") fail(`Could not move ${dana.displayName} in: ${moved.reason ?? moved.outcome}`);
  }
};

// ─── Machines and a program ───────────────────────────────────────────────────

const createMachines = async (db, parties, useCases, actor) => {
  const section = db.createWorkSection({ name: "MOULDING" });
  const machines = ["MACHINE 1", "MACHINE 2", "MACHINE 3"].map((name) => db.createMachine({ name, sectionId: section.id }));
  const assign = async (machineId, role, contractorPartyId) => {
    const result = await useCases.assign.execute({ machineId, role, contractorPartyId, actor });
    if (!result.accepted) fail(`Could not assign a contractor: ${result.reason}`);
  };
  await assign(machines[0].id, "MACHINE", parties.alamgir);
  await assign(machines[0].id, "PACKING", parties.daniyal);
  await assign(machines[1].id, "MACHINE", parties.shahid);
  await assign(machines[1].id, "PACKING", parties.rashid);
  return machines;
};

const findUpper = (uppers, article, size, color) => uppers.find((upper) => upper.article === article && upper.size === size && upper.color === color);

/**
 * MACHINE 1's program for today, ready to issue against:
 *   Injector 1  BLACK sole  SK6 7/10   BLACK 6 DOZEN + RED 4 DOZEN
 *   Injector 2  RED sole    SK12 8/11  BROWN 8 DOZEN
 *               BLACK outer / WHITE inner  EVR9 7/10  20 DOZEN   (fix run)
 */
const createProgram = async (machineId, articleSizeIds, uppers, useCases, actor) => {
  const programDate = localToday();
  const line = async (injectorNo, run, runId, upper, quantity) => {
    const result = await useCases.saveLine.execute({ machineId, programDate, injectorNo, runId, run: runId ? null : run, itemId: upper.id, quantity, actor });
    if (!result.accepted) fail(`Could not plan ${upper.displayName}: ${result.reason}`);
    return result;
  };

  const first = await line(1, { soleColour: "BLACK", articleSizeId: articleSizeIds["SK6 7/10"] }, null, findUpper(uppers, "SK6", "7/10", "BLACK"), 6);
  await line(1, null, first.runId, findUpper(uppers, "SK6", "7/10", "RED"), 4);
  await line(2, { soleColour: "RED", articleSizeId: articleSizeIds["SK12 8/11"] }, null, findUpper(uppers, "SK12", "8/11", "BROWN"), 8);

  const fix = await useCases.saveFixRun.execute({
    machineId, programDate, injectorNo: 2, soleColour: "BLACK", innerSoleColour: "WHITE", articleSizeId: articleSizeIds["EVR9 7/10"], quantity: 20, actor,
  });
  if (!fix.accepted) fail(`Could not plan the EVR9 fix run: ${fix.reason}`);
  return programDate;
};

// ─── Run ──────────────────────────────────────────────────────────────────────

const writeLabelList = (labels) => {
  const file = path.join(dataRoot, "seed-demo-labels.txt");
  const body = labels.map((entry) => `${entry.name}\n${entry.qrIds.map((qrId) => `  ${qrId}`).join("\n")}`).join("\n\n");
  fs.writeFileSync(file, `Raw material labels received into the store by the demo data (each is one PACKET of 2 DOZEN).\nType one into a scan box to scan it.\n\n${body}\n`);
  return file;
};

const main = async () => {
  assertAppClosed();
  const { db, actor, context } = openDatabase();
  const deps = { txManager: db, repo: db, eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator() };
  const useCases = {
    assign: new AssignMachineContractorUseCase(deps),
    saveLine: new SaveMachineProgramLineUseCase(deps),
    saveFixRun: new SaveMachineProgramFixRunUseCase(deps),
    receive: new ReceiveRawMaterialScanUseCase(deps),
  };

  const units = createUnits(db);
  const parties = createParties(db);
  const articleSizeIds = createProducts(db);
  const uppers = createUppers(db, units);
  const danas = createDana(db, units);
  const labels = await receiveUppers(db, uppers, parties.upperSupplier, useCases, context, actor);
  receiveDana(db, danas, parties.danaSupplier, actor);
  const machines = await createMachines(db, parties, useCases, actor);
  const programDate = await createProgram(machines[0].id, articleSizeIds, uppers, useCases, actor);
  const labelFile = writeLabelList(labels);
  db.close();

  console.log(`
✓ Demo data added (as ${actor}).

  Products     SK6, SK12 (uppers) and EVR9 (EVR FIX), sizes ${SIZES.join(" and ")}
  Uppers       ${uppers.length} uppers × ${PACKETS_PER_UPPER} packets of 2 DOZEN, in the store
  Dana         ${danas.map((dana) => dana.displayName).join(", ")} — 200 KG each
  Machines     MACHINE 1 (ALAMGIR / DANIYAL), MACHINE 2 (SHAHID / RASHID), MACHINE 3 (no contractors)
  Program      MACHINE 1 for ${programDate} — open it in Store Out as MP-000001 or 1

  Raw material labels: ${labelFile}
`);
};

await main();
