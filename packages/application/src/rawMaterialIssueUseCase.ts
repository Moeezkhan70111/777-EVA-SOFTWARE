import {
  InvalidQrError,
  RAW_MATERIAL_QR_STATUS,
  STOCK_EVENT_NOTE,
  cartonsExpectedFromUppers,
  isValidRawMaterialQrId,
  parseRawMaterialQrId,
  programOutstanding,
  roundQuantity,
  type MachineProgramCartonTarget,
} from "@erp/domain";
import type { RawMaterialMovementRepository } from "./rawMaterialReceiptUseCase.js";
import type { EventPublisher, IdGenerator, ScanOperationalContext, TransactionContext, TransactionManager } from "./ports.js";

// Raw Material Output: issuing a packet out of the store to the section that consumes it.
//
//   IN_STORE  ──STORE_EXIT──▶  ISSUED (at the material's section)
//
// The mirror of Raw Material Input, with one difference that matters: there is nothing for
// the operator to choose. Where a packet goes is a property of its material — rubber uppers
// go to packing, ragzine to the upper maker — so the storekeeper only scans.
//
// Gatepass reservations are a finished-goods concept and are deliberately not consulted
// here: a Gatepass is cut against carton store stock, never against raw material.
//
// MACHINE PROGRAMS are. A program promises a machine so much of an upper, and this
// scan is where that promise is kept. There are two ways a packet finds the promise it keeps:
//
//   AUTO      the generic store scanner. The storekeeper is never asked which program a packet
//             is for: the packet's own identity finds the oldest program still owing that upper
//             (FIFO). If nothing is owed, the scan is an ordinary issue and nothing about any
//             program changes. This is the 2026-09-22 rule — the store scanner stays generic.
//   PROGRAM   a Machine Program is open on Store Out and the operator is issuing against it.
//             Only THAT program's allocations may be consumed, and a packet it does not
//             authorise is refused rather than quietly counted against someone else's program.
//
// Both modes run the same body (issueRawMaterialPacket), so there is exactly one place where a
// raw material packet leaves the store, one stock change and one event shape.

export type RawMaterialIssueOutcome =
  /** Accepted: the packet has left the store and its stock is debited. */
  | "ISSUED"
  /** The packet is not in the store, so there is nothing to take out of it. */
  | "NOT_IN_STORE"
  /** The value parses as a raw material label but was never generated. */
  | "UNKNOWN_QR"
  /** Registered but not issuable: voided, or its material has been retired. */
  | "NOT_ELIGIBLE"
  /** The material has no packing, so there is no quantity to take off the balance. */
  | "NOT_CONFIGURED"
  /** The scanned text is not a raw material label at all. */
  | "INVALID_FORMAT"
  /** Another terminal moved this packet between our read and our write. */
  | "STATUS_CHANGED"
  /**
   * PROGRAM mode only: this upper is not on the open program at all, or everything the program
   * asked for of it has already been issued. The packet stays in the store.
   */
  | "NOT_ON_PROGRAM";

export interface RawMaterialIssueInput {
  rawScan: string;
  sessionId: string;
  context: ScanOperationalContext;
  actor?: string | null;
}

/**
 * Which machine program allocation a packet may be counted against as it leaves the store.
 *
 * AUTO is the generic scanner and is what every existing caller means. PROGRAM is Store Out
 * working through one open Machine Program.
 */
export type IssueProgramBinding =
  | { mode: "AUTO" }
  | { mode: "PROGRAM"; programId: string; batchId: string | null }
  /**
   * Upper Move Out (Phase 3): the operator named the MACHINE the packet goes to. No program
   * allocation is consumed — the retired programs' reservations are not this screen's to keep —
   * and the machine is stamped on the STORE_EXIT event (migration 079).
   */
  | { mode: "MACHINE"; machineId: string };

/** The generic store scanner: the packet finds its own program, or none. */
export const AUTO_PROGRAM_BINDING: IssueProgramBinding = { mode: "AUTO" };

/**
 * What this scan did to a machine program, so the scanner card can say it out loud: "12 of 30
 * DOZEN for MACHINE 2 — CONTRACTOR A". In AUTO mode the storekeeper chose none of it.
 */
export interface MachineProgramConsumption {
  programId: string;
  code: string;
  machineName: string;
  contractorName: string;
  /** What this line asked for, and how much has now been taken for it including this packet. */
  lineQuantity: number;
  lineConsumed: number;
  lineOutstanding: number;
  unitCode: string | null;
  /** True when this scan took the program's last outstanding quantity and closed it. */
  programCompleted: boolean;
  /**
   * The finished goods this packet's line is moulding, and how many cartons of them this
   * packet's quantity will come back as, so the store can label them before they arrive.
   *
   * Only filled in PROGRAM mode — the generic scanner does not know which program it will serve
   * until after the fact, and nothing about carton labelling belongs in a blind FIFO scan.
   * `cartonCount` is null when the quantity is not a whole number of cartons of DOZEN.
   */
  cartonTarget: MachineProgramCartonTarget | null;
  cartonCount: number | null;
}

export interface RawMaterialIssueResult {
  accepted: boolean;
  outcome: RawMaterialIssueOutcome;
  qrId?: string;
  reason?: string;
  itemDisplayName?: string;
  /** The supplier the packet came in from. */
  partyName?: string;
  packingQuantity?: number;
  packingUnitCode?: string | null;
  /** The store's own word for the container: BAG, PACKET, ROLL. */
  packName?: string | null;
  /** The machine program this bag was counted against, when one was waiting for it. */
  machineProgram?: MachineProgramConsumption;
  previousStatus?: string | null;
  currentStatus?: string | null;
  issuedAt?: string;
  eventId?: string;
  sessionId?: string;
}

/** Thrown inside the transaction to abort with a typed outcome and no writes. */
export class RawMaterialIssueRejectedError extends Error {
  constructor(
    readonly outcome: Exclude<RawMaterialIssueOutcome, "ISSUED">,
    message: string,
    readonly details: Partial<RawMaterialIssueResult> = {}
  ) {
    super(message);
    this.name = "RawMaterialIssueRejectedError";
  }
}

export interface RawMaterialIssueDeps {
  txManager: TransactionManager;
  repo: RawMaterialMovementRepository;
  eventPublisher: EventPublisher;
  idGenerator: IdGenerator;
}

/**
 * Whether a scanned value is a raw material label at all, and readable.
 *
 * Checked before any transaction is opened: a carton scanned on a raw material station is a real
 * mistake worth naming, and the operator is most likely on the wrong screen.
 */
export const checkRawMaterialScanFormat = (raw: string): RawMaterialIssueResult | null => {
  if (!isValidRawMaterialQrId(raw)) {
    return {
      accepted: false,
      outcome: "INVALID_FORMAT",
      reason: "This is not a raw material QR. Finished cartons leave the store on Store Move Out.",
    };
  }
  try {
    parseRawMaterialQrId(raw);
  } catch (error) {
    if (error instanceof InvalidQrError) {
      return { accepted: false, outcome: "INVALID_FORMAT", reason: "This label could not be read. Scan it again." };
    }
    throw error;
  }
  return null;
};

export interface IssuePacketInput {
  /** A raw material QR id whose format checkRawMaterialScanFormat has already accepted. */
  qrId: string;
  sessionId: string | null;
  context: ScanOperationalContext;
  actor?: string | null;
  binding: IssueProgramBinding;
}

/**
 * The allocation a packet is being counted against, in the shape both lookups answer in.
 *
 * AUTO finds it across programs (oldest first) and PROGRAM finds it inside the one the operator
 * opened; the carton target only the latter carries, so it is read separately.
 */
type OutstandingProgramLine = {
  lineId: string;
  programId: string;
  programNumber: number;
  machineName: string;
  contractorName: string;
  itemDisplayName: string;
  quantity: number;
  consumedQuantity: number;
  unitCode: string | null;
};

export interface IssuedPacket {
  eventId: string;
  issuedAt: string;
  /** What came off the balance, in the material stock unit — the figure the event carries. */
  quantity: number;
  unitId: string;
  unit: NonNullable<ReturnType<RawMaterialMovementRepository["getRawMaterialQrForMovement"]>>;
  machineProgram?: MachineProgramConsumption;
}

/**
 * Takes ONE packet out of the store, inside the caller's transaction.
 *
 * This is the single place a raw material packet's stock is debited: the status move, the balance
 * change and the stamped STORE_EXIT event all happen here, under one lock, so a packet can never
 * be out of the store and still reserved. A rule that refuses throws RawMaterialIssueRejectedError,
 * which rolls the caller's whole transaction back — for a batch, that is what makes Save Batch
 * all-or-nothing.
 */
export const issueRawMaterialPacket = async (
  deps: RawMaterialIssueDeps,
  input: IssuePacketInput,
  tx: TransactionContext
): Promise<IssuedPacket> => {
  const { repo } = deps;
  const qrId = input.qrId;
  const unit = repo.getRawMaterialQrForMovement(qrId, tx);
  if (!unit) {
    throw new RawMaterialIssueRejectedError("UNKNOWN_QR", "This QR is not registered.", { qrId });
  }

  const identity = {
    qrId,
    itemDisplayName: unit.displayName,
    partyName: unit.partyName,
    previousStatus: unit.currentStatus,
    currentStatus: unit.currentStatus,
  };

  if (unit.registryStatus === "VOID") {
    throw new RawMaterialIssueRejectedError("NOT_ELIGIBLE", "This QR was voided and has no packet to issue.", identity);
  }
  // The packet is simply taken out of the store. Where it goes afterwards is not the
  // store's business any more — raw material routes were removed on 2026-10-07.
  if (unit.currentStatus !== RAW_MATERIAL_QR_STATUS.IN_STORE) {
    throw new RawMaterialIssueRejectedError(
      "NOT_IN_STORE",
      "This packet is not in the store. Receive it on Raw Material Input first.",
      identity
    );
  }
  if (unit.packingQuantity == null || !unit.packingUnitId) {
    throw new RawMaterialIssueRejectedError(
      "NOT_CONFIGURED",
      `Set how much one packet of ${unit.displayName} holds in Raw Material Packing before issuing it.`,
      identity
    );
  }

  // The allocation this packet keeps, found BEFORE anything is written so a program-restricted
  // scan refuses without touching the packet at all.
  //
  // A machine program is satisfied by the material leaving the store for it. With no routes there
  // is no section to match on, and a program names no supplier, so the material is the whole
  // match. AUTO serves the oldest program still owing this upper; PROGRAM serves only the open
  // one, because the operator named it and that is a stronger instruction than date order.
  let reservation: OutstandingProgramLine | null;
  let cartonTarget: MachineProgramCartonTarget | null = null;
  if (input.binding.mode === "MACHINE") {
    reservation = null;
  } else if (input.binding.mode === "PROGRAM") {
    const found = await repo.findOutstandingMachineProgramLineOfProgram(
      { programId: input.binding.programId, itemId: unit.itemId },
      tx
    );
    reservation = found;
    cartonTarget = found?.cartonTarget ?? null;
  } else {
    reservation = await repo.findOutstandingMachineProgramLine({ itemId: unit.itemId, sectionId: null }, tx);
  }

  if (input.binding.mode === "PROGRAM" && !reservation) {
    throw new RawMaterialIssueRejectedError(
      "NOT_ON_PROGRAM",
      `${unit.displayName} is not waiting on this machine program. Nothing was issued.`,
      identity
    );
  }

  const moved = repo.setRawMaterialQrStatus(
    {
      qrId,
      expectedStatus: unit.currentStatus,
      nextStatus: RAW_MATERIAL_QR_STATUS.ISSUED,
      sectionId: null,
      updatedAt: tx.nowIso,
    },
    tx
  );
  if (!moved) {
    throw new RawMaterialIssueRejectedError("STATUS_CHANGED", "Another terminal moved this packet. Scan it again.", identity);
  }

  const applied = repo.applyRawMaterialStockChange(
    {
      itemId: unit.itemId,
      quantity: unit.packingQuantity,
      unitId: unit.packingUnitId,
      direction: "OUT",
      note: `${STOCK_EVENT_NOTE.SCAN_OUT} ${qrId}`,
      actor: input.actor ?? null,
      nowIso: tx.nowIso,
    },
    tx
  );

  const eventId = deps.idGenerator.nextId();
  repo.appendRawMaterialQrEvent(
    {
      eventId,
      qrId,
      itemId: unit.itemId,
      partyId: unit.partyId,
      eventType: "STORE_EXIT",
      occurredAt: tx.nowIso,
      factoryId: input.context.factoryId,
      workstationId: input.context.workstationId,
      deviceId: input.context.deviceId,
      actor: input.actor ?? null,
      sessionId: input.sessionId,
      quantity: applied.quantity,
      unitId: applied.unitId,
      previousStatus: unit.currentStatus,
      newStatus: RAW_MATERIAL_QR_STATUS.ISSUED,
      sectionId: null,
      itemDisplayName: unit.displayName,
      // The stamp IS the ownership record. Reserved is recomputed from these rows, so
      // writing it here, in the same transaction as the stock change, is what makes the
      // reconciliation atomic: a bag can never be out of the store and still reserved.
      machineProgramLineId: reservation?.lineId ?? null,
      // Which Save Batch committed it. Null for the generic scanner, which has no batch.
      machineProgramBatchId: input.binding.mode === "PROGRAM" ? input.binding.batchId : null,
      // Upper Move Out's machine — written once, with the event, never moved afterwards.
      machineId: input.binding.mode === "MACHINE" ? input.binding.machineId : null,
    },
    tx
  );

  let machineProgram: MachineProgramConsumption | undefined;
  if (reservation) {
    // The event's quantity is in the material's stock unit — the unit the line is in.
    const lineConsumed = roundQuantity(reservation.consumedQuantity + applied.quantity);
    // The scan that takes a program's last upper finishes it, inside its own transaction.
    const completed =
      (await repo.machineProgramIsFullyConsumed(reservation.programId, tx)) &&
      (await repo.closeMachineProgram(
        {
          programId: reservation.programId,
          status: "COMPLETED",
          actor: input.actor ?? null,
          reason: null,
          nowIso: tx.nowIso,
        },
        tx
      ));
    machineProgram = {
      programId: reservation.programId,
      code: formatProgramCode(reservation.programNumber),
      machineName: reservation.machineName,
      contractorName: reservation.contractorName,
      lineQuantity: reservation.quantity,
      lineConsumed,
      lineOutstanding: programOutstanding(reservation.quantity, lineConsumed),
      unitCode: reservation.unitCode,
      programCompleted: completed,
      cartonTarget,
      // The packet's own quantity, in the unit the line is counted in: one packet of 2 DOZEN of
      // uppers is 4 cartons of finished goods coming back.
      cartonCount: cartonTarget ? cartonsExpectedFromUppers(applied.quantity, reservation.unitCode) : null,
    };
  }

  return { eventId, issuedAt: tx.nowIso, quantity: applied.quantity, unitId: applied.unitId, unit, machineProgram };
};

/** MP-000012. Kept local so this module does not depend on the program use cases. */
const formatProgramCode = (programNumber: number): string => `MP-${String(programNumber).padStart(6, "0")}`;

/** Turns a refusal thrown inside the transaction into the typed result the scanner reads. */
export const issueRefusalResult = (
  error: RawMaterialIssueRejectedError,
  qrId: string,
  sessionId: string | null
): RawMaterialIssueResult => ({
  accepted: false,
  outcome: error.outcome,
  qrId,
  reason: error.message,
  itemDisplayName: error.details.itemDisplayName,
  partyName: error.details.partyName,
  previousStatus: error.details.previousStatus ?? null,
  currentStatus: error.details.currentStatus ?? null,
  sessionId: sessionId ?? undefined,
});

export class IssueRawMaterialScanUseCase {
  constructor(private readonly deps: RawMaterialIssueDeps) {}

  async execute(input: RawMaterialIssueInput): Promise<RawMaterialIssueResult> {
    const raw = String(input.rawScan ?? "").trim().toUpperCase();

    const badFormat = checkRawMaterialScanFormat(raw);
    if (badFormat) return badFormat;

    try {
      const committed = await this.deps.txManager.runInTransaction((tx) =>
        issueRawMaterialPacket(
          this.deps,
          { qrId: raw, sessionId: input.sessionId, context: input.context, actor: input.actor, binding: AUTO_PROGRAM_BINDING },
          tx
        )
      );

      await this.deps.eventPublisher.publish("RawMaterialIssued.v1", {
        qrId: raw,
        occurredAt: committed.issuedAt,
        sessionId: input.sessionId,
      });

      return {
        accepted: true,
        outcome: "ISSUED",
        qrId: raw,
        itemDisplayName: committed.unit.displayName,
        partyName: committed.unit.partyName,
        packingQuantity: committed.unit.packingQuantity ?? undefined,
        packingUnitCode: committed.unit.packingUnitCode,
        packName: committed.unit.packName,
        machineProgram: committed.machineProgram,
        previousStatus: committed.unit.currentStatus,
        currentStatus: RAW_MATERIAL_QR_STATUS.ISSUED,
        issuedAt: committed.issuedAt,
        eventId: committed.eventId,
        sessionId: input.sessionId,
      };
    } catch (error) {
      if (error instanceof RawMaterialIssueRejectedError) {
        return issueRefusalResult(error, raw, input.sessionId);
      }
      throw error;
    }
  }
}
