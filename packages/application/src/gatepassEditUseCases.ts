import type { TransactionContext, TransactionManager } from "./ports.js";
import {
  checkGatepassLineShapes,
  formatGatepassCode,
  GatepassRejectedError,
  prepareGatepassLines,
  requireGatepassParty,
  type AuditLogPayload,
  type BillingNoticePayload,
  type CreateGatepassOutcome,
  type GatepassLineInput,
  type GatepassLinePayload,
  type GatepassLineProgress,
  type GatepassLineToIssue,
  type GatepassOrderAllocationSummary,
  type GatepassPartyRecord,
  type GatepassShortage,
  type GatepassVariantStock,
} from "./gatepassUseCases.js";

// EDITING A GATEPASS, AND DELETING A CANCELLED ONE (owner, 23 Nov 2026, local migration 118).
//
// EDIT keeps the gatepass's id and number and replaces what it carries, in ONE transaction:
//
//   1. what it was is kept as a version (who replaced it, when, why) -- it travels with the gatepass
//   2. the cartons its old lines issued directly go back to the store (exactly as a cancel puts them back)
//   3. its old lines go, so their reservation no longer counts
//   4. the new lines meet the rule a new gatepass meets (prepareGatepassLines), against the store as it is now
//   5. the new lines are written with new ids, and their cartons issued afresh
//   6. the header takes the new figures and the next revision -- refused if someone else edited it first
//   7. the customer-order allocation is made again from the new lines, and its reversed shares naming the old lines go
//      (a receiver would otherwise wait for ever for lines that no longer exist)
//   8. a billed gatepass's bill follows: each article + size's dozens become what the gatepass now sends
//
// When an edit is allowed (the owner's rules):
//   * only while the gatepass is Gatepass Issued or Billed, and never once a carton has been scanned out of the
//     store -- those cartons have physically moved, and the paper must not say otherwise
//   * the party may change only before the bill is entered
//   * a billed gatepass may change quantities and colours and drop an article + size, but not take on an article +
//     size its bill does not price -- the bill would carry a line nobody gave a rate
//
// DELETE is only for a cancelled gatepass. It is marked deleted (who, when, why) and every list leaves it out. Nothing
// is erased: the lines, the history and the audit stay, and its number is never used again.

export type EditGatepassOutcome =
  | "EDITED"
  | "NOT_FOUND"
  | "REASON_REQUIRED"
  /** It was edited (or moved on) since the editor opened it: reopen and edit again. */
  | "EDITED_ELSEWHERE"
  | "CANCELLED"
  | "DELETED"
  /** Past billing: at the gate, dispatched or delivered. */
  | "MOVED_ON"
  /** Cartons have been scanned out of the store for it. */
  | "ALREADY_MOVED"
  | "BEFORE_GO_LIVE"
  /** The party may change only before the bill is entered. */
  | "PARTY_LOCKED"
  /** A billed gatepass may not take on an article + size its bill does not carry. */
  | "NEW_LINE_ON_BILL"
  | Exclude<CreateGatepassOutcome, "CREATED" | "ALREADY_SAVED" | "REQUEST_CONFLICT">;

export interface EditGatepassInput {
  gatepassId: string;
  /** The revision the editor opened. A newer one here means someone else edited it first. */
  revisionNo: number;
  partyId: string;
  lines: GatepassLineInput[];
  biltyNumber?: string | null;
  transportVia?: string | null;
  remarks?: string | null;
  /** Why it is being edited. Required: it is kept with the replaced version. */
  reason: string;
  actor: string;
  actorUserId?: string | null;
  deviceId?: string | null;
  /** This computer's store, for cartons beyond what it holds while a gatepass may go below zero. */
  storeLocationId?: string | null;
}

export interface EditGatepassResult {
  accepted: boolean;
  outcome: EditGatepassOutcome;
  reason?: string;
  gatepassId?: string;
  code?: string;
  revisionNo?: number;
  totalQuantity?: number;
  /** The bill that followed the edit, when the gatepass was billed. */
  billNumber?: string;
  shortages?: GatepassShortage[];
  productVariantId?: string;
}

/** A gatepass line as an edit reads it: its progress and the In Store figure when it was cut. */
export interface GatepassLineForEdit extends GatepassLineProgress {
  storeQuantityAtCreation: number;
}

export interface GatepassForEdit {
  id: string;
  gatepassNumber: number;
  status: string;
  revisionNo: number;
  partyId: string;
  partyName: string;
  biltyNumber: string | null;
  transportVia: string | null;
  remarks: string | null;
  totalQuantity: number;
  deletedAt: string | null;
  lines: GatepassLineForEdit[];
  /** Its live bill: `entered` once the desk has entered it (it has lines, and so money). */
  bill: { id: string; voucherNumber: string; entered: boolean } | null;
  madeBeforeGoLive?: boolean;
}

export interface GatepassVersionPayload {
  id: string;
  gatepassId: string;
  versionNo: number;
  partyId: string;
  partyName: string;
  biltyNumber: string | null;
  transportVia: string | null;
  remarks: string | null;
  totalQuantity: number;
  lines: Array<{ productVariantId: string; article: string; color: string; size: string; quantity: number; issuedDirectlyQuantity: number }>;
  replacedAt: string;
  replacedBy: string;
  reason: string;
}

export interface EditedGatepassHeader {
  gatepassId: string;
  /** The revision being replaced: the write is guarded on it. */
  fromRevision: number;
  partyId: string;
  biltyNumber: string | null;
  transportVia: string | null;
  remarks: string | null;
  totalQuantity: number;
  editedBy: string;
  editedAt: string;
}

export interface EditGatepassDeps {
  txManager: TransactionManager;
  repo: {
    getGatepassForEdit(gatepassId: string, tx: TransactionContext): Promise<GatepassForEdit | null>;
    getPartyForGatepass(partyId: string, tx: TransactionContext): Promise<GatepassPartyRecord | null>;
    saveGatepassVersion(payload: GatepassVersionPayload, tx: TransactionContext): Promise<void>;
    returnGatepassCartons(gatepassId: string, returnedBy: string, tx: TransactionContext): Promise<number>;
    removeGatepassLines(gatepassId: string, tx: TransactionContext): Promise<void>;
    getStoreStockForVariants(productVariantIds: string[], tx: TransactionContext): Promise<GatepassVariantStock[]>;
    gatepassMayGoBelowZero?(): boolean;
    insertGatepassLines(lines: GatepassLinePayload[], tx: TransactionContext): Promise<void>;
    issueGatepassCartons(lines: GatepassLineToIssue[], issuedBy: string, tx: TransactionContext, storeLocationId?: string): Promise<void>;
    /** Guarded on `fromRevision`: false when the gatepass is no longer at that revision. */
    updateEditedGatepass(payload: EditedGatepassHeader, tx: TransactionContext): Promise<boolean>;
    reallocateGatepassOrders(
      payload: { gatepassId: string; actor: string; reason: string; actorUserId?: string | null; deviceId?: string | null },
      tx: TransactionContext
    ): Promise<GatepassOrderAllocationSummary>;
    /** The allocation's reversed shares naming the replaced lines go, so the allocation names only lines that exist. */
    dropSharesOfReplacedLines(gatepassId: string, tx: TransactionContext): Promise<number>;
    /** The bill takes the gatepass's new dozens (and, before it is entered, its party). Null when it has no bill. */
    followGatepassEditOnBill(payload: { gatepassId: string; partyId: string }, tx: TransactionContext): Promise<{ voucherNumber: string } | null>;
    appendAuditLog(payload: AuditLogPayload, tx: TransactionContext): Promise<void>;
    notifyBilling(payload: BillingNoticePayload, tx: TransactionContext): Promise<void>;
  };
  idGenerator: { nextId(): string };
}

class EditRefused extends Error {
  constructor(readonly outcome: EditGatepassOutcome, message: string, readonly details: Partial<EditGatepassResult> = {}) {
    super(message);
    this.name = "EditRefused";
  }
}

const optionalText = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const articleSizeKey = (line: { article: string; size: string }) => `${line.article.trim().toUpperCase()}|||${line.size.trim().toUpperCase()}`;

/** Whether this gatepass may be edited at all, before anything is read about the new lines. */
function refuseUneditable(existing: GatepassForEdit, revisionNo: number): void {
  const code = formatGatepassCode(existing.gatepassNumber);
  if (existing.deletedAt) throw new EditRefused("DELETED", `${code} was deleted. It cannot be edited.`);
  if (existing.status === "CANCELLED") throw new EditRefused("CANCELLED", `${code} was cancelled. It cannot be edited.`);
  if (existing.madeBeforeGoLive === true) {
    throw new EditRefused("BEFORE_GO_LIVE", `${code} was made before Carton Cloud went live on this computer. It is test data and cannot be edited.`);
  }
  if (existing.revisionNo !== revisionNo) {
    throw new EditRefused("EDITED_ELSEWHERE", `${code} was changed after you opened it. Open it again to see the latest, then edit.`);
  }
  if (existing.status !== "CREATED" && existing.status !== "BILLED") {
    throw new EditRefused("MOVED_ON", `${code} is past the store. It can no longer be edited.`);
  }
  const scannedOut = existing.lines.reduce((sum, line) => sum + line.dispatchedFromStoreQuantity, 0);
  if (scannedOut > 0) {
    throw new EditRefused("ALREADY_MOVED", `${code} cannot be edited: ${scannedOut} carton(s) have already been scanned out of the store for it.`);
  }
}

/** The old version, as it is kept. */
function versionOf(existing: GatepassForEdit, versionId: string, actor: string, reason: string, nowIso: string): GatepassVersionPayload {
  return {
    id: versionId,
    gatepassId: existing.id,
    versionNo: existing.revisionNo,
    partyId: existing.partyId,
    partyName: existing.partyName,
    biltyNumber: existing.biltyNumber,
    transportVia: existing.transportVia,
    remarks: existing.remarks,
    totalQuantity: existing.totalQuantity,
    lines: existing.lines.map((line) => ({
      productVariantId: line.productVariantId, article: line.article, color: line.color, size: line.size,
      quantity: line.quantity, issuedDirectlyQuantity: line.issuedDirectlyQuantity,
    })),
    replacedAt: nowIso,
    replacedBy: actor,
    reason,
  };
}

export class EditGatepassUseCase {
  constructor(private readonly deps: EditGatepassDeps) {}

  async execute(input: EditGatepassInput): Promise<EditGatepassResult> {
    const gatepassId = String(input.gatepassId ?? "").trim();
    const reason = String(input.reason ?? "").trim();
    const actor = String(input.actor ?? "").trim();
    if (!gatepassId) return { accepted: false, outcome: "NOT_FOUND", reason: "This Gatepass could not be found." };
    if (!reason) return { accepted: false, outcome: "REASON_REQUIRED", reason: "Say why this Gatepass is being edited." };
    if (!actor) throw new Error("Editing a gatepass requires the acting user.");
    const lines = Array.isArray(input.lines) ? input.lines : [];
    const shapeRejection = checkGatepassLineShapes(lines);
    if (shapeRejection) return { accepted: false, outcome: shapeRejection.outcome as EditGatepassOutcome, reason: shapeRejection.reason, productVariantId: shapeRejection.productVariantId };

    try {
      return await this.deps.txManager.runInTransaction((tx) => this.edit(gatepassId, input, lines, reason, actor, tx));
    } catch (error) {
      if (error instanceof EditRefused) return { accepted: false, outcome: error.outcome, reason: error.message, gatepassId, ...error.details };
      if (error instanceof GatepassRejectedError) {
        return { accepted: false, outcome: error.outcome as EditGatepassOutcome, reason: error.message, gatepassId, shortages: error.details.shortages, productVariantId: error.details.productVariantId };
      }
      throw error;
    }
  }

  private async edit(gatepassId: string, input: EditGatepassInput, lines: GatepassLineInput[], reason: string, actor: string, tx: TransactionContext): Promise<EditGatepassResult> {
    const existing = await this.deps.repo.getGatepassForEdit(gatepassId, tx);
    if (!existing) throw new EditRefused("NOT_FOUND", "This Gatepass could not be found.");
    refuseUneditable(existing, Number(input.revisionNo));
    const code = formatGatepassCode(existing.gatepassNumber);
    const partyId = await this.partyFor(existing, String(input.partyId ?? "").trim(), tx);

    // 1-3: keep what it was, put its issued cartons back, and take its old lines off the store's books.
    await this.deps.repo.saveGatepassVersion(versionOf(existing, this.deps.idGenerator.nextId(), actor, reason, tx.nowIso), tx);
    await this.deps.repo.returnGatepassCartons(gatepassId, actor, tx);
    await this.deps.repo.removeGatepassLines(gatepassId, tx);

    // 4-5: the new lines meet the rule a new gatepass meets, and their cartons are issued afresh.
    const { linePayloads, auditLines } = await prepareGatepassLines(this.deps.repo, this.deps.idGenerator, lines, tx);
    refuseNewLineOnBill(existing, linePayloads, code);
    const atCreation = new Map(existing.lines.map((line) => [line.productVariantId, line.storeQuantityAtCreation]));
    const written = linePayloads.map((line) => ({ ...line, gatepassId, storeQuantityAtCreation: atCreation.get(line.productVariantId) ?? line.storeQuantityAtCreation }));
    await this.deps.repo.insertGatepassLines(written, tx);
    await this.deps.repo.issueGatepassCartons(
      written.map((line) => ({ gatepassId, lineId: line.id, productVariantId: line.productVariantId, quantity: line.quantity, label: `${line.article} / ${line.color} / ${line.size}` })),
      actor,
      tx,
      optionalText(input.storeLocationId) ?? undefined
    );

    // 6-8: the header, the orders and the bill.
    const totalQuantity = written.reduce((sum, line) => sum + line.quantity, 0);
    const header: EditedGatepassHeader = {
      gatepassId, fromRevision: existing.revisionNo, partyId, totalQuantity, editedBy: actor, editedAt: tx.nowIso,
      biltyNumber: optionalText(input.biltyNumber), transportVia: optionalText(input.transportVia), remarks: optionalText(input.remarks),
    };
    if (!(await this.deps.repo.updateEditedGatepass(header, tx))) {
      throw new EditRefused("EDITED_ELSEWHERE", `${code} was changed after you opened it. Open it again to see the latest, then edit.`);
    }
    await this.deps.repo.reallocateGatepassOrders({ gatepassId, actor, reason, actorUserId: input.actorUserId ?? null, deviceId: input.deviceId ?? null }, tx);
    await this.deps.repo.dropSharesOfReplacedLines(gatepassId, tx);
    const bill = await this.deps.repo.followGatepassEditOnBill({ gatepassId, partyId }, tx);

    await this.record(existing, header, auditLines, reason, input, tx);
    await this.deps.repo.notifyBilling(editNotice(existing, code, actor, reason, totalQuantity, bill), tx);
    return { accepted: true, outcome: "EDITED", gatepassId, code, revisionNo: existing.revisionNo + 1, totalQuantity, billNumber: bill?.voucherNumber };
  }

  /**
   * The party the edited gatepass is for: unchanged (even one made before the customers-only rule), or a new active
   * customer while its bill is not yet entered.
   */
  private async partyFor(existing: GatepassForEdit, partyId: string, tx: TransactionContext): Promise<string> {
    if (!partyId || partyId === existing.partyId) return existing.partyId;
    const code = formatGatepassCode(existing.gatepassNumber);
    if (existing.status !== "CREATED" || existing.bill?.entered) {
      throw new EditRefused("PARTY_LOCKED", `${code} has been billed to ${existing.partyName}. The party cannot change now. Delete the bill first to change it.`);
    }
    return requireGatepassParty(await this.deps.repo.getPartyForGatepass(partyId, tx)).id;
  }

  private async record(existing: GatepassForEdit, header: EditedGatepassHeader, lines: Array<Record<string, unknown>>, reason: string, input: EditGatepassInput, tx: TransactionContext) {
    await this.deps.repo.appendAuditLog(
      {
        id: this.deps.idGenerator.nextId(),
        eventType: "GATEPASS_EDITED",
        entityType: "GATEPASS",
        entityId: existing.id,
        actorUserId: input.actorUserId ?? null,
        actorDeviceId: input.deviceId ?? null,
        occurredAt: tx.nowIso,
        payload: {
          code: formatGatepassCode(existing.gatepassNumber), actor: header.editedBy, reason, fromRevision: existing.revisionNo, toRevision: existing.revisionNo + 1,
          before: { partyId: existing.partyId, totalQuantity: existing.totalQuantity, lines: existing.lines },
          after: { partyId: header.partyId, totalQuantity: header.totalQuantity, biltyNumber: header.biltyNumber, transportVia: header.transportVia, remarks: header.remarks, lines },
        },
      },
      tx
    );
  }
}

/** A billed gatepass may change what it sends of each article + size, but not take on one its bill does not price. */
function refuseNewLineOnBill(existing: GatepassForEdit, lines: GatepassLinePayload[], code: string): void {
  if (!existing.bill?.entered) return;
  const billed = new Set(existing.lines.map(articleSizeKey));
  const added = lines.find((line) => !billed.has(articleSizeKey(line)));
  if (added) {
    throw new EditRefused(
      "NEW_LINE_ON_BILL",
      `${code} is billed, and its bill has no rate for ${added.article} ${added.size}. Delete Sale Voucher #${existing.bill.voucherNumber} first, or make a separate Gatepass for it.`,
      { productVariantId: added.productVariantId }
    );
  }
}

/** The billing desk hears of every edit; urgently when the bill's quantities changed under it. */
function editNotice(existing: GatepassForEdit, code: string, actor: string, reason: string, totalQuantity: number, bill: { voucherNumber: string } | null): BillingNoticePayload {
  if (existing.bill?.entered && bill) {
    return {
      kind: "GATEPASS_CREATED",
      severity: "WARNING",
      entityId: existing.id,
      title: `Gatepass ${code} edited — Sale Voucher #${bill.voucherNumber} updated`,
      message: `Edited by ${actor}: ${reason}. The bill now carries what the gatepass sends. Check it.`,
    };
  }
  return {
    kind: "GATEPASS_CREATED",
    severity: "INFO",
    entityId: existing.id,
    title: `Gatepass ${code} edited`,
    message: `Edited by ${actor}: ${reason}. ${totalQuantity} carton(s) now. Make the sale voucher from it as it stands.`,
  };
}

// ─── Deleting a cancelled gatepass ───────────────────────────────────────────

export type DeleteGatepassOutcome = "DELETED" | "NOT_FOUND" | "REASON_REQUIRED" | "NOT_CANCELLED" | "ALREADY_DELETED";

export interface DeleteGatepassInput {
  gatepassId: string;
  reason: string;
  actor: string;
  actorUserId?: string | null;
  deviceId?: string | null;
}

export interface DeleteGatepassResult {
  accepted: boolean;
  outcome: DeleteGatepassOutcome;
  reason?: string;
  gatepassId?: string;
  code?: string;
  deletedAt?: string;
}

export interface DeleteGatepassDeps {
  txManager: TransactionManager;
  repo: {
    readGatepassForDelete(gatepassId: string, tx: TransactionContext): Promise<{ gatepassNumber: number; status: string; deletedAt: string | null } | null>;
    /** Guarded: only a cancelled gatepass not yet deleted changes. */
    markGatepassDeleted(payload: { gatepassId: string; deletedAt: string; deletedBy: string; reason: string }, tx: TransactionContext): Promise<boolean>;
    appendAuditLog(payload: AuditLogPayload, tx: TransactionContext): Promise<void>;
  };
  idGenerator: { nextId(): string };
}

export class DeleteGatepassUseCase {
  constructor(private readonly deps: DeleteGatepassDeps) {}

  async execute(input: DeleteGatepassInput): Promise<DeleteGatepassResult> {
    const gatepassId = String(input.gatepassId ?? "").trim();
    const reason = String(input.reason ?? "").trim();
    const actor = String(input.actor ?? "").trim();
    if (!gatepassId) return { accepted: false, outcome: "NOT_FOUND", reason: "This Gatepass could not be found." };
    if (!reason) return { accepted: false, outcome: "REASON_REQUIRED", reason: "Say why this Gatepass is being deleted." };
    if (!actor) throw new Error("Deleting a gatepass requires the acting user.");

    return this.deps.txManager.runInTransaction(async (tx): Promise<DeleteGatepassResult> => {
      const existing = await this.deps.repo.readGatepassForDelete(gatepassId, tx);
      if (!existing) return { accepted: false, outcome: "NOT_FOUND", reason: "This Gatepass could not be found.", gatepassId };
      const code = formatGatepassCode(existing.gatepassNumber);
      if (existing.deletedAt) return { accepted: false, outcome: "ALREADY_DELETED", reason: `${code} has already been deleted.`, gatepassId, code };
      if (existing.status !== "CANCELLED") {
        return { accepted: false, outcome: "NOT_CANCELLED", reason: `${code} is not cancelled. Cancel it first: only a cancelled Gatepass can be deleted.`, gatepassId, code };
      }
      if (!(await this.deps.repo.markGatepassDeleted({ gatepassId, deletedAt: tx.nowIso, deletedBy: actor, reason }, tx))) {
        return { accepted: false, outcome: "ALREADY_DELETED", reason: `${code} has already been deleted.`, gatepassId, code };
      }
      await this.deps.repo.appendAuditLog(
        {
          id: this.deps.idGenerator.nextId(),
          eventType: "GATEPASS_DELETED",
          entityType: "GATEPASS",
          entityId: gatepassId,
          actorUserId: input.actorUserId ?? null,
          actorDeviceId: input.deviceId ?? null,
          occurredAt: tx.nowIso,
          payload: { code, gatepassNumber: existing.gatepassNumber, actor, reason },
        },
        tx
      );
      return { accepted: true, outcome: "DELETED", gatepassId, code, deletedAt: tx.nowIso };
    });
  }
}
