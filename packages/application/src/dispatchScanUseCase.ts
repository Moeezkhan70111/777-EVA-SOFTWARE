import { InvalidQrError, parseQrCode } from "@erp/domain";
import type {
  EventPublisher,
  IdGenerator,
  OutboxRepository,
  ScanOperationalContext,
  TransactionContext,
  TransactionManager,
} from "./ports.js";

export interface DispatchQrRecord {
  qrId: string;
  productVariantId: string;
  currentStatus: string;
  article: string;
  color: string;
  size: string;
  stockOnHand: number;
  /** Where the unit currently sits (FACTORY, WAREHOUSE after Store Scanning, GATE after Store Move Out). */
  currentLocationType?: string;
  currentLocationId?: string | null;
}

/** Location a dispatch takes its unit from, so the per-location projection stays right. */
export interface StockLocationRef {
  type: string;
  id: string | null;
}

export interface DispatchScanInput {
  rawScan: string;
  sessionId?: string;
  context: ScanOperationalContext;
  /**
   * Gatepass-locked mode. Given, the carton is held to THAT document's lines — article, colour
   * and size exactly — and the document must be standing at the gate. The attribution written
   * is unchanged: the scan still belongs to the dispatch session of the gatepass's own bill,
   * which is what cancellation and reversal already read.
   *
   * The bill cannot make this check itself: a bill has no colour (price lives on article + size),
   * so the ordinary allowance calls every colour ALL COLORS. The gatepass knows the colour.
   */
  gatepassId?: string;
}

export interface DispatchScanResult {
  accepted: boolean;
  qrId?: string;
  parserVersion?: string;
  reason?: string;
  /** True when this scan completed the Gatepass and sent the whole document out. */
  gatepassDispatched?: boolean;
}

export interface DispatchScanDeps {
  txManager: TransactionManager;
  qrLookupRepo: {
    getQrForDispatch(qrId: string, tx: TransactionContext): Promise<DispatchQrRecord | null>;
  };
  stockProjectionRepo: {
    decrementStock(
      productVariantId: string,
      occurredAt: string,
      context: ScanOperationalContext,
      tx: TransactionContext,
      from?: StockLocationRef
    ): Promise<void>;
  };
  qrMasterRepo: {
    markDispatched(qrId: string, updatedAt: string, tx: TransactionContext): Promise<void>;
  };
  dispatchEventsRepo: {
    appendDispatchedEvent(payload: {
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
      /** The session (⇒ voucher) this scan was validated against, or null if none was selected. */
      dispatchSessionId: string | null;
      /** The QR's own current_status/location immediately before this dispatch — recorded so a
       *  cancellation can restore exactly this state instead of guessing. Never inferred later. */
      previousStatus: string;
      previousLocationType: string;
      previousLocationId: string;
    }, tx: TransactionContext): Promise<void>;
  };
  outboxRepo: {
    enqueueDispatch(payload: {
      outboxId: string;
      eventId: string;
      qrId: string;
      createdAt: string;
      parserVersion: string;
      factoryId: string;
      workstationId: string;
      deviceId: string;
    }, tx: TransactionContext): Promise<void>;
  };
  eventPublisher: EventPublisher;
  idGenerator: IdGenerator;
  dispatchSessionRepo?: {
    checkDispatchSessionAllowance(sessionId: string, productVariantId: string): Promise<DispatchAllowanceResult | null> | DispatchAllowanceResult | null;
    startDispatchSession(sessionId: string): Promise<void> | void;
  };
  /** Only needed for gatepass-locked dispatch; the generic flow never calls it. */
  gatepassRepo?: {
    readGatepassStatus(gatepassId: string, tx: TransactionContext): string | null;
    checkGatepassDispatchAllowance(gatepassId: string, productVariantId: string): DispatchAllowanceResult | null;
    gatepassDispatchComplete(gatepassId: string): boolean;
    advanceGatepassStatus(
      payload: { gatepassId: string; from: string; to: string; actor?: string | null },
      tx: TransactionContext
    ): boolean;
  };
}

/**
 * What the bill still allows for a scanned variant. Enforced in cartons: one scan is one
 * carton and a voucher line in dozens allows dozens × 2 scans (see @erp/domain units.ts).
 */
export interface DispatchAllowanceResult {
  allowed: boolean;
  lineItemId: string | null;
  article: string;
  color: string;
  size: string;
  requiredCartons: number;
  dispatchedCartons: number;
  requiredPairs: number;
  dispatchedPairs: number;
}

export class DispatchScanUseCase {
  constructor(private readonly deps: DispatchScanDeps) {}

  async execute(input: DispatchScanInput): Promise<DispatchScanResult> {
    try {
      const parsed = parseQrCode(input.rawScan);
      /** Set when this scan completed the Gatepass and sent the whole document out. */
      let gatepassDispatched = false;

      await this.deps.txManager.runInTransaction(async (tx) => {
        const qr = await this.deps.qrLookupRepo.getQrForDispatch(parsed.payload.qrId, tx);

        if (!qr) {
          throw new Error("ERROR: PRODUCT WAS NEVER PRODUCED");
        }

        // Gatepass-locked: the document decides what may leave, and it knows the colour.
        if (input.gatepassId && this.deps.gatepassRepo) {
          const status = this.deps.gatepassRepo.readGatepassStatus(input.gatepassId, tx);
          if (status !== "AT_GATE") {
            throw new Error(
              status === null
                ? "ERROR: THAT GATEPASS COULD NOT BE FOUND"
                : status === "DISPATCHED" || status === "DELIVERED"
                  ? "ERROR: THIS GATEPASS HAS ALREADY BEEN DISPATCHED"
                  : "ERROR: THIS GATEPASS IS NOT AT THE GATE YET"
            );
          }
          const allowance = this.deps.gatepassRepo.checkGatepassDispatchAllowance(input.gatepassId, qr.productVariantId);
          if (!allowance || allowance.requiredCartons === 0) {
            throw new Error(`ERROR: THIS GATEPASS DOES NOT ASK FOR ${qr.article} ${qr.color} ${qr.size}`);
          }
          if (!allowance.allowed) {
            throw new Error(`ERROR: ${qr.article} ${qr.color} ${qr.size} IS ALREADY COMPLETE ON THIS GATEPASS`);
          }
          if (input.sessionId && this.deps.dispatchSessionRepo) {
            await this.deps.dispatchSessionRepo.startDispatchSession(input.sessionId);
          }
        } else if (input.sessionId && this.deps.dispatchSessionRepo) {
          const allowance = await this.deps.dispatchSessionRepo.checkDispatchSessionAllowance(input.sessionId, qr.productVariantId);
          if (!allowance || !allowance.allowed) {
            throw new Error("ERROR: ITEM NOT IN SELECTED BILL");
          }
          await this.deps.dispatchSessionRepo.startDispatchSession(input.sessionId);
        }

        // A unit leaves for the customer from production stock, from the store (after
        // Store Scanning), from the gate (after Store Move Out), or after coming back
        // from a customer.
        const canDispatch =
          qr.currentStatus === "PRODUCED" ||
          qr.currentStatus === "RETURNED" ||
          qr.currentStatus === "WAREHOUSE" ||
          qr.currentStatus === "TO_GATE";

        if (qr.currentStatus === "DISPATCHED") {
          throw new Error("ERROR: PRODUCT HAS ALREADY BEEN DISPATCHED");
        }

        // A carton whose return has been recorded is standing at the gate and is in nobody's
        // stock until Store Move In receives it. Sending it straight back out would dispatch
        // a unit the projections do not hold, so it is refused — and told why, rather than
        // being lumped in with "already dispatched", which it is not.
        if (qr.currentStatus === "ON_GATE") {
          throw new Error("ERROR: PRODUCT MUST BE RECEIVED INTO STORE FIRST");
        }

        if (!canDispatch) {
          throw new Error("ERROR: PRODUCT HAS ALREADY BEEN DISPATCHED");
        }

        if (qr.stockOnHand <= 0) {
          throw new Error("ERROR: PRODUCT NOT FOUND IN STOCK");
        }

        const eventId = this.deps.idGenerator.nextId();
        const outboxId = this.deps.idGenerator.nextId();

        // Captured once, from the QR's actual state right now — never re-derived afterward.
        // `dispatchFrom` is exactly what is passed to decrementStock below, so the location
        // this event records as "previous" is always the same one stock was actually taken
        // from (decrementStock's own FACTORY/UNKNOWN fallback is applied here, identically,
        // so the two never disagree).
        const previousStatus = qr.currentStatus;
        const dispatchFrom = qr.currentLocationType
          ? { type: qr.currentLocationType, id: qr.currentLocationId ?? null }
          : undefined;
        const previousLocationType = dispatchFrom?.type && dispatchFrom.type !== "UNKNOWN" ? dispatchFrom.type : "FACTORY";
        const previousLocationId = dispatchFrom?.id ?? input.context.factoryId;

        await this.deps.qrMasterRepo.markDispatched(parsed.payload.qrId, tx.nowIso, tx);

        await this.deps.dispatchEventsRepo.appendDispatchedEvent({
          eventId,
          qrId: parsed.payload.qrId,
          productVariantId: qr.productVariantId,
          article: qr.article,
          color: qr.color,
          size: qr.size,
          serial: parsed.payload.serial,
          occurredAt: tx.nowIso,
          parserVersion: parsed.parserVersion,
          factoryId: input.context.factoryId,
          workstationId: input.context.workstationId,
          deviceId: input.context.deviceId,
          operatorId: input.context.operatorId,
          dispatchSessionId: input.sessionId ?? null,
          previousStatus,
          previousLocationType,
          previousLocationId,
        }, tx);

        await this.deps.stockProjectionRepo.decrementStock(
          qr.productVariantId,
          tx.nowIso,
          input.context,
          tx,
          dispatchFrom
        );

        await this.deps.outboxRepo.enqueueDispatch({
          outboxId,
          eventId,
          qrId: parsed.payload.qrId,
          createdAt: tx.nowIso,
          parserVersion: parsed.parserVersion,
          factoryId: input.context.factoryId,
          workstationId: input.context.workstationId,
          deviceId: input.context.deviceId,
        }, tx);

        // Gatepass-locked: the carton that completes the last line is what sends the whole
        // document out. Read from the events just written, never from a counter, and guarded
        // on AT_GATE so two operators finishing together cannot dispatch it twice — the second
        // finds the row already moved and simply reports its own scan as accepted.
        if (input.gatepassId && this.deps.gatepassRepo && this.deps.gatepassRepo.gatepassDispatchComplete(input.gatepassId)) {
          gatepassDispatched = this.deps.gatepassRepo.advanceGatepassStatus(
            { gatepassId: input.gatepassId, from: "AT_GATE", to: "DISPATCHED", actor: input.context.operatorId ?? null },
            tx
          );
        }
      });

      await this.deps.eventPublisher.publish("DispatchCompleted.v1", {
        qrId: parsed.payload.qrId,
        parserVersion: parsed.parserVersion,
        occurredAt: new Date().toISOString(),
      });

      return {
        accepted: true,
        qrId: parsed.payload.qrId,
        parserVersion: parsed.parserVersion,
        gatepassDispatched,
      };
    } catch (error) {
      if (error instanceof InvalidQrError) {
        return {
          accepted: false,
          reason: "Invalid QR Format",
        };
      }

      // A refusal this use case raised on purpose is an answer for the operator, not a fault:
      // the scan is reported as rejected with that exact wording. Every one of them is written
      // `ERROR: …` for the screen, which is what tells them apart from a genuine failure (a
      // broken database, a bug) — and those must keep bubbling up rather than being shown at
      // the scanner as if the carton were at fault. Listing each message here instead meant a
      // new refusal was thrown at the operator as a crash until someone remembered this list.
      if (error instanceof Error && error.message.startsWith("ERROR: ")) {
        return {
          accepted: false,
          reason: error.message,
        };
      }

      throw error;
    }
  }
}
