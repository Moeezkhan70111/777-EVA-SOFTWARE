// Public record shapes and constants of the data layer. Re-exported by sqliteDatabase.ts so
// \@erp/data\ keeps the same exports; feature modules import from here to avoid cycles.

import type { GatepassStatus } from "@erp/application";
import type { DiscountSource, PriceType } from "@erp/domain";

export interface SqliteDatabaseOptions {
  dbPath: string;
  schemaPath?: string;
  /**
   * Folder holding the versioned `*.up.sql` migrations. Defaults to the repository layout
   * (beside the schema), which is what the tests use; the desktop app passes it explicitly so
   * a packaged installation reads both resources from its own `resources` folder.
   */
  migrationsDir?: string;
}

export interface PartyBalanceLimitFigures {
  currentBalance: number;
  voucherAmount: number;
  projectedBalance: number;
  limit: number;
  available: number;
  exceeded: number;
}

export interface DiscountExceedsAllowedFigures {
  requestedDiscount: number;
  allowedMaximum: number;
  exceededBy: number;
}

/**
 * Thrown by addVoucherLineItem/updateVoucherLineItem when a caller-supplied discount exceeds
 * resolveDiscount()'s resolved maximum for the line. Never clamped — the write is refused
 * outright. The figures are exposed both as `figures` and as direct properties (the established
 * contract — see PartyBalanceLimitExceededError).
 */
export class DiscountExceedsAllowedError extends Error implements DiscountExceedsAllowedFigures {
  readonly code = "DISCOUNT_EXCEEDS_ALLOWED" as const;
  readonly figures: DiscountExceedsAllowedFigures;
  readonly requestedDiscount: number;
  readonly allowedMaximum: number;
  readonly exceededBy: number;

  constructor(figures: DiscountExceedsAllowedFigures) {
    super(
      `DISCOUNT_EXCEEDS_ALLOWED: Requested Discount: Rs. ${figures.requestedDiscount.toFixed(0)} | ` +
        `Allowed Maximum: Rs. ${figures.allowedMaximum.toFixed(0)} | ` +
        `Exceeded by: Rs. ${figures.exceededBy.toFixed(0)}`
    );
    this.name = "DiscountExceedsAllowedError";
    this.figures = figures;
    this.requestedDiscount = figures.requestedDiscount;
    this.allowedMaximum = figures.allowedMaximum;
    this.exceededBy = figures.exceededBy;
  }
}

/**
 * Thrown by createSaleVoucher when the gatepass it is being made from cannot be billed:
 * it does not exist, it was cancelled, or a live sale voucher was already made from it.
 * The partial unique index on sale_vouchers(gatepass_id) is the backstop for the last case.
 */
export type GatepassBillingRefusal = "GATEPASS_NOT_FOUND" | "GATEPASS_CANCELLED" | "GATEPASS_ALREADY_BILLED";

export class GatepassBillingError extends Error {
  readonly code: GatepassBillingRefusal;
  /** The live voucher already made from the gatepass, for GATEPASS_ALREADY_BILLED. */
  readonly existingVoucherId: string | null;
  readonly existingVoucherNumber: string | null;

  constructor(code: GatepassBillingRefusal, message: string, existing: { id: string; voucherNumber: string } | null = null) {
    super(message);
    this.name = "GatepassBillingError";
    this.code = code;
    this.existingVoucherId = existing?.id ?? null;
    this.existingVoucherNumber = existing?.voucherNumber ?? null;
  }
}

/**
 * Thrown when a bill made from a gatepass would stop saying what the gatepass says.
 *
 * A gatepass is the document the goods physically left on; the bill prices that same
 * dispatch. So WHAT went out — the articles, the sizes and the quantities — belongs to the
 * gatepass and is not the billing desk's to change. What the goods are WORTH — the rate, the
 * price type and the discount — is not on the gatepass at all, and stays theirs.
 *
 * If a bill genuinely needs different quantities, the gatepass was wrong: cancel it and make
 * the right one. That keeps the paper and the system telling the same story.
 */
export type BillGatepassMismatch =
  /** An article + size the gatepass does not carry. */
  | "LINE_NOT_ON_GATEPASS"
  /** The right article + size, but not the quantity that went out. */
  | "QUANTITY_DIFFERS"
  /** The same article + size billed twice; the gatepass folds colours into one line. */
  | "LINE_ALREADY_ON_BILL"
  /** Removing a line the gatepass carries would leave the dispatch part-billed. */
  | "LINE_MAY_NOT_BE_REMOVED";

export class BillDoesNotMatchGatepassError extends Error {
  readonly code = "BILL_DOES_NOT_MATCH_GATEPASS" as const;
  readonly mismatch: BillGatepassMismatch;
  readonly gatepassCode: string;
  /** "SK6 7/10" — the line at fault, as the desk reads it. */
  readonly line: string;
  /** Dozens the gatepass says, and dozens the bill was trying to say. Null where not applicable. */
  readonly expectedDozens: number | null;
  readonly billedDozens: number | null;

  constructor(input: {
    mismatch: BillGatepassMismatch;
    gatepassCode: string;
    line: string;
    expectedDozens?: number | null;
    billedDozens?: number | null;
    message: string;
  }) {
    super(input.message);
    this.name = "BillDoesNotMatchGatepassError";
    this.mismatch = input.mismatch;
    this.gatepassCode = input.gatepassCode;
    this.line = input.line;
    this.expectedDozens = input.expectedDozens ?? null;
    this.billedDozens = input.billedDozens ?? null;
  }
}

/**
 * Thrown by createSaleVoucher when the projected balance would exceed the party's limit.
 * The figures are exposed both as `figures` and as direct properties (the established contract).
 */
export class PartyBalanceLimitExceededError extends Error implements PartyBalanceLimitFigures {
  readonly code = "PARTY_BALANCE_LIMIT_EXCEEDED" as const;
  readonly figures: PartyBalanceLimitFigures;
  readonly currentBalance: number;
  readonly voucherAmount: number;
  readonly projectedBalance: number;
  readonly limit: number;
  readonly available: number;
  readonly exceeded: number;

  constructor(figures: PartyBalanceLimitFigures) {
    super(
      `PARTY_BALANCE_LIMIT_EXCEEDED: Current Balance: Rs. ${figures.currentBalance.toFixed(0)} | ` +
        `Voucher Amount: Rs. ${figures.voucherAmount.toFixed(0)} | ` +
        `Projected Balance: Rs. ${figures.projectedBalance.toFixed(0)} | ` +
        `Allowed Limit: Rs. ${figures.limit.toFixed(0)} | ` +
        `Available Credit: Rs. ${figures.available.toFixed(0)} | ` +
        `Exceeded by: Rs. ${figures.exceeded.toFixed(0)}`
    );
    this.name = "PartyBalanceLimitExceededError";
    this.figures = figures;
    this.currentBalance = figures.currentBalance;
    this.voucherAmount = figures.voucherAmount;
    this.projectedBalance = figures.projectedBalance;
    this.limit = figures.limit;
    this.available = figures.available;
    this.exceeded = figures.exceeded;
  }
}

export interface RecentScan {
  qrId: string;
  article: string;
  color: string;
  size: string;
  serial: string;
  occurredAt: string;
}

export interface BreakdownRow {
  key: string;
  quantity: number;
}

export interface DashboardSnapshot {
  todaysProduction: number;
  todaysDispatched: number;
  currentStockTotal: number;
  inventoryValue: number;
  syncQueuePending: number;
  productionCounter: number;
  recentScans: RecentScan[];
  byHour: BreakdownRow[];
  byProduct: BreakdownRow[];
  byColor: BreakdownRow[];
  bySize: BreakdownRow[];
}


export interface ProductVariantRecord {
  id: string;
  articleSizeId?: string | null;
  productCode?: string | null;
  article: string;
  color: string;
  size: string;
  colors?: string[];
  description: string | null;
  costPrice: number | null;
  sellingPrice: number | null;
  /**
   * The product's STANDARD contractor rates, per DOZEN, in integer paisa (migration 064) — what
   * machine, packing and printing work on it is normally paid. A machine program defaults from
   * these and then owns its own copy, the way a sale voucher owns the rate it was billed at.
   *
   * Null is NOT SET and is never read as 0: an unpriced product is reported as unpriced, while a
   * stored 0 means that job is not paid for this article.
   */
  machineRatePaisa?: number | null;
  packingRatePaisa?: number | null;
  printingRatePaisa?: number | null;
  /** What the packing rate is made of, in paisa (migration 072). Empty when it was typed as one figure. */
  packingRateItems?: Array<{ name: string; ratePaisa: number }>;
  mainGroupId: string | null;
  groupId: string | null;
  articleSeriesId: string | null;
  /** Added 2026-10-11 (migration 066). Null on every product saved before it. */
  productTypeId: string | null;
  productSubGroupId: string | null;
  articleSeriesName?: string | null;
  mainGroupName: string | null;
  groupName: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductListQuery {
  search?: string;
  status?: "ACTIVE" | "DISABLED" | "ALL";
  page?: number;
  pageSize?: number;
}

export interface PagedResult<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PartyRecord {
  id: string;
  partyCode: string;
  partyName: string;
  partyNameUrdu: string;
  partyType: string;
  contactPerson: string | null;
  mobileNumber: string | null;
  whatsAppNumber: string | null;
  phoneNumber: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  partyGroupId: string | null;
  remarks: string | null;
  status: string;
  balanceLimit: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PartyListRow {
  id: string;
  partyCode: string;
  partyName: string;
  partyNameUrdu: string;
  partyType: string;
  city: string | null;
  partyGroupId: string | null;
  groupName: string | null;
  mobileNumber: string | null;
  status: string;
  balanceLimit: number | null;
  createdAt: string;
}

export interface SaleVoucherLineRecord {
  id: string;
  productVariantId: string;
  /** Dozens. */
  quantity: number;
  /** The rate the line was billed at: the article's NORMAL price or the B-TYPE derived from it. */
  priceType: PriceType;
  /** Per pair. */
  unitPrice: number;
  /** Total discount for the line. */
  discount: number;
  /** Per pair, what the party's discount rule gave when the line was saved (0 for NONE or B-TYPE). */
  discountPerPair: number;
  /** The rule that set the line's discount ceiling when it was saved. */
  discountSource: DiscountSource;
  totalPrice: number;
  article: string;
  color: string;
  size: string;
  groupName: string | null;
}

export interface SaleVoucherRecord {
  id: string;
  voucherNumber: string;
  partyId: string;
  partyName: string;
  /** The party's name in Urdu, when it has one — the paper bill carries both. */
  partyNameUrdu: string | null;
  partyMobile: string;
  partyEmail: string;
  voucherDate: string;
  bookNo: string;
  subPartyName: string | null;
  subPartyNameUrdu: string | null;
  subPartyNumber: string | null;
  remarks: string | null;
  totalQuantity: number;
  totalAmount: number;
  status: string;
  /** The gatepass this bill was made from, when it was; its current status tells if the bill is still right. */
  gatepassId: string | null;
  gatepassCode: string | null;
  gatepassStatus: GatepassStatus | null;
  lineItems: SaleVoucherLineRecord[];
  createdAt: string;
  updatedAt: string;
}

/**
 * One voucher line as the dispatch scanner sees it. Cartons are the enforced unit (one
 * scan = one carton); the pair figures are derived with @erp/domain units.ts.
 */
export interface DispatchLineProgress {
  lineItemId: string;
  productVariantId: string;
  article: string;
  color: string;
  size: string;
  /** Dozens on the voucher line. */
  requiredDzn: number;
  /** Cartons the bill allows for this article/size (dozens × 2). */
  requiredCartons: number;
  /** Cartons scanned so far (one DISPATCHED event each). */
  dispatchedCartons: number;
  /** Pairs on the voucher line (dozens × 12). */
  requiredPairs: number;
  /** Pairs scanned so far (cartons × 6). */
  dispatchedPairs: number;
}

export interface DispatchSessionDetail {
  sessionId: string;
  voucherId: string;
  voucherNumber: string;
  partyName: string;
  voucherDate: string;
  status: string;
  allowedItems: DispatchLineProgress[];
}

export interface DispatchSessionSummary {
  sessionId: string;
  voucherId: string;
  voucherNumber: string;
  partyName: string;
  voucherDate: string;
  totalQuantity: number;
  totalAmount: number;
  status: string;
  startedAt: string | null;
  remainingCartons: number;
  remainingPairs: number;
}

export interface DispatchAllowance {
  allowed: boolean;
  lineItemId: string | null;
  article: string;
  color: string;
  size: string;
  requiredCartons: number;
  dispatchedCartons: number;
  requiredPairs: number;
  dispatchedPairs: number;
}

/**
 * Outcome of cancelling a sale voucher. `ambiguousDispatchEventIds` lists DISPATCHED events
 * that pre-date exact voucher/session attribution and merely look (by article + size) like
 * they might belong to this voucher — they are never auto-reversed and must be reconciled by
 * hand; the voucher itself is still cancelled either way.
 */
export interface DeleteSaleVoucherResult {
  cancelled: boolean;
  reversedEventCount: number;
  ambiguousDispatchEventIds: string[];
  /** Carton-return credits cancelled with the bill, so no credit outlives its own sale. */
  cancelledReturnCount: number;
}

export interface SaleVoucherListRow {
  id: string;
  voucherNumber: string;
  partyName: string;
  voucherDate: string;
  bookNo: string;
  subPartyName: string | null;
  totalQuantity: number;
  totalAmount: number;
  status: string;
  createdAt: string;
}

export interface InventoryRow {
  productId: string;
  articleSizeId?: string | null;
  article: string;
  color: string;
  size: string;
  /** Current Stock: cartons In Store right now — Store Move In adds one, Store Move Out removes one. */
  quantity: number;
  /** Units still at the factory (PRODUCED / RETURNED), from stock_projection_by_location. */
  productionQuantity: number;
  /** Units received into the store by Store Scanning (WAREHOUSE location) — the same figure as `quantity`. */
  storeQuantity: number;
  /** Units moved out of the store to the gate by Store Move Out (GATE location), ready to dispatch. */
  gateQuantity: number;
  costPrice: number;
  sellingPrice: number;
  stockValue: number;
  potentialRevenue: number;
  profitPotential: number;
}

// ─── Store Scanning ──────────────────────────────────────────────────────────────

/** One receiving session on one Store Scanning terminal (operational grouping only). */
export interface StoreReceivingSession {
  id: string;
  /** Display code, e.g. SR-000184. */
  code: string;
  sessionNumber: number;
  deviceId: string;
  startedBy: string | null;
  status: "OPEN" | "CLOSED";
  startedAt: string;
  closedAt: string | null;
}

/** One carton received during a session, straight from its STORE_ENTRY event. */
export interface StoreReceivedRow {
  eventId: string;
  qrId: string;
  article: string;
  color: string;
  size: string;
  serial: string;
  receivedAt: string;
  actor: string | null;
}

export interface StoreReceivingSessionSummary {
  session: StoreReceivingSession;
  receivedCount: number;
  /** Per article · colour · size tallies, largest first. */
  byProduct: Array<{ article: string; color: string; size: string; count: number }>;
  /** Most recent receipts first, capped by the caller's limit. */
  recent: StoreReceivedRow[];
  lastReceived: StoreReceivedRow | null;
}

// ─── Store Move Out ──────────────────────────────────────────────────────────────
// The mirror of the receiving session: one per open Store Move Out terminal, summarised
// from the MOVED / STORE_EXIT events that carry its id.

/** One move-out session on one Store Move Out terminal (operational grouping only). */
export interface StoreMoveOutSession {
  id: string;
  /** Display code, e.g. SO-000042. */
  code: string;
  sessionNumber: number;
  deviceId: string;
  startedBy: string | null;
  status: "OPEN" | "CLOSED";
  startedAt: string;
  closedAt: string | null;
}

/** One carton moved out during a session, straight from its STORE_EXIT event. */
export interface StoreMovedOutRow {
  eventId: string;
  qrId: string;
  article: string;
  color: string;
  size: string;
  serial: string;
  movedOutAt: string;
  actor: string | null;
}

export interface StoreMoveOutSessionSummary {
  session: StoreMoveOutSession;
  movedOutCount: number;
  /** Per article · colour · size tallies, largest first. */
  byProduct: Array<{ article: string; color: string; size: string; count: number }>;
  /** Most recent move-outs first, capped by the caller's limit. */
  recent: StoreMovedOutRow[];
  lastMovedOut: StoreMovedOutRow | null;
}

// ─── Gatepass ────────────────────────────────────────────────────────────────────
// An operational document — party + article/colour/size quantities reserved from store
// stock. Reads the same location projection Store Move Out maintains; never writes to it.
// Reserved / Reflected / dispatched figures are derived from production_events.gatepass_id
// every time (see database/gatepass.ts), never stored.

/** One colour + size of an article with its live store figures (cartons). */
export interface GatepassStockRow {
  productVariantId: string;
  article: string;
  color: string;
  size: string;
  /** Product group of the article + size (from article_sizes, which owns it); null when unset. */
  groupName: string | null;
  /** Current Stock: stock_projection_by_location at WAREHOUSE — physically in the store. */
  storeQuantity: number;
  /** Reserved: cartons still owed to outstanding gatepasses. */
  reservedQuantity: number;
  /** Reflected Stock: storeQuantity − reservedQuantity — what a new gatepass may take. */
  reflectedQuantity: number;
}

export interface GatepassLineRecord {
  id: string;
  lineNo: number;
  productVariantId: string;
  article: string;
  color: string;
  size: string;
  /** Product group of the article + size; null when unset. Read live, for display only. */
  groupName: string | null;
  quantity: number;
  storeQuantityAtCreation: number;
  /** Cartons Store Move Out has actually taken for this line (its STORE_EXIT events, less bring-backs). */
  dispatchedFromStoreQuantity: number;
  /** quantity − dispatchedFromStoreQuantity: still reserved, still owed. */
  outstandingQuantity: number;
}

/** A notice in the shell's bell. Typed ones (kind + entityId) open a screen; severity says how loudly. */
export interface UserNotificationRecord {
  id: string;
  title: string;
  message: string;
  createdAt: string;
  readAt: string | null;
  kind: string | null;
  entityId: string | null;
  severity: "INFO" | "WARNING" | "CRITICAL";
}

export interface GatepassRecord {
  id: string;
  /** Display code, e.g. GP-000123. */
  code: string;
  gatepassNumber: number;
  partyId: string;
  partyName: string;
  partyCode: string;
  partyCity: string | null;
  gatepassDate: string;
  status: GatepassStatus;
  /** Transporter's receipt number (بلٹی نمبر), when known at creation. */
  biltyNumber: string | null;
  /** Carrier / vehicle (بزریعہ), when known at creation. */
  transportVia: string | null;
  remarks: string | null;
  totalQuantity: number;
  /** Across every line: cartons Store Move Out has actually taken for this document. */
  dispatchedFromStoreQuantity: number;
  /** totalQuantity − dispatchedFromStoreQuantity: still reserved. 0 once fully moved out. */
  outstandingQuantity: number;
  lineCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  lines: GatepassLineRecord[];
}

export interface GatepassListRow {
  id: string;
  code: string;
  gatepassNumber: number;
  partyId: string;
  partyName: string;
  gatepassDate: string;
  status: GatepassStatus;
  totalQuantity: number;
  dispatchedFromStoreQuantity: number;
  outstandingQuantity: number;
  lineCount: number;
  /** Distinct articles on the document, alphabetical, for the list column. */
  articles: string[];
  createdBy: string | null;
  createdAt: string;
}

/**
 * One already-generated raw material packet label, for reprinting it exactly as printed.
 * The figures are the labels own, not the materials current ones.
 */
export interface RawMaterialQrLabel {
  qrId: string;
  displayName: string;
  partyName: string;
  categoryLine: string;
  subCategoryLine: string;
  /** What this packet holds, as stamped on the label when it was generated. */
  packingQuantity: number | null;
  /** The materials attribute values, in the shape listInventoryItems returns. */
  values: Array<Record<string, unknown>>;
}

/** The delivery/builty proof currently standing for a gatepass. */
export interface GatepassDeliveryProof {
  id: string;
  gatepassId: string;
  /** The name inside the application proof store — never a user-supplied path. */
  fileName: string;
  mimeType: string;
  byteSize: number;
  /** What the operator called the file, for display only. */
  originalName: string | null;
  uploadedBy: string | null;
  uploadedAt: string;
}

/** One line of a gatepass as both scanning desks see it. Counts are cartons, the stored unit. */
export interface GatepassScanLine {
  productVariantId: string;
  article: string;
  color: string;
  size: string;
  requiredCartons: number;
  storeScannedCartons: number;
  storeRemainingCartons: number;
  dispatchedCartons: number;
  dispatchRemainingCartons: number;
}

/** What a gatepass still needs at the store and at the gate, per line and in total. */
export interface GatepassScanProgress {
  gatepassId: string;
  code: string;
  status: GatepassStatus;
  partyName: string;
  /** The live bill this gatepass was billed on, which dispatch is attributed to. */
  voucherNumber: string | null;
  dispatchSessionId: string | null;
  lines: GatepassScanLine[];
  requiredCartons: number;
  storeScannedCartons: number;
  storeRemainingCartons: number;
  dispatchedCartons: number;
  dispatchRemainingCartons: number;
}

/** One step of the Gatepass journey, with the moment it was actually reached. */
export interface GatepassJourneyStep {
  status: string;
  label: string;
  /** DONE = already passed, CURRENT = where it stands, PENDING = still to come. */
  state: "DONE" | "CURRENT" | "PENDING";
  /** When this step was reached, or null when it has not been. Never guessed. */
  at: string | null;
  actor: string | null;
}

export interface GatepassListQuery {
  /** Matches the code / number or the party name. */
  search?: string;
  partyId?: string;
  article?: string;
  /** Local calendar days, YYYY-MM-DD, both inclusive. */
  fromDate?: string;
  toDate?: string;
  status?: GatepassStatus | "ALL";
  page?: number;
  pageSize?: number;
}

/** Which store station a session table belongs to; both tables share one shape. */
export interface SaleableVariant {
  id: string;
  articleSizeId: string | null;
  article: string;
  size: string;
  color: string;
  sellingPrice: number | null;
  /** Current Stock: cartons In Store right now (Store Move In / Store Move Out). */
  stockQuantity: number;
  articleSeriesId: string | null;
  productGroupId: string | null;
}

export interface QrBatchRecord {
  id: string;
  articleSizeId: string | null;
  article: string;
  color: string;
  size: string;
  startSequence: number;
  endSequence: number;
  quantity: number;
  createdAt: string;
  /** The logged-in operator who ran the generator. */
  createdBy: string | null;
  /** Whoever asked for the run, as typed by the operator (optional). */
  requestedBy: string | null;
}

export interface QrCodeRecord {
  id: string;
  batchId: string;
  article: string;
  color: string;
  size: string;
  sequence: number;
  status: string;
  createdAt: string;
  productVariantId?: string | null;
}

/** Upper bound for a single generation request — one realistic label print run. */
export const MAX_QR_BATCH_QUANTITY = 10000;

export interface RawMaterialQrBatchRecord {
  id: string;
  partyId: string;
  partyCode: string;
  partyName: string;
  itemId: string;
  itemCode: string;
  itemDisplayName: string;
  startSequence: number;
  endSequence: number;
  quantity: number;
  /** How much one packet in this run holds (the snapshot printed on every label). Null when no packing was set. */
  packingQuantity: number | null;
  createdAt: string;
  /** The logged-in operator who ran the generator. */
  createdBy: string | null;
  /** Whoever asked for the run, as typed by the operator (optional). */
  requestedBy: string | null;
}

export interface RawMaterialQrRecord {
  id: string;
  batchId: string;
  partyId: string;
  itemId: string;
  sequence: number;
  status: string;
  createdAt: string;
}

/** Upper bound for a single raw material QR generation request. */
export const MAX_RAW_MATERIAL_QR_BATCH_QUANTITY = 10000;

/**
 * Where a QR stands in its life. `REGISTERED` = generated but never scanned into
 * production; `VOID` = registered code withdrawn before production; everything else is
 * the live `qr_master.current_status`.
 */
export type QrStage =
  | "REGISTERED"
  | "VOID"
  | "PRODUCED"
  | "WAREHOUSE"
  /** Raw material only: the packet has been issued out of the store to a section. */
  | "ISSUED"
  | "TO_GATE"
  | "DISPATCHED"
  | "SOLD"
  | "RETURNED"
  | "DAMAGED"
  | "SCRAPPED";

export interface QrSearchRow {
  qrId: string;
  article: string;
  color: string;
  size: string;
  sequence: number;
  batchId: string;
  registeredAt: string;
  stage: QrStage;
  lastActivityAt: string;
}

export interface QrEventRow {
  id: string;
  eventType: string;
  /**
   * Finer-grained kind carried in metadata_json when one event_type covers several
   * business events — e.g. a MOVED event written by Store Scanning is "STORE_ENTRY".
   */
  subType: string | null;
  occurredAt: string;
  factory: string | null;
  workstation: string | null;
  operator: string | null;
  deviceId: string;
  note: string | null;
  syncStatus: string;
}

export interface QrDetail {
  qrId: string;
  /** Which registry this code belongs to. Raw material codes have no variant or article. */
  kind?: "CARTON" | "RAW_MATERIAL";
  /** Raw material only: the supplier the packet was received from, and where it is now. */
  supplierName?: string | null;
  sectionName?: string | null;
  /** The stage in words when it names a place the status does not, e.g. "Issued to PACKING". */
  stageLabel?: string | null;

  article: string;
  color: string;
  size: string;
  serial: string;
  stage: QrStage;
  productVariantId: string | null;
  sellingPrice: number | null;
  stockOnHand: number | null;
  registry: {
    status: string;
    registeredAt: string;
    voidReason: string | null;
    voidedAt: string | null;
    voidedBy: string | null;
  } | null;
  batch: {
    id: string;
    startSequence: number;
    endSequence: number;
    quantity: number;
    createdAt: string;
    createdBy: string | null;
    requestedBy: string | null;
    producedCount: number;
    voidCount: number;
  } | null;
  lifecycle: {
    currentStatus: string;
    locationType: string;
    locationId: string | null;
    firstScannedAt: string;
    updatedAt: string;
  } | null;
  events: QrEventRow[];
}

/** Per-stage tallies; a stage with no codes is simply absent. */
export type QrStageCounts = Partial<Record<QrStage, number>>;

// ─── QR Journey ──────────────────────────────────────────────────────────────────
// The whole path one code has taken, as an ordered list of hops. Every hop is derived from
// facts already recorded — the registry row and the append-only event log — never from a
// separately maintained history.

/** One kind of hop. Registry steps come from `qr_codes`; the rest from `production_events`. */
export type QrJourneyStepKind =
  | "REGISTERED"
  | "VOID"
  | "PRODUCED"
  | "STORE_ENTRY"
  | "STORE_EXIT"
  | "DISPATCHED"
  | "RETURNED"
  | "DAMAGED"
  | "SOLD"
  | "MOVED"
  | "PACKED"
  | "ADJUSTMENT";

/** Where a unit physically is after a hop; null while it is only a registered code. */
export type QrPlace = "FACTORY" | "WAREHOUSE" | "GATE" | "CUSTOMER";

export interface QrJourneyStep {
  /** Position on the path, 1-based. */
  index: number;
  /** Event id, or a synthetic id for registry-derived steps. */
  id: string;
  kind: QrJourneyStepKind;
  /** production_events.event_type for event-backed steps; null for registry steps. */
  eventType: string | null;
  occurredAt: string;
  /** Status before this hop (null on the first). */
  fromStatus: string | null;
  /** Status after this hop. Registry steps use REGISTERED / VOID. */
  toStatus: string;
  fromPlace: QrPlace | null;
  toPlace: QrPlace | null;
  /**
   * The destination in words when the status alone does not say enough — a packet is not
   * just "Issued", it is issued to PACKING. Null for a carton, whose statuses are complete
   * on their own.
   */
  toStatusLabel?: string | null;

  /** Who did it — the logged-in user carried on the event, else the operator record. */
  actor: string | null;
  deviceId: string | null;
  workstation: string | null;
  factory: string | null;
  /** Free text carried on the event (a damage or void reason). */
  note: string | null;
  syncStatus: string | null;
  /** Milliseconds since the previous hop; null on the first. */
  sinceMs: number | null;
}

export interface QrJourney {
  qrId: string;
  kind?: "CARTON" | "RAW_MATERIAL";
  /** The stage in words when it names a place the status does not, e.g. "Issued to PACKING". */
  stageLabel?: string | null;

  supplierName?: string | null;
  article: string;
  color: string;
  size: string;
  serial: string;
  stage: QrStage;
  currentStatus: string | null;
  currentPlace: QrPlace | null;
  registeredAt: string | null;
  batchId: string | null;
  firstScannedAt: string | null;
  lastActivityAt: string | null;
  steps: QrJourneyStep[];
  /** How many hops of each kind the path contains. */
  counts: Partial<Record<QrJourneyStepKind, number>>;
  /** Total time spent in each status (ms); the current status is counted up to `asOf`. */
  dwellMs: Record<string, number>;
  asOf: string;
}

/**
 * Filter for the QR Management overview. `fromDate`/`toDate` are local calendar days
 * (YYYY-MM-DD, both inclusive) on the machine running the app — the same convention the
 * dashboard uses — and are compared against the generation timestamp only.
 */
export interface QrGenerationFilter {
  fromDate?: string;
  toDate?: string;
  article?: string;
  color?: string;
  size?: string;
  page?: number;
  pageSize?: number;
  /**
   * Whether to compute the headline tallies over every code in the filter (default true).
   * Paging through the same filter can pass false and keep the tallies it already has —
   * they are the one part of the query whose cost grows with the number of codes.
   */
  includeSummary?: boolean;
}

/**
 * One generation run of the QR Generator: a contiguous serial range for one
 * article + colour + size, registered at one instant. Never merged across runs, so the
 * real generation history is preserved even when the same combination is generated twice.
 */
export interface QrGenerationGroup {
  batchId: string;
  article: string;
  color: string;
  size: string;
  startSequence: number;
  endSequence: number;
  quantity: number;
  firstQrId: string;
  lastQrId: string;
  generatedAt: string;
  generatedBy: string | null;
  requestedBy: string | null;
  stageCounts: QrStageCounts;
}

export interface QrGenerationOverview {
  groups: QrGenerationGroup[];
  /** Generation runs matching the filter (for paging the grouped table). */
  total: number;
  page: number;
  pageSize: number;
  /** Individual codes matching the filter, across every page; null when not requested. */
  totalQrCount: number | null;
  /** Per-stage tallies over every code in the filter; null when not requested. */
  stageCounts: QrStageCounts | null;
}

export interface QrGenerationFilterOptions {
  articles: string[];
  colors: string[];
  sizes: string[];
}

export interface QrBatchMemberRow {
  qrId: string;
  sequence: number;
  stage: QrStage;
  lastActivityAt: string;
}

/** One entry of the flat Product Type list. */
export interface ProductTypeRecord {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

/** One sub group, and the product group it belongs to. */
export interface ProductSubGroupRecord {
  id: string;
  productGroupId: string;
  /** Carried so a list of ALL sub groups can say which group each one is under. */
  productGroupName: string;
  name: string;
  description: string | null;
  isActive: boolean;
  /**
   * FIX articles: these products have NO UPPER and are moulded from two soles, an outer and
   * an inner (migration 067). A machine program for one asks for the second colour and a
   * quantity instead of uppers.
   */
  hasNoUpper: boolean;
}

/** The dropdown lists offered on the Add / Edit Product page. */
export type ProductListKind =
  | "article"
  | "size"
  | "main-group"
  | "product-group"
  | "article-series"
  | "product-type"
  | "product-sub-group";

export interface ProductListEntry {
  kind: ProductListKind;
  /** Group / series id; for articles and sizes, the value itself. */
  id: string;
  name: string;
  /** The product group a sub group belongs to. Null for every other kind. */
  parentName?: string | null;
  /** Active Product Master entries using this value (what the dropdown shows). */
  productCount: number;
  /** Disabled entries still carrying it — kept for history, not offered in dropdowns. */
  disabledProductCount: number;
  /** Registered QR codes whose identity embeds this value (articles / sizes only). */
  qrCount: number;
  /** Party discount rules pointing at it (product groups / article series only). */
  discountRuleCount: number;
  renameBlockedReason: string | null;
  deleteBlockedReason: string | null;
}

export interface HistoryQuery {
  search?: string;
  fromDate?: string;
  toDate?: string;
  page?: number;
  pageSize?: number;
  sortBy?: "event_ts_local" | "article_snapshot" | "color_snapshot" | "size_snapshot";
  sortOrder?: "ASC" | "DESC";
}

export interface HistoryRow {
  qrId: string;
  article: string;
  color: string;
  size: string;
  timestamp: string;
  operator: string | null;
  device: string;
  factory: string;
  status: string;
}

export interface ReportSummary {
  totalProduction: number;
  inventoryValue: number;
  byArticle: BreakdownRow[];
  byColor: BreakdownRow[];
  bySize: BreakdownRow[];
  byHour: BreakdownRow[];
  topProducts: BreakdownRow[];
}

export interface BackupRecord {
  id: string;
  backupType: string;
  backupPath: string;
  checksumSha256: string;
  sizeBytes: number;
  verified: boolean;
  verificationAt: string | null;
  status: string;
  createdAt: string;
}

export interface HealthSnapshot {
  sqliteStatus: string;
  databaseSizeBytes: number;
  pendingSyncQueue: number;
  failedSyncQueue: number;
  scannerConnected: boolean;
  diskFreeBytes: number;
  memoryUsageBytes: number;
  cpuLoadAverage: number;
  backupStatus: string;
  appVersion: string;
  deviceId: string;
  moneyDrift: MoneyDriftSummary;
}

/**
 * One row where a monetary REAL column and its `*_paisa` sibling disagree — see
 * SqliteDatabase.checkMoneyDrift (migrations/sqlite/029_money_paisa_columns). An empty
 * array from that method means every dual-written row is exactly in sync.
 */
export interface MoneyDriftViolation {
  table: string;
  column: string;
  id: string;
  /** The REAL rupee value as stored. */
  realValue: number | null;
  /** The INTEGER paisa value as stored. */
  paisaValue: number | null;
  /** What paisaValue should be, given realValue (null when realValue itself is null). */
  expectedPaisa: number | null;
}

/**
 * checkMoneyDrift() summarized for the Health page — the same data, reduced to what an
 * administrator needs at a glance (healthy/pairsChecked/violationCount) plus the full
 * violation list (empty when healthy) for identifying affected columns/values.
 */
export interface MoneyDriftSummary {
  healthy: boolean;
  pairsChecked: number;
  violationCount: number;
  violations: MoneyDriftViolation[];
}

/**
 * One recorded carton return, as the Return History screen and the ledger drill-down read
 * it. `awaitingStoreIn` is derived from the carton's live status, never stored: a return is
 * awaiting the store for exactly as long as the carton is still standing ON_GATE.
 */
export interface SaleReturnRecord {
  id: string;
  returnNumber: string;
  returnDate: string;
  recordedAt: string;
  recordedBy: string | null;
  qrId: string;
  article: string;
  color: string;
  size: string;
  partyId: string;
  partyName: string;
  saleVoucherId: string | null;
  saleVoucherNumber: string | null;
  /** Rate per pair the carton was billed at, in rupees. */
  unitPrice: number;
  /** Discount per pair the carton was billed at, in rupees. */
  discountPerPair: number;
  /** What the party was credited for this carton, in rupees. */
  creditAmount: number;
  currentStatus: string | null;
  awaitingStoreIn: boolean;
}

// ─── Raw material Store movement ─────────────────────────────────────────────────
// One printed raw-material QR is one PACKET. How much is in a packet, and where a packet
// goes when it leaves the store, are properties of the material (see
// migrations/sqlite/037_raw_material_packing_and_sections).

/** A place a packet can be issued to when it leaves the store: PACKING, UPPER MAKER, … */
export interface WorkSection {
  id: string;
  sectionCode: string;
  name: string;
  status: string;
}

/** One raw material's Store-movement configuration, for the settings screen. */
export interface RawMaterialMovementConfigRow {
  itemId: string;
  itemCode: string;
  displayName: string;
  /**
   * What one printed label goes on, in the store's own word: BAG, PACKET, ROLL, TIN.
   * null means it has not been named and the screens fall back to "Pack".
   */
  packName: string | null;
  /** How much one pack holds. null means this material cannot be moved through the store yet. */
  packingQuantity: number | null;
  /**
   * Labelled packets of this material standing in the store. Counted, not divided: each label
   * carries what its own packet holds, so two packets can hold different amounts.
   */
  packetsInStore: number;
  packingUnitId: string | null;
  packingUnitCode: string | null;
  /** The unit this material's stock is counted in — what a pack has to become to be added. */
  stockUnitId: string | null;
  stockUnitCode: string | null;
  /**
   * One pack, expressed in the unit stock is COUNTED in — the divisor that turns a balance
   * into a number of packs.
   *
   * Not always the same as `packingQuantity`: a pack of 2 DOZEN on a material stocked in
   * PIECE is 24 pieces, so dividing the balance by 2 would be wrong by a factor of twelve.
   * The conversion is done here because the conversion table lives here; screens divide, they
   * do not convert. Null when a pack could never reach the balance.
   */
  packSizeInStockUnit: number | null;
  /**
   * Whether a pack can actually reach the balance: same unit, or a conversion exists.
   *
   * False is the trap this catches — a material stocked in DOZEN whose packs are measured in
   * KILOGRAM looks configured on screen but every scan of it is REFUSED, because
   * applyRawMaterialStockChange will not add a quantity it cannot convert.
   */
  packingConvertsToStock: boolean;
  defaultSectionId: string | null;
  defaultSectionName: string | null;
  /** The route, in order. Empty means the material cannot be issued yet. */
  /** Always empty: raw material routes were removed on 2026-10-07. */
  hops: RawMaterialHop[];
}

/** The live packet behind a scanned raw-material label, with everything a movement needs. */
export interface RawMaterialMovementRecord {
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
  /** The label's own packing snapshot, falling back to the material's current setting. */
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

/** One supplier's delivery being received at one terminal. */
export interface RawMaterialReceivingSession {
  id: string;
  /** RMI-000042 */
  code: string;
  sessionNumber: number;
  partyId: string;
  partyName: string;
  deviceId: string;
  startedBy: string | null;
  status: "OPEN" | "CLOSED";
  startedAt: string;
  closedAt: string | null;
}

/** What a receiving session took in, for the screen and the printed receipt. */
export interface RawMaterialReceivingSessionSummary {
  session: RawMaterialReceivingSession;
  totalPackets: number;
  byMaterial: Array<{ itemDisplayName: string; packets: number; quantity: number; unitCode: string }>;
  scans: Array<{
    qrId: string;
    itemDisplayName: string;
    quantity: number;
    unitCode: string;
    receivedAt: string;
    actor: string | null;
  }>;
}

/** One terminal's run of issuing packets out of the store. */
export interface RawMaterialIssueSession {
  id: string;
  /** RMO-000042 */
  code: string;
  sessionNumber: number;
  deviceId: string;
  startedBy: string | null;
  status: "OPEN" | "CLOSED";
  startedAt: string;
  closedAt: string | null;
}

/** What an issue session sent out, grouped the way the printed slip is read. */
export interface RawMaterialIssueSessionSummary {
  session: RawMaterialIssueSession;
  totalPackets: number;
  bySection: Array<{
    sectionName: string;
    packets: number;
    materials: Array<{ itemDisplayName: string; packets: number; quantity: number; unitCode: string }>;
  }>;
  scans: Array<{
    qrId: string;
    itemDisplayName: string;
    quantity: number;
    unitCode: string;
    sectionName: string | null;
    issuedAt: string;
    actor: string | null;
  }>;
}

/**
 * One movement of a raw material's stock, as `inventory_stock_events` recorded it.
 *
 * This is the complete ledger behind `inventory_stock_balances`: every Raw Material Input
 * scan, every Raw Material Output scan and every manual adjustment writes one row, so the
 * balance on the Stock screen can always be traced back to the movements that produced it.
 */
export interface InventoryStockEventRow {
  id: string;
  itemId: string;
  eventType: string;
  /** Signed: positive added to stock, negative took it out. In `unitCode`. */
  quantity: number;
  unitId: string;
  unitCode: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

/** What the import decided about one spreadsheet row. */
export type InventoryImportOutcome = "CREATE" | "DUPLICATE" | "REJECTED";

export interface InventoryImportRowResult {
  /** 1-based, matching the row the operator sees in their spreadsheet (after the heading). */
  rowNumber: number;
  outcome: InventoryImportOutcome;
  displayName: string;
  /** Set once the material exists — the one it duplicates, or the one just created. */
  itemCode?: string;
  /** Every reason this row was rejected, in plain words. Never summarised away. */
  problems: string[];
  /** Internal: what would be created. Stripped before the result leaves the data layer. */
  draft?: {
    values: Record<string, string>;
    unitId?: string;
    openingStock?: number;
    costPrice?: number;
    packingQuantity?: number;
    packingUnitId?: string;
    packName?: string;
  };
}

export interface InventoryImportResult {
  categoryName: string;
  totalRows: number;
  created: number;
  duplicates: number;
  rejected: number;
  /** Required columns the file did not have. Non-empty means nothing was even looked at. */
  missingColumns: string[];
  /** False for a preview, true once the rows were actually written. */
  applied: boolean;
  rows: InventoryImportRowResult[];
}

/**
 * A request to correct a raw material's count.
 *
 * Raw material stock moves by itself through the two scanners, so a manual correction is a
 * claim that the shelf disagrees with the system. It carries a reason and waits for an
 * administrator; approving it is what applies it.
 */
/**
 * A request to remove a piece of master data, awaiting an administrator's decision.
 * `targetName` is a snapshot, so the request still reads sensibly after the thing is gone.
 */
/** One rung of a material's unit ladder: 1 `fromUnit` is `factor` of `toUnit`. */
export interface ItemUnitLadderStepRow {
  id: string;
  /** 0 is the biggest unit. */
  stepOrder: number;
  fromUnitId: string;
  fromUnit: string;
  toUnitId: string;
  toUnit: string;
  factor: number;
}

/** A saved set of conversions, reusable on any material. */
export interface UnitLadderPreset {
  id: string;
  name: string;
  /** Biggest unit first, exactly as a material's own ladder is held. */
  steps: ItemUnitLadderStepRow[];
}

/** A material's ladder, with the unit its stock is actually held in. */
export interface ItemUnitLadder {
  itemId: string;
  /** Biggest unit first. Empty when the material has no ladder. */
  steps: ItemUnitLadderStepRow[];
  /** The bottom of the chain — which must be `stockUnit`. */
  baseUnit: string | null;
  stockUnit: string | null;
  stockUnitId: string | null;
}

/** Which way material is being moved by hand: INto the store, or OUT of it. */
export type HandMoveDirection = "IN" | "OUT";

/**
 * What the Store In / Move Out screens need to offer one material by hand: the units it may be
 * counted in, what is on the shelf, and whether it may move that way at all.
 */
export interface RawMaterialHandMoveOptions {
  itemId: string;
  itemCode: string;
  displayName: string;
  /** The unit the balance is kept in. Null when the material has none yet. */
  stockUnitCode: string | null;
  stockUnitId: string | null;
  quantityOnHand: number;
  /** Every rung of its ladder, biggest first — or just the stock unit when it has no ladder. */
  units: string[];
  steps: ItemUnitLadderStepRow[];
  /** Labelled packets of it currently IN_STORE. Any at all block a move OUT by hand. */
  labelledPacketsInStore: number;
  /** Why it cannot move this way by hand, or null when it can. */
  blockedReason: string | null;
}

/**
 * One Dana the store holds in a sole colour a machine program runs.
 *
 * A row per MATERIAL, not per colour: EVA BLACK and PVC BLACK are both BLACK, and "3 bags of
 * BLACK" would not say which left the store.
 */
export interface MachineProgramDanaOption {
  itemId: string;
  displayName: string;
  /** The COLOR attribute, trimmed and upper-cased. */
  colour: string;
  /** EVA, PVC — what kind of Dana this is, which is what tells two of one colour apart. */
  subCategoryName: string;
  /** The units a quantity of it can be typed in: its ladder (BAG, KG), or just its stock unit. */
  units: string[];
  /** The unit its stock is counted in, or null while it has none. */
  stockUnitCode: string | null;
  /** How much of it has gone out for THIS program so far, in its stock unit. */
  issuedQuantity: number;
  /** Why this Dana cannot be issued by typing a quantity, or null when it can. */
  blockedReason: string | null;
}

export interface RawMaterialHandMoveInput {
  itemId: string;
  direction: HandMoveDirection;
  /** As typed, in `unitCode` — which may be any rung of the material's ladder. */
  quantity: number;
  unitCode: string;
  /** Who delivered it. Required moving IN, ignored moving OUT. */
  partyId?: string | null;
  /** Why it moved, kept on the stock event beside what was typed. */
  note?: string | null;
  actor?: string | null;
  /**
   * The machine program this move was made FOR, stamped on the stock event (migration 065).
   * Set by Dana Issue on the Machine Program Issue screen, null for an ordinary hand move.
   */
  machineProgramId?: string | null;
}

export interface RawMaterialHandMoveResult {
  accepted: boolean;
  outcome:
    | "MOVED"
    | "NOT_FOUND"
    | "NOT_ELIGIBLE"
    | "HAS_LABELLED_PACKETS"
    | "NO_SUPPLIER"
    | "UNKNOWN_UNIT"
    | "INVALID_QUANTITY"
    | "NOT_ENOUGH_STOCK";
  reason?: string;
  direction?: HandMoveDirection;
  /** What moved, in the unit stock is kept in. */
  quantity?: number;
  unitCode?: string;
  /** What the operator typed, so the result reads back the way it was entered. */
  typedQuantity?: number;
  typedUnitCode?: string;
  quantityOnHand?: number;
}

/** What would happen if a category were filed somewhere else, and what would stop it. */
export interface CategoryMovePreview {
  /** Empty means the move can go ahead. The first one is what a refusal reports. */
  blockers: string[];
  /** Where it sits now, and where it would sit — as a path, e.g. "UPPER — PVC UPPER". */
  from: string;
  to: string;
  /** How many materials would be renamed, because a name starts with its category path. */
  renames: number;
}

/** What would happen if a material were filed under another category, and what would stop it. */
export interface InventoryItemMovePreview {
  blockers: string[];
  /** Values the target also asks for, so they travel with the material. */
  carried: Array<{ label: string; value: string }>;
  /** Values the target does not ask for. They are let go. */
  dropped: Array<{ label: string; value: string }>;
  /** Required target attributes this material has no answer to. Any entry blocks the move. */
  missingRequired: string[];
  from: string;
  to: string;
  /** What it would be called afterwards. */
  newDisplayName: string;
}

export interface RemovalRequestRow {
  id: string;
  /** DEL-000001 — quoted on the notification. */
  requestCode: string;
  targetType: "CATEGORY" | "ITEM";
  targetId: string;
  targetName: string;
  reason: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  requestedBy: string;
  requestedByName: string | null;
  requestedAt: string;
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
}

export interface StockCorrectionRequestRow {
  id: string;
  /** SCR-000001 — quoted on the notification and written into the stock event's note. */
  requestCode: string;
  itemId: string;
  /** Snapshots, so the request stays readable after the material is renamed. */
  itemDisplayName: string;
  itemCode: string;
  /** Signed: positive adds to stock, negative takes away. */
  quantity: number;
  unitId: string | null;
  unitCode: string | null;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  requestedBy: string;
  requestedByName: string | null;
  requestedAt: string;
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
}

/**
 * The setup every new material in a sub-category should start from.
 *
 * DANA — EVA — BLACK, RED and BLUE are one material in three colours: the same unit, the same
 * bag, the same machine. Rather than a second place to configure that, a sub-category simply
 * remembers the last material set up in it, and the next one starts from there.
 *
 * Null when nothing in the category has been set up yet — the first material is configured by
 * hand, and every one after it follows.
 */
export interface RawMaterialSetupTemplate {
  /** The material this was read from, so a screen can say where it came from. */
  sourceItemId: string;
  sourceDisplayName: string;
  unitId: string | null;
  unitCode: string | null;
  packName: string | null;
  packingQuantity: number | null;
  packingUnitId: string | null;
  packingUnitCode: string | null;
  /** Always empty: raw material routes were removed on 2026-10-07. */
  hops: RawMaterialHop[];
  /** How many materials the category holds — what "apply to all" would touch. */
  materialCount: number;
}

/** One stop on a raw material's route out of the store. */
export interface RawMaterialHop {
  /** 1-based position along the route. */
  hopIndex: number;
  sectionId: string;
  sectionName: string;
}

// ─── Machine Program ──────────────────────────────────────────────────────────
// A planning layer over raw material store stock. Nothing here is a stock figure of its own:
// physical comes from inventory_stock_balances, reserved from the live programs' outstanding
// upper lines, and available is the difference — see packages/domain/src/machineProgram.ts
// for the one definition of that arithmetic.
//
//   machine + date → injector → sole run (sole, sole colour, article + size) → upper lines

/** One machine, standing inside the work section the store issues to, with its contractor. */
export interface MachineRecord {
  id: string;
  machineCode: string;
  name: string;
  sectionId: string;
  sectionName: string;
  sortOrder: number;
  status: string;
  /** Who RUNS this machine — set once, kept until somebody changes it. */
  contractorPartyId: string | null;
  contractorName: string | null;
  /** Who PACKS what it makes. A separate assignment, from the same contractor parties. */
  packingContractorPartyId: string | null;
  packingContractorName: string | null;
}

/** A colour a sole can be moulded in, with how much Dana the store holds in that colour. */
export interface SoleColourOption {
  colour: string;
  /** True when a DANA material in this colour exists in the Raw Material Master. */
  hasDana: boolean;
  /** Dana in this colour in the store, in `danaUnitCode`. Null when the Dana is in mixed units. */
  danaQuantity: number | null;
  danaUnitCode: string | null;
}

/** An article from the Product Master with the sizes it is made in. */
export interface MachineProgramArticle {
  article: string;
  sizes: Array<{
    articleSizeId: string;
    size: string;
    /**
     * The products STANDARD contractor rates, per DOZEN, in integer paisa (migration 064), so a
     * program can open its pricing boxes on them. Null is NOT SET and is never read as 0.
     */
    machineRatePaisa: number | null;
    packingRatePaisa: number | null;
    printingRatePaisa: number | null;
    /** FIX: no upper, moulded from an outer and an inner sole (migration 067). */
    hasNoUpper: boolean;
  }>;
}

/**
 * One source of a material: a supplier whose labelled packets are in the store, or the part of
 * the balance that carries no supplier at all.
 *
 * Supplier identity comes from `raw_material_qrs.party_id`, the only place the ERP records where
 * a packet came from. Stock that was never labelled — opening stock, an approved correction — is
 * real stock with no supplier on it, and is reported as such rather than given to somebody.
 */
export interface MachineProgramStockSource {
  /** null = this material's stock that carries no supplier. */
  supplierPartyId: string | null;
  supplierName: string | null;
  /** Labelled packets in store for this supplier. Null for the unattributed remainder. */
  packets: number | null;
  /** In the material's stock unit. */
  physical: number;
  reserved: number;
  /** What a new allocation may take from this source — never more than the material has left. */
  available: number;
}

/** A raw material as a program shows it: Dana for a sole colour, or an upper for an article + size. */
export interface MachineProgramMaterial {
  itemId: string;
  itemCode: string;
  displayName: string;
  /** "UPPER — RAGZINE UPPER", the path the material lives at. */
  categoryPath: string;
  /** "RAGZINE UPPER" — what kind of upper (or Dana) this is. */
  subCategoryName: string;
  /** The COLOR attribute. */
  colour: string;
  /** The TYPE attribute (SILAI, READY), when the material has one. */
  type: string | null;
  unitCode: string | null;
  packName: string;
  physical: number;
  reserved: number;
  available: number;
  sources: MachineProgramStockSource[];
  /**
   * Whether this machine may be programmed with this material. Raw material routes were removed
   * on 2026-10-07 — the store sends material wherever it is needed — so anything in stock can be
   * programmed, and `notAllocatableReason` says why when that ever stops being true.
   */
  allocatable: boolean;
  notAllocatableReason: string | null;
}

/** One upper colour on a sole run, with what Raw Material Output has actually taken for it. */
export interface MachineProgramUpperLineRecord {
  id: string;
  runId: string;
  lineNo: number;
  itemId: string;
  itemDisplayName: string;
  upperColour: string;
  upperType: string | null;
  subCategoryName: string;
  quantity: number;
  unitCode: string | null;
  /** Taken by Raw Material Output for this line, net of packets received back. */
  consumed: number;
  outstanding: number;
  availableAtSave: number;
}

/** One sole run on one injector: what is moulded, onto what, and the uppers it takes. */
export interface MachineProgramRunRecord {
  id: string;
  programId: string;
  /** 1 or 2 — or null on a FIX run, which belongs to the program, not an injector (migration 073). */
  injectorNo: number | null;
  runNo: number;
  /** THE sole on a normal run, the OUTER sole on a fix run. */
  soleColour: string;
  /**
   * The INNER sole, and the mark of a FIX run: an article with no upper, moulded from two
   * soles (migration 067). Null on every normal run.
   */
  innerSoleColour: string | null;
  articleSizeId: string;
  article: string;
  size: string;
  /**
   * A fix run plans this many, typed on the run itself, because it has no upper lines to add
   * up. 0 on a normal run, where totalQuantity is the figure. NOT a reservation.
   */
  fixQuantity: number;
  totalQuantity: number;
  consumedQuantity: number;
  /** The unit every line on this run shares, or null when they differ. */
  unitCode: string | null;
  /**
   * The hours this sole colour runs, in minutes from midnight of programDate — the same
   * convention as the shift (migrations 058, 070). Both null when nobody timed it, which means
   * the colour runs the whole shift.
   */
  startMinute: number | null;
  endMinute: number | null;
  lines: MachineProgramUpperLineRecord[];
}

/**
 * What one article's work is paid at on one program, per DOZEN, in integer paisa.
 *
 * One row per article, however many runs it is spread across (migration 063). An article with
 * NO row is unpriced — which is not the same as an article priced at zero, and no reader may
 * treat it as such.
 */
export interface MachineProgramArticleRateRecord {
  articleSizeId: string;
  machineRatePaisa: number;
  packingRatePaisa: number;
  printingRatePaisa: number;
  updatedAt: string;
}

export interface MachineProgramRecord {
  id: string;
  programNumber: number;
  code: string;
  machineId: string;
  machineName: string;
  contractorPartyId: string;
  /** The machine contractor as they were when the program was made — never rewritten later. */
  contractorName: string;
  /**
   * Who packs this program's output, snapshotted the same way. Null only on programs saved
   * before a machine had two contractors — nothing made since can be missing it.
   */
  packingContractorPartyId: string | null;
  packingContractorName: string | null;
  programDate: string;
  /** Minutes from midnight of programDate that the shift starts, 0 to 1439. */
  shiftStartMinute: number;
  /** Minutes from the same midnight that it ends. Above 1440 when it ends the next morning. */
  shiftEndMinute: number;
  status: string;
  /** PROGRAMMED / PARTIALLY_USED / COMPLETED / CANCELLED — derived, never stored. */
  displayStatus: string;
  /** What the program RESERVES: the sum of its upper lines. Fix runs are not in it. */
  totalQuantity: number;
  /** What its FIX runs plan, which reserves nothing. */
  fixQuantity: number;
  /** Everything the machine is to make — uppers plus fix. What "Total Dozen" shows. */
  productionQuantity: number;
  consumedQuantity: number;
  outstandingQuantity: number;
  /** The unit every line on the program shares, or null when they differ. */
  unitCode: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  runs: MachineProgramRunRecord[];
  /** Contractor pricing, one row per article on the program. Empty until somebody prices it. */
  articleRates: MachineProgramArticleRateRecord[];
}

/** A machine as the board shows it for one date: the machine, and that date's program. */
export interface MachineProgramBoardRow {
  machine: MachineRecord;
  program: MachineProgramRecord | null;
}
