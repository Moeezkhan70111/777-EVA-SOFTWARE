import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryEventBus } from "./eventBus.js";
import { StoreExitRejectedError, StoreExitScanUseCase } from "./storeExitScanUseCase.js";
import type { OutstandingGatepassLine, StoreExitQrRecord, StoreExitScanDeps } from "./storeExitScanUseCase.js";
import type { TransactionContext } from "./ports.js";

// Same approach as the store entry tests: in-memory fakes count every write, so "nothing
// changed" is asserted, not assumed. The scanner is generic — nothing about a Gatepass is
// passed in; the reconciliation section below gives the fake repository reservations and
// checks what the event records.

const CONTEXT = { factoryId: "factory-777", workstationId: "ws-store-01", deviceId: "desktop-store" };

interface Writes {
  markAtGate: number;
  events: number;
  moves: number;
  outbox: number;
}

function unit(overrides: Partial<StoreExitQrRecord> = {}): StoreExitQrRecord {
  return {
    qrId: "SK6_RED_7/10_000037",
    productVariantId: "variant-sk6-red-7-10",
    currentStatus: "WAREHOUSE",
    currentLocationType: "WAREHOUSE",
    currentLocationId: "factory-777",
    article: "SK6",
    color: "RED",
    size: "7/10",
    ...overrides,
  };
}

/** A tiny in-memory qr_master with a guarded `markAtGate`, exactly like the SQLite one. */
function createWorld(initial: Record<string, StoreExitQrRecord | "REGISTERED" | "VOID">) {
  const world = new Map(Object.entries(initial));
  const writes: Writes = { markAtGate: 0, events: 0, moves: 0, outbox: 0 };

  const deps: StoreExitScanDeps = {
    txManager: {
      async runInTransaction<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
        return work({ nowIso: "2026-09-16T14:05:00.000Z" });
      },
    },
    qrLookupRepo: {
      async getQrForStoreExit(qrId) {
        const entry = world.get(qrId);
        return entry && typeof entry === "object" ? { ...entry } : null;
      },
    },
    gatepassRepo: {
      // Nothing reserved unless a test says so.
      async findOldestOutstandingGatepassLine() {
        return null;
      },
      findGatepassLineForVariant() {
        return null;
      },
      readGatepassStatus() {
        return null;
      },
      gatepassStoreScanComplete() {
        return false;
      },
      advanceGatepassStatus() {
        return false;
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
      async markAtGate({ qrId, locationId }) {
        const entry = world.get(qrId);
        if (!entry || typeof entry !== "object") throw new StoreExitRejectedError("STATUS_CHANGED", "gone");
        if (entry.currentStatus === "TO_GATE") throw new StoreExitRejectedError("ALREADY_AT_GATE", "already");
        if (entry.currentStatus !== "WAREHOUSE") throw new StoreExitRejectedError("STATUS_CHANGED", "changed");
        world.set(qrId, { ...entry, currentStatus: "TO_GATE", currentLocationType: "GATE", currentLocationId: locationId });
        writes.markAtGate += 1;
      },
    },
    storeExitEventsRepo: {
      async appendStoreExitEvent() {
        writes.events += 1;
      },
    },
    stockProjectionRepo: {
      async moveStockToGate() {
        writes.moves += 1;
      },
    },
    outboxRepo: {
      async enqueueStoreExit() {
        writes.outbox += 1;
      },
    },
    eventPublisher: new InMemoryEventBus(),
    idGenerator: { nextId: () => crypto.randomUUID() },
  };

  return { deps, world, writes };
}

const scan = (useCase: StoreExitScanUseCase, rawScan: string, sessionId = "session-1") =>
  useCase.execute({ rawScan, context: CONTEXT, sessionId, actor: "store-op" });

test("an In Store unit is moved out: status → TO_GATE, location → GATE, one event, one stock move, one outbox row", async () => {
  const { deps, world, writes } = createWorld({ "SK6_RED_7/10_000037": unit() });
  const useCase = new StoreExitScanUseCase(deps);

  const result = await scan(useCase, "SK6_RED_7/10_000037");

  assert.equal(result.accepted, true);
  assert.equal(result.outcome, "MOVED_OUT");
  assert.equal(result.qrId, "SK6_RED_7/10_000037");
  assert.deepEqual([result.article, result.color, result.size, result.serial], ["SK6", "RED", "7/10", "000037"]);
  assert.equal(result.previousStatus, "WAREHOUSE");
  assert.equal(result.currentStatus, "TO_GATE");
  assert.equal(result.movedOutAt, "2026-09-16T14:05:00.000Z");
  assert.equal(result.sessionId, "session-1");
  assert.ok(result.eventId);
  assert.equal(result.gatepass, undefined, "nothing was reserved, so nothing was counted against a gatepass");

  const after = world.get("SK6_RED_7/10_000037") as StoreExitQrRecord;
  assert.equal(after.currentStatus, "TO_GATE");
  assert.equal(after.currentLocationType, "GATE");
  assert.equal(after.currentLocationId, "factory-777");
  assert.deepEqual(writes, { markAtGate: 1, events: 1, moves: 1, outbox: 1 });
});

test("the event carries the WAREHOUSE → GATE movement, the actor and the session, and no gatepass when nothing is reserved", async () => {
  const { deps } = createWorld({ "SK6_RED_7/10_000037": unit() });
  const appended: Array<Parameters<StoreExitScanDeps["storeExitEventsRepo"]["appendStoreExitEvent"]>[0]> = [];
  deps.storeExitEventsRepo = {
    async appendStoreExitEvent(p) {
      appended.push(p);
    },
  };
  await scan(new StoreExitScanUseCase(deps), "SK6_RED_7/10_000037");
  assert.equal(appended.length, 1);
  const event = appended[0];
  assert.equal(event.previousStatus, "WAREHOUSE");
  assert.equal(event.fromLocationType, "WAREHOUSE");
  assert.equal(event.toLocationType, "GATE");
  assert.equal(event.toLocationId, "factory-777");
  assert.equal(event.actor, "store-op");
  assert.equal(event.sessionId, "session-1");
  assert.equal(event.gatepassId, null);
});

test("scanning the same carton again is ALREADY_AT_GATE with no further writes", async () => {
  const { deps, writes } = createWorld({ "SK6_RED_7/10_000037": unit() });
  const useCase = new StoreExitScanUseCase(deps);

  assert.equal((await scan(useCase, "SK6_RED_7/10_000037")).outcome, "MOVED_OUT");
  const duplicate = await scan(useCase, "SK6_RED_7/10_000037");

  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.outcome, "ALREADY_AT_GATE");
  assert.equal(duplicate.currentStatus, "TO_GATE");
  assert.deepEqual([duplicate.article, duplicate.color, duplicate.size], ["SK6", "RED", "7/10"]);
  assert.deepEqual(writes, { markAtGate: 1, events: 1, moves: 1, outbox: 1 });
});

test("a PRODUCED or RETURNED unit that never entered the store is NOT_IN_STORE and unchanged", async () => {
  for (const status of ["PRODUCED", "RETURNED"]) {
    const { deps, world, writes } = createWorld({
      "SK6_RED_7/10_000037": unit({ currentStatus: status, currentLocationType: "FACTORY" }),
    });
    const result = await scan(new StoreExitScanUseCase(deps), "SK6_RED_7/10_000037");

    assert.equal(result.accepted, false, status);
    assert.equal(result.outcome, "NOT_IN_STORE", status);
    assert.equal(result.currentStatus, status);
    assert.match(result.reason ?? "", /move it in first/i);
    assert.equal((world.get("SK6_RED_7/10_000037") as StoreExitQrRecord).currentStatus, status);
    assert.deepEqual(writes, { markAtGate: 0, events: 0, moves: 0, outbox: 0 }, status);
  }
});

test("an unregistered QR is UNKNOWN_QR and nothing is written", async () => {
  const { deps, world, writes } = createWorld({});
  const result = await scan(new StoreExitScanUseCase(deps), "SK6_RED_7/10_999999");

  assert.equal(result.accepted, false);
  assert.equal(result.outcome, "UNKNOWN_QR");
  assert.equal(result.previousStatus, null);
  assert.equal(world.size, 0, "no QR was created");
  assert.deepEqual(writes, { markAtGate: 0, events: 0, moves: 0, outbox: 0 });
});

test("a GENERATED or VOID code (never produced) is NOT_PRODUCED", async () => {
  const generated = createWorld({ "SK6_RED_7/10_000041": "REGISTERED" });
  const g = await scan(new StoreExitScanUseCase(generated.deps), "SK6_RED_7/10_000041");
  assert.equal(g.outcome, "NOT_PRODUCED");
  assert.equal(g.registryStatus, "REGISTERED");
  assert.deepEqual(generated.writes, { markAtGate: 0, events: 0, moves: 0, outbox: 0 });

  const voided = createWorld({ "SK6_RED_7/10_000042": "VOID" });
  const v = await scan(new StoreExitScanUseCase(voided.deps), "SK6_RED_7/10_000042");
  assert.equal(v.outcome, "NOT_PRODUCED");
  assert.equal(v.registryStatus, "VOID");
  assert.match(v.reason ?? "", /voided/i);
});

test("DISPATCHED, SOLD, DAMAGED and SCRAPPED units are NOT_ELIGIBLE and unchanged", async () => {
  for (const status of ["DISPATCHED", "SOLD", "DAMAGED", "SCRAPPED"]) {
    const { deps, world, writes } = createWorld({ "SK6_RED_7/10_000037": unit({ currentStatus: status }) });
    const result = await scan(new StoreExitScanUseCase(deps), "SK6_RED_7/10_000037");

    assert.equal(result.accepted, false, status);
    assert.equal(result.outcome, "NOT_ELIGIBLE", status);
    assert.equal(result.currentStatus, status);
    assert.equal((world.get("SK6_RED_7/10_000037") as StoreExitQrRecord).currentStatus, status);
    assert.deepEqual(writes, { markAtGate: 0, events: 0, moves: 0, outbox: 0 }, status);
  }
});

test("malformed input is INVALID_FORMAT before any lookup", async () => {
  const { deps, writes } = createWorld({});
  let lookups = 0;
  deps.qrLookupRepo = {
    async getQrForStoreExit() {
      lookups += 1;
      return null;
    },
  };
  const result = await scan(new StoreExitScanUseCase(deps), "not a qr");
  assert.equal(result.outcome, "INVALID_FORMAT");
  assert.equal(lookups, 0);
  assert.deepEqual(writes, { markAtGate: 0, events: 0, moves: 0, outbox: 0 });
});

test("a raw material QR is recognised, not called invalid, and moves nothing", async () => {
  const { deps, writes } = createWorld({});
  let lookups = 0;
  deps.qrLookupRepo = {
    async getQrForStoreExit() {
      lookups += 1;
      return null;
    },
  };
  const result = await scan(new StoreExitScanUseCase(deps), "RMQR_PTY000001_RM000001_000001");
  assert.equal(result.accepted, false);
  assert.equal(result.outcome, "RAW_MATERIAL_NOT_SUPPORTED", "a registered raw material label is not a bad print");
  assert.match(result.reason ?? "", /raw material/i);
  assert.equal(lookups, 0, "nothing is looked up for a format this screen cannot move");
  assert.deepEqual(writes, { markAtGate: 0, events: 0, moves: 0, outbox: 0 });
});

test("a mixed sequence: failures never break the following scans", async () => {
  const { deps, writes } = createWorld({
    "SK6_RED_7/10_000001": unit({ qrId: "SK6_RED_7/10_000001" }),
    "SK6_RED_7/10_000002": unit({ qrId: "SK6_RED_7/10_000002" }),
    "SK6_RED_7/10_000003": unit({ qrId: "SK6_RED_7/10_000003", currentStatus: "PRODUCED", currentLocationType: "FACTORY" }),
    "SK6_RED_7/10_000004": unit({ qrId: "SK6_RED_7/10_000004" }),
  });
  const useCase = new StoreExitScanUseCase(deps);

  const sequence = [
    "SK6_RED_7/10_000001", // valid
    "SK6_RED_7/10_999999", // unknown
    "SK6_RED_7/10_000002", // valid
    "SK6_RED_7/10_000001", // duplicate
    "SK6_RED_7/10_000003", // never entered the store
    "SK6_RED_7/10_000004", // valid
  ];
  const outcomes = [];
  for (const raw of sequence) outcomes.push((await scan(useCase, raw)).outcome);

  assert.deepEqual(outcomes, ["MOVED_OUT", "UNKNOWN_QR", "MOVED_OUT", "ALREADY_AT_GATE", "NOT_IN_STORE", "MOVED_OUT"]);
  assert.deepEqual(writes, { markAtGate: 3, events: 3, moves: 3, outbox: 3 });
});

test("a stale read loses to the guarded update: second terminal gets ALREADY_AT_GATE with no writes", async () => {
  const { deps, writes } = createWorld({ "SK6_RED_7/10_000037": unit() });
  const staleRead = unit();
  deps.qrLookupRepo = { async getQrForStoreExit() { return { ...staleRead }; } };
  const useCase = new StoreExitScanUseCase(deps);

  const first = await scan(useCase, "SK6_RED_7/10_000037");
  const second = await scan(useCase, "SK6_RED_7/10_000037");

  assert.equal(first.outcome, "MOVED_OUT");
  assert.equal(second.accepted, false);
  assert.equal(second.outcome, "ALREADY_AT_GATE");
  assert.deepEqual(writes, { markAtGate: 1, events: 1, moves: 1, outbox: 1 });
});

test("unexpected infrastructure errors propagate instead of being reported as rejections", async () => {
  const { deps } = createWorld({ "SK6_RED_7/10_000037": unit() });
  deps.storeExitEventsRepo = {
    async appendStoreExitEvent() {
      throw new Error("disk full");
    },
  };
  await assert.rejects(scan(new StoreExitScanUseCase(deps), "SK6_RED_7/10_000037"), /disk full/);
});

// ─── Gatepass reconciliation ──────────────────────────────────────────────────
// The operator never names a Gatepass. After the physical move is decided, the scan asks
// the repository for the oldest open line still owing this exact variant and records that
// gatepass on the event. The fake below keeps a FIFO list of lines and does what the real
// derived count does once the event exists.

interface FakeLine extends OutstandingGatepassLine {
  productVariantId: string;
}

function withReservations(world: ReturnType<typeof createWorld>, lines: FakeLine[]) {
  const state = lines.map((line) => ({ ...line }));
  const appended: Array<Parameters<StoreExitScanDeps["storeExitEventsRepo"]["appendStoreExitEvent"]>[0]> = [];
  world.deps.gatepassRepo = {
    async findOldestOutstandingGatepassLine(productVariantId) {
      const line = state
        .filter((candidate) => candidate.productVariantId === productVariantId && candidate.quantity > candidate.dispatchedFromStoreQuantity)
        .sort((a, b) => a.gatepassNumber - b.gatepassNumber)[0];
      return line ? { ...line } : null;
    },
    findGatepassLineForVariant() {
      return null;
    },
    readGatepassStatus() {
      return null;
    },
    gatepassStoreScanComplete() {
      return false;
    },
    advanceGatepassStatus() {
      return false;
    },
  };
  world.deps.storeExitEventsRepo = {
    async appendStoreExitEvent(payload) {
      appended.push(payload);
      world.writes.events += 1;
      const line = state.find((candidate) => candidate.gatepassId === payload.gatepassId && candidate.productVariantId === payload.productVariantId);
      if (line) line.dispatchedFromStoreQuantity += 1;
    },
  };
  return { appended, state };
}

const line = (gatepassNumber: number, productVariantId: string, color: string, quantity: number, dispatched = 0): FakeLine => ({
  gatepassId: `gp-${gatepassNumber}`,
  gatepassNumber,
  partyName: "ABC TRADERS",
  productVariantId,
  article: "SK6",
  color,
  size: "7/10",
  quantity,
  dispatchedFromStoreQuantity: dispatched,
});

test("reconciliation: a plain scan counts against the oldest open line for its variant — GP1 (2) before GP2 (1) — and reports the line's progress", async () => {
  const w = createWorld({
    "SK6_RED_7/10_000001": unit({ qrId: "SK6_RED_7/10_000001" }),
    "SK6_RED_7/10_000002": unit({ qrId: "SK6_RED_7/10_000002" }),
    "SK6_RED_7/10_000003": unit({ qrId: "SK6_RED_7/10_000003" }),
    "SK6_RED_7/10_000004": unit({ qrId: "SK6_RED_7/10_000004" }),
  });
  const { appended } = withReservations(w, [line(2, "variant-sk6-red-7-10", "RED", 1), line(1, "variant-sk6-red-7-10", "RED", 2)]);
  const useCase = new StoreExitScanUseCase(w.deps);

  const first = await scan(useCase, "SK6_RED_7/10_000001");
  assert.equal(first.outcome, "MOVED_OUT");
  assert.deepEqual(first.gatepass, { gatepassId: "gp-1", code: "GP-000001", partyName: "ABC TRADERS", article: "SK6", color: "RED", size: "7/10", requested: 2, dispatchedFromStore: 1, outstanding: 1 });

  const second = await scan(useCase, "SK6_RED_7/10_000002");
  assert.deepEqual([second.gatepass?.code, second.gatepass?.dispatchedFromStore, second.gatepass?.outstanding], ["GP-000001", 2, 0]);

  const third = await scan(useCase, "SK6_RED_7/10_000003");
  assert.deepEqual([third.gatepass?.code, third.gatepass?.dispatchedFromStore, third.gatepass?.outstanding], ["GP-000002", 1, 0]);

  // Nothing left reserved: the fourth carton moves out for nobody, and still moves out.
  const fourth = await scan(useCase, "SK6_RED_7/10_000004");
  assert.equal(fourth.outcome, "MOVED_OUT");
  assert.equal(fourth.gatepass, undefined);

  assert.deepEqual(appended.map((e) => e.gatepassId), ["gp-1", "gp-1", "gp-2", null]);
  assert.deepEqual(w.writes, { markAtGate: 4, events: 4, moves: 4, outbox: 4 });
});

test("reconciliation: a different colour never consumes another colour's reservation", async () => {
  const w = createWorld({ "SK6_BLUE_7/10_000001": unit({ qrId: "SK6_BLUE_7/10_000001", productVariantId: "variant-sk6-blue-7-10", color: "BLUE" }) });
  const { appended, state } = withReservations(w, [line(1, "variant-sk6-red-7-10", "RED", 2)]);

  const result = await scan(new StoreExitScanUseCase(w.deps), "SK6_BLUE_7/10_000001");
  assert.equal(result.outcome, "MOVED_OUT");
  assert.equal(result.gatepass, undefined);
  assert.equal(appended[0].gatepassId, null);
  assert.equal(state[0].dispatchedFromStoreQuantity, 0, "the RED line is untouched");
});

test("reconciliation: the reservation is looked up only after the physical move is decided — a refused carton never touches it", async () => {
  const w = createWorld({ "SK6_RED_7/10_000037": unit({ currentStatus: "TO_GATE", currentLocationType: "GATE" }) });
  let lookups = 0;
  w.deps.gatepassRepo = {
    async findOldestOutstandingGatepassLine() {
      lookups += 1;
      return null;
    },
    findGatepassLineForVariant() {
      return null;
    },
    readGatepassStatus() {
      return null;
    },
    gatepassStoreScanComplete() {
      return false;
    },
    advanceGatepassStatus() {
      return false;
    },
  };
  const result = await scan(new StoreExitScanUseCase(w.deps), "SK6_RED_7/10_000037");
  assert.equal(result.outcome, "ALREADY_AT_GATE");
  assert.equal(lookups, 0);
});

test("reconciliation: a failure while reading the reservation aborts the whole scan — the error propagates so the transaction rolls back", async () => {
  const w = createWorld({ "SK6_RED_7/10_000037": unit() });
  w.deps.gatepassRepo = {
    async findOldestOutstandingGatepassLine() {
      throw new Error("gatepass read failed");
    },
    findGatepassLineForVariant() {
      return null;
    },
    readGatepassStatus() {
      return null;
    },
    gatepassStoreScanComplete() {
      return false;
    },
    advanceGatepassStatus() {
      return false;
    },
  };
  await assert.rejects(scan(new StoreExitScanUseCase(w.deps), "SK6_RED_7/10_000037"), /gatepass read failed/);
  // The event, stock move and outbox row were never reached; the real database also undoes the status move.
  assert.deepEqual(w.writes, { markAtGate: 1, events: 0, moves: 0, outbox: 0 });
});
