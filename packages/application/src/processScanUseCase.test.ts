import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryEventBus } from "./eventBus.js";
import { ProcessScanUseCase } from "./processScanUseCase.js";
import type { ProcessScanDeps } from "./processScanUseCase.js";
import type { TransactionContext } from "./ports.js";

function createDeps(overrides: Partial<ProcessScanDeps> = {}) {
  const calls = {
    committed: false,
  };

  const deps: ProcessScanDeps = {
    txManager: {
      async runInTransaction<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
        calls.committed = true;
        return work({ nowIso: new Date().toISOString() });
      },
    },
    duplicateChecker: {
      async existsByQrId() {
        return false;
      },
    },
    qrRegistry: {
      async findRegisteredQrCode() {
        return { productVariantId: "variant-1", article: "SK6", color: "BLUE", size: "7/10", status: "GENERATED" };
      },
    },
    productCatalog: {
      async getOrCreateVariant() {
        return { id: "variant-1" };
      },
    },
    qrMasterRepo: {
      async insertProduced() {},
    },
    productionEventsRepo: {
      async appendProducedEvent() {},
    },
    stockProjectionRepo: {
      async incrementProduced() {},
    },
    outboxRepo: {
      async enqueueProduced() {},
    },
    eventPublisher: new InMemoryEventBus(),
    idGenerator: {
      nextId() {
        return crypto.randomUUID();
      },
    },
    ...overrides,
  };

  return { deps, calls };
}

test("duplicate scan returns rejection message", async () => {
  const { deps } = createDeps({
    duplicateChecker: {
      async existsByQrId() {
        return true;
      },
    },
  });

  const useCase = new ProcessScanUseCase(deps);
  const result = await useCase.execute({
    rawScan: "SK6_BLUE_7/10_001",
    context: {
      factoryId: "f1",
      workstationId: "w1",
      deviceId: "d1",
    },
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "This QR has already been produced.");
});

test("valid scan succeeds", async () => {
  const { deps, calls } = createDeps();
  const useCase = new ProcessScanUseCase(deps);

  const result = await useCase.execute({
    rawScan: "SK6_BLUE_7/10_001",
    context: {
      factoryId: "f1",
      workstationId: "w1",
      deviceId: "d1",
    },
  });

  assert.equal(result.accepted, true);
  assert.equal(calls.committed, true);
});

test("QR that was never generated is rejected and writes nothing", async () => {
  let wrote = false;
  const { deps } = createDeps({
    qrRegistry: {
      async findRegisteredQrCode() {
        return null;
      },
    },
    qrMasterRepo: {
      async insertProduced() {
        wrote = true;
      },
    },
    productionEventsRepo: {
      async appendProducedEvent() {
        wrote = true;
      },
    },
    stockProjectionRepo: {
      async incrementProduced() {
        wrote = true;
      },
    },
  });

  const useCase = new ProcessScanUseCase(deps);
  const result = await useCase.execute({
    rawScan: "SK6_BLUE_7/10_999999",
    context: { factoryId: "f1", workstationId: "w1", deviceId: "d1" },
  });

  assert.equal(result.accepted, false);
  assert.match(result.reason ?? "", /not registered/i);
  assert.equal(wrote, false);
});

test("a voided QR is rejected and writes nothing", async () => {
  let wrote = false;
  const { deps } = createDeps({
    qrRegistry: {
      async findRegisteredQrCode() {
        return { productVariantId: "variant-1", article: "SK6", color: "RED", size: "7/10", status: "VOID" };
      },
    },
    qrMasterRepo: {
      async insertProduced() {
        wrote = true;
      },
    },
  });

  const useCase = new ProcessScanUseCase(deps);
  const result = await useCase.execute({
    rawScan: "SK6_RED_7/10_000009",
    context: { factoryId: "f1", workstationId: "w1", deviceId: "d1" },
  });

  assert.equal(result.accepted, false);
  assert.match(result.reason ?? "", /voided/i);
  assert.equal(wrote, false);
});

test("scan resolves to the variant the QR Generator registered", async () => {
  let usedVariantId = "";
  const { deps } = createDeps({
    qrRegistry: {
      async findRegisteredQrCode() {
        return { productVariantId: "variant-red-710", article: "SK6", color: "RED", size: "7/10", status: "GENERATED" };
      },
    },
    productCatalog: {
      async getOrCreateVariant() {
        throw new Error("scanner must not fall back to catalog resolution for a registered QR code");
      },
    },
    qrMasterRepo: {
      async insertProduced(payload) {
        usedVariantId = payload.productVariantId;
      },
    },
  });

  const useCase = new ProcessScanUseCase(deps);
  const result = await useCase.execute({
    rawScan: "SK6_RED_7/10_000001",
    context: { factoryId: "f1", workstationId: "w1", deviceId: "d1" },
  });

  assert.equal(result.accepted, true);
  assert.equal(usedVariantId, "variant-red-710");
});
