import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryEventBus } from "./eventBus.js";
import { ReturnRejectedError, ReturnScanUseCase } from "./returnScanUseCase.js";
import type { DispatchAttribution, ExistingReturn, ReturnQrRecord, ReturnScanDeps } from "./returnScanUseCase.js";
import type { TransactionContext } from "./ports.js";

// The use case is driven with in-memory fakes that count what each port was asked to write,
// so "the party was credited exactly once" and "no stock moved" are asserted, not assumed.
//
// The rule these tests exist to protect: recording a return is a COMMERCIAL event. It
// credits the customer and leaves the carton standing ON_GATE. It does not move stock and
// does not receive the carton into the store — a separate, ordinary Store Move In does that.

const CONTEXT = { factoryId: "factory-777", workstationId: "ws-gate-01", deviceId: "desktop-gate" };
const QR = "SK6_RED_7/10_000123";

interface Writes {
  markOnGate: number;
  credits: number;
  events: number;
  outbox: number;
}

function unit(overrides: Partial<ReturnQrRecord> = {}): ReturnQrRecord {
  return {
    qrId: QR,
    productVariantId: "variant-sk6-red-7-10",
    currentStatus: "DISPATCHED",
    article: "SK6",
    color: "RED",
    size: "7/10",
    ...overrides,
  };
}

function attribution(overrides: Partial<DispatchAttribution> = {}): DispatchAttribution {
  return {
    dispatchEventId: "dispatch-event-1",
    dispatchedAt: "2026-09-20T09:00:00.000Z",
    dispatchSessionId: "session-1",
    partyId: "party-mama",
    partyName: "MAMA CHAPPAL",
    saleVoucherId: "voucher-125",
    saleVoucherNumber: "125",
    saleVoucherLineItemId: "line-1",
    unitPrice: 180,
    discountPerPair: 0,
    creditAmount: 1080, // one carton = 6 pairs at 180
    ...overrides,
  };
}

/**
 * A tiny in-memory qr_master + sale_returns. `markOnGate` is a guarded update exactly like
 * the SQLite one (it only applies while the carton is DISPATCHED) and `recordSaleReturn`
 * enforces the unique-per-dispatch-event rule the database index enforces for real.
 */
function createWorld(initial: Record<string, ReturnQrRecord>, dispatch: DispatchAttribution | null = attribution()) {
  const world = new Map(Object.entries(initial));
  const returnsByDispatchEvent = new Map<string, ExistingReturn>();
  const writes: Writes = { markOnGate: 0, credits: 0, events: 0, outbox: 0 };
  let sequence = 0;

  const deps: ReturnScanDeps = {
    txManager: {
      async runInTransaction<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
        return work({ nowIso: "2026-09-22T11:30:00.000Z" });
      },
    },
    qrLookupRepo: {
      async getQrForReturn(qrId) {
        const entry = world.get(qrId);
        return entry ? { ...entry } : null;
      },
    },
    attributionRepo: {
      async findActiveDispatchAttribution() {
        return dispatch ? { ...dispatch } : null;
      },
      async findReturnForDispatchEvent(dispatchEventId) {
        return returnsByDispatchEvent.get(dispatchEventId) ?? null;
      },
    },
    qrMasterRepo: {
      async markOnGate({ qrId, locationId }) {
        const entry = world.get(qrId);
        if (!entry) throw new ReturnRejectedError("UNKNOWN_QR", "gone");
        if (entry.currentStatus === "ON_GATE") throw new ReturnRejectedError("ALREADY_RETURNED", "already");
        if (entry.currentStatus !== "DISPATCHED") throw new ReturnRejectedError("NOT_DISPATCHED", "changed");
        world.set(qrId, { ...entry, currentStatus: "ON_GATE" });
        writes.markOnGate += 1;
      },
    },
    saleReturnsRepo: {
      async recordSaleReturn(payload) {
        // The database's partial unique index, in miniature: one live return per dispatch.
        if (returnsByDispatchEvent.has(payload.attribution.dispatchEventId)) {
          throw new Error("UNIQUE constraint failed: sale_returns.dispatch_event_id");
        }
        sequence += 1;
        const returnNumber = `SR-${String(sequence).padStart(6, "0")}`;
        returnsByDispatchEvent.set(payload.attribution.dispatchEventId, {
          saleReturnId: payload.saleReturnId,
          returnNumber,
          returnedAt: payload.occurredAt,
          partyId: payload.attribution.partyId,
          partyName: payload.attribution.partyName,
          saleVoucherNumber: payload.attribution.saleVoucherNumber,
          creditAmount: payload.attribution.creditAmount,
        });
        writes.credits += 1;
        return { saleReturnId: payload.saleReturnId, returnNumber };
      },
    },
    returnEventsRepo: {
      async appendReturnRecordedEvent() {
        writes.events += 1;
      },
    },
    outboxRepo: {
      async enqueueReturn() {
        writes.outbox += 1;
      },
    },
    eventPublisher: new InMemoryEventBus(),
    idGenerator: { nextId: () => crypto.randomUUID() },
    localDate: () => "2026-09-22",
  };

  return { deps, world, writes, returnsByDispatchEvent };
}

const NO_WRITES: Writes = { markOnGate: 0, credits: 0, events: 0, outbox: 0 };

// ─── TEST B — the party is resolved from the QR, never chosen ─────────────────

test("TEST B — scanning a dispatched carton resolves its party and voucher with no operator input", async () => {
  const { deps, writes } = createWorld({ [QR]: unit() });

  const preview = await new ReturnScanUseCase(deps).lookup({ rawScan: QR });

  assert.equal(preview.accepted, true);
  assert.equal(preview.currentStatus, "DISPATCHED", "the operator is shown DISPATCHED before confirming");
  assert.equal(preview.attribution?.partyName, "MAMA CHAPPAL");
  assert.equal(preview.attribution?.saleVoucherNumber, "125");
  assert.deepEqual([preview.article, preview.color, preview.size], ["SK6", "RED", "7/10"]);
  // A preview must never write anything: a mis-scan has to cost nothing.
  assert.deepEqual(writes, NO_WRITES);
});

test("the party comes from the CURRENT dispatch, so an earlier customer is never re-credited", async () => {
  // The carton went to MAMA CHAPPAL, came back, and has since gone out to ABC TRADERS.
  const { deps } = createWorld(
    { [QR]: unit() },
    attribution({ dispatchEventId: "dispatch-event-2", partyId: "party-abc", partyName: "ABC TRADERS", saleVoucherNumber: "131" })
  );

  const confirmed = await new ReturnScanUseCase(deps).execute({ rawScan: QR, context: CONTEXT });

  assert.equal(confirmed.attribution?.partyName, "ABC TRADERS");
  assert.equal(confirmed.attribution?.saleVoucherNumber, "131");
});

// ─── TEST C — a return is not a store entry ──────────────────────────────────

test("TEST C — confirming a return leaves the carton ON_GATE and moves no stock", async () => {
  const { deps, world, writes } = createWorld({ [QR]: unit() });

  const result = await new ReturnScanUseCase(deps).execute({ rawScan: QR, context: CONTEXT, actor: "gate-op" });

  assert.equal(result.accepted, true);
  assert.equal(result.outcome, "RETURN_RECORDED");
  assert.equal(result.currentStatus, "ON_GATE");
  assert.equal(result.attribution?.partyName, "MAMA CHAPPAL");
  assert.equal(result.returnNumber, "SR-000001");

  // The carton is at the gate — NOT in store.
  const after = world.get(QR)!;
  assert.equal(after.currentStatus, "ON_GATE");

  // Exactly one status move, one credit, one event, one outbox row — and no stock port
  // exists on these deps at all, which is the structural guarantee that a recorded return
  // cannot touch stock even by mistake.
  assert.deepEqual(writes, { markOnGate: 1, credits: 1, events: 1, outbox: 1 });
  assert.equal("stockProjectionRepo" in deps, false, "a recorded return has no stock port to call");
});

test("the credit is the carton's own share of its bill line, in exact money", async () => {
  const { deps } = createWorld({ [QR]: unit() }, attribution({ unitPrice: 180, discountPerPair: 30, creditAmount: 900 }));

  const result = await new ReturnScanUseCase(deps).execute({ rawScan: QR, context: CONTEXT });

  // 6 pairs × (180 − 30) = 900.
  assert.equal(result.attribution?.creditAmount, 900);
});

// ─── TEST E — a second return scan must not double-credit ────────────────────

test("TEST E — scanning the same carton again records no second return and no second credit", async () => {
  const { deps, world, writes } = createWorld({ [QR]: unit() });
  const useCase = new ReturnScanUseCase(deps);

  const first = await useCase.execute({ rawScan: QR, context: CONTEXT });
  assert.equal(first.accepted, true);

  const second = await useCase.execute({ rawScan: QR, context: CONTEXT });

  assert.equal(second.accepted, false);
  assert.equal(second.outcome, "ALREADY_RETURNED");
  assert.match(second.reason ?? "", /already been recorded|already recorded/i);
  assert.match(second.reason ?? "", /Store Move In/i, "the operator is told what it is waiting for");
  assert.equal(second.existingReturn?.returnNumber, "SR-000001");
  assert.equal(second.existingReturn?.partyName, "MAMA CHAPPAL");

  // Still exactly one of everything from the first scan.
  assert.deepEqual(writes, { markOnGate: 1, credits: 1, events: 1, outbox: 1 });
  assert.equal(world.get(QR)!.currentStatus, "ON_GATE");
});

test("a preview of an already-returned carton explains it is waiting for the store", async () => {
  const { deps, writes } = createWorld({ [QR]: unit() });
  const useCase = new ReturnScanUseCase(deps);
  await useCase.execute({ rawScan: QR, context: CONTEXT });

  const preview = await useCase.lookup({ rawScan: QR });

  assert.equal(preview.accepted, false);
  assert.equal(preview.outcome, "ALREADY_RETURNED");
  assert.equal(preview.existingReturn?.partyName, "MAMA CHAPPAL");
  assert.deepEqual(writes, { markOnGate: 1, credits: 1, events: 1, outbox: 1 });
});

// ─── TEST H — only a dispatched carton can be returned ───────────────────────

test("TEST H — a carton that is not with a customer is rejected and nothing is written", async () => {
  for (const status of ["WAREHOUSE", "PRODUCED", "TO_GATE", "SOLD", "DAMAGED", "SCRAPPED"]) {
    const { deps, world, writes } = createWorld({ [QR]: unit({ currentStatus: status }) });

    const result = await new ReturnScanUseCase(deps).execute({ rawScan: QR, context: CONTEXT });

    assert.equal(result.accepted, false, status);
    assert.equal(result.outcome, "NOT_DISPATCHED", status);
    assert.equal(result.currentStatus, status, status);
    assert.equal(world.get(QR)!.currentStatus, status, status);
    assert.deepEqual(writes, NO_WRITES, status);
  }
});

test("an In Store carton is told plainly why it cannot be returned", async () => {
  const { deps } = createWorld({ [QR]: unit({ currentStatus: "WAREHOUSE" }) });
  const result = await new ReturnScanUseCase(deps).lookup({ rawScan: QR });
  assert.equal(result.outcome, "NOT_DISPATCHED");
  assert.match(result.reason ?? "", /In Store/i);
});

test("an unknown QR is rejected and nothing is written", async () => {
  const { deps, writes } = createWorld({});
  const result = await new ReturnScanUseCase(deps).execute({ rawScan: QR, context: CONTEXT });

  assert.equal(result.accepted, false);
  assert.equal(result.outcome, "UNKNOWN_QR");
  assert.deepEqual(writes, NO_WRITES);
});

test("malformed input is INVALID_FORMAT before any lookup", async () => {
  const { deps, writes } = createWorld({});
  let lookups = 0;
  deps.qrLookupRepo = {
    async getQrForReturn() {
      lookups += 1;
      return null;
    },
  };

  const result = await new ReturnScanUseCase(deps).execute({ rawScan: "not a qr", context: CONTEXT });

  assert.equal(result.outcome, "INVALID_FORMAT");
  assert.equal(lookups, 0);
  assert.deepEqual(writes, NO_WRITES);
});

// ─── No attribution means no guess ───────────────────────────────────────────

test("a carton dispatched with no bill selected is refused rather than credited to a guess", async () => {
  const { deps, world, writes } = createWorld({ [QR]: unit() }, null);

  const result = await new ReturnScanUseCase(deps).execute({ rawScan: QR, context: CONTEXT });

  assert.equal(result.accepted, false);
  assert.equal(result.outcome, "NO_ATTRIBUTION");
  assert.equal(result.attribution, null);
  assert.match(result.reason ?? "", /which customer/i);
  assert.equal(world.get(QR)!.currentStatus, "DISPATCHED", "the carton is left exactly as it was");
  assert.deepEqual(writes, NO_WRITES);
});

// ─── Atomicity ───────────────────────────────────────────────────────────────

test("a failing credit aborts the whole return — no event and no outbox row survive it", async () => {
  const { deps, writes } = createWorld({ [QR]: unit() });
  deps.saleReturnsRepo = {
    async recordSaleReturn() {
      throw new Error("UNIQUE constraint failed: sale_returns.dispatch_event_id");
    },
  };

  await assert.rejects(() => new ReturnScanUseCase(deps).execute({ rawScan: QR, context: CONTEXT }), /UNIQUE constraint/);

  // markOnGate ran before the failure; the real transaction rolls it back. What matters
  // here is that no event and no outbox row were written after the credit failed.
  assert.equal(writes.credits, 0);
  assert.equal(writes.events, 0);
  assert.equal(writes.outbox, 0);
});
