import {
  MACHINE_PROGRAM_STATUS,
  QUANTITY_EPSILON,
  RAW_MATERIAL_QR_STATUS,
  cartonsExpectedFromUppers,
  parseMachineProgramLookup,
  roundQuantity,
  type MachineProgramCartonTarget,
  type MachineProgramLookup,
} from "@erp/domain";
import type { RawMaterialMovementRepository } from "./rawMaterialReceiptUseCase.js";
import {
  RawMaterialIssueRejectedError,
  checkRawMaterialScanFormat,
  issueRawMaterialPacket,
  type IssuedPacket,
  type RawMaterialIssueDeps,
} from "./rawMaterialIssueUseCase.js";
import type { ScanOperationalContext, TransactionContext } from "./ports.js";

// Store Out against an open Machine Program.
//
//   MP-000012  MACHINE 1 · 8 Oct · 06:00 AM – 06:00 PM
//     SK6 7/10 BLACK   100 DOZEN authorised   30 issued   70 remaining
//     SK6 7/10 RED      50 DOZEN authorised   10 issued   40 remaining
//
//   scan → that packet is out of the store, and its cartons are owed back
//
// This is the second way a machine program is consumed, beside the generic store scanner that
// has always reconciled a plain Raw Material Output scan to the oldest program owing that upper.
// Both end in the same place: issueRawMaterialPacket, the one function that takes a packet out of
// the store. Nothing here debits a balance, writes an event or decides a quantity of its own.
//
// SaveMachineProgramBatchUseCase is the only thing here that writes, and Machine Move Out calls
// it once per scan — a batch of exactly one packet. Three rules shape it, and they are what make
// a per-scan movement safe:
//
//   * ALL OR NOTHING. Every packet is validated again inside the write lock and issued in ONE
//     transaction, so a refusal anywhere rolls the whole call back and nothing left the store.
//   * IDEMPOTENT. The call carries the key the screen made for it, and
//     machine_program_issue_batches.batch_key is UNIQUE, so a request that arrives twice — a
//     double click, a reply lost on the way back — reports the batch it already saved instead of
//     issuing the packet a second time.
//   * PROGRAM-SCOPED. Only what this program authorises may go out through it; anything else is
//     refused NOT_ON_PROGRAM and stays on the shelf.
//
// PARTIAL is the normal case, not an exception: the floor fetches what it has room for, the rest
// stays in the store, and the program is still PROGRAMMED and still resumable. A program becomes
// COMPLETED only when everything on it has actually left — that is settled by
// issueRawMaterialPacket from the event log, never by the act of saving.
//
// Each saved packet comes back with the CARTONS its output will be labelled with (see
// cartonPlanOf): uppers going out are cartons coming back, and that arithmetic is the domain's
// (cartonsExpectedFromUppers), never a screen's.

// The lookup parser itself lives in @erp/domain, beside the program's other rules, because the
// screens need the same test to tell a scanned program code apart from a raw material label
// before they submit it. Re-exported here so every existing caller keeps one import.
export { parseMachineProgramLookup, type MachineProgramLookup } from "@erp/domain";

// ─── What the database must answer ────────────────────────────────────────────

/** A program as Store Out needs to judge it, read inside the lock. */
export interface MachineProgramStoreOutHead {
  id: string;
  programNumber: number;
  status: string;
  machineName: string;
  programDate: string;
  /** Σ over its upper lines, already computed from the event log. */
  authorizedQuantity: number;
  issuedQuantity: number;
  outstandingQuantity: number;
  /** Closed in Store In (complete or reconciled): production is over. */
  closed?: boolean;
}

/** What one program promises of one upper, across every run it appears on. */
export interface MachineProgramItemAllocation {
  itemId: string;
  authorized: number;
  issued: number;
  outstanding: number;
  unitCode: string | null;
}

/** A batch already saved under this key. */
export interface MachineProgramIssueBatchRecord {
  id: string;
  batchKey: string;
  programId: string;
  sessionId: string | null;
  deviceId: string;
  issuedBy: string | null;
  packetCount: number;
  createdAt: string;
}

export interface MachineProgramStoreOutRepository extends RawMaterialMovementRepository {
  /** The program named by a lookup, or null. Reads the same row the program screens read. */
  findMachineProgramForStoreOut(lookup: MachineProgramLookup, tx: TransactionContext): Promise<MachineProgramStoreOutHead | null>;
  /** Null when this upper is on no line of the program at all. */
  getMachineProgramItemAllocation(
    input: { programId: string; itemId: string },
    tx: TransactionContext
  ): Promise<MachineProgramItemAllocation | null>;
  findMachineProgramIssueBatchByKey(batchKey: string, tx: TransactionContext): Promise<MachineProgramIssueBatchRecord | null>;
  insertMachineProgramIssueBatch(
    payload: {
      id: string; batchKey: string; programId: string; sessionId: string | null;
      deviceId: string; issuedBy: string | null; packetCount: number; createdAt: string;
    },
    tx: TransactionContext
  ): Promise<void>;
  appendAuditLog(
    payload: {
      id: string; eventType: string; entityType: string; entityId: string; actorUserId: string | null;
      actorDeviceId: string | null; occurredAt: string; payload: Record<string, unknown>;
    },
    tx: TransactionContext
  ): Promise<void>;
}

export interface MachineProgramStoreOutDeps extends RawMaterialIssueDeps {
  repo: MachineProgramStoreOutRepository;
}

// ─── Opening a program ────────────────────────────────────────────────────────

export type MachineProgramStoreOutOutcome =
  | "OPENED"
  | "SAVED"
  /** This exact Save Batch had already been committed. Nothing was issued again. */
  | "ALREADY_SAVED"
  /** The value is not a machine program number or id at all. */
  | "INVALID_LOOKUP"
  | "PROGRAM_NOT_FOUND"
  /** Deleted: it holds no reservation and nothing may be issued against it. */
  | "PROGRAM_CANCELLED"
  /** Everything on it has already left the store. */
  | "PROGRAM_COMPLETED"
  /** It has no uppers on it yet, so there is nothing to fetch. */
  | "PROGRAM_EMPTY"
  /** Save Batch with nothing accepted in it. */
  | "NOTHING_TO_SAVE"
  /** A packet in the batch was refused inside the lock; the whole batch was rolled back. */
  | "SCAN_REFUSED";

export interface OpenMachineProgramResult {
  accepted: boolean;
  outcome: MachineProgramStoreOutOutcome;
  reason?: string;
  programId?: string;
  programCode?: string;
}

export const formatMachineProgramCodeNumber = (programNumber: number): string => `MP-${String(programNumber).padStart(6, "0")}`;

/**
 * Whether a program may be issued against, judged from its stored status and what the event log
 * says has already left. Shared by opening a program and by saving a batch, so the screen and
 * the write can never disagree about eligibility.
 */
export const machineProgramStoreOutRefusal = (
  head: MachineProgramStoreOutHead
): { outcome: MachineProgramStoreOutOutcome; reason: string } | null => {
  const code = formatMachineProgramCodeNumber(head.programNumber);
  if (head.status === MACHINE_PROGRAM_STATUS.CANCELLED) {
    return { outcome: "PROGRAM_CANCELLED", reason: `${code} has been deleted. Nothing can be issued against it.` };
  }
  if (head.closed) {
    return { outcome: "PROGRAM_COMPLETED", reason: `${code} is closed — production is complete. Nothing more can be issued against it.` };
  }
  if (head.status === MACHINE_PROGRAM_STATUS.COMPLETED) {
    return { outcome: "PROGRAM_COMPLETED", reason: `${code} is fully issued. Everything on it has already left the store.` };
  }
  if (head.authorizedQuantity <= QUANTITY_EPSILON) {
    return { outcome: "PROGRAM_EMPTY", reason: `${code} has no uppers on it yet. Production has not finished planning it.` };
  }
  if (head.outstandingQuantity <= QUANTITY_EPSILON) {
    return { outcome: "PROGRAM_COMPLETED", reason: `${code} is fully issued. Everything on it has already left the store.` };
  }
  return null;
};

/**
 * Opens a Machine Program for Store Out: resolves what the operator typed, scanned or clicked
 * through from a notification, and says whether it may be issued against.
 *
 * Both entry points — the notification and the lookup box — come through here, so a program that
 * is cancelled, finished or empty is refused the same way whichever door it arrived by, and the
 * screen never has to judge it.
 */
export class OpenMachineProgramForStoreOutUseCase {
  constructor(private readonly deps: MachineProgramStoreOutDeps) {}

  async execute(input: { lookup: string }): Promise<OpenMachineProgramResult> {
    const lookup = parseMachineProgramLookup(input.lookup);
    if (!lookup) {
      return {
        accepted: false,
        outcome: "INVALID_LOOKUP",
        reason: "Enter a machine program number, like MP-000012 or 12.",
      };
    }

    const head = await this.deps.txManager.runInTransaction((tx) => this.deps.repo.findMachineProgramForStoreOut(lookup, tx));
    if (!head) {
      const named = lookup.kind === "NUMBER" ? formatMachineProgramCodeNumber(lookup.programNumber) : "That machine program";
      return { accepted: false, outcome: "PROGRAM_NOT_FOUND", reason: `${named} does not exist.` };
    }

    const refusal = machineProgramStoreOutRefusal(head);
    if (refusal) {
      return { accepted: false, ...refusal, programId: head.id, programCode: formatMachineProgramCodeNumber(head.programNumber) };
    }

    return { accepted: true, outcome: "OPENED", programId: head.id, programCode: formatMachineProgramCodeNumber(head.programNumber) };
  }
}

// ─── Checking one scan against the open program ───────────────────────────────

export type MachineProgramScanVerdict =
  | "ACCEPTED"
  /** Not a raw material label at all — most likely a carton, or an unreadable read. */
  | "INVALID_FORMAT"
  | "UNKNOWN_QR"
  /** Issued already, or never received: it is not in the store to take out of it. */
  | "NOT_IN_STORE"
  /** Voided, or its material has been retired. */
  | "NOT_ELIGIBLE"
  /** The material has no packing, so there is no quantity to take off the balance. */
  | "NOT_CONFIGURED"
  /** This upper is on no line of the open program. */
  | "NOT_ON_PROGRAM"
  /** Everything the program asked for of this upper is already issued or already in this batch. */
  | "VARIANT_FULFILLED"
  /** This exact packet is already in the unsaved batch. */
  | "ALREADY_IN_BATCH"
  | "PROGRAM_NOT_FOUND"
  /** Deleted or fully issued: no further issuance. */
  | "PROGRAM_CLOSED";

export interface MachineProgramScanCheckResult {
  accepted: boolean;
  verdict: MachineProgramScanVerdict;
  reason?: string;
  qrId?: string;
  itemId?: string;
  itemDisplayName?: string;
  /** The supplier whose delivery this packet came in on. */
  partyName?: string;
  packingQuantity?: number;
  packName?: string | null;
  unitCode?: string | null;
  /** What the program asked for of this upper, and what has COMMITTED so far. */
  authorized?: number;
  issued?: number;
  /** What this unsaved batch would add, this packet included. */
  pending?: number;
}

/** A scanned value as both the check and the commit normalise it. */
export const normalizeQrId = (raw: string): string => String(raw ?? "").trim().toUpperCase();

/**
 * Judges one scan against the open program WITHOUT writing anything.
 *
 * The read-only twin of the commit: every rule the commit enforces is checked here too, in the
 * same order and with the same reasons. Machine Move Out does NOT go through it — a scan there
 * is the movement itself, and asking first would only let the answer go stale between the two
 * calls — so this is the probe for anything that needs to know whether a packet WOULD be
 * accepted without taking it out of the store. The commit never trusts it either way.
 */
export const checkMachineProgramScan = async (
  repo: MachineProgramStoreOutRepository,
  input: { programId: string; rawScan: string; batchQrIds: readonly string[] },
  tx: TransactionContext
): Promise<MachineProgramScanCheckResult> => {
  const qrId = normalizeQrId(input.rawScan);
  const badFormat = checkRawMaterialScanFormat(qrId);
  if (badFormat) return { accepted: false, verdict: "INVALID_FORMAT", reason: badFormat.reason, qrId };

  const batch = input.batchQrIds.map(normalizeQrId);
  if (batch.includes(qrId)) {
    return { accepted: false, verdict: "ALREADY_IN_BATCH", reason: "This packet is already in the batch.", qrId };
  }

  const head = await repo.findMachineProgramForStoreOut({ kind: "ID", id: input.programId }, tx);
  if (!head) return { accepted: false, verdict: "PROGRAM_NOT_FOUND", reason: "This machine program no longer exists.", qrId };
  const refusal = machineProgramStoreOutRefusal(head);
  if (refusal) return { accepted: false, verdict: "PROGRAM_CLOSED", reason: refusal.reason, qrId };

  const unit = repo.getRawMaterialQrForMovement(qrId, tx);
  if (!unit) return { accepted: false, verdict: "UNKNOWN_QR", reason: "This QR has not been generated in the system.", qrId };

  const identity = {
    qrId,
    itemId: unit.itemId,
    itemDisplayName: unit.displayName,
    partyName: unit.partyName,
    packingQuantity: unit.packingQuantity ?? undefined,
    packName: unit.packName,
  };

  if (unit.registryStatus === "VOID") {
    return { accepted: false, verdict: "NOT_ELIGIBLE", reason: "This QR was voided and has no packet to issue.", ...identity };
  }
  if (unit.currentStatus !== RAW_MATERIAL_QR_STATUS.IN_STORE) {
    return {
      accepted: false,
      verdict: "NOT_IN_STORE",
      reason: "This packet is not in the store — it has already been issued, or was never received.",
      ...identity,
    };
  }
  if (unit.packingQuantity == null || !unit.packingUnitId) {
    return {
      accepted: false,
      verdict: "NOT_CONFIGURED",
      reason: `Set how much one packet of ${unit.displayName} holds in Raw Material Packing before issuing it.`,
      ...identity,
    };
  }

  const allocation = await repo.getMachineProgramItemAllocation({ programId: input.programId, itemId: unit.itemId }, tx);
  if (!allocation) {
    return {
      accepted: false,
      verdict: "NOT_ON_PROGRAM",
      reason: `${unit.displayName} is not on ${formatMachineProgramCodeNumber(head.programNumber)}. It asks for other uppers.`,
      ...identity,
    };
  }

  // What the unsaved batch already promises of this same upper. A packet is indivisible, so the
  // last one may overshoot what the line still owes — the rule is only that something is still
  // owed before another packet is accepted.
  const pendingBefore = await pendingQuantityForItem(repo, batch, unit.itemId, tx);
  const figures = {
    unitCode: allocation.unitCode,
    authorized: allocation.authorized,
    issued: allocation.issued,
    pending: roundQuantity(pendingBefore + unit.packingQuantity),
  };
  if (allocation.outstanding - pendingBefore <= QUANTITY_EPSILON) {
    return {
      accepted: false,
      verdict: "VARIANT_FULFILLED",
      reason: `${formatMachineProgramCodeNumber(head.programNumber)} has everything it asked for of ${unit.displayName}.`,
      ...identity,
      ...figures,
    };
  }

  return { accepted: true, verdict: "ACCEPTED", ...identity, ...figures };
};

/** How much of one upper the unsaved batch already holds, read from the packets themselves. */
const pendingQuantityForItem = async (
  repo: MachineProgramStoreOutRepository,
  batchQrIds: readonly string[],
  itemId: string,
  tx: TransactionContext
): Promise<number> => {
  let pending = 0;
  for (const candidate of batchQrIds) {
    const unit = repo.getRawMaterialQrForMovement(candidate, tx);
    if (unit && unit.itemId === itemId) pending += unit.packingQuantity ?? 0;
  }
  return roundQuantity(pending);
};

export class CheckMachineProgramScanUseCase {
  constructor(private readonly deps: MachineProgramStoreOutDeps) {}

  /** Read-only. It runs in a transaction only so every figure it reports comes from one snapshot. */
  execute(input: { programId: string; rawScan: string; batchQrIds: readonly string[] }): Promise<MachineProgramScanCheckResult> {
    return this.deps.txManager.runInTransaction((tx) => checkMachineProgramScan(this.deps.repo, input, tx));
  }
}

// ─── Saving the batch ─────────────────────────────────────────────────────────

export interface SaveMachineProgramBatchInput {
  programId: string;
  /** The idempotency key the screen made when the operator pressed Start Scan. */
  batchKey: string;
  /** The terminal's open Raw Material Output session, so the packets print on its issue slip. */
  sessionId: string | null;
  qrIds: readonly string[];
  context: ScanOperationalContext;
  actor: string;
  actorUserId?: string | null;
  deviceId: string;
}

/** The cartons one issued packet's output will be labelled with. */
export interface IssuedCartonPlan {
  /** The product master row the carton QR batch is generated against. */
  articleSizeId: string;
  article: string;
  size: string;
  soleColour: string;
  /** The colour the carton QR identity carries — the upper's own colour. */
  colour: string;
  /** How many carton QR labels this packet's quantity needs. */
  count: number;
}

/**
 * One packet this Save took out of the store, as the screen reads it back.
 *
 * The screen never works any of this out: what left, in which unit, and how many cartons it
 * will come back as are all settled here, inside the transaction that issued it.
 */
export interface IssuedProgramPacket {
  qrId: string;
  itemId: string;
  itemDisplayName: string;
  partyName: string | null;
  /** The packet's contents, in the unit the program line is counted in. */
  quantity: number;
  unitCode: string | null;
  packName: string | null;
  cartons: IssuedCartonPlan | null;
  /** Why the cartons cannot be labelled from here. Set only when `cartons` is null. */
  cartonNote: string | null;
}

/**
 * What the machine will send back for one issued packet, or the reason it cannot be said.
 *
 * A carton QR is a permanent identity, so every part of it has to be known: the product it
 * belongs to, the colour it will be sold as, and a whole number of cartons. Anything missing is
 * reported as a sentence the operator can act on, never filled in with a guess.
 */
export const cartonPlanFor = (input: {
  /** The upper's name, for the sentence when the cartons cannot be worked out. */
  name: string;
  target: MachineProgramCartonTarget | null;
  /** cartonsExpectedFromUppers for the packet's quantity, in the unit the line is counted in. */
  cartonCount: number | null;
}): Pick<IssuedProgramPacket, "cartons" | "cartonNote"> => {
  const { name, target, cartonCount } = input;
  if (!target) {
    return {
      cartons: null,
      cartonNote: `This program line has no product left in Product Master, so cartons for ${name} cannot be labelled here.`,
    };
  }
  if (!target.upperColour) {
    return {
      cartons: null,
      cartonNote: `${name} has no colour on it, and a carton QR needs one. Set the upper's colour in Raw Material Setup, or generate these cartons in QR Generator.`,
    };
  }
  if (cartonCount == null) {
    return {
      cartons: null,
      cartonNote: `${name} is not counted in whole cartons of DOZEN, so its cartons have to be generated in QR Generator.`,
    };
  }
  return {
    cartons: {
      articleSizeId: target.articleSizeId,
      article: target.article,
      size: target.size,
      soleColour: target.soleColour,
      colour: target.upperColour,
      count: cartonCount,
    },
    cartonNote: null,
  };
};

const cartonPlanOf = (issued: IssuedPacket): Pick<IssuedProgramPacket, "cartons" | "cartonNote"> =>
  cartonPlanFor({
    name: issued.unit.displayName,
    target: issued.machineProgram?.cartonTarget ?? null,
    cartonCount: issued.machineProgram?.cartonCount ?? null,
  });

const issuedProgramPacket = (qrId: string, issued: IssuedPacket): IssuedProgramPacket => ({
  qrId,
  itemId: issued.unit.itemId,
  itemDisplayName: issued.unit.displayName,
  partyName: issued.unit.partyName ?? null,
  quantity: roundQuantity(issued.quantity),
  unitCode: issued.machineProgram?.unitCode ?? issued.unit.packingUnitCode ?? null,
  packName: issued.unit.packName ?? null,
  ...cartonPlanOf(issued),
});

export interface SaveMachineProgramBatchResult {
  accepted: boolean;
  outcome: MachineProgramStoreOutOutcome;
  reason?: string;
  batchId?: string;
  programId?: string;
  packetCount?: number;
  /** Every packet that left the store in this Save, in the order it was scanned. */
  packets?: IssuedProgramPacket[];
  /** Which packet was refused, and why. Set only when nothing was committed. */
  refusedQrId?: string;
  refusedVerdict?: MachineProgramScanVerdict;
  /** True when this batch took the program's last outstanding upper and finished it. */
  programCompleted?: boolean;
}

/** The verdict a refusal thrown by issueRawMaterialPacket corresponds to. */
const verdictOfIssueOutcome = (outcome: string): MachineProgramScanVerdict => {
  switch (outcome) {
    case "UNKNOWN_QR":
      return "UNKNOWN_QR";
    case "NOT_IN_STORE":
    case "STATUS_CHANGED":
      return "NOT_IN_STORE";
    case "NOT_ELIGIBLE":
      return "NOT_ELIGIBLE";
    case "NOT_CONFIGURED":
      return "NOT_CONFIGURED";
    case "NOT_ON_PROGRAM":
      return "NOT_ON_PROGRAM";
    default:
      return "INVALID_FORMAT";
  }
};

/** Thrown inside the commit to abort the whole batch with the packet that caused it. */
class BatchRefusedError extends Error {
  constructor(
    readonly outcome: MachineProgramStoreOutOutcome,
    message: string,
    readonly details: { refusedQrId?: string; refusedVerdict?: MachineProgramScanVerdict } = {}
  ) {
    super(message);
    this.name = "BatchRefusedError";
  }
}

/**
 * Commits one Store Out batch against a Machine Program: every accepted packet leaves the store
 * in ONE transaction, each STORE_EXIT stamped with the allocation that authorised it and the
 * batch that recorded it.
 *
 * A partial batch is the normal case. The program is not touched by the act of saving — it ends
 * COMPLETED only if these packets happened to take the last thing it was owed, which
 * issueRawMaterialPacket settles from the event log inside the same lock.
 */
export class SaveMachineProgramBatchUseCase {
  constructor(private readonly deps: MachineProgramStoreOutDeps) {}

  async execute(input: SaveMachineProgramBatchInput): Promise<SaveMachineProgramBatchResult> {
    const batchKey = String(input.batchKey ?? "").trim();
    if (!batchKey) {
      return { accepted: false, outcome: "NOTHING_TO_SAVE", reason: "This batch has no key. Start the scan again." };
    }

    const qrIds = input.qrIds.map(normalizeQrId).filter((qrId) => qrId.length > 0);
    if (qrIds.length === 0) {
      return { accepted: false, outcome: "NOTHING_TO_SAVE", reason: "Scan at least one packet before saving the batch." };
    }
    const duplicate = qrIds.find((qrId, index) => qrIds.indexOf(qrId) !== index);
    if (duplicate) {
      return {
        accepted: false,
        outcome: "SCAN_REFUSED",
        reason: "The same packet is in this batch twice. Nothing was issued.",
        refusedQrId: duplicate,
        refusedVerdict: "ALREADY_IN_BATCH",
      };
    }

    try {
      const committed = await this.deps.txManager.runInTransaction(async (tx) => {
        // The key was recorded by a request that already succeeded: report that batch rather
        // than issuing its packets a second time.
        const existing = await this.deps.repo.findMachineProgramIssueBatchByKey(batchKey, tx);
        if (existing) {
          return {
            alreadySaved: true as const,
            batchId: existing.id,
            programId: existing.programId,
            packetCount: existing.packetCount,
            // The packets are not re-derived: the first attempt already reported them, and
            // reporting them again would read as a second issuance.
            packets: [] as IssuedProgramPacket[],
            programCompleted: false,
          };
        }

        const head = await this.deps.repo.findMachineProgramForStoreOut({ kind: "ID", id: input.programId }, tx);
        if (!head) throw new BatchRefusedError("PROGRAM_NOT_FOUND", "This machine program no longer exists.");
        const refusal = machineProgramStoreOutRefusal(head);
        if (refusal) throw new BatchRefusedError(refusal.outcome, refusal.reason);

        // The batch row goes in first: the events point at it, and its CHECK (packet_count > 0)
        // with the UNIQUE key is what makes a replayed request safe. If any packet below is
        // refused the whole transaction rolls back, so the stored count is always what committed.
        const batchId = this.deps.idGenerator.nextId();
        await this.deps.repo.insertMachineProgramIssueBatch(
          {
            id: batchId,
            batchKey,
            programId: head.id,
            sessionId: input.sessionId,
            deviceId: input.deviceId,
            issuedBy: input.actor,
            packetCount: qrIds.length,
            createdAt: tx.nowIso,
          },
          tx
        );

        let programCompleted = false;
        const packets: IssuedProgramPacket[] = [];
        for (const qrId of qrIds) {
          const badFormat = checkRawMaterialScanFormat(qrId);
          if (badFormat) {
            throw new BatchRefusedError("SCAN_REFUSED", badFormat.reason ?? "This is not a raw material label.", {
              refusedQrId: qrId,
              refusedVerdict: "INVALID_FORMAT",
            });
          }
          const issued = await issueRawMaterialPacket(
            this.deps,
            {
              qrId,
              sessionId: input.sessionId,
              context: input.context,
              actor: input.actor,
              binding: { mode: "PROGRAM", programId: head.id, batchId },
            },
            tx
          );
          if (issued.machineProgram?.programCompleted) programCompleted = true;
          packets.push(issuedProgramPacket(qrId, issued));
        }

        await this.deps.repo.appendAuditLog(
          {
            id: this.deps.idGenerator.nextId(),
            eventType: "MACHINE_PROGRAM_STORE_OUT_BATCH_SAVED",
            entityType: "MACHINE_PROGRAM",
            entityId: head.id,
            actorUserId: input.actorUserId ?? null,
            actorDeviceId: input.deviceId,
            occurredAt: tx.nowIso,
            payload: {
              code: formatMachineProgramCodeNumber(head.programNumber),
              batchId,
              batchKey,
              sessionId: input.sessionId,
              packetCount: qrIds.length,
              qrIds,
              actor: input.actor,
              programCompleted,
            },
          },
          tx
        );

        return { alreadySaved: false as const, batchId, programId: head.id, packetCount: qrIds.length, packets, programCompleted };
      });

      await this.deps.eventPublisher.publish("MachineProgramStoreOutBatchSaved.v1", {
        programId: committed.programId,
        batchId: committed.batchId,
        packetCount: committed.packetCount,
      });

      return {
        accepted: true,
        outcome: committed.alreadySaved ? "ALREADY_SAVED" : "SAVED",
        batchId: committed.batchId,
        programId: committed.programId,
        packetCount: committed.packetCount,
        packets: committed.packets,
        programCompleted: committed.programCompleted,
      };
    } catch (error) {
      if (error instanceof BatchRefusedError) {
        return { accepted: false, outcome: error.outcome, reason: error.message, programId: input.programId, ...error.details };
      }
      if (error instanceof RawMaterialIssueRejectedError) {
        return {
          accepted: false,
          outcome: "SCAN_REFUSED",
          reason: `${error.message} Nothing in this batch was issued.`,
          programId: input.programId,
          refusedQrId: error.details.qrId,
          refusedVerdict: verdictOfIssueOutcome(error.outcome),
        };
      }
      throw error;
    }
  }
}
