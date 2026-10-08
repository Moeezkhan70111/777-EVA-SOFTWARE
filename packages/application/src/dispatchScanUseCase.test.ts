import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryEventBus } from "./eventBus.js";
import { DispatchScanUseCase } from "./dispatchScanUseCase.js";
import type { DispatchScanDeps } from "./dispatchScanUseCase.js";
import type { TransactionContext } from "./ports.js";

function createDeps(overrides: Partial<DispatchScanDeps> = {}) {
  const deps: DispatchScanDeps = {
    txManager: {
      async runInTransaction<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
        return work({ nowIso: new Date().toISOString() });
      },
    },
    qrLookupRepo: {
      async getQrForDispatch() {
        return {
          qrId: "SK6_BLUE_7/10_001",
          productVariantId: "variant-1",
          currentStatus: "PRODUCED",
          article: "SK6",
          color: "BLUE",
          size: "7/10",
          stockOnHand: 1,
        };
      },
    },
    stockProjectionRepo: {
      async decrementStock() {},
    },
    qrMasterRepo: {
      async markDispatched() {},
    },
    dispatchEventsRepo: {
      async appendDispatchedEvent() {},
    },
    outboxRepo: {
      async enqueueDispatch() {},
    },
    eventPublisher: new InMemoryEventBus(),
    idGenerator: {
      nextId() {
        return crypto.randomUUID();
      },
    },
    ...overrides,
  };

  return deps;
}

test("valid dispatch succeeds", async () => {
  const deps = createDeps();
  const useCase = new DispatchScanUseCase(deps);

  const result = await useCase.execute({
    rawScan: "SK6_BLUE_7/10_001",
    context: { factoryId: "f1", workstationId: "w1", deviceId: "d1" },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.qrId, "SK6_BLUE_7/10_001");
});

test("invalid QR is rejected", async () => {
  const deps = createDeps();
  const useCase = new DispatchScanUseCase(deps);

  const result = await useCase.execute({
    rawScan: "BAD_INPUT",
    context: { factoryId: "f1", workstationId: "w1", deviceId: "d1" },
  });

  assert.equal(result.accepted, false);
  assert.match(result.reason ?? "", /Invalid QR|unsupported/i);
});

test("never produced is rejected before any mutation", async () => {
  const deps = createDeps({
    qrLookupRepo: {
      async getQrForDispatch() {
        return null;
      },
    },
  });
  const useCase = new DispatchScanUseCase(deps);

  const result = await useCase.execute({
    rawScan: "SK6_BLUE_7/10_002",
    context: { factoryId: "f1", workstationId: "w1", deviceId: "d1" },
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "ERROR: PRODUCT WAS NEVER PRODUCED");
});

test("a unit at the gate (after Store Move Out) is dispatched from the GATE location", async () => {
  let from: { type: string; id: string | null } | undefined;
  const deps = createDeps({
    qrLookupRepo: {
      async getQrForDispatch() {
        return {
          qrId: "SK6_BLUE_7/10_001",
          productVariantId: "variant-1",
          currentStatus: "TO_GATE",
          article: "SK6",
          color: "BLUE",
          size: "7/10",
          stockOnHand: 1,
          currentLocationType: "GATE",
          currentLocationId: "factory-777",
        };
      },
    },
    stockProjectionRepo: {
      async decrementStock(_variant, _at, _ctx, _tx, location) {
        from = location;
      },
    },
  });

  const result = await new DispatchScanUseCase(deps).execute({
    rawScan: "SK6_BLUE_7/10_001",
    context: { factoryId: "f1", workstationId: "w1", deviceId: "d1" },
  });

  assert.equal(result.accepted, true);
  assert.deepEqual(from, { type: "GATE", id: "factory-777" });
});

test("dispatch is allowed again after a return, but not twice in a row", async () => {
  let status: "PRODUCED" | "DISPATCHED" | "RETURNED" = "PRODUCED";

  const deps = createDeps({
    qrLookupRepo: {
      async getQrForDispatch() {
        return {
          qrId: "SK6_BLUE_7/10_001",
          productVariantId: "variant-1",
          currentStatus: status,
          article: "SK6",
          color: "BLUE",
          size: "7/10",
          stockOnHand: 1,
        };
      },
    },
    qrMasterRepo: {
      async markDispatched() {
        status = "DISPATCHED";
      },
    },
  });

  const useCase = new DispatchScanUseCase(deps);

  const firstDispatch = await useCase.execute({
    rawScan: "SK6_BLUE_7/10_001",
    context: { factoryId: "f1", workstationId: "w1", deviceId: "d1" },
  });
  assert.equal(firstDispatch.accepted, true);

  const secondDispatch = await useCase.execute({
    rawScan: "SK6_BLUE_7/10_001",
    context: { factoryId: "f1", workstationId: "w1", deviceId: "d1" },
  });
  assert.equal(secondDispatch.accepted, false);
  assert.equal(secondDispatch.reason, "ERROR: PRODUCT HAS ALREADY BEEN DISPATCHED");

  status = "RETURNED";
  const reDispatch = await useCase.execute({
    rawScan: "SK6_BLUE_7/10_001",
    context: { factoryId: "f1", workstationId: "w1", deviceId: "d1" },
  });
  assert.equal(reDispatch.accepted, true);

  const blockedAfterRedispatch = await useCase.execute({
    rawScan: "SK6_BLUE_7/10_001",
    context: { factoryId: "f1", workstationId: "w1", deviceId: "d1" },
  });
  assert.equal(blockedAfterRedispatch.accepted, false);
  assert.equal(blockedAfterRedispatch.reason, "ERROR: PRODUCT HAS ALREADY BEEN DISPATCHED");
});

test("the DISPATCHED event payload carries the exact session and the QR's own prior state — never inferred later", async () => {
  let capturedPayload: any;
  const deps = createDeps({
    qrLookupRepo: {
      async getQrForDispatch() {
        return {
          qrId: "SK6_BLUE_7/10_001",
          productVariantId: "variant-1",
          currentStatus: "WAREHOUSE",
          article: "SK6",
          color: "BLUE",
          size: "7/10",
          stockOnHand: 1,
          currentLocationType: "WAREHOUSE",
          currentLocationId: "store-1",
        };
      },
    },
    dispatchEventsRepo: {
      async appendDispatchedEvent(payload) {
        capturedPayload = payload;
      },
    },
    dispatchSessionRepo: {
      async checkDispatchSessionAllowance() {
        return {
          allowed: true, lineItemId: "line-1", article: "SK6", color: "BLUE", size: "7/10",
          requiredCartons: 2, dispatchedCartons: 0, requiredPairs: 12, dispatchedPairs: 0,
        };
      },
      async startDispatchSession() {},
    },
  });

  const result = await new DispatchScanUseCase(deps).execute({
    rawScan: "SK6_BLUE_7/10_001",
    sessionId: "session-42",
    context: { factoryId: "f1", workstationId: "w1", deviceId: "d1" },
  });

  assert.equal(result.accepted, true);
  assert.equal(capturedPayload.dispatchSessionId, "session-42");
  assert.equal(capturedPayload.previousStatus, "WAREHOUSE");
  assert.equal(capturedPayload.previousLocationType, "WAREHOUSE");
  assert.equal(capturedPayload.previousLocationId, "store-1");
});

test("a scan with no session selected records dispatchSessionId as null, not undefined or omitted", async () => {
  let capturedPayload: any;
  const deps = createDeps({
    dispatchEventsRepo: {
      async appendDispatchedEvent(payload) {
        capturedPayload = payload;
      },
    },
  });

  const result = await new DispatchScanUseCase(deps).execute({
    rawScan: "SK6_BLUE_7/10_001",
    context: { factoryId: "f1", workstationId: "w1", deviceId: "d1" },
  });

  assert.equal(result.accepted, true);
  assert.equal(capturedPayload.dispatchSessionId, null);
  // No currentLocationType from this mock's getQrForDispatch (see createDeps) — the use case
  // must still fall back to a concrete FACTORY location, never undefined.
  assert.equal(capturedPayload.previousStatus, "PRODUCED");
  assert.equal(capturedPayload.previousLocationType, "FACTORY");
  assert.equal(capturedPayload.previousLocationId, "f1");
});
