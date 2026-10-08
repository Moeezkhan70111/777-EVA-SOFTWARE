import { InvalidQrError, RAW_MATERIAL_QR_STATUS, isValidRawMaterialQrId, parseRawMaterialQrId } from "@erp/domain";
import type { EventPublisher, IdGenerator, ScanOperationalContext, TransactionContext, TransactionManager } from "./ports.js";

// Raw Material Input: receiving a supplier's delivery into the store, one packet at a time.
//
//   GENERATED / ISSUED  ──STORE_ENTRY──▶  IN_STORE
//
// This is deliberately NOT the carton Store Move In screen. A carton and a raw material
// packet are different identities with different registries, different stock and different
// lifecycles, and mixing them on one scanner made both harder to reason about. The carton
// screens turn a raw material label away with a pointer to this one.
//
// The thing this screen adds over a plain scan is the SUPPLIER. Receiving is a
// supplier-at-a-time job: the storekeeper opens a session against the party whose delivery
// is on the floor, and every packet scanned into that session is checked against it. A
// packet belonging to another supplier is refused at the scanner rather than quietly
// credited to the wrong delivery.

/** One packet of a material, as the registry knows it. */
export interface RawMaterialMovementUnit {
  qrId: string;
  itemId: string;
  itemCode: string;
  partyId: string;
  partyName: string;
  displayName: string;
  itemStatus: string;
  /** Registry status (GENERATED / VOID), mirroring qr_codes.status. */
  registryStatus: string;
  /** Physical lifecycle status, mirroring qr_master.current_status. */
  currentStatus: string;
  currentSectionId: string | null;
  packingQuantity: number | null;
  packingUnitId: string | null;
  packingUnitCode: string | null;
  /** The store's own word for the container a label goes on: BAG, PACKET, ROLL. */
  packName: string | null;
  defaultSectionId: string | null;
  defaultSectionName: string | null;
  /** How far along its route the packet has got. 0 = not issued yet. */
  currentHopIndex: number;
  hopCount: number;
  /** The hop it is due at next, or null once the route is finished. */
  nextSectionId: string | null;
  nextSectionName: string | null;
}

export interface RawMaterialMovementRepository {
  getRawMaterialQrForMovement(qrId: string, tx: TransactionContext): RawMaterialMovementUnit | null;
  setRawMaterialQrStatus(
    input: {
      qrId: string; expectedStatus: string; nextStatus: string; sectionId: string | null;
      updatedAt: string; hopIndex?: number;
    },
    tx: TransactionContext
  ): boolean;
  applyRawMaterialStockChange(
    input: {
      itemId: string; quantity: number; unitId: string; direction: "IN" | "OUT";
      note: string; actor: string | null; nowIso: string;
    },
    tx: TransactionContext
  ): { quantity: number; unitId: string };
  appendRawMaterialQrEvent(
    payload: {
      eventId: string; qrId: string; itemId: string; partyId: string;
      eventType: "STORE_ENTRY" | "STORE_EXIT"; occurredAt: string;
      factoryId: string; workstationId: string; deviceId: string;
      actor: string | null; sessionId: string | null;
      quantity: number; unitId: string;
      previousStatus: string; newStatus: string; sectionId: string | null;
      itemDisplayName: string;
      /** The machine program allocation this movement was counted against, or null. */
      machineProgramLineId?: string | null;
    },
    tx: TransactionContext
  ): void;

  // ─── Machine Program reconciliation ───────────────────────────────────────
  // A machine program reserves uppers for a machine on a date. The packet that satisfies one is
  // identified by the scan itself, never chosen by the storekeeper.

  /**
   * The allocation this packet should be counted against as it leaves the store, or null when
   * nothing is waiting for it. Matched on the exact material, oldest program first — a program
   * names no supplier, so any packet of the upper satisfies it. A section narrows it to the
   * machines standing there; raw material no longer carries one, so it is optional.
   */
  findOutstandingMachineProgramLine(
    input: { itemId: string; sectionId?: string | null },
    tx: TransactionContext
  ): Promise<{
    lineId: string;
    programId: string;
    programNumber: number;
    machineName: string;
    contractorName: string;
    itemDisplayName: string;
    /** What the line asked for, and what had been taken for it BEFORE this scan, in unitCode. */
    quantity: number;
    consumedQuantity: number;
    unitCode: string | null;
  } | null>;

  /** The allocation this packet's last Store exit was counted against, for the compensating record. */
  findMachineProgramLineOfLastStoreExit(qrId: string, tx: TransactionContext): Promise<string | null>;

  getMachineProgramOfLine(lineId: string, tx: TransactionContext): Promise<{ programId: string; status: string } | null>;

  /** Whether a program has nothing outstanding left, so the scan that finished it can close it. */
  machineProgramIsFullyConsumed(programId: string, tx: TransactionContext): Promise<boolean>;

  closeMachineProgram(
    input: { programId: string; status: "COMPLETED" | "CANCELLED"; actor: string | null; reason: string | null; nowIso: string },
    tx: TransactionContext
  ): Promise<boolean>;

  /** Puts a completed program back in service when a packet it consumed comes back to the store. */
  reopenMachineProgram(programId: string, nowIso: string, tx: TransactionContext): Promise<boolean>;
}

export type RawMaterialReceiptOutcome =
  /** Accepted: the packet is in the store and its stock is credited. */
  | "RECEIVED"
  /** The packet is already in the store. Nothing changed. */
  | "ALREADY_IN_STORE"
  /** The label belongs to a different supplier than the open session. Nothing changed. */
  | "WRONG_PARTY"
  /** The value parses as a raw material label but was never generated. */
  | "UNKNOWN_QR"
  /** Registered but not receivable: voided, or its material has been retired. */
  | "NOT_ELIGIBLE"
  /** The material has no packing set, so there is no safe amount to credit. */
  | "NOT_CONFIGURED"
  /** The scanned text is not a raw material label at all. */
  | "INVALID_FORMAT"
  /** Another terminal moved this packet between our read and our write. */
  | "STATUS_CHANGED";

export interface RawMaterialReceiptInput {
  rawScan: string;
  /** The supplier the open session belongs to. Every scan is checked against it. */
  partyId: string;
  sessionId: string;
  context: ScanOperationalContext;
  actor?: string | null;
}

export interface RawMaterialReceiptResult {
  accepted: boolean;
  outcome: RawMaterialReceiptOutcome;
  qrId?: string;
  reason?: string;
  /** The material's plain-language name, e.g. "RUBBER UPPER — SK6 — RED — 7/10". */
  itemDisplayName?: string;
  /** The supplier the label was generated for — not necessarily the session's. */
  partyName?: string;
  packingQuantity?: number;
  packingUnitCode?: string | null;
  packName?: string | null;
  previousStatus?: string | null;
  currentStatus?: string | null;
  receivedAt?: string;
  eventId?: string;
  sessionId?: string;
}

/** Thrown inside the transaction to abort with a typed outcome and no writes. */
export class RawMaterialReceiptRejectedError extends Error {
  constructor(
    readonly outcome: Exclude<RawMaterialReceiptOutcome, "RECEIVED">,
    message: string,
    readonly details: Partial<RawMaterialReceiptResult> = {}
  ) {
    super(message);
    this.name = "RawMaterialReceiptRejectedError";
  }
}

export interface RawMaterialReceiptDeps {
  txManager: TransactionManager;
  repo: RawMaterialMovementRepository;
  eventPublisher: EventPublisher;
  idGenerator: IdGenerator;
}

export class ReceiveRawMaterialScanUseCase {
  constructor(private readonly deps: RawMaterialReceiptDeps) {}

  async execute(input: RawMaterialReceiptInput): Promise<RawMaterialReceiptResult> {
    const raw = String(input.rawScan ?? "").trim().toUpperCase();

    if (!isValidRawMaterialQrId(raw)) {
      // A carton label scanned here is a real mistake worth naming, rather than a generic
      // "bad code" — the operator is most likely on the wrong screen.
      return {
        accepted: false,
        outcome: "INVALID_FORMAT",
        reason: "This is not a raw material QR. Finished cartons are received on Store Move In.",
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
          throw new RawMaterialReceiptRejectedError("UNKNOWN_QR", "This QR is not registered.", {});
        }

        const identity = {
          itemDisplayName: unit.displayName,
          partyName: unit.partyName,
          previousStatus: unit.currentStatus,
          currentStatus: unit.currentStatus,
        };

        // The supplier check is the whole point of the session.
        if (unit.partyId !== input.partyId) {
          throw new RawMaterialReceiptRejectedError(
            "WRONG_PARTY",
            `This packet belongs to ${unit.partyName}. Close this session and start one for that supplier.`,
            identity
          );
        }
        if (unit.registryStatus === "VOID") {
          throw new RawMaterialReceiptRejectedError("NOT_ELIGIBLE", "This QR was voided and has no packet to receive.", identity);
        }
        if (unit.itemStatus !== "ACTIVE") {
          throw new RawMaterialReceiptRejectedError("NOT_ELIGIBLE", "This raw material is no longer active.", identity);
        }
        if (unit.currentStatus === RAW_MATERIAL_QR_STATUS.IN_STORE) {
          throw new RawMaterialReceiptRejectedError("ALREADY_IN_STORE", "This packet has already been received.", identity);
        }
        // No packing means there is no defensible answer to "how much did that add", so the
        // receipt is refused rather than guessed.
        if (unit.packingQuantity == null || !unit.packingUnitId) {
          throw new RawMaterialReceiptRejectedError(
            "NOT_CONFIGURED",
            `Set how much one packet of ${unit.displayName} holds in Raw Material Packing before receiving it.`,
            identity
          );
        }

        const moved = this.deps.repo.setRawMaterialQrStatus(
          {
            qrId: raw,
            expectedStatus: unit.currentStatus,
            nextStatus: RAW_MATERIAL_QR_STATUS.IN_STORE,
            sectionId: null,
            // A packet that has come home starts its route again from the beginning.
            hopIndex: 0,
            updatedAt: tx.nowIso,
          },
          tx
        );
        if (!moved) {
          throw new RawMaterialReceiptRejectedError("STATUS_CHANGED", "Another terminal moved this packet. Scan it again.", identity);
        }

        const applied = this.deps.repo.applyRawMaterialStockChange(
          {
            itemId: unit.itemId,
            quantity: unit.packingQuantity,
            unitId: unit.packingUnitId,
            direction: "IN",
            note: `Raw Material Input ${raw}`,
            actor: input.actor ?? null,
            nowIso: tx.nowIso,
          },
          tx
        );

        // A packet coming home undoes the Store exit that took it. If that exit was counted
        // against a machine program, the same stamp goes on this entry so the bag returns to
        // that program's outstanding quantity — the compensating record the carton gatepass
        // uses, for the same reason: a bag back on the shelf is not a bag on the machine.
        const machineProgramLineId = await this.deps.repo.findMachineProgramLineOfLastStoreExit(raw, tx);
        const releasedProgram = machineProgramLineId
          ? await this.deps.repo.getMachineProgramOfLine(machineProgramLineId, tx)
          : null;

        const eventId = this.deps.idGenerator.nextId();
        this.deps.repo.appendRawMaterialQrEvent(
          {
            eventId,
            qrId: raw,
            itemId: unit.itemId,
            partyId: unit.partyId,
            eventType: "STORE_ENTRY",
            occurredAt: tx.nowIso,
            factoryId: input.context.factoryId,
            workstationId: input.context.workstationId,
            deviceId: input.context.deviceId,
            actor: input.actor ?? null,
            sessionId: input.sessionId,
            quantity: applied.quantity,
            unitId: applied.unitId,
            previousStatus: unit.currentStatus,
            newStatus: RAW_MATERIAL_QR_STATUS.IN_STORE,
            sectionId: null,
            itemDisplayName: unit.displayName,
            machineProgramLineId,
          },
          tx
        );

        // A program that had been finished by this very packet is owed a bag again, so it goes
        // back in service — unless its machine has since been given another program, in which
        // case the completed one stays closed rather than fighting for the machine.
        if (releasedProgram?.status === "COMPLETED") {
          await this.deps.repo.reopenMachineProgram(releasedProgram.programId, tx.nowIso, tx);
        }

        return { eventId, receivedAt: tx.nowIso, unit };
      });

      await this.deps.eventPublisher.publish("RawMaterialReceived.v1", {
        qrId: raw,
        occurredAt: committed.receivedAt,
        sessionId: input.sessionId,
      });

      return {
        accepted: true,
        outcome: "RECEIVED",
        qrId: raw,
        itemDisplayName: committed.unit.displayName,
        partyName: committed.unit.partyName,
        packingQuantity: committed.unit.packingQuantity ?? undefined,
        packingUnitCode: committed.unit.packingUnitCode,
        packName: committed.unit.packName,
        previousStatus: committed.unit.currentStatus,
        currentStatus: RAW_MATERIAL_QR_STATUS.IN_STORE,
        receivedAt: committed.receivedAt,
        eventId: committed.eventId,
        sessionId: input.sessionId,
      };
    } catch (error) {
      if (error instanceof RawMaterialReceiptRejectedError) {
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
