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
}

export interface QrMasterRepository {
  insertProduced(payload: {
    qrId: string;
    productVariantId: string;
    createdAt: string;
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
