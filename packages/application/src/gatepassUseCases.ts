import { gatepassShortBy, maxNewGatepassQuantity, outstandingQuantity, reflectedStock } from "@erp/domain";
import type { TransactionContext, TransactionManager } from "./ports.js";

// Gatepass: an operational document that reserves store stock for a party. It sits beside
// the QR lifecycle, not inside it.
//
//   PRODUCT MASTER → STORE STOCK → GATEPASS (reservation) → Store Move Out scan → gate
//
// Two stock figures, never confused (see @erp/domain gatepassStock.ts):
//
//   Current Stock    physical cartons In Store — changed only by an actual scan
//   Reflected Stock  Current Stock − cartons still owed to outstanding Gatepasses
//
// Creating a gatepass never changes a QR's status or location, never assigns QR codes, and never
// creates a voucher or ledger entry. It writes the gatepass header, its lines, an audit row and a
// notice to the billing users. The one hard rule it enforces is that every line fits inside
// Reflected Stock — Current Stock and the other Gatepasses' outstanding quantity are both re-read
// inside the same write transaction, never trusted from the screen, so two clerks can never take
// the same last carton.
//
// EACH LINE IS SPLIT WHEN THE GATEPASS IS MADE (docs/42 section 3.5, revised 2026-11-03). What QR
// cartons in the store can cover is RESERVED, consumed by the Store Move Out scan that names this
// gatepass (StoreExitScanUseCase), exactly as before. The shortfall -- cartons with no QR, from
// Manual Production -- is ISSUED DIRECTLY: in the same transaction the repository takes it out of
// stock as a carton movement, which every other computer receives. Cancelling releases the
// reservation and puts back exactly what was issued. With every carton a QR carton, nothing is
// issued and the gatepass behaves exactly as it always has.

/** Display code, e.g. GP-000123. */
export const formatGatepassCode = (gatepassNumber: number): string => `GP-${String(gatepassNumber).padStart(6, "0")}`;

export const GATEPASS_STATUSES = ["CREATED", "BILLED", "AT_GATE", "DISPATCHED", "DELIVERED", "CANCELLED"] as const;
export type GatepassStatus = (typeof GATEPASS_STATUSES)[number];

export interface GatepassLineInput {
  productVariantId: string;
  /** Cartons (the unit the store stock projection counts). Whole numbers only. */
  quantity: number;
  /**
   * The Reflected Stock the operator saw when they typed the line. Optional; when given it
   * lets a rejection say "stock changed" rather than "too much" when the numbers moved
   * underneath them.
   */
  reflectedStockSeen?: number;
}

export interface CreateGatepassInput {
  partyId: string;
  lines: GatepassLineInput[];
  /** Transporter's receipt number (بلٹی نمبر). Optional — often written in by hand later. */
  biltyNumber?: string | null;
  /** Carrier / vehicle the goods travel by (بزریعہ). Optional. */
  transportVia?: string | null;
  remarks?: string | null;
  /** Logged-in user creating the document. */
  actor: string;
  actorUserId?: string | null;
  deviceId?: string | null;
  /**
   * This computer's store. When a gatepass may go below zero (repo.gatepassMayGoBelowZero), what a line asks
   * for beyond the store's stock is taken from it, and Manual Production makes it up later (owner, 12 Nov 2026).
   */
  storeLocationId?: string | null;
  /**
   * The screen's id for one press of Create, kept across a retry whose answer was lost (migration 105).
   * The same id asking for the same gatepass returns the one already made (ALREADY_SAVED); asking for a
   * different one is REQUEST_CONFLICT. The desktop always sends one; without it nothing is deduplicated.
   */
  requestId?: string | null;
}

export type CreateGatepassOutcome =
  | "CREATED"
  /** This request id already made this gatepass: it is returned, and nothing is written again. */
  | "ALREADY_SAVED"
  /** This request id already made a DIFFERENT gatepass: nothing is written. */
  | "REQUEST_CONFLICT"
  | "NO_PARTY"
  | "PARTY_NOT_FOUND"
  | "PARTY_INACTIVE"
  | "NO_LINES"
  | "INVALID_QUANTITY"
  | "DUPLICATE_LINE"
  | "VARIANT_NOT_FOUND"
  /** A line asks for more than Reflected Stock, and the operator saw the same figure. */
  | "INSUFFICIENT_STOCK"
  /** A line asks for more than Reflected Stock because the figure changed since it was shown. */
  | "STOCK_CHANGED";

export interface GatepassShortage {
  productVariantId: string;
  article: string;
  color: string;
  size: string;
  requested: number;
  /** Physical In Store cartons at the moment of the check. */
  currentStock: number;
  /** Cartons still owed to other outstanding Gatepasses at the moment of the check. */
  reserved: number;
  /** currentStock − reserved: what a new Gatepass may take. */
  reflected: number;
  /** The Reflected Stock the operator saw, when they told us. */
  seen: number | null;
}

export interface CreateGatepassResult {
  accepted: boolean;
  outcome: CreateGatepassOutcome;
  /** Operator-facing explanation for a rejection. */
  reason?: string;
  gatepassId?: string;
  gatepassNumber?: number;
  code?: string;
  totalQuantity?: number;
  createdAt?: string;
  /** The bill made with the gatepass, when it was made. */
  billId?: string;
  billNumber?: string;
  /** Every failing line for INSUFFICIENT_STOCK / STOCK_CHANGED. */
  shortages?: GatepassShortage[];
  /** The offending variant for VARIANT_NOT_FOUND / DUPLICATE_LINE / INVALID_QUANTITY. */
  productVariantId?: string;
}

/** Thrown inside the transaction to abort with a typed outcome and no writes. */
export class GatepassRejectedError extends Error {
  constructor(
    readonly outcome: Exclude<CreateGatepassOutcome, "CREATED">,
    message: string,
    readonly details: Partial<CreateGatepassResult> = {}
  ) {
    super(message);
    this.name = "GatepassRejectedError";
  }
}

export interface GatepassPartyRecord {
  id: string;
  partyName: string;
  status: string;
}

/**
 * One variant's identity plus its two live figures, read inside the transaction:
 * `storeQuantity` is Current Stock, `reservedQuantity` is what outstanding Gatepasses still
 * owe. Reflected Stock is derived here, never stored.
 */
export interface GatepassVariantStock {
  productVariantId: string;
  article: string;
  color: string;
  size: string;
  storeQuantity: number;
  reservedQuantity: number;
}

export interface GatepassHeaderPayload {
  id: string;
  gatepassNumber: number;
  partyId: string;
  /** Local calendar day, YYYY-MM-DD. */
  gatepassDate: string;
  biltyNumber: string | null;
  transportVia: string | null;
  remarks: string | null;
  totalQuantity: number;
  createdBy: string;
  createdAt: string;
  /** The press of Create that made it, and a hash of what it asked for (migration 105). */
  requestId?: string | null;
  requestFingerprint?: string | null;
}

/** A gatepass already made under a request id, with what a retry needs to answer it. */
export interface GatepassMadeByRequest {
  gatepassId: string;
  gatepassNumber: number;
  totalQuantity: number;
  createdAt: string;
  requestFingerprint: string | null;
  billId: string | null;
  billNumber: string | null;
}

/** What a press of Create asked for: the part a retry must repeat to be the same request. */
export interface GatepassRequestSummary {
  partyId: string;
  biltyNumber: string | null;
  transportVia: string | null;
  remarks: string | null;
  lines: Array<{ productVariantId: string; quantity: number }>;
}

export interface GatepassLinePayload {
  id: string;
  gatepassId: string;
  lineNo: number;
  productVariantId: string;
  article: string;
  color: string;
  size: string;
  quantity: number;
  /** Current Stock (physical In Store) when the line was written — for the printed document. */
  storeQuantityAtCreation: number;
  createdAt: string;
}

/** One line whose cartons leave the store as the gatepass is made. */
export interface GatepassLineToIssue {
  gatepassId: string;
  lineId: string;
  productVariantId: string;
  quantity: number;
  /** "SK6 / RED / 7/10", for a refusal. */
  label: string;
}

export interface AuditLogPayload {
  id: string;
  eventType: string;
  entityType: string;
  entityId: string;
  actorUserId: string | null;
  actorDeviceId: string | null;
  occurredAt: string;
  payload: Record<string, unknown>;
}

/** A notice for every user who bills — written in the same transaction as the document. */
export interface BillingNoticePayload {
  kind: "GATEPASS_CREATED" | "GATEPASS_CANCELLED";
  severity: "INFO" | "WARNING" | "CRITICAL";
  /** The gatepass the notice is about. */
  entityId: string;
  title: string;
  message: string;
}

export interface CreateGatepassDeps {
  txManager: TransactionManager;
  repo: {
    getPartyForGatepass(partyId: string, tx: TransactionContext): Promise<GatepassPartyRecord | null>;
    /**
     * Current Stock and Reserved for each active variant, read under the write lock. A
     * variant that does not exist, is disabled or is deleted is simply absent from the result.
     */
    getStoreStockForVariants(productVariantIds: string[], tx: TransactionContext): Promise<GatepassVariantStock[]>;
    /** Next document number. Must be called inside the transaction so numbers never collide. */
    allocateGatepassNumber(tx: TransactionContext): Promise<number>;
    insertGatepass(payload: GatepassHeaderPayload, tx: TransactionContext): Promise<void>;
    insertGatepassLines(lines: GatepassLinePayload[], tx: TransactionContext): Promise<void>;
    /**
     * Takes each line's cartons out of the store as a carton movement, in this transaction. What the store
     * does not hold comes from `storeLocationId`, below zero. Throws (rolling the whole gatepass back) only
     * when there is a shortfall and no store to take it from.
     */
    issueGatepassCartons(lines: GatepassLineToIssue[], issuedBy: string, tx: TransactionContext, storeLocationId?: string): Promise<void>;
    /**
     * Whether a gatepass may ask for more than Reflected Stock, taking the store below zero (owner, 12 Nov 2026).
     * Only while carton QR is on hold: with QR scanning on, the cartons beyond Reflected Stock are other
     * gatepasses' reserved QR cartons, and taking them would leave those scans with nothing to take. Absent: no.
     */
    gatepassMayGoBelowZero?(): boolean;
    appendAuditLog(payload: AuditLogPayload, tx: TransactionContext): Promise<void>;
    /**
     * Makes the gatepass's one bill, in this transaction: its number and its link to the gatepass, and no lines
     * yet, so no money. The bill desk enters the rates (docs/43).
     */
    generateGatepassBill(payload: { gatepassId: string; partyId: string; voucherDate: string }, tx: TransactionContext): Promise<{ id: string; voucherNumber: string }>;
    /** Tells every billing user; who they are is the repository's business. */
    notifyBilling(payload: BillingNoticePayload, tx: TransactionContext): Promise<void>;
    /** The gatepass a request id already made, read under the write lock, or null. Needed only with a request id. */
    findGatepassByRequest?(requestId: string, tx: TransactionContext): Promise<GatepassMadeByRequest | null>;
    /** A stable hash of what a request asked for. Needed only with a request id. */
    fingerprintRequest?(summary: GatepassRequestSummary): string;
  };
  idGenerator: { nextId(): string };
  /** Local calendar day for the document date; defaults to the machine's local date. */
  localDate?: () => string;
}

const localYmd = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const describeLine = (line: { article: string; color: string; size: string }) => `${line.article} / ${line.color} / ${line.size}`;

const optionalText = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Shape checks that need no database. Returns the rejection, or null when the input is usable. */
const checkLineShapes = (lines: GatepassLineInput[]): CreateGatepassResult | null => {
  if (lines.length === 0) {
    return { accepted: false, outcome: "NO_LINES", reason: "Enter a quantity for at least one colour / size before continuing." };
  }
  const seen = new Set<string>();
  for (const line of lines) {
    const variantId = String(line?.productVariantId ?? "").trim();
    if (!variantId) {
      return { accepted: false, outcome: "VARIANT_NOT_FOUND", reason: "One of the lines has no product. Refresh the stock and try again." };
    }
    const quantity = line.quantity;
    if (typeof quantity !== "number" || !Number.isFinite(quantity) || !Number.isInteger(quantity)) {
      return { accepted: false, outcome: "INVALID_QUANTITY", reason: "Quantity must be a whole number of cartons.", productVariantId: variantId };
    }
    if (quantity <= 0) {
      return { accepted: false, outcome: "INVALID_QUANTITY", reason: "Quantity must be greater than 0.", productVariantId: variantId };
    }
    if (seen.has(variantId)) {
      return {
        accepted: false,
        outcome: "DUPLICATE_LINE",
        reason: "The same colour / size appears twice. Combine the quantities into one line.",
        productVariantId: variantId,
      };
    }
    seen.add(variantId);
  }
  return null;
};

const shortageRejection = (shortages: GatepassShortage[]): GatepassRejectedError => {
  const changed = shortages.some((s) => s.seen !== null && s.seen !== s.reflected);
  const first = shortages[0];
  return new GatepassRejectedError(
    changed ? "STOCK_CHANGED" : "INSUFFICIENT_STOCK",
    changed
      ? "Available stock changed before the Gatepass could be created. Please review the latest figures."
      : `Requested quantity is more than what is available for ${describeLine(first)}. In Store: ${first.currentStock}. Reserved: ${first.reserved}. Available: ${first.reflected}. Requested: ${first.requested}.`,
    { shortages }
  );
};

export class CreateGatepassUseCase {
  constructor(private readonly deps: CreateGatepassDeps) {}

  async execute(input: CreateGatepassInput): Promise<CreateGatepassResult> {
    const partyId = String(input.partyId ?? "").trim();
    const actor = String(input.actor ?? "").trim();

    if (!partyId) {
      return { accepted: false, outcome: "NO_PARTY", reason: "Select a party before continuing." };
    }
    if (!actor) {
      throw new Error("Gatepass creation requires the acting user.");
    }
    const lines = Array.isArray(input.lines) ? input.lines : [];
    const shapeRejection = checkLineShapes(lines);
    if (shapeRejection) return shapeRejection;

    const remarks = optionalText(input.remarks);
    const biltyNumber = optionalText(input.biltyNumber);
    const transportVia = optionalText(input.transportVia);
    const request = this.requestOf(input, { partyId, biltyNumber, transportVia, remarks, lines });

    try {
      const committed = await this.deps.txManager.runInTransaction(async (tx) => {
        // A retry of a press already answered: the gatepass it made, before anything is checked or written.
        const made = request ? await this.madeByRequest(request, tx) : null;
        if (made) return { ...made, alreadySaved: true };

        const party = await this.requireActiveParty(partyId, tx);
        const { linePayloads, auditLines } = await this.reserveLines(lines, tx);

        // ── Number, header, lines, audit — one atomic write ───────────────────
        const gatepassNumber = await this.deps.repo.allocateGatepassNumber(tx);
        const gatepassId = this.deps.idGenerator.nextId();
        const totalQuantity = linePayloads.reduce((sum, line) => sum + line.quantity, 0);
        const gatepassDate = (this.deps.localDate ?? (() => localYmd(new Date())))();
        const code = formatGatepassCode(gatepassNumber);

        await this.deps.repo.insertGatepass(
          {
            id: gatepassId, gatepassNumber, partyId: party.id, gatepassDate, biltyNumber, transportVia, remarks, totalQuantity, createdBy: actor, createdAt: tx.nowIso,
            requestId: request?.id ?? null, requestFingerprint: request?.fingerprint ?? null,
          },
          tx
        );
        await this.deps.repo.insertGatepassLines(linePayloads.map((line) => ({ ...line, gatepassId })), tx);
        await this.deps.repo.issueGatepassCartons(
          linePayloads.map((line) => ({ gatepassId, lineId: line.id, productVariantId: line.productVariantId, quantity: line.quantity, label: describeLine(line) })),
          actor,
          tx,
          optionalText(input.storeLocationId) ?? undefined
        );
        // After the stock: a gatepass that could not issue its cartons leaves no bill behind.
        const bill = await this.deps.repo.generateGatepassBill({ gatepassId, partyId: party.id, voucherDate: gatepassDate }, tx);
        await this.deps.repo.appendAuditLog(
          {
            id: this.deps.idGenerator.nextId(),
            eventType: "GATEPASS_CREATED",
            entityType: "GATEPASS",
            entityId: gatepassId,
            actorUserId: input.actorUserId ?? null,
            actorDeviceId: input.deviceId ?? null,
            occurredAt: tx.nowIso,
            payload: { code, gatepassNumber, partyId: party.id, partyName: party.partyName, actor, biltyNumber, transportVia, totalQuantity, lines: auditLines },
          },
          tx
        );

        // The billing desk makes the sale voucher from this document.
        await this.deps.repo.notifyBilling(
          { kind: "GATEPASS_CREATED", severity: "INFO", entityId: gatepassId, title: `New Gatepass ${code}`, message: `${totalQuantity} cartons for ${party.partyName}. Open it to make the sale voucher.` },
          tx
        );

        return { gatepassId, gatepassNumber, totalQuantity, createdAt: tx.nowIso, billId: bill.id, billNumber: bill.voucherNumber, alreadySaved: false };
      });

      return {
        accepted: true,
        outcome: committed.alreadySaved ? "ALREADY_SAVED" : "CREATED",
        gatepassId: committed.gatepassId,
        gatepassNumber: committed.gatepassNumber,
        code: formatGatepassCode(committed.gatepassNumber),
        totalQuantity: committed.totalQuantity,
        createdAt: committed.createdAt,
        billId: committed.billId ?? undefined,
        billNumber: committed.billNumber ?? undefined,
      };
    } catch (error) {
      if (error instanceof GatepassRejectedError) {
        return {
          accepted: false, outcome: error.outcome, reason: error.message, shortages: error.details.shortages, productVariantId: error.details.productVariantId,
          gatepassId: error.details.gatepassId, code: error.details.code,
        };
      }
      throw error;
    }
  }

  /** The request id and the hash of what it asks for, or null when no id came (nothing is then deduplicated). */
  private requestOf(input: CreateGatepassInput, asked: Omit<GatepassRequestSummary, "lines"> & { lines: GatepassLineInput[] }) {
    const id = typeof input.requestId === "string" ? input.requestId.trim() : "";
    if (!id) return null;
    const { findGatepassByRequest, fingerprintRequest } = this.deps.repo;
    if (!findGatepassByRequest || !fingerprintRequest) throw new Error("This repository cannot answer a repeated request.");
    const lines = asked.lines
      .map((line) => ({ productVariantId: String(line.productVariantId).trim(), quantity: Number(line.quantity) }))
      .sort((a, b) => (a.productVariantId < b.productVariantId ? -1 : a.productVariantId > b.productVariantId ? 1 : 0));
    return { id, fingerprint: fingerprintRequest.call(this.deps.repo, { ...asked, lines }) };
  }

  /**
   * The gatepass this request already made, or null. The same request gets it back; a different one under
   * the same id is refused, and nothing is written either way.
   */
  private async madeByRequest(request: { id: string; fingerprint: string }, tx: TransactionContext) {
    const made = await this.deps.repo.findGatepassByRequest!.call(this.deps.repo, request.id, tx);
    if (!made) return null;
    const code = formatGatepassCode(made.gatepassNumber);
    if (made.requestFingerprint !== request.fingerprint) {
      throw new GatepassRejectedError(
        "REQUEST_CONFLICT",
        `This Create was already recorded as ${code}, with different details. Nothing new was made. Open ${code} to check it, or start a new Gatepass.`,
        { gatepassId: made.gatepassId, code }
      );
    }
    return made;
  }

  /** Party must exist in Party Master and be active. */
  private async requireActiveParty(partyId: string, tx: TransactionContext): Promise<GatepassPartyRecord> {
    const party = await this.deps.repo.getPartyForGatepass(partyId, tx);
    if (!party) {
      throw new GatepassRejectedError("PARTY_NOT_FOUND", "This party is not in the Party Master. Select a party from the list.");
    }
    if (party.status !== "ACTIVE") {
      throw new GatepassRejectedError("PARTY_INACTIVE", `${party.partyName} is inactive. Only active parties can receive a Gatepass.`);
    }
    return party;
  }

  /**
   * Every line must be a live Product Master variant, and must fit inside Reflected Stock —
   * Current Stock and the other Gatepasses' outstanding quantity as they are NOW, inside the
   * write lock, so two clerks cannot both pass on stale numbers. All-or-nothing: one short
   * line refuses the whole document.
   *
   * EXCEPT WHILE A GATEPASS MAY GO BELOW ZERO (owner, 12 Nov 2026; repo.gatepassMayGoBelowZero): then a line may
   * ask for more, the store goes below zero, and Manual Production makes it up later. The figures are read all
   * the same, so the audit records what the store held and by how much each line went short.
   */
  private async reserveLines(lines: GatepassLineInput[], tx: TransactionContext) {
    const variantIds = lines.map((line) => String(line.productVariantId).trim());
    const stockRows = await this.deps.repo.getStoreStockForVariants(variantIds, tx);
    const stockById = new Map(stockRows.map((row) => [row.productVariantId, row]));

    const mayGoBelowZero = this.deps.repo.gatepassMayGoBelowZero?.call(this.deps.repo) ?? false;
    const shortages: GatepassShortage[] = [];
    const linePayloads: GatepassLinePayload[] = [];
    const auditLines: Array<Record<string, unknown>> = [];
    for (const [index, line] of lines.entries()) {
      const variantId = String(line.productVariantId).trim();
      const stock = stockById.get(variantId);
      if (!stock) {
        throw new GatepassRejectedError(
          "VARIANT_NOT_FOUND",
          "One of the selected products is no longer active in Product Master. Refresh the stock and try again.",
          { productVariantId: variantId }
        );
      }
      const requested = line.quantity;
      const reflected = reflectedStock(stock.storeQuantity, stock.reservedQuantity);
      // More than is free for a new gatepass: refused, unless a gatepass may go below zero.
      if (requested > maxNewGatepassQuantity(stock.storeQuantity, stock.reservedQuantity) && !mayGoBelowZero) {
        shortages.push({
          productVariantId: variantId,
          article: stock.article,
          color: stock.color,
          size: stock.size,
          requested,
          currentStock: stock.storeQuantity,
          reserved: stock.reservedQuantity,
          reflected,
          seen: typeof line.reflectedStockSeen === "number" && Number.isFinite(line.reflectedStockSeen) ? line.reflectedStockSeen : null,
        });
        continue;
      }
      linePayloads.push({
        id: this.deps.idGenerator.nextId(),
        gatepassId: "", // filled once the header id is known
        lineNo: index + 1,
        productVariantId: variantId,
        article: stock.article,
        color: stock.color,
        size: stock.size,
        quantity: requested,
        storeQuantityAtCreation: stock.storeQuantity,
        createdAt: tx.nowIso,
      });
      auditLines.push({
        productVariantId: variantId,
        article: stock.article,
        color: stock.color,
        size: stock.size,
        quantity: requested,
        storeQuantityAtCreation: stock.storeQuantity,
        reservedAtCreation: stock.reservedQuantity,
        reflectedStockAtCreation: reflected,
        // How far this line takes the In Store figure below zero: what production now owes for it. 0 when it fits.
        shortBy: gatepassShortBy(stock.storeQuantity, requested),
      });
    }

    if (shortages.length > 0) throw shortageRejection(shortages);
    return { linePayloads, auditLines };
  }
}

// ─── Cancellation ──────────────────────────────────────────────────────────────
// A gatepass is never deleted. Cancelling marks the document, keeps every line, and records
// who did it and why. Its outstanding reservation is released by that status change alone:
// Reserved only ever counts CREATED documents. Cartons that Store Move Out already took for
// it are physical history and are never brought back by cancelling the paper.

export interface CancelGatepassInput {
  gatepassId: string;
  reason: string;
  actor: string;
  actorUserId?: string | null;
  deviceId?: string | null;
}

export type CancelGatepassOutcome =
  | "CANCELLED"
  | "NOT_FOUND"
  | "ALREADY_CANCELLED"
  | "REASON_REQUIRED"
  /** Its bill must be deleted first — cancelling here would leave a live bill for nothing. */
  | "BILLED"
  /** Cartons have physically left the store. Undoing that needs a controlled reversal. */
  | "ALREADY_MOVED"
  /** Made before Carton Cloud went live on this computer: test data, which must never move the live figure. */
  | "BEFORE_GO_LIVE";

export interface CancelGatepassResult {
  accepted: boolean;
  outcome: CancelGatepassOutcome;
  reason?: string;
  gatepassId?: string;
  code?: string;
  cancelledAt?: string;
  /** Cartons whose reservation this cancellation released (were still outstanding). */
  releasedQuantity?: number;
  /** Cartons issued directly when the gatepass was made, put back into stock by this cancellation. */
  returnedToStockQuantity?: number;
  /** Cartons Store Move Out had already taken for this gatepass — unchanged by cancelling. */
  dispatchedFromStoreQuantity?: number;
}

export class GatepassCancelRejectedError extends Error {
  constructor(readonly outcome: Exclude<CancelGatepassOutcome, "CANCELLED">, message: string) {
    super(message);
    this.name = "GatepassCancelRejectedError";
  }
}

/** A line's requested quantity, what Store Move Out has taken for it, and what was issued directly. */
export interface GatepassLineProgress {
  productVariantId: string;
  article: string;
  color: string;
  size: string;
  quantity: number;
  dispatchedFromStoreQuantity: number;
  /** Taken out of stock when the gatepass was made (docs/42), net of any cancel. */
  issuedDirectlyQuantity: number;
}

export interface GatepassForCancel {
  id: string;
  gatepassNumber: number;
  status: string;
  lines: GatepassLineProgress[];
  /**
   * True when Carton Cloud is live on this computer and this gatepass was made before it went live: test data. Cancelling
   * it would put test cartons back into the live figure, which the cloud and every other computer would never see.
   */
  madeBeforeGoLive?: boolean;
}

export interface CancelGatepassDeps {
  txManager: TransactionManager;
  repo: {
    /** Cancels the gatepass's bill if nobody has entered it. A bill with lines is never touched here. */
    cancelUnenteredBill(payload: { gatepassId: string; reason: string; cancelledAt: string }, tx: TransactionContext): Promise<void>;
    getGatepassForCancel(gatepassId: string, tx: TransactionContext): Promise<GatepassForCancel | null>;
    /**
     * Guarded status move: only a CREATED document changes. Returns false when nothing
     * changed (someone else cancelled it first), so the caller can report that honestly.
     */
    markGatepassCancelled(
      payload: { gatepassId: string; cancelledAt: string; cancelledBy: string; reason: string },
      tx: TransactionContext
    ): Promise<boolean>;
    /**
     * Puts back exactly the cartons this gatepass took out when it was made, in this transaction,
     * and returns how many. A gatepass that took none (made before carton movements) puts none back.
     */
    returnGatepassCartons(gatepassId: string, returnedBy: string, tx: TransactionContext): Promise<number>;
    appendAuditLog(payload: AuditLogPayload, tx: TransactionContext): Promise<void>;
    /** The live (not deleted) sale voucher made from this gatepass, if any. */
    getLinkedSaleVoucher(gatepassId: string, tx: TransactionContext): Promise<{ id: string; voucherNumber: string } | null>;
    notifyBilling(payload: BillingNoticePayload, tx: TransactionContext): Promise<void>;
  };
  idGenerator: { nextId(): string };
}

/** What a cancellation releases and what it cannot touch, per line and in total. */
const summariseRelease = (lines: GatepassLineProgress[]) => {
  const perLine = lines.map((line) => ({
    productVariantId: line.productVariantId,
    article: line.article,
    color: line.color,
    size: line.size,
    quantity: line.quantity,
    dispatchedFromStoreQuantity: line.dispatchedFromStoreQuantity,
    // The reservation the QR scanners no longer owe, and the cartons issued directly, which go back to stock.
    releasedQuantity: outstandingQuantity(line.quantity, line.dispatchedFromStoreQuantity, line.issuedDirectlyQuantity),
    returnedToStockQuantity: line.issuedDirectlyQuantity,
  }));
  return {
    lines: perLine,
    releasedQuantity: perLine.reduce((sum, line) => sum + line.releasedQuantity, 0),
    returnedToStockQuantity: perLine.reduce((sum, line) => sum + line.returnedToStockQuantity, 0),
    dispatchedFromStoreQuantity: perLine.reduce((sum, line) => sum + line.dispatchedFromStoreQuantity, 0),
  };
};

export class CancelGatepassUseCase {
  constructor(private readonly deps: CancelGatepassDeps) {}

  async execute(input: CancelGatepassInput): Promise<CancelGatepassResult> {
    const gatepassId = String(input.gatepassId ?? "").trim();
    const reason = String(input.reason ?? "").trim();
    const actor = String(input.actor ?? "").trim();
    if (!gatepassId) {
      return { accepted: false, outcome: "NOT_FOUND", reason: "This Gatepass could not be found." };
    }
    if (!reason) {
      return { accepted: false, outcome: "REASON_REQUIRED", reason: "Give a reason for cancelling this Gatepass." };
    }
    if (!actor) {
      throw new Error("Gatepass cancellation requires the acting user.");
    }

    try {
      const committed = await this.deps.txManager.runInTransaction(async (tx) => {
        const existing = await this.deps.repo.getGatepassForCancel(gatepassId, tx);
        if (!existing) {
          throw new GatepassCancelRejectedError("NOT_FOUND", "This Gatepass could not be found.");
        }
        const code = formatGatepassCode(existing.gatepassNumber);
        if (existing.status === "CANCELLED") {
          throw new GatepassCancelRejectedError("ALREADY_CANCELLED", `${code} has already been cancelled.`);
        }
        if (existing.madeBeforeGoLive === true) {
          throw new GatepassCancelRejectedError(
            "BEFORE_GO_LIVE",
            `${code} was made before Carton Cloud went live on this computer. It is test data, and cancelling it would put test cartons into the live stock. Nothing was changed.`
          );
        }

        // Cancelling is for a document nothing has happened to yet.
        //
        // Once cartons have been scanned out of the store they are standing at the gate: the
        // paperwork can be torn up but the goods cannot be un-moved, and cancelling here would
        // leave the store's record saying they left for a document that says it never existed.
        // Putting them back is a controlled reversal, which this system does not have yet.
        const alreadyMoved = existing.lines.reduce((sum, line) => sum + line.dispatchedFromStoreQuantity, 0);
        if (alreadyMoved > 0) {
          throw new GatepassCancelRejectedError(
            "ALREADY_MOVED",
            `${code} cannot be cancelled: ${alreadyMoved} carton(s) have already left the store for it. Bring them back into the store first.`
          );
        }

        // A billed document is unwound from the billing side, so that the bill and the
        // document can never disagree about whether this dispatch was priced.
        if (existing.status !== "CREATED") {
          const bill = await this.deps.repo.getLinkedSaleVoucher(gatepassId, tx);
          throw new GatepassCancelRejectedError(
            "BILLED",
            bill
              ? `${code} has been billed. Delete Sale Voucher #${bill.voucherNumber} first — that is what releases the Gatepass.`
              : `${code} has moved past billing and can no longer be cancelled here.`
          );
        }
        const changed = await this.deps.repo.markGatepassCancelled({ gatepassId, cancelledAt: tx.nowIso, cancelledBy: actor, reason }, tx);
        if (!changed) {
          throw new GatepassCancelRejectedError("ALREADY_CANCELLED", `${code} has already been cancelled.`);
        }
        // Only after the guarded status move: a second cancel never gets here, so nothing is put back twice.
        const returnedToStock = await this.deps.repo.returnGatepassCartons(gatepassId, actor, tx);
        // The bill made with it was never entered (entering one moves the gatepass past CREATED), so no money goes.
        await this.deps.repo.cancelUnenteredBill({ gatepassId, reason, cancelledAt: tx.nowIso }, tx);

        // Read under the same lock as the status change, so the audit row states exactly
        // what this cancellation released, what went back to stock, and what had already
        // physically left the store. What went back is what the repository put back.
        const release = { ...summariseRelease(existing.lines), returnedToStockQuantity: returnedToStock };
        await this.deps.repo.appendAuditLog(
          {
            id: this.deps.idGenerator.nextId(),
            eventType: "GATEPASS_CANCELLED",
            entityType: "GATEPASS",
            entityId: gatepassId,
            actorUserId: input.actorUserId ?? null,
            actorDeviceId: input.deviceId ?? null,
            occurredAt: tx.nowIso,
            payload: { code, gatepassNumber: existing.gatepassNumber, actor, reason, ...release },
          },
          tx
        );

        await this.deps.repo.notifyBilling(await this.billingNotice(gatepassId, code, actor, reason, tx), tx);
        return {
          code,
          cancelledAt: tx.nowIso,
          releasedQuantity: release.releasedQuantity,
          returnedToStockQuantity: release.returnedToStockQuantity,
          dispatchedFromStoreQuantity: release.dispatchedFromStoreQuantity,
        };
      });

      return { accepted: true, outcome: "CANCELLED", gatepassId, ...committed };
    } catch (error) {
      if (error instanceof GatepassCancelRejectedError) {
        return { accepted: false, outcome: error.outcome, reason: error.message, gatepassId };
      }
      throw error;
    }
  }

  /**
   * A bill made from this gatepass is now wrong: the billing desk must delete it. When no
   * bill exists yet, they are still told so the notice to make one is not acted on.
   */
  private async billingNotice(gatepassId: string, code: string, actor: string, reason: string, tx: TransactionContext): Promise<BillingNoticePayload> {
    const bill = await this.deps.repo.getLinkedSaleVoucher(gatepassId, tx);
    if (bill) {
      return {
        kind: "GATEPASS_CANCELLED",
        severity: "CRITICAL",
        entityId: gatepassId,
        title: `Gatepass ${code} cancelled — delete Sale Voucher #${bill.voucherNumber}`,
        message: `Cancelled by ${actor}: ${reason}. The bill made from it must be deleted.`,
      };
    }
    return {
      kind: "GATEPASS_CANCELLED",
      severity: "WARNING",
      entityId: gatepassId,
      title: `Gatepass ${code} cancelled`,
      message: `Cancelled by ${actor}: ${reason}. Do not make a sale voucher for it.`,
    };
  }
}
