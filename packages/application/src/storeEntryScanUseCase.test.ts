import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryEventBus } from "./eventBus.js";
import { STORE_ENTRY_ELIGIBLE_STATUSES, StoreEntryRejectedError, StoreEntryScanUseCase } from "./storeEntryScanUseCase.js";
import type { StoreEntryQrRecord, StoreEntryScanDeps } from "./storeEntryScanUseCase.js";
import type { TransactionContext } from "./ports.js";

// Every test below drives the use case with in-memory fakes and counts what each port was
// asked to write, so "nothing changed" is asserted, not assumed.

const CONTEXT = { factoryId: "factory-777", workstationId: "ws-store-01", deviceId: "desktop-store" };

interface Writes {
  markInStore: number;
  events: number;
  /** Stock moved between our own locations — the variant total does not change. */
  moves: number;
  /** Stock received back from outside the company — the variant total grows by one. */
  receivesFromOutside: number;
  outbox: number;
}

function unit(overrides: Partial<StoreEntryQrRecord> = {}): StoreEntryQrRecord {
  return {
    qrId: "SK6_RED_7/10_000037",
    productVariantId: "variant-sk6-red-7-10",
    currentStatus: "PRODUCED",
    currentLocationType: "FACTORY",
    currentLocationId: "factory-777",
    article: "SK6",
    color: "RED",
    size: "7/10",
    ...overrides,
  };
}

/**
 * A tiny in-memory qr_master: status per QR, plus registry membership. `markInStore` is a
 * guarded update exactly like the SQLite one — it only applies while the status is
 * eligible, and throws when it is not.
 */
function createWorld(initial: Record<string, StoreEntryQrRecord | "REGISTERED" | "VOID">) {
  const world = new Map(Object.entries(initial));
  const writes: Writes = { markInStore: 0, events: 0, moves: 0, receivesFromOutside: 0, outbox: 0 };

  const deps: StoreEntryScanDeps = {
    txManager: {
      async runInTransaction<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
        return work({ nowIso: "2026-09-16T08:15:00.000Z" });
      },
    },
    qrLookupRepo: {
      async getQrForStoreEntry(qrId) {
        const entry = world.get(qrId);
        return entry && typeof entry === "object" ? { ...entry } : null;
      },
    },
    qrRegistry: {
      async findRegisteredQrCode(qrId) {
        const entry = world.get(qrId);
        if (!entry) return null;
        if (typeof entry === "object") {
          return { productVariantId: entry.productVariantId, article: entry.article, color: entry.color, size: entry.size, status: "GENERATED" };
        }
        const [article, color, size] = qrId.split("_");
        return { productVariantId: null, article, color, size, status: entry };
      },
    },
    qrMasterRepo: {
      async markInStore({ qrId, locationId }) {
        const entry = world.get(qrId);
        if (!entry || typeof entry !== "object") throw new StoreEntryRejectedError("STATUS_CHANGED", "gone");
        if (entry.currentStatus === "WAREHOUSE") throw new StoreEntryRejectedError("ALREADY_IN_STORE", "already");
        if (!STORE_ENTRY_ELIGIBLE_STATUSES.has(entry.currentStatus)) {
          throw new StoreEntryRejectedError("STATUS_CHANGED", "changed");
        }
        world.set(qrId, { ...entry, currentStatus: "WAREHOUSE", currentLocationType: "WAREHOUSE", currentLocationId: locationId });
        writes.markInStore += 1;
      },
    },
    storeEntryEventsRepo: {
      async appendStoreEntryEvent() {
        writes.events += 1;
      },
    },
    stockProjectionRepo: {
      async moveStockToStore() {
        writes.moves += 1;
      },
      async receiveReturnedStockIntoStore() {
        writes.receivesFromOutside += 1;
      },
    },
    outboxRepo: {
      async enqueueStoreEntry() {
        writes.outbox += 1;
      },
    },
    eventPublisher: new InMemoryEventBus(),
    idGenerator: { nextId: () => crypto.randomUUID() },
  };

  return { deps, world, writes };
}

const scan = (useCase: StoreEntryScanUseCase, rawScan: string, sessionId = "session-1") =>
  useCase.execute({ rawScan, context: CONTEXT, sessionId, actor: "store-op" });

test("TEST 1 — a PRODUCED unit is received: status → WAREHOUSE, one event, one stock move, one outbox row", async () => {
  const { deps, world, writes } = createWorld({ "SK6_RED_7/10_000037": unit() });
  const useCase = new StoreEntryScanUseCase(deps);

  const result = await scan(useCase, "SK6_RED_7/10_000037");

  assert.equal(result.accepted, true);
  assert.equal(result.outcome, "RECEIVED");
  assert.equal(result.qrId, "SK6_RED_7/10_000037");
  assert.deepEqual([result.article, result.color, result.size, result.serial], ["SK6", "RED", "7/10", "000037"]);
  assert.equal(result.previousStatus, "PRODUCED");
  assert.equal(result.currentStatus, "WAREHOUSE");
  assert.equal(result.receivedAt, "2026-09-16T08:15:00.000Z");
  assert.equal(result.sessionId, "session-1");
  assert.ok(result.eventId);

  const after = world.get("SK6_RED_7/10_000037") as StoreEntryQrRecord;
  assert.equal(after.currentStatus, "WAREHOUSE");
  assert.equal(after.currentLocationType, "WAREHOUSE");
  assert.equal(after.currentLocationId, "factory-777");
  assert.deepEqual(writes, { markInStore: 1, events: 1, moves: 1, receivesFromOutside: 0, outbox: 1 });
});

test("a RETURNED unit (back in production stock) can be received", async () => {
  const { deps, writes } = createWorld({ "SK6_RED_7/10_000037": unit({ currentStatus: "RETURNED" }) });
  const result = await scan(new StoreEntryScanUseCase(deps), "SK6_RED_7/10_000037");
  assert.equal(result.outcome, "RECEIVED");
  assert.equal(result.previousStatus, "RETURNED");
  assert.deepEqual(writes, { markInStore: 1, events: 1, moves: 1, receivesFromOutside: 0, outbox: 1 });
});

test("a TO_GATE unit (moved out by mistake) can be received back into the store", async () => {
  const { deps, world, writes } = createWorld({
    "SK6_RED_7/10_000037": unit({ currentStatus: "TO_GATE", currentLocationType: "GATE" }),
  });
  const appended: Array<Parameters<StoreEntryScanDeps["storeEntryEventsRepo"]["appendStoreEntryEvent"]>[0]> = [];
  deps.storeEntryEventsRepo = {
    async appendStoreEntryEvent(p) {
      appended.push(p);
      writes.events += 1;
    },
  };

  const result = await scan(new StoreEntryScanUseCase(deps), "SK6_RED_7/10_000037");

  assert.equal(result.outcome, "RECEIVED");
  assert.equal(result.previousStatus, "TO_GATE");
  assert.equal(result.currentStatus, "WAREHOUSE");
  assert.equal((world.get("SK6_RED_7/10_000037") as StoreEntryQrRecord).currentLocationType, "WAREHOUSE");
  assert.equal(appended[0]?.fromLocationType, "GATE");
  assert.deepEqual(writes, { markInStore: 1, events: 1, moves: 1, receivesFromOutside: 0, outbox: 1 });
});

// TEST D — the physical half of a return. The carton's return was recorded on the gate
// (status ON_GATE, no stock moved then); this ordinary store scan is what finally puts it
// back in stock. It must ADD a unit, not move one: dispatch took that unit out of the pool
// and nothing has put it back.
test("an ON_GATE unit (returned carton arriving) is received and its stock is ADDED, not moved", async () => {
  const { deps, world, writes } = createWorld({
    "SK6_RED_7/10_000123": unit({ qrId: "SK6_RED_7/10_000123", currentStatus: "ON_GATE", currentLocationType: "GATE" }),
  });
  const appended: Array<Parameters<StoreEntryScanDeps["storeEntryEventsRepo"]["appendStoreEntryEvent"]>[0]> = [];
  deps.storeEntryEventsRepo = {
    async appendStoreEntryEvent(p) {
      appended.push(p);
      writes.events += 1;
    },
  };

  const result = await scan(new StoreEntryScanUseCase(deps), "SK6_RED_7/10_000123");

  assert.equal(result.outcome, "RECEIVED");
  assert.equal(result.previousStatus, "ON_GATE");
  assert.equal(result.currentStatus, "WAREHOUSE");
  assert.equal((world.get("SK6_RED_7/10_000123") as StoreEntryQrRecord).currentStatus, "WAREHOUSE");
  assert.equal(appended[0]?.previousStatus, "ON_GATE");
  assert.equal(appended[0]?.fromLocationType, "GATE");
  // The point of the test: receiveReturnedStockIntoStore, never moveStockToStore.
  assert.deepEqual(writes, { markInStore: 1, events: 1, moves: 0, receivesFromOutside: 1, outbox: 1 });
});

// The store operator needs no knowledge of parties, vouchers or returns — the QR's own
// status is the whole instruction. A carton still out with a customer is simply refused.
test("a DISPATCHED unit is refused at the store and told its return must be recorded first", async () => {
  const { deps, writes } = createWorld({
    "SK6_RED_7/10_000123": unit({ qrId: "SK6_RED_7/10_000123", currentStatus: "DISPATCHED" }),
  });
  const result = await scan(new StoreEntryScanUseCase(deps), "SK6_RED_7/10_000123");

  assert.equal(result.accepted, false);
  assert.equal(result.outcome, "NOT_ELIGIBLE");
  assert.match(result.reason ?? "", /return has to be recorded/i);
  assert.deepEqual(writes, { markInStore: 0, events: 0, moves: 0, receivesFromOutside: 0, outbox: 0 });
});

test("TEST 2 — scanning the same carton again is ALREADY_IN_STORE with no further writes", async () => {
  const { deps, writes } = createWorld({ "SK6_RED_7/10_000037": unit() });
  const useCase = new StoreEntryScanUseCase(deps);

  assert.equal((await scan(useCase, "SK6_RED_7/10_000037")).outcome, "RECEIVED");
  const duplicate = await scan(useCase, "SK6_RED_7/10_000037");

  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.outcome, "ALREADY_IN_STORE");
  assert.equal(duplicate.currentStatus, "WAREHOUSE");
  assert.deepEqual([duplicate.article, duplicate.color, duplicate.size], ["SK6", "RED", "7/10"]);
  assert.deepEqual(writes, { markInStore: 1, events: 1, moves: 1, receivesFromOutside: 0, outbox: 1 });
});

test("TEST 3 — an unregistered QR is UNKNOWN_QR and nothing is written", async () => {
  const { deps, world, writes } = createWorld({});
  const result = await scan(new StoreEntryScanUseCase(deps), "SK6_RED_7/10_999999");

  assert.equal(result.accepted, false);
  assert.equal(result.outcome, "UNKNOWN_QR");
  assert.equal(result.qrId, "SK6_RED_7/10_999999");
  assert.equal(result.previousStatus, null);
  assert.equal(world.size, 0, "no QR was created");
  assert.deepEqual(writes, { markInStore: 0, events: 0, moves: 0, receivesFromOutside: 0, outbox: 0 });
});

test("TEST 4/5 — a GENERATED (registered, never produced) QR is rejected as NOT_PRODUCED", async () => {
  const { deps, world, writes } = createWorld({ "SK6_RED_7/10_000041": "REGISTERED" });
  const result = await scan(new StoreEntryScanUseCase(deps), "SK6_RED_7/10_000041");

  assert.equal(result.accepted, false);
  assert.equal(result.outcome, "NOT_PRODUCED");
  assert.equal(result.registryStatus, "REGISTERED");
  assert.match(result.reason ?? "", /not completed the required production process/i);
  assert.equal(world.get("SK6_RED_7/10_000041"), "REGISTERED", "registry row untouched");
  assert.deepEqual(writes, { markInStore: 0, events: 0, moves: 0, receivesFromOutside: 0, outbox: 0 });
});

test("a VOID code is rejected as NOT_PRODUCED with the void explanation", async () => {
  const { deps } = createWorld({ "SK6_RED_7/10_000042": "VOID" });
  const result = await scan(new StoreEntryScanUseCase(deps), "SK6_RED_7/10_000042");
  assert.equal(result.outcome, "NOT_PRODUCED");
  assert.equal(result.registryStatus, "VOID");
  assert.match(result.reason ?? "", /voided/i);
});

test("TEST 6 — DISPATCHED, SOLD, DAMAGED and SCRAPPED units are NOT_ELIGIBLE and unchanged", async () => {
  for (const status of ["DISPATCHED", "SOLD", "DAMAGED", "SCRAPPED"]) {
    const { deps, world, writes } = createWorld({ "SK6_RED_7/10_000037": unit({ currentStatus: status }) });
    const result = await scan(new StoreEntryScanUseCase(deps), "SK6_RED_7/10_000037");

    assert.equal(result.accepted, false, status);
    assert.equal(result.outcome, "NOT_ELIGIBLE", status);
    assert.equal(result.currentStatus, status);
    assert.equal((world.get("SK6_RED_7/10_000037") as StoreEntryQrRecord).currentStatus, status);
    assert.deepEqual(writes, { markInStore: 0, events: 0, moves: 0, receivesFromOutside: 0, outbox: 0 }, status);
  }
});

test("malformed input is INVALID_FORMAT before any lookup", async () => {
  const { deps, writes } = createWorld({});
  let lookups = 0;
  deps.qrLookupRepo = {
    async getQrForStoreEntry() {
      lookups += 1;
      return null;
    },
  };
  const result = await scan(new StoreEntryScanUseCase(deps), "not a qr");
  assert.equal(result.outcome, "INVALID_FORMAT");
  assert.equal(lookups, 0);
  assert.deepEqual(writes, { markInStore: 0, events: 0, moves: 0, receivesFromOutside: 0, outbox: 0 });
});

test("a raw material QR is recognised, not called invalid, and moves nothing", async () => {
  const { deps, writes } = createWorld({});
  let lookups = 0;
  deps.qrLookupRepo = {
    async getQrForStoreEntry() {
      lookups += 1;
      return null;
    },
  };
  const result = await scan(new StoreEntryScanUseCase(deps), "RMQR_PTY000001_RM000001_000001");
  assert.equal(result.accepted, false);
  assert.equal(result.outcome, "RAW_MATERIAL_NOT_SUPPORTED", "a registered raw material label is not a bad print");
  assert.match(result.reason ?? "", /raw material/i);
  assert.equal(lookups, 0, "nothing is looked up for a format this screen cannot move");
  assert.deepEqual(writes, { markInStore: 0, events: 0, moves: 0, receivesFromOutside: 0, outbox: 0 });
});

test("TEST 7 — rapid consecutive scans are each accepted independently", async () => {
  const ids = Array.from({ length: 40 }, (_, i) => `SK6_RED_7/10_${String(i + 1).padStart(6, "0")}`);
  const { deps, writes } = createWorld(Object.fromEntries(ids.map((id) => [id, unit({ qrId: id })])));
  const useCase = new StoreEntryScanUseCase(deps);

  const results = [];
  for (const id of ids) results.push(await scan(useCase, id));

  assert.equal(results.filter((r) => r.outcome === "RECEIVED").length, 40);
  assert.deepEqual(writes, { markInStore: 40, events: 40, moves: 40, receivesFromOutside: 0, outbox: 40 });
});

test("TEST 8 — a mixed sequence: failures never break the following scans", async () => {
  const { deps, writes } = createWorld({
    "SK6_RED_7/10_000001": unit({ qrId: "SK6_RED_7/10_000001" }),
    "SK6_RED_7/10_000002": unit({ qrId: "SK6_RED_7/10_000002" }),
    "SK6_RED_7/10_000003": unit({ qrId: "SK6_RED_7/10_000003" }),
    "SK6_RED_7/10_000004": unit({ qrId: "SK6_RED_7/10_000004" }),
  });
  const useCase = new StoreEntryScanUseCase(deps);

  const sequence = [
    "SK6_RED_7/10_000001", // valid
    "SK6_RED_7/10_000002", // valid
    "SK6_RED_7/10_999999", // unknown
    "SK6_RED_7/10_000003", // valid
    "SK6_RED_7/10_000001", // duplicate
    "SK6_RED_7/10_000004", // valid
  ];
  const outcomes = [];
  for (const raw of sequence) outcomes.push((await scan(useCase, raw)).outcome);

  assert.deepEqual(outcomes, ["RECEIVED", "RECEIVED", "UNKNOWN_QR", "RECEIVED", "ALREADY_IN_STORE", "RECEIVED"]);
  assert.deepEqual(writes, { markInStore: 4, events: 4, moves: 4, receivesFromOutside: 0, outbox: 4 });
});

test("TEST 9 — a stale read loses to the guarded update: second terminal gets ALREADY_IN_STORE with no writes", async () => {
  // Both terminals read the unit as PRODUCED (the read happens before either commits);
  // only the first guarded update applies. The second must not append an event, move
  // stock, or enqueue anything.
  const { deps, writes } = createWorld({ "SK6_RED_7/10_000037": unit() });
  const staleRead = unit();
  deps.qrLookupRepo = { async getQrForStoreEntry() { return { ...staleRead }; } };
  const useCase = new StoreEntryScanUseCase(deps);

  const first = await scan(useCase, "SK6_RED_7/10_000037");
  const second = await scan(useCase, "SK6_RED_7/10_000037");

  assert.equal(first.outcome, "RECEIVED");
  assert.equal(second.accepted, false);
  assert.equal(second.outcome, "ALREADY_IN_STORE");
  assert.deepEqual(writes, { markInStore: 1, events: 1, moves: 1, receivesFromOutside: 0, outbox: 1 });
});

test("unexpected infrastructure errors propagate instead of being reported as rejections", async () => {
  const { deps } = createWorld({ "SK6_RED_7/10_000037": unit() });
  deps.storeEntryEventsRepo = {
    async appendStoreEntryEvent() {
      throw new Error("disk full");
    },
  };
  await assert.rejects(scan(new StoreEntryScanUseCase(deps), "SK6_RED_7/10_000037"), /disk full/);
});
