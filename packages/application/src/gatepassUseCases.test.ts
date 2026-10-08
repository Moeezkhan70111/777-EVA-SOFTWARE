import test from "node:test";
import assert from "node:assert/strict";
import { CancelGatepassUseCase, CreateGatepassUseCase, formatGatepassCode } from "./gatepassUseCases.js";
import type { BillingNoticePayload, CancelGatepassDeps, CreateGatepassDeps, GatepassHeaderPayload, GatepassLinePayload, GatepassVariantStock, AuditLogPayload } from "./gatepassUseCases.js";
import type { TransactionContext } from "./ports.js";

// Same approach as the store station tests: in-memory fakes count every write and every
// rollback, so "nothing was written" is asserted, not assumed. The real-database run of
// the same rules — including actual Store Move Out scans — lives in @erp/data
// (gatepass.test.ts and gatepassReservations.test.ts).
//
// The fake repository derives Reserved exactly as the real one does: the sum over CREATED
// documents' lines of (requested − dispatched from store). `world.dispatched` stands in for
// the STORE_EXIT events a real store scan would write.

const NOW = "2026-09-16T10:00:00.000Z";

interface World {
  parties: Record<string, { id: string; partyName: string; status: string }>;
  /** Current Stock per variant (physical In Store). Reserved is derived, never set here. */
  stock: Record<string, Omit<GatepassVariantStock, "reservedQuantity">>;
  nextNumber: number;
  /** Live sale vouchers by the gatepass they were made from — what cancel must warn about. */
  bills: Record<string, { id: string; voucherNumber: string }>;
  /** Cartons Store Move Out has taken per line id — what a real STORE_EXIT event would record. */
  dispatched: Record<string, number>;
}

function createWorld(initial: Partial<World> = {}) {
  const world: World = { parties: {}, stock: {}, nextNumber: 1, bills: {}, dispatched: {}, ...initial };
  const headers: GatepassHeaderPayload[] = [];
  const lines: GatepassLinePayload[] = [];
  const audit: AuditLogPayload[] = [];
  const notices: BillingNoticePayload[] = [];
  const cancelledIds = new Set<string>();
  let rollbacks = 0;
  let commits = 0;
  let cancelled: { gatepassId: string; cancelledBy: string; reason: string } | null = null;
  let ids = 0;

  const txManager = {
    async runInTransaction<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
      // Snapshot so a thrown rejection really leaves nothing behind, like ROLLBACK does.
      const snapshot = { headers: headers.length, lines: lines.length, audit: audit.length, notices: notices.length, nextNumber: world.nextNumber };
      try {
        const result = await work({ nowIso: NOW });
        commits += 1;
        return result;
      } catch (error) {
        headers.length = snapshot.headers;
        lines.length = snapshot.lines;
        audit.length = snapshot.audit;
        notices.length = snapshot.notices;
        world.nextNumber = snapshot.nextNumber;
        rollbacks += 1;
        throw error;
      }
    },
  };

  const dispatchedFor = (line: GatepassLinePayload) => world.dispatched[line.id] ?? 0;
  const reservedFor = (variantId: string) =>
    lines
      .filter((line) => line.productVariantId === variantId && !cancelledIds.has(line.gatepassId))
      .reduce((sum, line) => sum + (line.quantity - dispatchedFor(line)), 0);

  const createDeps: CreateGatepassDeps = {
    txManager,
    repo: {
      async getPartyForGatepass(partyId) {
        const party = world.parties[partyId];
        return party ? { ...party } : null;
      },
      async getStoreStockForVariants(variantIds) {
        return variantIds
          .map((id) => world.stock[id])
          .filter((row): row is World["stock"][string] => Boolean(row))
          .map((row) => ({ ...row, reservedQuantity: reservedFor(row.productVariantId) }));
      },
      async allocateGatepassNumber() {
        return world.nextNumber++;
      },
      async insertGatepass(payload) {
        headers.push({ ...payload });
      },
      async insertGatepassLines(payload) {
        lines.push(...payload.map((line) => ({ ...line })));
      },
      async appendAuditLog(payload) {
        audit.push({ ...payload });
      },
      async notifyBilling(payload) {
        notices.push({ ...payload });
      },
    },
    idGenerator: { nextId: () => `id-${++ids}` },
    localDate: () => "2026-09-16",
  };

  const cancelDeps: CancelGatepassDeps = {
    txManager,
    repo: {
      async getGatepassForCancel(gatepassId) {
        const header = headers.find((h) => h.id === gatepassId);
        if (!header) return null;
        return {
          id: header.id,
          gatepassNumber: header.gatepassNumber,
          status: cancelledIds.has(gatepassId) ? "CANCELLED" : "CREATED",
          lines: lines
            .filter((line) => line.gatepassId === gatepassId)
            .map((line) => ({ productVariantId: line.productVariantId, article: line.article, color: line.color, size: line.size, quantity: line.quantity, dispatchedFromStoreQuantity: dispatchedFor(line) })),
        };
      },
      async markGatepassCancelled(payload) {
        if (cancelledIds.has(payload.gatepassId)) return false;
        cancelledIds.add(payload.gatepassId);
        cancelled = { gatepassId: payload.gatepassId, cancelledBy: payload.cancelledBy, reason: payload.reason };
        return true;
      },
      async appendAuditLog(payload) {
        audit.push({ ...payload });
      },
      async getLinkedSaleVoucher(gatepassId) {
        return world.bills[gatepassId] ? { ...world.bills[gatepassId] } : null;
      },
      async notifyBilling(payload) {
        notices.push({ ...payload });
      },
    },
    idGenerator: { nextId: () => `id-${++ids}` },
  };

  /** What a real Store Move Out scan does to the figures: Current −1 on the variant, line dispatched +1. */
  const moveOutFromStore = (gatepassId: string, variantId: string, cartons: number) => {
    const line = lines.find((l) => l.gatepassId === gatepassId && l.productVariantId === variantId);
    if (!line) throw new Error("no such line");
    world.dispatched[line.id] = dispatchedFor(line) + cartons;
    world.stock[variantId] = { ...world.stock[variantId], storeQuantity: world.stock[variantId].storeQuantity - cartons };
  };

  /** Current / Reserved / Reflected for a variant, the way the screen would show them. */
  const figures = (variantId: string) => {
    const current = world.stock[variantId].storeQuantity;
    const reserved = reservedFor(variantId);
    return { current, reserved, reflected: current - reserved };
  };

  return {
    world,
    headers,
    lines,
    audit,
    notices,
    creator: new CreateGatepassUseCase(createDeps),
    canceller: new CancelGatepassUseCase(cancelDeps),
    counts: () => ({ commits, rollbacks, headers: headers.length, lines: lines.length, audit: audit.length, notices: notices.length }),
    cancelledState: () => cancelled,
    moveOutFromStore,
    figures,
  };
}

const RED = { productVariantId: "v-red", article: "SK6", color: "RED", size: "7/10", storeQuantity: 120 };
const BLUE = { productVariantId: "v-blue", article: "SK6", color: "BLUE", size: "7/10", storeQuantity: 80 };
const ABC = { id: "p-abc", partyName: "ABC TRADERS", status: "ACTIVE" };

test("formatGatepassCode pads to six digits", () => {
  assert.equal(formatGatepassCode(1), "GP-000001");
  assert.equal(formatGatepassCode(123), "GP-000123");
  assert.equal(formatGatepassCode(1234567), "GP-1234567");
});

test("a valid document writes exactly one header, its lines, one audit row, one billing notice, and returns GP-000001", async () => {
  const w = createWorld({ parties: { [ABC.id]: ABC }, stock: { [RED.productVariantId]: RED, [BLUE.productVariantId]: BLUE } });

  const result = await w.creator.execute({
    partyId: ABC.id,
    lines: [
      { productVariantId: "v-red", quantity: 50, reflectedStockSeen: 120 },
      { productVariantId: "v-blue", quantity: 20 },
    ],
    biltyNumber: " B-4471 ",
    transportVia: "   ",
    remarks: " truck 12 ",
    actor: "clerk",
    actorUserId: "user-1",
    deviceId: "desktop-main",
  });

  assert.equal(result.accepted, true, result.reason);
  assert.equal(result.outcome, "CREATED");
  assert.equal(result.code, "GP-000001");
  assert.equal(result.gatepassNumber, 1);
  assert.equal(result.totalQuantity, 70);
  assert.equal(result.createdAt, NOW);
  assert.deepEqual(w.counts(), { commits: 1, rollbacks: 0, headers: 1, lines: 2, audit: 1, notices: 1 });

  const header = w.headers[0];
  assert.equal(header.id, result.gatepassId);
  assert.equal(header.partyId, ABC.id);
  assert.equal(header.gatepassDate, "2026-09-16");
  assert.equal(header.biltyNumber, "B-4471", "trimmed");
  assert.equal(header.transportVia, null, "blank means not given");
  assert.equal(header.remarks, "truck 12");
  assert.equal(header.totalQuantity, 70);
  assert.equal(header.createdBy, "clerk");
  assert.equal(header.createdAt, NOW);

  assert.deepEqual(
    w.lines.map((l) => [l.gatepassId, l.lineNo, l.productVariantId, l.article, l.color, l.size, l.quantity, l.storeQuantityAtCreation]),
    [
      [header.id, 1, "v-red", "SK6", "RED", "7/10", 50, 120],
      [header.id, 2, "v-blue", "SK6", "BLUE", "7/10", 20, 80],
    ]
  );

  const audit = w.audit[0];
  assert.equal(audit.eventType, "GATEPASS_CREATED");
  assert.equal(audit.entityType, "GATEPASS");
  assert.equal(audit.entityId, header.id);
  assert.equal(audit.actorUserId, "user-1");
  assert.equal(audit.actorDeviceId, "desktop-main");
  assert.equal(audit.occurredAt, NOW);
  assert.equal(audit.payload.code, "GP-000001");
  assert.equal(audit.payload.actor, "clerk");
  assert.equal(audit.payload.biltyNumber, "B-4471");
  assert.equal(audit.payload.transportVia, null);
  // The audit row states the three figures each line was checked against.
  assert.deepEqual(
    (audit.payload.lines as Array<Record<string, unknown>>).map((l) => [l.quantity, l.storeQuantityAtCreation, l.reservedAtCreation, l.reflectedStockAtCreation]),
    [
      [50, 120, 0, 120],
      [20, 80, 0, 80],
    ]
  );

  // The billing desk is told, in the same transaction, which document to bill.
  assert.deepEqual(w.notices[0], {
    kind: "GATEPASS_CREATED",
    severity: "INFO",
    entityId: header.id,
    title: "New Gatepass GP-000001",
    message: "70 cartons for ABC TRADERS. Open it to make the sale voucher.",
  });
});

test("input checks that need no database are rejected before any transaction starts", async () => {
  const w = createWorld({ parties: { [ABC.id]: ABC }, stock: { [RED.productVariantId]: RED } });
  const line = { productVariantId: "v-red", quantity: 1 };

  const cases: Array<[Parameters<typeof w.creator.execute>[0], string]> = [
    [{ partyId: "", lines: [line], actor: "clerk" }, "NO_PARTY"],
    [{ partyId: ABC.id, lines: [], actor: "clerk" }, "NO_LINES"],
    [{ partyId: ABC.id, lines: [{ productVariantId: "", quantity: 1 }], actor: "clerk" }, "VARIANT_NOT_FOUND"],
    [{ partyId: ABC.id, lines: [{ productVariantId: "v-red", quantity: 0 }], actor: "clerk" }, "INVALID_QUANTITY"],
    [{ partyId: ABC.id, lines: [{ productVariantId: "v-red", quantity: -1 }], actor: "clerk" }, "INVALID_QUANTITY"],
    [{ partyId: ABC.id, lines: [{ productVariantId: "v-red", quantity: 2.5 }], actor: "clerk" }, "INVALID_QUANTITY"],
    [{ partyId: ABC.id, lines: [{ productVariantId: "v-red", quantity: "5" as unknown as number }], actor: "clerk" }, "INVALID_QUANTITY"],
    [{ partyId: ABC.id, lines: [line, { productVariantId: "v-red", quantity: 2 }], actor: "clerk" }, "DUPLICATE_LINE"],
  ];
  for (const [input, outcome] of cases) {
    const result = await w.creator.execute(input);
    assert.equal(result.accepted, false, outcome);
    assert.equal(result.outcome, outcome);
    assert.ok(result.reason);
  }
  assert.deepEqual(w.counts(), { commits: 0, rollbacks: 0, headers: 0, lines: 0, audit: 0, notices: 0 });

  await assert.rejects(() => w.creator.execute({ partyId: ABC.id, lines: [line], actor: "  " }), /acting user/);
});

test("party and variant checks inside the transaction roll back with nothing written", async () => {
  const w = createWorld({
    parties: { [ABC.id]: ABC, "p-old": { id: "p-old", partyName: "OLD TRADERS", status: "INACTIVE" } },
    stock: { [RED.productVariantId]: RED },
  });

  assert.equal((await w.creator.execute({ partyId: "p-missing", lines: [{ productVariantId: "v-red", quantity: 1 }], actor: "clerk" })).outcome, "PARTY_NOT_FOUND");
  const inactive = await w.creator.execute({ partyId: "p-old", lines: [{ productVariantId: "v-red", quantity: 1 }], actor: "clerk" });
  assert.equal(inactive.outcome, "PARTY_INACTIVE");
  assert.match(inactive.reason ?? "", /OLD TRADERS is inactive/);
  const missingVariant = await w.creator.execute({ partyId: ABC.id, lines: [{ productVariantId: "v-ghost", quantity: 1 }], actor: "clerk" });
  assert.equal(missingVariant.outcome, "VARIANT_NOT_FOUND");
  assert.equal(missingVariant.productVariantId, "v-ghost");

  assert.deepEqual(w.counts(), { commits: 0, rollbacks: 3, headers: 0, lines: 0, audit: 0, notices: 0 });
  assert.equal(w.world.nextNumber, 1, "no number was consumed");
});

test("stock is re-read inside the transaction: INSUFFICIENT_STOCK when the clerk saw the same figure, STOCK_CHANGED when it moved", async () => {
  const w = createWorld({ parties: { [ABC.id]: ABC }, stock: { [RED.productVariantId]: { ...RED, storeQuantity: 40 }, [BLUE.productVariantId]: BLUE } });

  const tooMany = await w.creator.execute({
    partyId: ABC.id,
    lines: [
      { productVariantId: "v-blue", quantity: 10, reflectedStockSeen: 80 },
      { productVariantId: "v-red", quantity: 50, reflectedStockSeen: 40 },
    ],
    actor: "clerk",
  });
  assert.equal(tooMany.accepted, false);
  assert.equal(tooMany.outcome, "INSUFFICIENT_STOCK");
  assert.match(tooMany.reason ?? "", /exceeds Reflected Stock for SK6 \/ RED \/ 7\/10\. Current Stock: 40\. Reserved: 0\. Reflected Stock: 40\. Requested: 50\./);
  assert.deepEqual(tooMany.shortages, [
    { productVariantId: "v-red", article: "SK6", color: "RED", size: "7/10", requested: 50, currentStock: 40, reserved: 0, reflected: 40, seen: 40 },
  ]);

  const moved = await w.creator.execute({
    partyId: ABC.id,
    lines: [{ productVariantId: "v-red", quantity: 50, reflectedStockSeen: 120 }],
    actor: "clerk",
  });
  assert.equal(moved.outcome, "STOCK_CHANGED");
  assert.match(moved.reason ?? "", /Reflected Stock changed before the Gatepass could be created/);
  assert.deepEqual(moved.shortages?.map((s) => [s.requested, s.reflected, s.seen]), [[50, 40, 120]]);

  // Without a "seen" figure the use case cannot claim the figure changed, so it says "too many".
  const unknownSeen = await w.creator.execute({ partyId: ABC.id, lines: [{ productVariantId: "v-red", quantity: 41 }], actor: "clerk" });
  assert.equal(unknownSeen.outcome, "INSUFFICIENT_STOCK");
  assert.equal(unknownSeen.shortages?.[0].seen, null);

  // Exactly Reflected Stock passes.
  const exact = await w.creator.execute({ partyId: ABC.id, lines: [{ productVariantId: "v-red", quantity: 40, reflectedStockSeen: 40 }], actor: "clerk" });
  assert.equal(exact.accepted, true, exact.reason);

  assert.deepEqual(w.counts(), { commits: 1, rollbacks: 3, headers: 1, lines: 1, audit: 1, notices: 1 });
  assert.equal(w.headers[0].gatepassNumber, 1, "rejected attempts consumed no number");
});

// ─── Reservations: the exact sequence the business rule is defined by ──────────
//
//   Current 5, Reflected 5 → GP1 = 3 → Current 5, Reflected 2 → GP2 = 1 → Current 5, Reflected 1
//   → move out GP1 → Current 2, Reflected 1 → move out GP2 → Current 1, Reflected 1

test("reservations — creating a gatepass lowers Reflected Stock and never Current Stock; a store move-out lowers Current Stock and never Reflected Stock", async () => {
  const w = createWorld({ parties: { [ABC.id]: ABC }, stock: { [RED.productVariantId]: { ...RED, storeQuantity: 5 } } });
  assert.deepEqual(w.figures("v-red"), { current: 5, reserved: 0, reflected: 5 });

  const gp1 = await w.creator.execute({ partyId: ABC.id, lines: [{ productVariantId: "v-red", quantity: 3, reflectedStockSeen: 5 }], actor: "clerk" });
  assert.equal(gp1.accepted, true, gp1.reason);
  assert.deepEqual(w.figures("v-red"), { current: 5, reserved: 3, reflected: 2 });

  const gp2 = await w.creator.execute({ partyId: ABC.id, lines: [{ productVariantId: "v-red", quantity: 1, reflectedStockSeen: 2 }], actor: "clerk" });
  assert.equal(gp2.accepted, true, gp2.reason);
  assert.deepEqual(w.figures("v-red"), { current: 5, reserved: 4, reflected: 1 });

  // Only 1 is free: 2 is refused with all three figures, 1 would be allowed.
  const gp3 = await w.creator.execute({ partyId: ABC.id, lines: [{ productVariantId: "v-red", quantity: 2, reflectedStockSeen: 1 }], actor: "clerk" });
  assert.equal(gp3.accepted, false);
  assert.equal(gp3.outcome, "INSUFFICIENT_STOCK");
  assert.deepEqual(gp3.shortages?.map((s) => [s.requested, s.currentStock, s.reserved, s.reflected]), [[2, 5, 4, 1]]);
  assert.match(gp3.reason ?? "", /Current Stock: 5\. Reserved: 4\. Reflected Stock: 1\. Requested: 2\./);

  // A clerk who saw "2" before GP2 was cut is told the figure changed, not that they asked too much.
  const stale = await w.creator.execute({ partyId: ABC.id, lines: [{ productVariantId: "v-red", quantity: 2, reflectedStockSeen: 2 }], actor: "clerk" });
  assert.equal(stale.outcome, "STOCK_CHANGED");

  // Store Move Out takes GP1's three cartons: Current falls, Reflected does not — that carton is GP2's.
  w.moveOutFromStore(gp1.gatepassId!, "v-red", 3);
  assert.deepEqual(w.figures("v-red"), { current: 2, reserved: 1, reflected: 1 });

  // Then GP2's one.
  w.moveOutFromStore(gp2.gatepassId!, "v-red", 1);
  assert.deepEqual(w.figures("v-red"), { current: 1, reserved: 0, reflected: 1 });

  assert.deepEqual(w.counts(), { commits: 2, rollbacks: 2, headers: 2, lines: 2, audit: 2, notices: 2 });
});

test("reservations — a partial move-out leaves the rest reserved, and colours / sizes are reserved independently", async () => {
  const w = createWorld({
    parties: { [ABC.id]: ABC },
    stock: { [RED.productVariantId]: { ...RED, storeQuantity: 5 }, [BLUE.productVariantId]: { ...BLUE, storeQuantity: 4 } },
  });

  const gp1 = await w.creator.execute({
    partyId: ABC.id,
    lines: [
      { productVariantId: "v-red", quantity: 3 },
      { productVariantId: "v-blue", quantity: 2 },
    ],
    actor: "clerk",
  });
  assert.equal(gp1.accepted, true, gp1.reason);
  assert.deepEqual(w.figures("v-red"), { current: 5, reserved: 3, reflected: 2 });
  assert.deepEqual(w.figures("v-blue"), { current: 4, reserved: 2, reflected: 2 }, "the red line does not touch blue");

  w.moveOutFromStore(gp1.gatepassId!, "v-red", 2);
  assert.deepEqual(w.figures("v-red"), { current: 3, reserved: 1, reflected: 2 });
  assert.deepEqual(w.figures("v-blue"), { current: 4, reserved: 2, reflected: 2 }, "untouched by a red move-out");
});

test("the use case never receives, needs or produces a QR identity, price or ledger figure", async () => {
  const w = createWorld({ parties: { [ABC.id]: ABC }, stock: { [RED.productVariantId]: RED } });
  const result = await w.creator.execute({ partyId: ABC.id, lines: [{ productVariantId: "v-red", quantity: 3 }], actor: "clerk" });
  assert.equal(result.accepted, true);
  const everything = JSON.stringify({ result, headers: w.headers, lines: w.lines, audit: w.audit }).toLowerCase();
  for (const forbidden of ["qrid", "qr_id", "serial", "rate", "price", "discount", "amount", "ledger", "balance", "debit", "credit"]) {
    assert.ok(!everything.includes(forbidden), `must not mention ${forbidden}`);
  }
});

test("cancel: marks once, records actor and reason, refuses a second time, and requires a reason", async () => {
  const w = createWorld({ parties: { [ABC.id]: ABC }, stock: { [RED.productVariantId]: RED } });
  const created = await w.creator.execute({ partyId: ABC.id, lines: [{ productVariantId: "v-red", quantity: 3 }], actor: "clerk" });

  assert.equal((await w.canceller.execute({ gatepassId: created.gatepassId!, reason: "", actor: "manager" })).outcome, "REASON_REQUIRED");
  assert.equal((await w.canceller.execute({ gatepassId: "", reason: "x", actor: "manager" })).outcome, "NOT_FOUND");
  assert.equal((await w.canceller.execute({ gatepassId: "nope", reason: "x", actor: "manager" })).outcome, "NOT_FOUND");
  await assert.rejects(() => w.canceller.execute({ gatepassId: created.gatepassId!, reason: "x", actor: "" }), /acting user/);
  assert.equal(w.cancelledState(), null);

  const first = await w.canceller.execute({ gatepassId: created.gatepassId!, reason: "wrong party", actor: "manager", actorUserId: "user-m" });
  assert.equal(first.accepted, true);
  assert.equal(first.outcome, "CANCELLED");
  assert.equal(first.code, "GP-000001");
  assert.equal(first.cancelledAt, NOW);
  assert.equal(first.releasedQuantity, 3, "nothing had moved out, so the whole reservation is released");
  assert.equal(first.dispatchedFromStoreQuantity, 0);
  assert.deepEqual(w.cancelledState(), { gatepassId: created.gatepassId, cancelledBy: "manager", reason: "wrong party" });

  const again = await w.canceller.execute({ gatepassId: created.gatepassId!, reason: "again", actor: "manager" });
  assert.equal(again.accepted, false);
  assert.equal(again.outcome, "ALREADY_CANCELLED");
  assert.match(again.reason ?? "", /GP-000001 has already been cancelled/);

  assert.deepEqual(w.audit.map((a) => a.eventType), ["GATEPASS_CREATED", "GATEPASS_CANCELLED"]);
  assert.equal(w.audit[1].actorUserId, "user-m");
  assert.equal(w.audit[1].payload.reason, "wrong party");
  assert.equal(w.audit[1].payload.releasedQuantity, 3);
  // The header and lines are untouched by cancellation.
  assert.equal(w.headers.length, 1);
  assert.equal(w.lines.length, 1);

  // No bill was made from it yet: a warning not to make one. The refused second cancel wrote nothing.
  assert.deepEqual(w.notices.map((n) => [n.kind, n.severity]), [["GATEPASS_CREATED", "INFO"], ["GATEPASS_CANCELLED", "WARNING"]]);
  assert.equal(w.notices[1].entityId, created.gatepassId);
  assert.equal(w.notices[1].title, "Gatepass GP-000001 cancelled");
  assert.match(w.notices[1].message, /Cancelled by manager: wrong party. Do not make a sale voucher/);
});

test("cancel: releases only what was still outstanding — Reflected Stock returns, cartons already moved out do not", async () => {
  const w = createWorld({ parties: { [ABC.id]: ABC }, stock: { [RED.productVariantId]: { ...RED, storeQuantity: 5 } } });

  // Untouched document: cancelling gives every carton back to Reflected Stock, Current unchanged.
  const whole = await w.creator.execute({ partyId: ABC.id, lines: [{ productVariantId: "v-red", quantity: 3 }], actor: "clerk" });
  assert.deepEqual(w.figures("v-red"), { current: 5, reserved: 3, reflected: 2 });
  const wholeCancel = await w.canceller.execute({ gatepassId: whole.gatepassId!, reason: "wrong party", actor: "manager" });
  assert.equal(wholeCancel.releasedQuantity, 3);
  assert.deepEqual(w.figures("v-red"), { current: 5, reserved: 0, reflected: 5 });

  // Partly moved out: only the outstanding 1 comes back. The 2 at the gate stay at the gate.
  const partial = await w.creator.execute({ partyId: ABC.id, lines: [{ productVariantId: "v-red", quantity: 3 }], actor: "clerk" });
  w.moveOutFromStore(partial.gatepassId!, "v-red", 2);
  assert.deepEqual(w.figures("v-red"), { current: 3, reserved: 1, reflected: 2 });
  const partialCancel = await w.canceller.execute({ gatepassId: partial.gatepassId!, reason: "customer took less", actor: "manager" });
  assert.equal(partialCancel.accepted, true);
  assert.equal(partialCancel.releasedQuantity, 1);
  assert.equal(partialCancel.dispatchedFromStoreQuantity, 2);
  assert.deepEqual(w.figures("v-red"), { current: 3, reserved: 0, reflected: 3 });
  const auditPayload = w.audit[w.audit.length - 1].payload;
  assert.equal(auditPayload.releasedQuantity, 1);
  assert.equal(auditPayload.dispatchedFromStoreQuantity, 2);
  assert.deepEqual((auditPayload.lines as Array<Record<string, unknown>>).map((l) => [l.quantity, l.dispatchedFromStoreQuantity, l.releasedQuantity]), [[3, 2, 1]]);
});

test("cancel: when a sale voucher was already made from the gatepass, the billing desk gets a critical notice naming the bill to delete", async () => {
  const w = createWorld({ parties: { [ABC.id]: ABC }, stock: { [RED.productVariantId]: RED } });
  const created = await w.creator.execute({ partyId: ABC.id, lines: [{ productVariantId: "v-red", quantity: 3 }], actor: "clerk" });
  w.world.bills[created.gatepassId!] = { id: "sv-9", voucherNumber: "45" };

  const result = await w.canceller.execute({ gatepassId: created.gatepassId!, reason: "wrong party", actor: "manager" });
  assert.equal(result.accepted, true);

  const notice = w.notices[1];
  assert.equal(notice.kind, "GATEPASS_CANCELLED");
  assert.equal(notice.severity, "CRITICAL");
  assert.equal(notice.entityId, created.gatepassId);
  assert.equal(notice.title, "Gatepass GP-000001 cancelled — delete Sale Voucher #45");
  assert.match(notice.message, /Cancelled by manager: wrong party. The bill made from it must be deleted/);
});
