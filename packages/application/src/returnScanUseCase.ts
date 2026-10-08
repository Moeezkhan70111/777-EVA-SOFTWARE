import { InvalidQrError, parseQrCode } from "@erp/domain";
import type {
  EventPublisher,
  IdGenerator,
  ScanOperationalContext,
  TransactionContext,
  TransactionManager,
} from "./ports.js";

// Carton return — the commercial half of a customer sending a carton back.
//
//   DISPATCHED  ──RETURN CONFIRMED──▶  ON_GATE
//   location CUSTOMER                   location GATE
//
// Recording a return and receiving the physical carton are two SEPARATE events. This use
// case does the first only:
//
//   * the party is credited (a sale_returns row against the party the carton was actually
//     dispatched to, at the rate that carton's own voucher line was billed at),
//   * the carton's status becomes ON_GATE — it is standing at the gate, in no one's stock,
//   * NO stock projection is touched, and no store entry is invented.
//
// The carton re-enters stock only when it physically arrives and a normal Store Move In
// scan receives it (see StoreEntryScanUseCase). That operator names no party, no voucher and
// no return: the QR's own status is the whole instruction.
//
// Who the carton belongs to is never guessed. It is read from the carton's own latest
// DISPATCHED event, whose dispatch_session_id names the session, whose voucher names the
// party — the exact chain migration 028 recorded. A carton dispatched without a selected
// bill has no attribution and its return is refused rather than attributed to someone.

/** The qr_master status a carton must be in for its return to be recorded. */
export const RETURNABLE_STATUS = "DISPATCHED";

/** The qr_master status and location a recorded return leaves the carton in. */
export const ON_GATE_STATUS = "ON_GATE";
export const ON_GATE_LOCATION_TYPE = "GATE";

/**
 * Where a carton being returned is coming back FROM. A DISPATCHED carton is with the
 * customer by definition, which is what this event has to record. It is deliberately not
 * read from qr_master.current_location_type: the dispatch scan does not maintain that
 * column (it only changes the status), so it still holds whichever of our own locations the
 * carton left from — stale by the time it comes back.
 */
export const RETURNED_FROM_LOCATION_TYPE = "CUSTOMER";

export type ReturnOutcome =
  /** Accepted: party credited, carton is now ON_GATE. */
  | "RETURN_RECORDED"
  /** This carton's return was already recorded and it is still waiting for Store Move In. */
  | "ALREADY_RETURNED"
  /** The value parses but no live unit was ever produced for it. */
  | "UNKNOWN_QR"
  /** A live unit that is not currently with a customer, so there is nothing to return. */
  | "NOT_DISPATCHED"
  /** Dispatched, but with no bill selected at the time — there is no party to credit. */
  | "NO_ATTRIBUTION"
  /** The scanned text is not a QR identity at all. */
  | "INVALID_FORMAT";

export interface ReturnQrRecord {
  qrId: string;
  productVariantId: string;
  currentStatus: string;
  article: string;
  color: string;
  size: string;
}

/**
 * Who a carton currently belongs to, read from its latest DISPATCHED event. "Current" is
 * exactly that event: a carton that was dispatched, returned and dispatched again resolves
 * to its newest dispatch, so the earlier party stays history and is never credited twice.
 */
export interface DispatchAttribution {
  dispatchEventId: string;
  dispatchedAt: string;
  dispatchSessionId: string | null;
  partyId: string;
  partyName: string;
  saleVoucherId: string | null;
  saleVoucherNumber: string | null;
  saleVoucherLineItemId: string | null;
  /** The rate and discount this exact carton was billed at, in rupees. */
  unitPrice: number;
  discountPerPair: number;
  /** What one carton is worth against that line — the amount the party is credited. */
  creditAmount: number;
}

/** An already-recorded return, for the idempotent second scan. */
export interface ExistingReturn {
  saleReturnId: string;
  returnNumber: string;
  returnedAt: string;
  partyId: string;
  partyName: string;
  saleVoucherNumber: string | null;
  creditAmount: number;
}

export interface ReturnLookupInput {
  rawScan: string;
}

export interface ReturnScanInput {
  rawScan: string;
  context: ScanOperationalContext;
  /** Logged-in user confirming the return, recorded on the credit and the event. */
  actor?: string | null;
}

/** What the Return screen shows before the operator confirms, and again after. */
export interface ReturnScanResult {
  accepted: boolean;
  outcome: ReturnOutcome;
  qrId?: string;
  parserVersion?: string;
  /** Operator-facing explanation for a rejection. */
  reason?: string;
  article?: string;
  color?: string;
  size?: string;
  serial?: string;
  /** The carton's status as it stands right now. */
  currentStatus?: string | null;
  /** Who the carton is out with, resolved from its own dispatch. Null when unresolvable. */
  attribution?: DispatchAttribution | null;
  /** Present when this carton's return was already recorded. */
  existingReturn?: ExistingReturn | null;
  recordedAt?: string;
  saleReturnId?: string;
  returnNumber?: string;
  eventId?: string;
}

/** Thrown inside the transaction to abort with a typed outcome and no writes. */
export class ReturnRejectedError extends Error {
  constructor(
    readonly outcome: Exclude<ReturnOutcome, "RETURN_RECORDED">,
    message: string,
    readonly details: Partial<ReturnScanResult> = {}
  ) {
    super(message);
    this.name = "ReturnRejectedError";
  }
}

export interface RecordedReturn {
  saleReturnId: string;
  returnNumber: string;
}

export interface ReturnEventPayload {
  eventId: string;
  qrId: string;
  productVariantId: string;
  article: string;
  color: string;
  size: string;
  serial: string;
  occurredAt: string;
  parserVersion: string;
  previousStatus: string;
  fromLocationType: string;
  fromLocationId: string | null;
  factoryId: string;
  workstationId: string;
  deviceId: string;
  operatorId?: string;
  actor?: string | null;
  /** The dispatch this return answers, so the audit trail runs both ways. */
  dispatchEventId: string;
  dispatchSessionId: string | null;
  partyId: string;
  saleVoucherId: string | null;
  saleReturnId: string;
}

export interface ReturnScanDeps {
  txManager: TransactionManager;
  qrLookupRepo: {
    getQrForReturn(qrId: string, tx: TransactionContext): Promise<ReturnQrRecord | null>;
  };
  attributionRepo: {
    /** The carton's latest dispatch, priced from the voucher line it was sold on. */
    findActiveDispatchAttribution(qrId: string, tx: TransactionContext): Promise<DispatchAttribution | null>;
    /** The live sale return already recorded for that dispatch, if any. */
    findReturnForDispatchEvent(dispatchEventId: string, tx: TransactionContext): Promise<ExistingReturn | null>;
  };
  qrMasterRepo: {
    /**
     * Moves the carton to ON_GATE_STATUS / ON_GATE_LOCATION_TYPE. Must be a guarded update
     * that only succeeds while the carton is still DISPATCHED, and must throw
     * ReturnRejectedError when it is not — that guard is what makes two terminals scanning
     * the same carton at once record exactly one return.
     */
    markOnGate(
      payload: { qrId: string; locationId: string; updatedAt: string },
      tx: TransactionContext
    ): Promise<void>;
  };
  saleReturnsRepo: {
    /** Writes the party credit. Must refuse a second live return for the same dispatch. */
    recordSaleReturn(
      payload: {
        saleReturnId: string;
        qrId: string;
        productVariantId: string;
        returnDate: string;
        attribution: DispatchAttribution;
        recordedBy?: string | null;
        occurredAt: string;
      },
      tx: TransactionContext
    ): Promise<RecordedReturn>;
  };
  returnEventsRepo: {
    appendReturnRecordedEvent(payload: ReturnEventPayload, tx: TransactionContext): Promise<void>;
  };
  outboxRepo: {
    enqueueReturn(
      payload: {
        outboxId: string;
        eventId: string;
        qrId: string;
        createdAt: string;
        parserVersion: string;
        factoryId: string;
        workstationId: string;
        deviceId: string;
      },
      tx: TransactionContext
    ): Promise<void>;
  };
  eventPublisher: EventPublisher;
  idGenerator: IdGenerator;
  /** Business date for the credit, in the application's local `YYYY-MM-DD` form. */
  localDate?: () => string;
}

const describeStatus = (status: string): string => {
  switch (status) {
    case "WAREHOUSE":
      return "This carton is In Store. It was never dispatched to a customer, so there is nothing to return.";
    case "PRODUCED":
      return "This carton is in production stock. It was never dispatched to a customer, so there is nothing to return.";
    case "TO_GATE":
      return "This carton is waiting at the gate to be dispatched. It has not gone out to a customer yet.";
    case "RETURNED":
      return "This carton was returned under the previous return process and is already back in stock.";
    case "SOLD":
      return "This carton is marked sold and cannot be returned here.";
    case "DAMAGED":
      return "This unit has been written off as damaged.";
    case "SCRAPPED":
      return "This unit has been scrapped.";
    default:
      return `This carton is in status ${status} and cannot be returned.`;
  }
};

export class ReturnScanUseCase {
  constructor(private readonly deps: ReturnScanDeps) {}

  /**
   * What the Return screen shows the operator before they confirm: the carton, who it went
   * out to and on which bill. Read-only — nothing is written, so a mis-scan costs nothing.
   */
  async lookup(input: ReturnLookupInput): Promise<ReturnScanResult> {
    let parsed: ReturnType<typeof parseQrCode>;
    try {
      parsed = parseQrCode(input.rawScan);
    } catch (error) {
      if (error instanceof InvalidQrError) {
        return {
          accepted: false,
          outcome: "INVALID_FORMAT",
          reason: "This is not a valid carton QR. Check the label and scan again.",
        };
      }
      throw error;
    }

    const { qrId, article, color, size, serial } = parsed.payload;

    return this.deps.txManager.runInTransaction(async (tx) => {
      const qr = await this.deps.qrLookupRepo.getQrForReturn(qrId, tx);
      const identity = { qrId, parserVersion: parsed.parserVersion, article, color, size, serial };

      if (!qr) {
        return {
          ...identity,
          accepted: false,
          outcome: "UNKNOWN_QR" as const,
          reason: "This QR has no produced carton. It cannot be returned.",
          currentStatus: null,
        };
      }

      const found = { ...identity, article: qr.article, color: qr.color, size: qr.size, currentStatus: qr.currentStatus };

      // A carton whose return is already recorded is still ON_GATE waiting for the store —
      // say so plainly instead of reporting a bare wrong-status rejection.
      if (qr.currentStatus === ON_GATE_STATUS) {
        const existing = await this.findRecordedReturn(qrId, tx);
        return {
          ...found,
          accepted: false,
          outcome: "ALREADY_RETURNED" as const,
          reason: existing
            ? `This carton's return was already recorded for ${existing.partyName}. It is waiting to be received by Store Move In.`
            : "This carton is already standing at the gate, waiting to be received by Store Move In.",
          existingReturn: existing,
        };
      }

      if (qr.currentStatus !== RETURNABLE_STATUS) {
        return {
          ...found,
          accepted: false,
          outcome: "NOT_DISPATCHED" as const,
          reason: describeStatus(qr.currentStatus),
        };
      }

      const attribution = await this.deps.attributionRepo.findActiveDispatchAttribution(qrId, tx);
      if (!attribution) {
        return {
          ...found,
          accepted: false,
          outcome: "NO_ATTRIBUTION" as const,
          reason:
            "This carton was dispatched without a bill selected, so the system does not know which customer it went to. Its return cannot be recorded here.",
          attribution: null,
        };
      }

      return { ...found, accepted: true, outcome: "RETURN_RECORDED" as const, attribution };
    });
  }

  /**
   * Confirms the return: one transaction that credits the party, moves the carton to
   * ON_GATE and records the event. Stock is deliberately untouched — the carton has not
   * reached the store yet.
   */
  async execute(input: ReturnScanInput): Promise<ReturnScanResult> {
    let parsed: ReturnType<typeof parseQrCode>;
    try {
      parsed = parseQrCode(input.rawScan);
    } catch (error) {
      if (error instanceof InvalidQrError) {
        return {
          accepted: false,
          outcome: "INVALID_FORMAT",
          reason: "This is not a valid carton QR. Check the label and scan again.",
        };
      }
      throw error;
    }

    const { qrId, article, color, size, serial } = parsed.payload;

    try {
      const committed = await this.deps.txManager.runInTransaction(async (tx) => {
        const qr = await this.deps.qrLookupRepo.getQrForReturn(qrId, tx);

        if (!qr) {
          throw new ReturnRejectedError("UNKNOWN_QR", "This QR has no produced carton. It cannot be returned.", {
            currentStatus: null,
          });
        }

        const identity = {
          article: qr.article,
          color: qr.color,
          size: qr.size,
          currentStatus: qr.currentStatus,
        };

        // Idempotency, first line: the carton is already standing at the gate. Nothing is
        // written, and the operator is told what it is waiting for. (The unique index on
        // sale_returns.dispatch_event_id is the second line, for two terminals at once.)
        if (qr.currentStatus === ON_GATE_STATUS) {
          const existing = await this.findRecordedReturn(qrId, tx);
          throw new ReturnRejectedError(
            "ALREADY_RETURNED",
            existing
              ? `This carton's return was already recorded for ${existing.partyName}. It is waiting to be received by Store Move In.`
              : "This carton is already standing at the gate, waiting to be received by Store Move In.",
            { ...identity, existingReturn: existing }
          );
        }

        if (qr.currentStatus !== RETURNABLE_STATUS) {
          throw new ReturnRejectedError("NOT_DISPATCHED", describeStatus(qr.currentStatus), identity);
        }

        const attribution = await this.deps.attributionRepo.findActiveDispatchAttribution(qrId, tx);
        if (!attribution) {
          throw new ReturnRejectedError(
            "NO_ATTRIBUTION",
            "This carton was dispatched without a bill selected, so the system does not know which customer it went to. Its return cannot be recorded here.",
            { ...identity, attribution: null }
          );
        }

        const eventId = this.deps.idGenerator.nextId();
        const outboxId = this.deps.idGenerator.nextId();
        const saleReturnId = this.deps.idGenerator.nextId();
        const returnDate = this.deps.localDate ? this.deps.localDate() : tx.nowIso.slice(0, 10);

        // Guarded status move first: if it does not apply (another terminal got there
        // first) the repository throws and nothing below runs.
        await this.deps.qrMasterRepo.markOnGate(
          { qrId, locationId: input.context.factoryId, updatedAt: tx.nowIso },
          tx
        );

        const recorded = await this.deps.saleReturnsRepo.recordSaleReturn(
          {
            saleReturnId,
            qrId,
            productVariantId: qr.productVariantId,
            returnDate,
            attribution,
            recordedBy: input.actor ?? null,
            occurredAt: tx.nowIso,
          },
          tx
        );

        await this.deps.returnEventsRepo.appendReturnRecordedEvent(
          {
            eventId,
            qrId,
            productVariantId: qr.productVariantId,
            article: qr.article,
            color: qr.color,
            size: qr.size,
            serial,
            occurredAt: tx.nowIso,
            parserVersion: parsed.parserVersion,
            previousStatus: qr.currentStatus,
            fromLocationType: RETURNED_FROM_LOCATION_TYPE,
            fromLocationId: null,
            factoryId: input.context.factoryId,
            workstationId: input.context.workstationId,
            deviceId: input.context.deviceId,
            operatorId: input.context.operatorId,
            actor: input.actor ?? null,
            dispatchEventId: attribution.dispatchEventId,
            dispatchSessionId: attribution.dispatchSessionId,
            partyId: attribution.partyId,
            saleVoucherId: attribution.saleVoucherId,
            saleReturnId: recorded.saleReturnId,
          },
          tx
        );

        await this.deps.outboxRepo.enqueueReturn(
          {
            outboxId,
            eventId,
            qrId,
            createdAt: tx.nowIso,
            parserVersion: parsed.parserVersion,
            factoryId: input.context.factoryId,
            workstationId: input.context.workstationId,
            deviceId: input.context.deviceId,
          },
          tx
        );

        return { eventId, recordedAt: tx.nowIso, identity: qr, attribution, recorded };
      });

      await this.deps.eventPublisher.publish("ReturnRecorded.v1", {
        qrId,
        parserVersion: parsed.parserVersion,
        occurredAt: committed.recordedAt,
        partyId: committed.attribution.partyId,
        saleReturnId: committed.recorded.saleReturnId,
      });

      return {
        accepted: true,
        outcome: "RETURN_RECORDED",
        qrId,
        parserVersion: parsed.parserVersion,
        article: committed.identity.article,
        color: committed.identity.color,
        size: committed.identity.size,
        serial,
        currentStatus: ON_GATE_STATUS,
        attribution: committed.attribution,
        recordedAt: committed.recordedAt,
        saleReturnId: committed.recorded.saleReturnId,
        returnNumber: committed.recorded.returnNumber,
        eventId: committed.eventId,
      };
    } catch (error) {
      if (error instanceof ReturnRejectedError) {
        return {
          accepted: false,
          outcome: error.outcome,
          qrId,
          parserVersion: parsed.parserVersion,
          reason: error.message,
          article: error.details.article ?? article,
          color: error.details.color ?? color,
          size: error.details.size ?? size,
          serial,
          currentStatus: error.details.currentStatus ?? null,
          attribution: error.details.attribution ?? null,
          existingReturn: error.details.existingReturn ?? null,
        };
      }
      throw error;
    }
  }

  /** The live return recorded for this carton's latest dispatch, if there is one. */
  private async findRecordedReturn(qrId: string, tx: TransactionContext): Promise<ExistingReturn | null> {
    const attribution = await this.deps.attributionRepo.findActiveDispatchAttribution(qrId, tx);
    if (!attribution) return null;
    return this.deps.attributionRepo.findReturnForDispatchEvent(attribution.dispatchEventId, tx);
  }
}
