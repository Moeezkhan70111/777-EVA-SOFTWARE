import type { CanonicalQrPayload } from "@erp/domain";

export interface TransactionContext {
  nowIso: string;
}

export interface ScanOperationalContext {
  factoryId: string;
  workstationId: string;
  deviceId: string;
  operatorId?: string;
}

export interface TransactionManager {
  runInTransaction<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;
}

export interface DuplicateChecker {
  existsByQrId(qrId: string, tx: TransactionContext): Promise<boolean>;
}

export interface ProductVariantRef {
  id: string;
}

export interface ProductCatalogRepository {
  getOrCreateVariant(payload: CanonicalQrPayload, tx: TransactionContext): Promise<ProductVariantRef>;
}

export interface RegisteredQrCode {
  productVariantId: string | null;
  article: string;
  color: string;
  size: string;
  /** Registry status: 'GENERATED' (issuable) or 'VOID' (withdrawn before production). */
  status: string;
}

/**
 * Registered QR code identities, written only by the QR Generator. The scanner reads
 * this to confirm a scanned value was actually issued; it never writes to it.
 */
export interface QrRegistryRepository {
  findRegisteredQrCode(qrId: string, tx: TransactionContext): Promise<RegisteredQrCode | null>;
  /**
   * Registers an identity the generator never issued, for a station allowed to take a carton as
   * it finds it (Live Production). Refuses an article + size the Product Master does not have.
   */
  adoptScannedQrCode(
    payload: { qrId: string; article: string; color: string; size: string; serial: string },
    origin: { createdBy: string | null; requestedBy: string },
    tx: TransactionContext
  ): Promise<RegisteredQrCode & { productVariantId: string }>;
}

export interface QrMasterRepository {
  insertProduced(payload: {
    qrId: string;
    productVariantId: string;
    createdAt: string;
    /** Present when the identity should also be queued for the other computers, in the same transaction. */
    outboxId?: string;
  }, tx: TransactionContext): Promise<void>;
}

export interface ProductionEventsRepository {
  appendProducedEvent(payload: {
    eventId: string;
    qrId: string;
    productVariantId: string;
    article: string;
    color: string;
    size: string;
    serial: string;
    occurredAt: string;
    parserVersion: string;
    factoryId: string;
    workstationId: string;
    deviceId: string;
    operatorId?: string;
    /**
     * Who recorded it and at which station, kept in the event's metadata. operator_id cannot
     * hold an app user (it references the operators table), so the signed-in user goes here.
     */
    receivedBy?: { actor: string | null; station: string } | null;
  }, tx: TransactionContext): Promise<void>;
}

export interface StockProjectionRepository {
  incrementProduced(
    productVariantId: string,
    occurredAt: string,
    context: ScanOperationalContext,
    tx: TransactionContext
  ): Promise<void>;
}

export interface OutboxRepository {
  enqueueProduced(payload: {
    outboxId: string;
    eventId: string;
    qrId: string;
    createdAt: string;
    parserVersion: string;
    factoryId: string;
    workstationId: string;
    deviceId: string;
  }, tx: TransactionContext): Promise<void>;
}

export interface EventPublisher {
  publish<T>(eventName: string, payload: T): Promise<void>;
}

export interface IdGenerator {
  nextId(): string;
}
