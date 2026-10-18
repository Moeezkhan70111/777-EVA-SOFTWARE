import { InvalidQrError, parseQrCode } from "@erp/domain";
import { DuplicateQrError, UnregisteredQrError, VoidedQrError } from "./errors.js";
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
  /** Who is at the station, recorded as whoever registered an identity taken off the floor. */
  actor?: string | null;
}

export interface ProcessScanResult {
  accepted: boolean;
  qrId?: string;
  parserVersion?: string;
  reason?: string;
  /**
   * True when this carton's identity had never been generated and was registered by this scan,
   * so the station can say so rather than letting it pass as an ordinary scan.
   */
  registeredOnScan?: boolean;
}

/** What `requested_by` says on an identity the production station registered itself. */
export const LIVE_PRODUCTION_STATION = "Live Production scan";

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

      // Live Production takes the carton as it finds it: a label the generator never issued is
      // registered by this scan rather than turned away (owner, 2026-10-13).
      const recorded = await this.deps.txManager.runInTransaction((tx) =>
        recordProductionInTransaction(
          this.deps,
          {
            parsed,
            context: input.context,
            registerIfUnknown: { actor: input.actor ?? null, station: LIVE_PRODUCTION_STATION },
          },
          tx
        )
      );

      await this.deps.eventPublisher.publish("ProductionCompleted.v1", {
        qrId: parsed.payload.qrId,
        parserVersion: parsed.parserVersion,
        occurredAt: new Date().toISOString(),
      });

      return {
        accepted: true,
        qrId: parsed.payload.qrId,
        parserVersion: parsed.parserVersion,
        registeredOnScan: recorded.registeredOnScan,
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
  input: {
    parsed: ReturnType<typeof parseQrCode>;
    context: ScanOperationalContext;
    /**
     * Set by a station allowed to produce a carton whose identity was never generated: the
     * identity is registered as this run is recorded. Left out, an unregistered identity is
     * refused as it always was.
     */
    registerIfUnknown?: { actor: string | null; station: string };
    /** Who recorded the carton and where, written into the PRODUCED event's metadata. */
    receivedBy?: { actor: string | null; station: string } | null;
  },
  tx: TransactionContext
): Promise<{ eventId: string; productVariantId: string; registeredOnScan: boolean }> {
  const { parsed } = input;
  const duplicate = await deps.duplicateChecker.existsByQrId(parsed.payload.qrId, tx);
  if (duplicate) {
    throw new DuplicateQrError("This QR has already been produced.");
  }

  // An identity the generator never issued: refused outright for every station EXCEPT the one
  // the owner opened up — Live Production, which takes the carton as it finds it and registers
  // the identity on the spot (see adoptScannedQrCode). Store In/Out, dispatch and returns still
  // refuse, because a carton can only arrive, leave or come back if it was produced first.
  const existing = await deps.qrRegistry.findRegisteredQrCode(parsed.payload.qrId, tx);
  if (!existing && !input.registerIfUnknown) {
    throw new UnregisteredQrError(
      "This QR is not registered. Generate it in the QR Generator before production scanning."
    );
  }
  const registered =
    existing ??
    (await deps.qrRegistry.adoptScannedQrCode(
      parsed.payload,
      {
        createdBy: input.registerIfUnknown?.actor ?? null,
        requestedBy: input.registerIfUnknown?.station ?? "",
      },
      tx
    ));
  const registeredOnScan = existing === null;
  if (registered.status === "VOID") {
    throw new VoidedQrError(
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
  // A second queue entry: the carton identity travels as its own event, and the receiving
  // computer needs it before the production event that references it.
  const qrOutboxId = deps.idGenerator.nextId();

  await deps.qrMasterRepo.insertProduced({
    qrId: parsed.payload.qrId,
    productVariantId: productVariant.id,
    createdAt: tx.nowIso,
    outboxId: qrOutboxId,
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
    receivedBy: input.receivedBy ?? null,
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

  return { eventId, productVariantId: productVariant.id, registeredOnScan };
}
