import {
  InvalidQrError,
  RAW_MATERIAL_QR_STATUS,
  STOCK_EVENT_NOTE,
  isValidRawMaterialQrId,
  parseRawMaterialQrId,
  type MachineProgramCartonTarget,
} from "@erp/domain";
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
  /** The material's top-level category name, upper-cased — UPPER, DANA … (RAW_MATERIAL_KIND). */
  kind?: string | null;
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
      /** The saved Store Out batch that committed it, or null for the generic scanner. */
      machineProgramBatchId?: string | null;
      /** Upper Move Out: the machine the operator issued the packet to (migration 079), or null. */
      machineId?: string | null;
      /**
       * Scan Out: the party the packet was moved out TO (0.3.6). Kept in the event's metadata,
       * not a column, because 0.3.6 ships no migration. Null for every other movement.
       */
      issuedToPartyId?: string | null;
    },
    tx: TransactionContext
  ): void;
  /** A party as the Scan Out rule needs to judge it, or null when there is no such party. */
  getRawMaterialIssueParty(
    partyId: string,
    tx: TransactionContext
  ): { id: string; partyName: string; partyType: string; status: string } | null;

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

  /**
   * The same answer narrowed to ONE program: the allocation on `programId` that still owes this
   * upper, or null when the program does not authorise it (or has already had all of it).
   *
   * This is what Store Out working through an open Machine Program consumes. It deliberately
   * ignores every other program's claim on the same upper, because the operator named this one.
   */
  findOutstandingMachineProgramLineOfProgram(
    input: { programId: string; itemId: string },
    tx: TransactionContext
  ): Promise<{
    lineId: string;
    programId: string;
    programNumber: number;
    machineName: string;
    contractorName: string;
    itemDisplayName: string;
    quantity: number;
    consumedQuantity: number;
    unitCode: string | null;
    /**
     * The finished goods this line's run is moulding, so the store can label the cartons the
     * machine will send back. Read off the run and the upper itself — never worked out on a
     * screen. Null only when the line's run has lost its product master row.
     */
    cartonTarget: MachineProgramCartonTarget | null;
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

  /** Whether a program has been closed (complete or reconciled). */
  isMachineProgramClosed(programId: string): boolean;

  /** Cartons printed for this packet's last issue that are already stored in — 0 for a sealed packet. */
  cartonsBackOfIssuedPacket(qrId: string, tx: TransactionContext): number;
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
  | "STATUS_CHANGED"
  /** Return Upper: the packet did not go out for the program it is being returned to. */
  | "NOT_ON_PROGRAM"
  /** Return Upper: the program is closed. */
  | "PROGRAM_CLOSED"
  /** Return Upper: some of the packet's cartons are already back, so it was opened. */
  | "CARTONS_BACK";

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

/**
 * Where a packet is being received from — the one thing the two ways of receiving differ in.
 *
 *   SESSION         a supplier's delivery: every packet must be that supplier's
 *   PROGRAM_RETURN  a sealed packet coming home from a machine program it went out for, scanned
 *                   in that program's reconciliation: it must have gone out for THAT program,
 *                   the program must be open, and none of the packet's cartons may be back yet
 */
type ReceiptMode =
  | { kind: "SESSION"; partyId: string; sessionId: string }
  | { kind: "PROGRAM_RETURN"; programId: string };

interface ReceiptRequest {
  raw: string;
  mode: ReceiptMode;
  context: ScanOperationalContext;
  actor: string | null;
}

type Identity = Partial<RawMaterialReceiptResult>;

const identityOf = (unit: RawMaterialMovementUnit): Identity => ({
  itemDisplayName: unit.displayName,
  partyName: unit.partyName,
  previousStatus: unit.currentStatus,
  currentStatus: unit.currentStatus,
});

/** Refuses a scan that is not a readable raw material label, before anything is read. */
const formatRefusal = (raw: string): RawMaterialReceiptResult | null => {
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
    return null;
  } catch (error) {
    if (error instanceof InvalidQrError) {
      return { accepted: false, outcome: "INVALID_FORMAT", reason: "This label could not be read. Scan it again." };
    }
    throw error;
  }
};

/** Refuses a packet that cannot come home for the program it is being returned to. */
const checkProgramReturn = async (
  repo: RawMaterialMovementRepository,
  raw: string,
  programId: string,
  identity: Identity,
  tx: TransactionContext
): Promise<void> => {
  const lineId = await repo.findMachineProgramLineOfLastStoreExit(raw, tx);
  const program = lineId ? await repo.getMachineProgramOfLine(lineId, tx) : null;
  if (!program || program.programId !== programId) {
    throw new RawMaterialReceiptRejectedError("NOT_ON_PROGRAM", "This packet did not go out for this program, so it cannot be returned here.", identity);
  }
  if (repo.isMachineProgramClosed(programId)) {
    throw new RawMaterialReceiptRejectedError("PROGRAM_CLOSED", "This program is closed — nothing more is returned against it.", identity);
  }
  const back = repo.cartonsBackOfIssuedPacket(raw, tx);
  if (back > 0) {
    const what = back === 1 ? "1 carton of this packet is" : `${back} cartons of this packet are`;
    throw new RawMaterialReceiptRejectedError("CARTONS_BACK", `${what} already back, so it was opened. Record what is left as cut size instead.`, identity);
  }
};

/** The packet, read and checked — everything that can refuse a receipt before anything is written. */
const checkPacket = async (repo: RawMaterialMovementRepository, request: ReceiptRequest, tx: TransactionContext): Promise<RawMaterialMovementUnit> => {
  const unit = repo.getRawMaterialQrForMovement(request.raw, tx);
  if (!unit) throw new RawMaterialReceiptRejectedError("UNKNOWN_QR", "This QR is not registered.", {});
  const identity = identityOf(unit);

  // The supplier check is the whole point of a session.
  if (request.mode.kind === "SESSION" && unit.partyId !== request.mode.partyId) {
    throw new RawMaterialReceiptRejectedError("WRONG_PARTY", `This packet belongs to ${unit.partyName}. End this batch and start one for that supplier.`, identity);
  }
  if (unit.registryStatus === "VOID") throw new RawMaterialReceiptRejectedError("NOT_ELIGIBLE", "This QR was voided and has no packet to receive.", identity);
  if (unit.itemStatus !== "ACTIVE") throw new RawMaterialReceiptRejectedError("NOT_ELIGIBLE", "This raw material is no longer active.", identity);
  if (unit.currentStatus === RAW_MATERIAL_QR_STATUS.IN_STORE) {
    throw new RawMaterialReceiptRejectedError("ALREADY_IN_STORE", "This packet has already been received.", identity);
  }
  // No packing means there is no defensible answer to "how much did that add", so the receipt
  // is refused rather than guessed.
  if (unit.packingQuantity == null || !unit.packingUnitId) {
    throw new RawMaterialReceiptRejectedError("NOT_CONFIGURED", `Set how much one packet of ${unit.displayName} holds in Raw Material Packing before receiving it.`, identity);
  }
  if (request.mode.kind === "PROGRAM_RETURN") await checkProgramReturn(repo, request.raw, request.mode.programId, identity, tx);
  return unit;
};

/**
 * Receives one packet inside the caller's transaction: its status, its stock and its event, or a
 * refusal having written nothing. Both ways of receiving run exactly this.
 */
const receivePacket = async (
  deps: RawMaterialReceiptDeps,
  request: ReceiptRequest,
  tx: TransactionContext
): Promise<{ eventId: string; receivedAt: string; unit: RawMaterialMovementUnit }> => {
  const { repo } = deps;
  const unit = await checkPacket(repo, request, tx);

  const moved = repo.setRawMaterialQrStatus(
    {
      qrId: request.raw,
      expectedStatus: unit.currentStatus,
      nextStatus: RAW_MATERIAL_QR_STATUS.IN_STORE,
      sectionId: null,
      // A packet that has come home starts its route again from the beginning.
      hopIndex: 0,
      updatedAt: tx.nowIso,
    },
    tx
  );
  if (!moved) throw new RawMaterialReceiptRejectedError("STATUS_CHANGED", "Another terminal moved this packet. Scan it again.", identityOf(unit));

  const applied = repo.applyRawMaterialStockChange(
    {
      itemId: unit.itemId,
      quantity: unit.packingQuantity!,
      unitId: unit.packingUnitId!,
      direction: "IN",
      note: `${STOCK_EVENT_NOTE.SCAN_IN} ${request.raw}`,
      actor: request.actor,
      nowIso: tx.nowIso,
    },
    tx
  );

  // A packet coming home undoes the Store exit that took it. If that exit was counted against a
  // machine program, the same stamp goes on this entry so the bag returns to that program's
  // outstanding quantity — the compensating record the carton gatepass uses, for the same reason:
  // a bag back on the shelf is not a bag on the machine.
  const machineProgramLineId = await repo.findMachineProgramLineOfLastStoreExit(request.raw, tx);
  const releasedProgram = machineProgramLineId ? await repo.getMachineProgramOfLine(machineProgramLineId, tx) : null;

  const eventId = deps.idGenerator.nextId();
  repo.appendRawMaterialQrEvent(
    {
      eventId,
      qrId: request.raw,
      itemId: unit.itemId,
      partyId: unit.partyId,
      eventType: "STORE_ENTRY",
      occurredAt: tx.nowIso,
      factoryId: request.context.factoryId,
      workstationId: request.context.workstationId,
      deviceId: request.context.deviceId,
      actor: request.actor,
      sessionId: request.mode.kind === "SESSION" ? request.mode.sessionId : null,
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

  // A program that had been finished by this very packet is owed a bag again, so it goes back in
  // service — unless its machine has since been given another program, in which case the
  // completed one stays closed rather than fighting for the machine. A packet RETURNED in a
  // reconciliation is the opposite case: the program is being closed, and owes nothing more.
  if (request.mode.kind === "SESSION" && releasedProgram?.status === "COMPLETED") {
    await repo.reopenMachineProgram(releasedProgram.programId, tx.nowIso, tx);
  }

  return { eventId, receivedAt: tx.nowIso, unit };
};

/** Runs one receipt end to end: its transaction, its event and its answer. */
const runReceipt = async (deps: RawMaterialReceiptDeps, request: ReceiptRequest, sessionId: string | undefined): Promise<RawMaterialReceiptResult> => {
  const refused = formatRefusal(request.raw);
  if (refused) return refused;

  try {
    const committed = await deps.txManager.runInTransaction((tx) => receivePacket(deps, request, tx));
    await deps.eventPublisher.publish("RawMaterialReceived.v1", { qrId: request.raw, occurredAt: committed.receivedAt, sessionId });
    return {
      accepted: true,
      outcome: "RECEIVED",
      qrId: request.raw,
      itemDisplayName: committed.unit.displayName,
      partyName: committed.unit.partyName,
      packingQuantity: committed.unit.packingQuantity ?? undefined,
      packingUnitCode: committed.unit.packingUnitCode,
      packName: committed.unit.packName,
      previousStatus: committed.unit.currentStatus,
      currentStatus: RAW_MATERIAL_QR_STATUS.IN_STORE,
      receivedAt: committed.receivedAt,
      eventId: committed.eventId,
      sessionId,
    };
  } catch (error) {
    if (!(error instanceof RawMaterialReceiptRejectedError)) throw error;
    return {
      accepted: false,
      outcome: error.outcome,
      qrId: request.raw,
      reason: error.message,
      itemDisplayName: error.details.itemDisplayName,
      partyName: error.details.partyName,
      previousStatus: error.details.previousStatus ?? null,
      currentStatus: error.details.currentStatus ?? null,
      sessionId,
    };
  }
};

export class ReceiveRawMaterialScanUseCase {
  constructor(private readonly deps: RawMaterialReceiptDeps) {}

  async execute(input: RawMaterialReceiptInput): Promise<RawMaterialReceiptResult> {
    const raw = String(input.rawScan ?? "").trim().toUpperCase();
    const mode: ReceiptMode = { kind: "SESSION", partyId: input.partyId, sessionId: input.sessionId };
    return runReceipt(this.deps, { raw, mode, context: input.context, actor: input.actor ?? null }, input.sessionId);
  }
}

export interface MachineProgramUpperReturnInput {
  programId: string;
  rawScan: string;
  context: ScanOperationalContext;
  actor?: string | null;
}

/**
 * RETURN UPPER — a sealed packet of uppers that went out for a machine program comes back to the
 * store unused, scanned in that program's reconciliation.
 *
 *   SK6 7/10 BLACK RED · 6 DOZEN out = 12 cartons due  →  a 2-DOZEN packet scanned back
 *   →  stock + 2 DOZEN, and 8 cartons due
 *
 * It is the same receipt a supplier's delivery is — status, stock and event in one transaction,
 * the guarded status move refusing a second scan — with the program's checks in place of the
 * supplier's. Scanning the same packet twice credits it once: the second finds it in the store.
 */
export class ReturnMachineProgramUpperUseCase {
  constructor(private readonly deps: RawMaterialReceiptDeps) {}

  async execute(input: MachineProgramUpperReturnInput): Promise<RawMaterialReceiptResult> {
    const raw = String(input.rawScan ?? "").trim().toUpperCase();
    const programId = String(input.programId ?? "").trim();
    if (!programId) return { accepted: false, outcome: "NOT_ON_PROGRAM", reason: "Open the program the packet is being returned to." };
    const mode: ReceiptMode = { kind: "PROGRAM_RETURN", programId };
    return runReceipt(this.deps, { raw, mode, context: input.context, actor: input.actor ?? null }, undefined);
  }
}
