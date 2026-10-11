import { InvalidQrError, isValidRawMaterialQrId, parseQrCode } from "@erp/domain";
import type {
  QrRegistryRepository,
  EventPublisher,
  IdGenerator,
  ScanOperationalContext,
  TransactionContext,
  TransactionManager,
} from "./ports.js";

// Store Scanning: receives a physical production carton into the store.
//
//   PRODUCED / RETURNED  ──STORE_ENTRY──▶  WAREHOUSE  ("In Store")
//   location FACTORY                        location WAREHOUSE
//
//   TO_GATE              ──STORE_ENTRY──▶  WAREHOUSE  (a carton brought back from the gate)
//   location GATE                           location WAREHOUSE
//
//   ON_GATE              ──STORE_ENTRY──▶  WAREHOUSE  (a returned carton, now arriving)
//   location GATE                           location WAREHOUSE
//
// It is another consumer of the same QR identity + event log the production, dispatch and
// return scanners write to. It never creates a QR, product or variant: a value that is not
// already a live unit in qr_master is rejected before anything is written.
//
// A bring-back from the gate is the compensating record for a Store Move Out made for a
// Gatepass: the STORE_ENTRY event carries the gatepass id of the STORE_EXIT that put this
// exact carton at the gate, so that Gatepass line becomes outstanding again and Reflected
// Stock stays right (see @erp/domain gatepassStock.ts). Nothing is deleted or edited.

/**
 * Statuses a unit may be in when it physically arrives at the store. TO_GATE is included so
 * a carton moved out by mistake can be brought back with a plain receiving scan; ON_GATE so
 * a carton whose return has been recorded can be received when it actually arrives.
 */
export const STORE_ENTRY_ELIGIBLE_STATUSES: ReadonlySet<string> = new Set(["PRODUCED", "RETURNED", "ON_GATE", "TO_GATE"]);

/**
 * Statuses whose unit is not currently counted anywhere in stock, because it was dispatched
 * out of the company and has not been credited back. Receiving one of these ADDS a unit to
 * the variant pool rather than moving an existing one between locations.
 */
export const STORE_ENTRY_FROM_OUTSIDE_STATUSES: ReadonlySet<string> = new Set(["ON_GATE"]);

/** The qr_master status and location type a received unit moves to. */
export const IN_STORE_STATUS = "WAREHOUSE";
export const IN_STORE_LOCATION_TYPE = "WAREHOUSE";

export type StoreEntryOutcome =
  /** Accepted: status and location moved, event recorded. */
  | "RECEIVED"
  /** The unit is already IN STORE. Nothing changed. */
  | "ALREADY_IN_STORE"
  /** The value parses but was never issued by the QR Generator and has no live unit. */
  | "UNKNOWN_QR"
  /** Registered by the QR Generator (GENERATED / VOID) but never scanned into production. */
  | "NOT_PRODUCED"
  /** A live unit that is not in a receivable state (dispatched, sold, damaged, scrapped). */
  | "NOT_ELIGIBLE"
  /** The scanned text is not a QR identity at all. */
  | "INVALID_FORMAT"
  /** A well-formed raw material QR, which belongs on the Raw Material Input screen. */
  | "RAW_MATERIAL_NOT_SUPPORTED"
  /** Another terminal moved this unit between our read and our write. Nothing changed. */
  | "STATUS_CHANGED";

export interface StoreEntryQrRecord {
  qrId: string;
  productVariantId: string;
  currentStatus: string;
  currentLocationType: string;
  currentLocationId: string | null;
  article: string;
  color: string;
  size: string;
}

export interface StoreEntryScanInput {
  rawScan: string;
  context: ScanOperationalContext;
  /** Receiving session the scan belongs to (operational grouping only). */
  sessionId?: string;
  /** Logged-in user performing the scan; recorded on the event like QR Management's actor. */
  actor?: string | null;
}

export interface StoreEntryScanResult {
  accepted: boolean;
  outcome: StoreEntryOutcome;
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
  receivedAt?: string;
  eventId?: string;
  sessionId?: string;
}

/** Thrown inside the transaction to abort with a typed outcome and no writes. */
export class StoreEntryRejectedError extends Error {
  constructor(
    readonly outcome: Exclude<StoreEntryOutcome, "RECEIVED">,
    message: string,
    readonly details: Partial<StoreEntryScanResult> = {}
  ) {
    super(message);
    this.name = "StoreEntryRejectedError";
  }
}

export interface StoreEntryEventPayload {
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
  /**
   * For a carton brought back from the gate: the Gatepass its Store Move Out was made for,
   * so this entry is that move-out's compensating record. Null otherwise.
   */
  gatepassId?: string | null;
}

export interface StoreEntryScanDeps {
  txManager: TransactionManager;
  qrLookupRepo: {
    getQrForStoreEntry(qrId: string, tx: TransactionContext): Promise<StoreEntryQrRecord | null>;
  };
  /**
   * Which Gatepass this exact carton's latest Store Move Out was made for (null when it was
   * moved out without one). Optional only for callers with no Gatepass module.
   */
  gatepassRepo?: {
    findGatepassOfLastStoreExit(qrId: string, tx: TransactionContext): Promise<string | null>;
  };
  /** Distinguishes an unknown value from a registered code that was never produced. */
  qrRegistry: QrRegistryRepository;
  qrMasterRepo: {
    /**
     * Moves the unit to IN_STORE_STATUS / IN_STORE_LOCATION_TYPE. Must be a guarded update
     * that only succeeds while the unit is still in an eligible status, and must throw
     * StoreEntryRejectedError when it is not — that guard is what makes two terminals
     * scanning the same carton at once yield exactly one store entry.
     */
    markInStore(
      payload: { qrId: string; locationId: string; updatedAt: string },
      tx: TransactionContext
    ): Promise<void>;
  };
  storeEntryEventsRepo: {
    appendStoreEntryEvent(payload: StoreEntryEventPayload, tx: TransactionContext): Promise<void>;
  };
  stockProjectionRepo: {
    /** Moves one unit between locations; the variant total on hand does not change. */
    moveStockToStore(
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
    /**
     * Receives a unit that is currently outside the company (a returned carton arriving at
     * the store). Unlike a move, this ADDS to the variant total — dispatch removed it, and
     * nothing has put it back until now — as well as to the store's location count. There
     * is no source location to debit: the unit was with the customer.
     */
    receiveReturnedStockIntoStore(
      payload: { productVariantId: string; toLocationId: string; occurredAt: string },
      context: ScanOperationalContext,
      tx: TransactionContext
    ): Promise<void>;
  };
  outboxRepo: {
    enqueueStoreEntry(
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
      return "This carton is still out with a customer. Its return has to be recorded on the Return screen before the store can receive it.";
    case "SOLD":
      return "This carton has already been sold.";
    case "DAMAGED":
      return "This unit has been written off as damaged.";
    case "SCRAPPED":
      return "This unit has been scrapped.";
    default:
      return `This carton is in status ${status} and cannot be received into the store.`;
  }
};

export class StoreEntryScanUseCase {
  constructor(private readonly deps: StoreEntryScanDeps) {}

  async execute(input: StoreEntryScanInput): Promise<StoreEntryScanResult> {
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

    try {
      const committed = await this.deps.txManager.runInTransaction((tx) =>
        receiveIntoStoreInTransaction(this.deps, { parsed, context: input.context, sessionId: input.sessionId, actor: input.actor }, tx)
      );

      await this.deps.eventPublisher.publish("StoreEntryCompleted.v1", {
        qrId,
        parserVersion: parsed.parserVersion,
        occurredAt: committed.receivedAt,
        sessionId: input.sessionId,
      });

      return {
        accepted: true,
        outcome: "RECEIVED",
        qrId,
        parserVersion: parsed.parserVersion,
        article: committed.identity.article,
        color: committed.identity.color,
        size: committed.identity.size,
        serial,
        previousStatus: committed.previousStatus,
        currentStatus: IN_STORE_STATUS,
        receivedAt: committed.receivedAt,
        eventId: committed.eventId,
        sessionId: input.sessionId,
      };
    } catch (error) {
      if (error instanceof StoreEntryRejectedError) {
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

/** What the store-in step needs inside a transaction someone else opened. */
export type ReceiveIntoStoreDeps = Omit<StoreEntryScanDeps, "txManager" | "eventPublisher">;

/**
 * Store Move In itself — the ONE place a live carton is moved into the store: the guarded status
 * move, the STORE_ENTRY event, the stock movement and the outbox.
 *
 * Runs inside the caller's transaction, so another step can commit with it or not at all (Store
 * In receiving a machine program's carton produces it first, in the same transaction). Throws
 * StoreEntryRejectedError to refuse.
 */
export async function receiveIntoStoreInTransaction(
  deps: ReceiveIntoStoreDeps,
  input: { parsed: ReturnType<typeof parseQrCode>; context: ScanOperationalContext; sessionId?: string; actor?: string | null },
  tx: TransactionContext
): Promise<{ eventId: string; receivedAt: string; previousStatus: string; identity: StoreEntryQrRecord }> {
  const { parsed } = input;
  const { qrId, serial } = parsed.payload;
  const toLocationId = input.context.factoryId;
  const qr = await deps.qrLookupRepo.getQrForStoreEntry(qrId, tx);

  if (!qr) {
    // No live unit. Either the QR Generator never issued it, or it was issued and is
    // still waiting for its production scan. Either way nothing is created here.
    const registered = await deps.qrRegistry.findRegisteredQrCode(qrId, tx);
    if (!registered) {
      throw new StoreEntryRejectedError("UNKNOWN_QR", "This QR is not registered.", {
        previousStatus: null,
        currentStatus: null,
      });
    }
    throw new StoreEntryRejectedError(
      "NOT_PRODUCED",
      registered.status === "VOID"
        ? "This QR was voided in QR Management and has no unit to receive."
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

  if (qr.currentStatus === IN_STORE_STATUS) {
    throw new StoreEntryRejectedError("ALREADY_IN_STORE", "This carton has already been received.", identity);
  }

  if (!STORE_ENTRY_ELIGIBLE_STATUSES.has(qr.currentStatus)) {
    throw new StoreEntryRejectedError("NOT_ELIGIBLE", describeStatus(qr.currentStatus), identity);
  }

  const eventId = deps.idGenerator.nextId();
  const outboxId = deps.idGenerator.nextId();

  // A carton coming back from the gate undoes its Store Move Out for whichever
  // Gatepass that move-out named — read from this carton's own exit event, never guessed.
  const gatepassId =
    qr.currentStatus === "TO_GATE" && deps.gatepassRepo ? await deps.gatepassRepo.findGatepassOfLastStoreExit(qrId, tx) : null;

  // Guarded status move first: if it does not apply (another terminal got there
  // first) the repository throws and nothing below runs.
  await deps.qrMasterRepo.markInStore({ qrId, locationId: toLocationId, updatedAt: tx.nowIso }, tx);

  await deps.storeEntryEventsRepo.appendStoreEntryEvent(
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
      toLocationType: IN_STORE_LOCATION_TYPE,
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

  // A carton arriving back from a customer is not moving between our own locations —
  // it is re-entering the company, so the variant total grows by the one unit dispatch
  // took out. Every other eligible status is already counted somewhere and only moves.
  // This is the ONLY point at which a returned carton re-enters physical stock; the
  // return that was recorded on the gate deliberately moved nothing.
  if (STORE_ENTRY_FROM_OUTSIDE_STATUSES.has(qr.currentStatus)) {
    await deps.stockProjectionRepo.receiveReturnedStockIntoStore(
      { productVariantId: qr.productVariantId, toLocationId, occurredAt: tx.nowIso },
      input.context,
      tx
    );
  } else {
    await deps.stockProjectionRepo.moveStockToStore(
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
  }

  await deps.outboxRepo.enqueueStoreEntry(
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
    },
    tx
  );

  return { eventId, receivedAt: tx.nowIso, previousStatus: qr.currentStatus, identity: qr };
}
