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

      await this.deps.txManager.runInTransaction(async (tx) => {
        const duplicate = await this.deps.duplicateChecker.existsByQrId(parsed.payload.qrId, tx);
        if (duplicate) {
          throw new DuplicateQrError("This QR has already been produced.");
        }

        // The QR Generator is the only source of registered identities. A value that parses
        // but was never issued is rejected here, before anything is written.
        const registered = await this.deps.qrRegistry.findRegisteredQrCode(parsed.payload.qrId, tx);
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
          : await this.deps.productCatalog.getOrCreateVariant(parsed.payload, tx);
        const eventId = this.deps.idGenerator.nextId();
        const outboxId = this.deps.idGenerator.nextId();

        await this.deps.qrMasterRepo.insertProduced({
          qrId: parsed.payload.qrId,
          productVariantId: productVariant.id,
          createdAt: tx.nowIso,
        }, tx);

        await this.deps.productionEventsRepo.appendProducedEvent({
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

        await this.deps.stockProjectionRepo.incrementProduced(
          productVariant.id,
          tx.nowIso,
          input.context,
          tx
        );

        await this.deps.outboxRepo.enqueueProduced({
          outboxId,
          eventId,
          qrId: parsed.payload.qrId,
          createdAt: tx.nowIso,
          parserVersion: parsed.parserVersion,
          factoryId: input.context.factoryId,
          workstationId: input.context.workstationId,
          deviceId: input.context.deviceId,
        }, tx);
      });

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
