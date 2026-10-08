import { InvalidQrError, isValidRawMaterialQrId, parseQrCode } from "@erp/domain";
import type {
  QrRegistryRepository,
  EventPublisher,
  IdGenerator,
  ScanOperationalContext,
  TransactionContext,
  TransactionManager,
} from "./ports.js";
import type { StoreEntryQrRecord } from "./storeEntryScanUseCase.js";

// Store Move Out: sends a carton out of the store to the gate, ready to be dispatched.
//
//   WAREHOUSE ("In Store")  ──STORE_EXIT──▶  TO_GATE  ("To Gate")
//   location WAREHOUSE                        location GATE
//
// The mirror of Store Scanning's receiving step. It consumes the same QR identity and event
// log, never creates anything, and only moves a unit that Store Scanning actually received:
// a carton that skipped the store is refused so the store's in/out record stays honest.
//
// Gatepass reconciliation. The store scanner is generic: the operator scans, the carton
// moves, nothing about a Gatepass is asked or required. Inside the same transaction, once the
// physical move is decided, the scan looks for the oldest open Gatepass line that still owes
// this exact variant (article + colour + size — the product_variant_id of the scanned unit)
// and, if there is one, records that gatepass id on the STORE_EXIT event. That stamp is what
// turns "requested 2" into "moved out 1, outstanding 1" and keeps Reflected Stock right
// (see @erp/domain gatepassStock.ts). Oldest first (gatepass number, i.e. creation order):
// deterministic, variant-exact, never a guess from time or from the operator. With no
// matching reservation the event simply carries no gatepass. The reservation never decides
// whether the carton may leave — the physical movement is the authority and the reservation
// follows it; and because both are one transaction, one cannot happen without the other.

/** Statuses a unit may be in when it is carried out of the store. */
export const STORE_EXIT_ELIGIBLE_STATUSES: ReadonlySet<string> = new Set(["WAREHOUSE"]);

/** The qr_master status and location type a moved-out unit goes to. */
export const TO_GATE_STATUS = "TO_GATE";
export const GATE_LOCATION_TYPE = "GATE";

export type StoreExitOutcome =
  /** Accepted: status and location moved, event recorded. */
  | "MOVED_OUT"
  /** The unit is already TO GATE. Nothing changed. */
  | "ALREADY_AT_GATE"
  /** A live unit at the factory (PRODUCED / RETURNED) that was never received into the store. */
  | "NOT_IN_STORE"
  /** The value parses but was never issued by the QR Generator and has no live unit. */
  | "UNKNOWN_QR"
  /** Registered by the QR Generator (GENERATED / VOID) but never scanned into production. */
  | "NOT_PRODUCED"
  /** A live unit that cannot leave the store (dispatched, sold, damaged, scrapped). */
  | "NOT_ELIGIBLE"
  /** The scanned text is not a QR identity at all. */
  | "INVALID_FORMAT"
  /** A well-formed raw material QR, which belongs on the Raw Material screens. */
  | "RAW_MATERIAL_NOT_SUPPORTED"
  /** Another terminal moved this unit between our read and our write. Nothing changed. */
  | "STATUS_CHANGED"
  /** Gatepass-locked only: this carton is not an article/colour/size the Gatepass asks for. */
  | "NOT_ON_GATEPASS"
  /** Gatepass-locked only: that line already has every carton it asked for. */
  | "LINE_COMPLETE"
  /** Gatepass-locked only: the document is not waiting at the store (unbilled, or already gone). */
  | "GATEPASS_NOT_READY";

/** Same read as store entry: the live unit plus its variant identity. */
export type StoreExitQrRecord = StoreEntryQrRecord;

/** The oldest open Gatepass line still owing a variant, as the repository reads it under the write lock. */
export interface OutstandingGatepassLine {
  gatepassId: string;
  gatepassNumber: number;
  partyName: string;
  article: string;
  color: string;
  size: string;
  quantity: number;
  dispatchedFromStoreQuantity: number;
}

/** The Gatepass line a move-out was counted against, after that scan. */
export interface StoreExitGatepassProgress {
  gatepassId: string;
  code: string;
  partyName: string;
  article: string;
  color: string;
  size: string;
  requested: number;
  dispatchedFromStore: number;
  outstanding: number;
}

export interface StoreExitScanInput {
  /**
   * Gatepass-locked mode. Given, the scan is held to THAT document: only an article + colour +
   * size it asks for is accepted, only while it is BILLED, and only while that line still owes
   * cartons. Omitted, the scanner stays generic and reconciles to the oldest open line as
   * before — the two modes share one transaction and one event path.
   */
  gatepassId?: string;
  rawScan: string;
  context: ScanOperationalContext;
  /** Move-out session the scan belongs to (operational grouping only). */
  sessionId?: string;
  /** Logged-in user performing the scan; recorded on the event like the receiving step. */
  actor?: string | null;
}

export interface StoreExitScanResult {
  accepted: boolean;
  outcome: StoreExitOutcome;
  qrId?: string;
  parserVersion?: string;
  /** Operator-facing explanation for a rejection. */
  reason?: string;
  article?: string;
  color?: string;
  size?: string;
  serial?: string;
  /** Status before this scan (null when the code has no live unit). */
  previousStatus?: string | null;
  /** Status after this scan — unchanged unless accepted. */
  currentStatus?: string | null;
  /** qr_codes.status for a registered-but-unproduced code. */
  registryStatus?: string | null;
  movedOutAt?: string;
  eventId?: string;
  /** True when this scan completed the Gatepass and sent the whole document to the gate. */
  gatepassReachedGate?: boolean;
  sessionId?: string;
  /** Set when the move-out was counted against a Gatepass reservation: that line's progress after this scan. */
  gatepass?: StoreExitGatepassProgress;
}

/** Thrown inside the transaction to abort with a typed outcome and no writes. */
export class StoreExitRejectedError extends Error {
  constructor(
    readonly outcome: Exclude<StoreExitOutcome, "MOVED_OUT">,
    message: string,
    readonly details: Partial<StoreExitScanResult> = {}
  ) {
    super(message);
    this.name = "StoreExitRejectedError";
  }
}

export interface StoreExitEventPayload {
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
  toLocationType: string;
  toLocationId: string;
  factoryId: string;
  workstationId: string;
  deviceId: string;
  operatorId?: string;
  actor?: string | null;
  sessionId?: string;
  /** The Gatepass reservation this move-out was counted against, recorded on the event as its exact owner. */
  gatepassId?: string | null;
}

export interface StoreExitScanDeps {
  txManager: TransactionManager;
  qrLookupRepo: {
    getQrForStoreExit(qrId: string, tx: TransactionContext): Promise<StoreExitQrRecord | null>;
  };
  /**
   * The oldest open Gatepass line that still owes this variant, read inside the write lock so
   * two terminals scanning the same variant at once consume two different cartons of it,
   * never the same one twice. Null when nothing is reserved for the variant.
   */
  gatepassRepo: {
    findOldestOutstandingGatepassLine(productVariantId: string, tx: TransactionContext): Promise<OutstandingGatepassLine | null>;
    /** Gatepass-locked: the one line of THIS document that matches the scanned carton exactly. */
    findGatepassLineForVariant(
      gatepassId: string,
      productVariantId: string,
      tx: TransactionContext
    ): { article: string; color: string; size: string; quantity: number; dispatchedFromStoreQuantity: number } | null;
    readGatepassStatus(gatepassId: string, tx: TransactionContext): string | null;
    /** Whether every line of a Gatepass has now had its full quantity scanned out of the store. */
    gatepassStoreScanComplete(gatepassId: string, tx: TransactionContext): boolean;
    /** Guarded status move. False when the document was not in `from` any more. */
    advanceGatepassStatus(
      payload: { gatepassId: string; from: string; to: string; actor?: string | null },
      tx: TransactionContext
    ): boolean;
  };
  /** Distinguishes an unknown value from a registered code that was never produced. */
  qrRegistry: QrRegistryRepository;
  qrMasterRepo: {
    /**
     * Moves the unit to TO_GATE_STATUS / GATE_LOCATION_TYPE. Must be a guarded update that
     * only succeeds while the unit is still In Store, and must throw StoreExitRejectedError
     * when it is not — that guard is what makes two terminals scanning the same carton at
     * once yield exactly one store exit.
     */
    markAtGate(
      payload: { qrId: string; locationId: string; updatedAt: string },
      tx: TransactionContext
    ): Promise<void>;
  };
  storeExitEventsRepo: {
    appendStoreExitEvent(payload: StoreExitEventPayload, tx: TransactionContext): Promise<void>;
  };
  stockProjectionRepo: {
    /** Moves one unit from the store to the gate; the variant total on hand does not change. */
    moveStockToGate(
      payload: {
        productVariantId: string;
        fromLocationType: string;
        fromLocationId: string | null;
        toLocationId: string;
        occurredAt: string;
      },
      context: ScanOperationalContext,
      tx: TransactionContext
    ): Promise<void>;
  };
  outboxRepo: {
    enqueueStoreExit(
      payload: {
        outboxId: string;
        eventId: string;
        qrId: string;
        createdAt: string;
        parserVersion: string;
        factoryId: string;
        workstationId: string;
        deviceId: string;
        sessionId?: string;
        gatepassId?: string | null;
      },
      tx: TransactionContext
    ): Promise<void>;
  };
  eventPublisher: EventPublisher;
  idGenerator: IdGenerator;
}

const describeStatus = (status: string): string => {
  switch (status) {
    case "DISPATCHED":
      return "This carton has already been dispatched to a customer.";
    case "SOLD":
      return "This carton has already been sold.";
    case "DAMAGED":
      return "This unit has been written off as damaged.";
    case "SCRAPPED":
      return "This unit has been scrapped.";
    default:
      return `This carton is in status ${status} and cannot be moved out of the store.`;
  }
};

const gatepassCode = (gatepassNumber: number): string => `GP-${String(gatepassNumber).padStart(6, "0")}`;

/** The line's figures once this one carton is counted against it. */
const progressAfterThisScan = (line: OutstandingGatepassLine): StoreExitGatepassProgress => ({
  gatepassId: line.gatepassId,
  code: gatepassCode(line.gatepassNumber),
  partyName: line.partyName,
  article: line.article,
  color: line.color,
  size: line.size,
  requested: line.quantity,
  dispatchedFromStore: line.dispatchedFromStoreQuantity + 1,
  outstanding: line.quantity - line.dispatchedFromStoreQuantity - 1,
});

export class StoreExitScanUseCase {
  constructor(private readonly deps: StoreExitScanDeps) {}

  async execute(input: StoreExitScanInput): Promise<StoreExitScanResult> {
    let parsed: ReturnType<typeof parseQrCode>;
    try {
      parsed = parseQrCode(input.rawScan);
    } catch (error) {
      if (error instanceof InvalidQrError) {
        // Tell the operator the truth: a raw material label is registered and readable,
        // it is this screen that does not handle raw materials yet. Calling it invalid
        // sends them off reprinting perfectly good labels. See
        // docs/21-raw-material-store-movement-gap.md.
        // A raw material label is well formed, just not this screen's business.
        if (isValidRawMaterialQrId(input.rawScan)) {
          return {
            accepted: false,
            outcome: "RAW_MATERIAL_NOT_SUPPORTED",
            qrId: input.rawScan.trim().toUpperCase(),
            reason: "This is a raw material QR. Receive it on the Raw Material Input screen — this screen is for finished cartons.",
          };
        }
        return {
          accepted: false,
          outcome: "INVALID_FORMAT",
          reason: "This is not a valid carton QR. Check the label and scan again.",
        };
      }
      throw error;
    }

    const { qrId, article, color, size, serial } = parsed.payload;
    const toLocationId = input.context.factoryId;

    try {
      const committed = await this.deps.txManager.runInTransaction(async (tx) => {
        const qr = await this.deps.qrLookupRepo.getQrForStoreExit(qrId, tx);

        if (!qr) {
          const registered = await this.deps.qrRegistry.findRegisteredQrCode(qrId, tx);
          if (!registered) {
            throw new StoreExitRejectedError("UNKNOWN_QR", "This QR is not registered.", {
              previousStatus: null,
              currentStatus: null,
            });
          }
          throw new StoreExitRejectedError(
            "NOT_PRODUCED",
            registered.status === "VOID"
              ? "This QR was voided in QR Management and has no unit to move."
              : "This QR has not completed the required production process.",
            {
              article: registered.article,
              color: registered.color,
              size: registered.size,
              registryStatus: registered.status,
              previousStatus: null,
              currentStatus: null,
            }
          );
        }

        const identity = {
          article: qr.article,
          color: qr.color,
          size: qr.size,
          previousStatus: qr.currentStatus,
          currentStatus: qr.currentStatus,
        };

        if (qr.currentStatus === TO_GATE_STATUS) {
          throw new StoreExitRejectedError("ALREADY_AT_GATE", "This carton has already been moved out to the gate.", identity);
        }

        if (qr.currentStatus === "PRODUCED" || qr.currentStatus === "RETURNED") {
          throw new StoreExitRejectedError(
            "NOT_IN_STORE",
            "This carton has not been received into the store. Move it in first.",
            identity
          );
        }

        if (!STORE_EXIT_ELIGIBLE_STATUSES.has(qr.currentStatus)) {
          throw new StoreExitRejectedError("NOT_ELIGIBLE", describeStatus(qr.currentStatus), identity);
        }

        const eventId = this.deps.idGenerator.nextId();
        const outboxId = this.deps.idGenerator.nextId();

        // Guarded status move first: if it does not apply (another terminal got there
        // first) the repository throws and nothing below runs.
        await this.deps.qrMasterRepo.markAtGate({ qrId, locationId: toLocationId, updatedAt: tx.nowIso }, tx);

        // Which Gatepass this carton counts against.
        //
        // Locked mode: the operator opened one document and the scan is held to it — the line
        // must exist on it, exactly, and still owe cartons. Generic mode: the oldest open line
        // still owing this variant, as before. Either way the decision is read under the same
        // lock as the move, so the stamp below is the only record of the consumption.
        let gatepassId: string | null = null;
        let gatepass: StoreExitGatepassProgress | undefined;

        if (input.gatepassId) {
          const status = this.deps.gatepassRepo.readGatepassStatus(input.gatepassId, tx);
          if (status !== "BILLED") {
            throw new StoreExitRejectedError(
              "GATEPASS_NOT_READY",
              status === null
                ? "That Gatepass could not be found."
                : status === "CREATED"
                  ? "This Gatepass has not been billed yet. Billing must make its bill first."
                  : `This Gatepass is already ${status.replace("_", " ").toLowerCase()}. The store has finished with it.`
            );
          }
          const line = this.deps.gatepassRepo.findGatepassLineForVariant(input.gatepassId, qr.productVariantId, tx);
          if (!line) {
            throw new StoreExitRejectedError(
              "NOT_ON_GATEPASS",
            `This Gatepass does not ask for ${qr.article} ${qr.color} ${qr.size}.`
            );
          }
          if (line.quantity - line.dispatchedFromStoreQuantity <= 0) {
            throw new StoreExitRejectedError(
              "LINE_COMPLETE",
            `${qr.article} ${qr.color} ${qr.size} is already complete on this Gatepass.`
            );
          }
          gatepassId = input.gatepassId;
          gatepass = progressAfterThisScan({
            gatepassId: input.gatepassId,
            gatepassNumber: 0,
            partyName: "",
            article: line.article,
            color: line.color,
            size: line.size,
            quantity: line.quantity,
            dispatchedFromStoreQuantity: line.dispatchedFromStoreQuantity,
          });
        } else {
          const reservation = await this.deps.gatepassRepo.findOldestOutstandingGatepassLine(qr.productVariantId, tx);
          gatepass = reservation ? progressAfterThisScan(reservation) : undefined;
          gatepassId = reservation?.gatepassId ?? null;
        }

        await this.deps.storeExitEventsRepo.appendStoreExitEvent(
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
            fromLocationType: qr.currentLocationType,
            fromLocationId: qr.currentLocationId,
            toLocationType: GATE_LOCATION_TYPE,
            toLocationId,
            factoryId: input.context.factoryId,
            workstationId: input.context.workstationId,
            deviceId: input.context.deviceId,
            operatorId: input.context.operatorId,
            actor: input.actor ?? null,
            sessionId: input.sessionId,
            gatepassId,
          },
          tx
        );

        await this.deps.stockProjectionRepo.moveStockToGate(
          {
            productVariantId: qr.productVariantId,
            fromLocationType: qr.currentLocationType,
            fromLocationId: qr.currentLocationId,
            toLocationId,
            occurredAt: tx.nowIso,
          },
          input.context,
          tx
        );

        await this.deps.outboxRepo.enqueueStoreExit(
          {
            outboxId,
            eventId,
            qrId,
            createdAt: tx.nowIso,
            parserVersion: parsed.parserVersion,
            factoryId: input.context.factoryId,
            workstationId: input.context.workstationId,
            deviceId: input.context.deviceId,
            sessionId: input.sessionId,
            gatepassId,
          },
          tx
        );

        // The carton that completes the last outstanding line is what sends the whole
        // document to the gate. Decided here, inside the same transaction as the move, from
        // the events just written — never from a counter, and never by the operator.
        //
        // Guarded on BILLED: a document still waiting for its bill is not allowed through the
        // journey, so if its cartons were moved by the generic scanner it simply stays where
        // it is and the status moves when billing catches up. The guard returning false is a
        // normal outcome here, not an error.
        let reachedGate = false;
        if (gatepassId && this.deps.gatepassRepo.gatepassStoreScanComplete(gatepassId, tx)) {
          reachedGate = this.deps.gatepassRepo.advanceGatepassStatus(
            { gatepassId, from: "BILLED", to: "AT_GATE", actor: input.actor ?? null },
            tx
          );
        }

        return { eventId, movedOutAt: tx.nowIso, previousStatus: qr.currentStatus, identity: qr, gatepass, reachedGate };
      });

      await this.deps.eventPublisher.publish("StoreExitCompleted.v1", {
        qrId,
        parserVersion: parsed.parserVersion,
        occurredAt: committed.movedOutAt,
        sessionId: input.sessionId,
        gatepassId: committed.gatepass?.gatepassId ?? null,
      });

      return {
        accepted: true,
        outcome: "MOVED_OUT",
        qrId,
        parserVersion: parsed.parserVersion,
        article: committed.identity.article,
        color: committed.identity.color,
        size: committed.identity.size,
        serial,
        previousStatus: committed.previousStatus,
        currentStatus: TO_GATE_STATUS,
        movedOutAt: committed.movedOutAt,
        eventId: committed.eventId,
        sessionId: input.sessionId,
        gatepass: committed.gatepass,
        gatepassReachedGate: committed.reachedGate,
      };
    } catch (error) {
      if (error instanceof StoreExitRejectedError) {
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
          previousStatus: error.details.previousStatus ?? null,
          currentStatus: error.details.currentStatus ?? null,
          registryStatus: error.details.registryStatus ?? null,
          sessionId: input.sessionId,
        };
      }
      throw error;
    }
  }
}
