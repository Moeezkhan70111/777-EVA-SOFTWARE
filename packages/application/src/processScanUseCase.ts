import { InvalidQrError, parseQrCode } from "@erp/domain";
import { DuplicateQrError, UnregisteredQrError } from "./errors.js";
import type {
  QrRegistryRepository,
  DuplicateChecker,
  EventPublisher,
  IdGenerator,
  OutboxRepository,
  ProductCatalogRepository,
  ProductionEventsRepository,
  QrMasterRepository,
  ScanOperationalContext,
  StockProjectionRepository,
  TransactionContext,
  TransactionManager,
} from "./ports.js";

export interface ProcessScanInput {
  rawScan: string;
  context: ScanOperationalContext;
}

export interface ProcessScanResult {
  accepted: boolean;
  qrId?: string;
  parserVersion?: string;
  reason?: string;
}

export interface ProcessScanDeps {
  txManager: TransactionManager;
  duplicateChecker: DuplicateChecker;
  qrRegistry: QrRegistryRepository;
  productCatalog: ProductCatalogRepository;
  qrMasterRepo: QrMasterRepository;
  productionEventsRepo: ProductionEventsRepository;
  stockProjectionRepo: StockProjectionRepository;
  outboxRepo: OutboxRepository;
  eventPublisher: EventPublisher;
  idGenerator: IdGenerator;
}

export class ProcessScanUseCase {
  constructor(private readonly deps: ProcessScanDeps) {}

  async execute(input: ProcessScanInput): Promise<ProcessScanResult> {
    try {
      const parsed = parseQrCode(input.rawScan);

      await this.deps.txManager.runInTransaction((tx) => recordProductionInTransaction(this.deps, { parsed, context: input.context }, tx));

      await this.deps.eventPublisher.publish("ProductionCompleted.v1", {
        qrId: parsed.payload.qrId,
        parserVersion: parsed.parserVersion,
        occurredAt: new Date().toISOString(),
      });

      return {
        accepted: true,
        qrId: parsed.payload.qrId,
        parserVersion: parsed.parserVersion,
      };
    } catch (error) {
      if (
        error instanceof InvalidQrError ||
        error instanceof DuplicateQrError ||
        error instanceof UnregisteredQrError ||
        (error instanceof Error && error.message.startsWith("PRODUCT_NOT_FOUND:"))
      ) {
        return {
          accepted: false,
          reason: error.message,
        };
      }

      throw error;
    }
  }
}

/** What the production step needs inside a transaction someone else opened. */
export type RecordProductionDeps = Omit<ProcessScanDeps, "txManager" | "eventPublisher">;

/**
 * The production scan itself — the ONE place a carton QR becomes a live unit: the qr_master row,
 * the PRODUCED event the production reports count, the produced stock projection and the outbox.
 *
 * Runs inside the caller's transaction, so another step can commit with it or not at all (Store
 * In receiving a machine program's carton produces AND stores it in one go). Throws
 * DuplicateQrError / UnregisteredQrError to refuse, having written nothing.
 */
export async function recordProductionInTransaction(
  deps: RecordProductionDeps,
  input: { parsed: ReturnType<typeof parseQrCode>; context: ScanOperationalContext },
  tx: TransactionContext
): Promise<{ eventId: string; productVariantId: string }> {
  const { parsed } = input;
  const duplicate = await deps.duplicateChecker.existsByQrId(parsed.payload.qrId, tx);
  if (duplicate) {
    throw new DuplicateQrError("This QR has already been produced.");
  }

  // The QR Generator is the only source of registered identities. A value that parses
  // but was never issued is rejected here, before anything is written.
  const registered = await deps.qrRegistry.findRegisteredQrCode(parsed.payload.qrId, tx);
  if (!registered) {
    throw new UnregisteredQrError(
      "This QR is not registered. Generate it in the QR Generator before production scanning."
    );
  }
  if (registered.status === "VOID") {
    throw new UnregisteredQrError(
      "This QR was voided in QR Management and cannot be produced. Restore it there first if this was a mistake."
    );
  }

  // Resolve to the variant the generator registered; fall back to the natural key for
  // legacy identities that predate the variant link.
  const productVariant = registered.productVariantId
    ? { id: registered.productVariantId }
    : await deps.productCatalog.getOrCreateVariant(parsed.payload, tx);
  const eventId = deps.idGenerator.nextId();
  const outboxId = deps.idGenerator.nextId();

  await deps.qrMasterRepo.insertProduced({
    qrId: parsed.payload.qrId,
    productVariantId: productVariant.id,
    createdAt: tx.nowIso,
  }, tx);

  await deps.productionEventsRepo.appendProducedEvent({
    eventId,
    qrId: parsed.payload.qrId,
    productVariantId: productVariant.id,
    article: parsed.payload.article,
    color: parsed.payload.color,
    size: parsed.payload.size,
    serial: parsed.payload.serial,
    occurredAt: tx.nowIso,
    parserVersion: parsed.parserVersion,
    factoryId: input.context.factoryId,
    workstationId: input.context.workstationId,
    deviceId: input.context.deviceId,
    operatorId: input.context.operatorId,
  }, tx);

  await deps.stockProjectionRepo.incrementProduced(
    productVariant.id,
    tx.nowIso,
    input.context,
    tx
  );

  await deps.outboxRepo.enqueueProduced({
    outboxId,
    eventId,
    qrId: parsed.payload.qrId,
    createdAt: tx.nowIso,
    parserVersion: parsed.parserVersion,
    factoryId: input.context.factoryId,
    workstationId: input.context.workstationId,
    deviceId: input.context.deviceId,
  }, tx);

  return { eventId, productVariantId: productVariant.id };
}
