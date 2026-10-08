import { InvalidQrError, RAW_MATERIAL_QR_STATUS, isValidRawMaterialQrId, parseRawMaterialQrId, programOutstanding, roundQuantity } from "@erp/domain";
import type { RawMaterialMovementRepository } from "./rawMaterialReceiptUseCase.js";
import type { EventPublisher, IdGenerator, ScanOperationalContext, TransactionManager } from "./ports.js";

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
// scan is where that promise is kept. The storekeeper is never asked which program a packet is
// for: the packet's own identity — its material and its supplier — finds the oldest program
// still owing it, on a machine standing in the section the packet is being sent to. If nothing
// is owed, the scan is an ordinary issue and nothing about any program changes.

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
  | "STATUS_CHANGED";

export interface RawMaterialIssueInput {
  rawScan: string;
  sessionId: string;
  context: ScanOperationalContext;
  actor?: string | null;
}

/**
 * What this scan did to a machine program, so the scanner card can say it out loud: "12 of 30
 * DOZEN for MACHINE 2 — CONTRACTOR A". The storekeeper chose none of it.
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

export class IssueRawMaterialScanUseCase {
  constructor(private readonly deps: RawMaterialIssueDeps) {}

  async execute(input: RawMaterialIssueInput): Promise<RawMaterialIssueResult> {
    const raw = String(input.rawScan ?? "").trim().toUpperCase();

    if (!isValidRawMaterialQrId(raw)) {
      // A carton scanned here is a real mistake worth naming: the operator is most likely
      // on the wrong screen.
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

    try {
      const committed = await this.deps.txManager.runInTransaction(async (tx) => {
        const unit = this.deps.repo.getRawMaterialQrForMovement(raw, tx);
        if (!unit) {
          throw new RawMaterialIssueRejectedError("UNKNOWN_QR", "This QR is not registered.", {});
        }

        const identity = {
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
        const moved = this.deps.repo.setRawMaterialQrStatus(
          {
            qrId: raw,
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

        // A machine program is satisfied by the material leaving the store for it. With no routes
        // there is no section to match on, and a program names no supplier, so the material is the
        // whole match: the oldest program still owing this upper is the one served.
        const reservation = await this.deps.repo.findOutstandingMachineProgramLine({ itemId: unit.itemId, sectionId: null }, tx);

        const applied = this.deps.repo.applyRawMaterialStockChange(
              {
                itemId: unit.itemId,
                quantity: unit.packingQuantity,
                unitId: unit.packingUnitId,
                direction: "OUT",
                note: `Raw Material Output ${raw}`,
                actor: input.actor ?? null,
                nowIso: tx.nowIso,
              },
          tx
        );

        const eventId = this.deps.idGenerator.nextId();
        this.deps.repo.appendRawMaterialQrEvent(
          {
            eventId,
            qrId: raw,
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
          },
          tx
        );

        let machineProgram: MachineProgramConsumption | undefined;
        if (reservation) {
          // The event's quantity is in the material's stock unit — the unit the line is in.
          const lineConsumed = roundQuantity(reservation.consumedQuantity + applied.quantity);
          // The scan that takes a program's last upper finishes it, inside its own transaction.
          const completed =
            (await this.deps.repo.machineProgramIsFullyConsumed(reservation.programId, tx)) &&
            (await this.deps.repo.closeMachineProgram(
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
            code: `MP-${String(reservation.programNumber).padStart(6, "0")}`,
            machineName: reservation.machineName,
            contractorName: reservation.contractorName,
            lineQuantity: reservation.quantity,
            lineConsumed,
            lineOutstanding: programOutstanding(reservation.quantity, lineConsumed),
            unitCode: reservation.unitCode,
            programCompleted: completed,
          };
        }

        return { eventId, issuedAt: tx.nowIso, unit, machineProgram };
      });

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
        return {
          accepted: false,
          outcome: error.outcome,
          qrId: raw,
          reason: error.message,
          itemDisplayName: error.details.itemDisplayName,
          partyName: error.details.partyName,
          previousStatus: error.details.previousStatus ?? null,
          currentStatus: error.details.currentStatus ?? null,
          sessionId: input.sessionId,
        };
      }
      throw error;
    }
  }
}
