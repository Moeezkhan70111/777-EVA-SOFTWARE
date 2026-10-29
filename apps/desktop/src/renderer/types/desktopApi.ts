import type { ClaimPartyRole, ContractorLedger, ContractorRole, ReceiveProductionOutcome, StoreDailyReport, StoreDirection, UpperIssueOutcome, UpperProductionComparison, UpperReconciliation } from "@erp/domain";

export type SortOrder = "ASC" | "DESC";

/** Why this computer may not record a document-number range for itself. Mirrors @erp/data. */
export type NumberBlockAdoptRefusal = "ALREADY_CONFIGURED" | "NO_EXISTING_DATA" | "OUT_OF_RANGE";

/**
 * This computer's document-number range, as the Settings status view reads it. Mirrors
 * NumberBlockStatus in @erp/data, declared here because this file states the shapes the bridge
 * hands the renderer.
 */
export interface NumberBlockStatus {
  /** The range this computer holds (1-5), or null when it holds none. */
  block: number | null;
  /** The first and last number this computer may allocate, or null when it holds no range. */
  range: { block: number; lo: number; hi: number } | null;
  /** True once a range was recorded here through provisioning. */
  confirmed: boolean;
  /** Why documents cannot be created here, or null when the configuration is usable. */
  problem: "NOT_CONFIGURED" | "INVALID" | null;
  /** What is stored, when it is not a usable range, so an administrator can see what to correct. */
  storedValue: string | null;
  /** Whether this computer may record block 1 for itself, and what it is told when it may not. */
  adoption: { allowed: boolean; refusal: NumberBlockAdoptRefusal | null; detail: string };
  /**
   * The ranges a second computer may be given, in order, or empty when one is already recorded
   * here. The numbers come from the data layer: no screen works a range out for itself.
   */
  assignable: Array<{ block: number; lo: number; hi: number }>;
}

/** This computer's cloud-sync situation. Read-only: asking for it syncs nothing. */
export interface CloudSyncStatus {
  configured: boolean;
  host?: string;
  email?: string;
  problems?: readonly string[];
  running: boolean;
  /** The local queue, read two ways. See SyncQueueSummary. */
  queue: SyncQueueSummary;
  /** How far through the cloud log this computer has read. 0 = it has applied nothing. */
  pullCursor: number;
  /** Present only while a pull is waiting for something that has not arrived yet. */
  waitingFor?: { seq: number; attempts: number; retryAfter: string };
  /** The background loop's state. Absent on a computer with no scheduler. */
  schedule?: { nextPassInMs: number | null; consecutiveFailures: number };
  /** The most recent pass attempted, from sync_runs. Null if none has ever run here. */
  lastAttempt?: SyncRunSummary | null;
  /** The most recent pass that completed. Null if none ever has. */
  lastSuccess?: SyncRunSummary | null;
}

/** One recorded pass, as the renderer sees it. Mirrors SyncRunRecord in @erp/data. */
export interface SyncRunSummary {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  trigger: "STARTUP" | "TIMER" | "RECONNECT" | "MANUAL";
  outcome: "OK" | "REFUSED" | "TRANSPORT_ERROR" | "FAILED" | null;
  pushed: number | null;
  fetched: number | null;
  applied: number | null;
  duplicates: number | null;
  refused: number | null;
  reason: string | null;
}

/**
 * The local sync queue, read two ways.
 *
 * `counts` partitions it by status. The three numbers after it partition the UNSENT rows
 * (PENDING + FAILED) by whether anything can actually carry them, which the status alone cannot
 * say: four of the six aggregate types have no transport yet.
 *
 * pushableNow + pushableWaiting + notPushable === counts.PENDING + counts.FAILED
 */
export interface SyncQueueSummary {
  counts: { PENDING: number; IN_FLIGHT: number; FAILED: number; DEAD_LETTER: number; SYNCED: number };
  /** Exactly what the next pass would claim. */
  pushableNow: number;
  /** Sendable, but waiting out a backoff. */
  pushableWaiting: number;
  /** Queued, and no transport can carry it yet. Waiting for a contract, not for the network. */
  notPushable: number;
  /** When a row was last SENT. Not when a pass last ran -- nothing records that. */
  lastSyncedAt: string | null;
  /** When a row last failed or was parked. */
  lastFailureAt: string | null;
}

/**
 * One sync event the service refused often enough to be parked, as Settings shows it.
 *
 * The payload is deliberately absent: a production scan's payload carries the operator, the
 * station and every article snapshot, and none of that is needed to decide what to do. The
 * aggregate id -- a carton QR or an event id -- is the identification, and nothing more.
 */
export interface DeadLetterEvent {
  outboxId: string;
  dedupeKey: string;
  aggregateType: string;
  aggregateId: string;
  /** Refusals from the service. This is the count that parked it. */
  attempts: number;
  /** Failures to reach the service at all. These never park anything. */
  transientAttempts: number;
  error: string;
  createdAt: string;
  /** When it was parked. */
  updatedAt: string;
}

export interface DashboardSnapshot {
  todaysProduction: number;
  todaysDispatched: number;
  currentStockTotal: number;
  inventoryValue: number;
  syncQueuePending: number;
  productionCounter: number;
  recentScans: Array<{
    qrId: string;
    article: string;
    color: string;
    size: string;
    serial: string;
    occurredAt: string;
  }>;
  byHour: Array<{ key: string; quantity: number }>;
  byProduct: Array<{ key: string; quantity: number }>;
  byColor: Array<{ key: string; quantity: number }>;
  bySize: Array<{ key: string; quantity: number }>;
}

export interface InventoryRow {
  productId: string;
  articleSizeId?: string | null;
  article: string;
  color: string;
  size: string;
  /** Current Stock: cartons In Store right now — Store Move In adds one, Store Move Out removes one. */
  quantity: number;
  /** Units still at the factory (production stock). */
  productionQuantity?: number;
  /** Units received into the store by Store Scanning. */
  storeQuantity?: number;
  /** Units moved out of the store to the gate by Store Move Out, ready to dispatch. */
  gateQuantity?: number;
  costPrice: number;
  sellingPrice: number;
  stockValue: number;
  potentialRevenue: number;
  profitPotential: number;
}

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

/** One entry of the flat Product Type list. */
export interface ProductTypeRow {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

/** One sub group, and the product group it belongs to. */
export interface ProductSubGroupRow {
  id: string;
  productGroupId: string;
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

export interface ProductRow {
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
   * The product's STANDARD contractor rates, per DOZEN, in integer paisa (migration 064): what
   * machine, packing and printing work on it is normally paid. A machine program starts from
   * these and then keeps its own copy, like a sale voucher and a selling price.
   *
   * Null is NOT SET and is never shown as 0 — an unpriced product reads as "Not priced", while a
   * stored 0 means that job is not paid for this article.
   */
  machineRatePaisa?: number | null;
  packingRatePaisa?: number | null;
  printingRatePaisa?: number | null;
  /**
   * What the packing rate is made of, in integer paisa (migration 072) — BOX 50 + TAPE 30 + …
   * When present, packingRatePaisa is their sum. Empty when the rate was typed as one figure.
   */
  packingRateItems?: Array<{ name: string; ratePaisa: number }>;
  mainGroupId: string | null;
  groupId: string | null;
  articleSeriesId?: string | null;
  /** Added 2026-10-11 (migration 066). Null on every product saved before it. */
  productTypeId?: string | null;
  productSubGroupId?: string | null;
  articleSeriesName?: string | null;
  mainGroupName?: string | null;
  groupName?: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface QrBatchRow {
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
  /** "B" for a run of B carton labels — MIX, with a B on the sticker. Null for an ordinary run. */
  grade: "B" | null;
}

/**
 * One line of a machine's day program: every carton QR generated for one product in one colour
 * (and grade). Worked out by the main process from persisted codes — nothing here is added up.
 */
export interface CartonProgramLine {
  articleSizeId: string;
  productVariantId: string | null;
  article: string;
  size: string;
  color: string;
  /** "B" for B carton labels (colour MIX). */
  grade: "B" | null;
  /** Carton QRs registered and not voided — one per carton. */
  cartons: number;
  /** Codes voided in QR Management since; not in `cartons`. */
  voidedCartons: number;
  /** `cartons` in dozens (2 cartons to the dozen). */
  equivalentDozens: number;
  batchCount: number;
  lastGeneratedAt: string;
}

/** A machine's program for one business day — MP-000123 — with its contractors as opened. */
/** A program still open, as the administrator's list of what is left to delete shows it (0.3.8). */
export interface OpenMachineProgram {
  programId: string;
  code: string;
  programDate: string;
  machineName: string;
  contractorName: string;
}

export interface MachineDayProgram {
  programId: string;
  programNumber: number;
  code: string;
  programDate: string;
  machineId: string;
  machineName: string;
  contractorName: string;
  packingContractorName: string | null;
  cartons: number;
  voidedCartons: number;
  equivalentDozens: number;
  lines: CartonProgramLine[];
}

/** The program a QR run joined, as the generator reports it back. */
export interface MachineDayProgramRef {
  id: string;
  code: string;
  machineName: string;
  programDate: string;
}

/** One carton recorded as produced — a PRODUCED event, read through the registry. */
export interface ProductionReceipt {
  qrId: string;
  article: string;
  size: string;
  color: string;
  grade: "B" | null;
  /** UTC ISO. */
  receivedAt: string;
  receivedBy: string | null;
  /** RECEIVE_PRODUCTION, or null for a station that did not record one. */
  station: string | null;
  /** Where the carton is now (qr_master.current_status). */
  stage: string;
  programCode: string | null;
  machineName: string | null;
}

/** A business day's receipts, a page at a time, with the whole day's totals. */
export interface ProductionReceiptPage {
  date: string;
  rows: ProductionReceipt[];
  page: number;
  pageSize: number;
  totalCartons: number;
  equivalentDozens: number;
  /** The whole day added up per article, size and colour (B cartons on their own line). */
  summary: ProductionReceiptSummaryLine[];
}

/** One Manual Production entry: cartons typed in, with no carton QR. */
export interface ManualProductionEntry {
  id: string;
  /** MAN-000001 */
  code: string;
  article: string;
  size: string;
  color: string;
  cartons: number;
  equivalentDozens: number;
  programCode: string;
  machineName: string;
  enteredAt: string;
  enteredBy: string | null;
}

/** One business day of Manual Production, a page at a time, with the whole day added up. */
export interface ManualProductionPage {
  date: string;
  rows: ManualProductionEntry[];
  page: number;
  pageSize: number;
  totalEntries: number;
  totalCartons: number;
  equivalentDozens: number;
  summary: ProductionReceiptSummaryLine[];
}

/** What a Save came to, decided by the main process. A retried Save returns the entry already made. */
export interface ManualProductionResult {
  accepted: boolean;
  entry: ManualProductionEntry | null;
  duplicate?: boolean;
  reason?: string;
}

/** One line of a day's receipt summary: SK6 7/10 RED — 20 cartons, 10 dozen. */
export interface ProductionReceiptSummaryLine {
  article: string;
  size: string;
  color: string;
  grade: "B" | null;
  cartons: number;
  equivalentDozens: number;
}

/** An amount of upper in one stock unit — uppers are counted in their material's own unit. */
export interface UpperQuantity {
  unitCode: string;
  quantity: number;
}

export interface UpperIssueTotals {
  packets: number;
  quantities: UpperQuantity[];
}

/** One upper packet issued to a machine. */
export interface UpperIssueRow {
  eventId: string;
  qrId: string;
  itemDisplayName: string;
  article: string | null;
  size: string | null;
  colour: string | null;
  quantity: number;
  unitCode: string;
  packName: string | null;
  machineId: string;
  machineName: string;
  issuedAt: string;
  issuedBy: string | null;
  /** Where the packet is now: ISSUED, or IN_STORE if it came back. */
  status: string;
}

export interface UpperIssuePage {
  machineId: string;
  date: string;
  rows: UpperIssueRow[];
  page: number;
  pageSize: number;
  totals: UpperIssueTotals;
}

/** The three measures the Move Out summary keeps apart. */
export interface UpperIssueSummary {
  machineId: string;
  machineName: string;
  session: UpperIssueTotals & { sessionNumber: number | null };
  day: UpperIssueTotals & { date: string };
  stock: UpperIssueTotals;
}

export interface UpperStockRow {
  itemId: string;
  itemCode: string;
  displayName: string;
  categoryName: string;
  article: string | null;
  size: string | null;
  colour: string | null;
  type: string | null;
  onHand: number;
  unitCode: string;
  packetsInStore: number;
  packName: string | null;
}

/** A machine program that can be reconciled: one machine on one business day. */
export interface ReconcilableProgram {
  programId: string;
  code: string;
  programDate: string;
  machineId: string;
  machineName: string;
}

/** Upper Out against Production Received for one machine program, counted by the main process. */
export interface ProgramReconciliation {
  program: ReconcilableProgram & { contractorName: string | null; packingContractorName: string | null };
  upperOut: UpperIssueTotals;
  /** Cartons recorded as produced — carton QRs once each, plus Manual Production's, which are also given alone. */
  productionReceived: { cartons: number; bCartons: number; manualCartons: number };
  comparison: UpperProductionComparison;
}

/** What one Upper Move Out scan came to, decided by the main process. */
export interface UpperIssueResult {
  accepted: boolean;
  outcome: UpperIssueOutcome;
  qrId?: string;
  reason?: string;
  eventId?: string;
  /** The issue as the database holds it — for ALREADY_ISSUED, the earlier one. */
  issue?: UpperIssueRow | null;
}

/** What one Receive Production scan came to, decided by the main process. */
export interface ReceiveProductionResult {
  accepted: boolean;
  outcome: ReceiveProductionOutcome;
  qrId?: string;
  reason?: string;
  /** The carton's receipt as the database holds it — for ALREADY_RECEIVED, the earlier one. */
  receipt?: ProductionReceipt | null;
}

/** One generation run behind a program line. */
export interface CartonProgramBatch {
  id: string;
  firstQrId: string;
  lastQrId: string;
  cartons: number;
  voidedCartons: number;
  equivalentDozens: number;
  createdAt: string;
  createdBy: string | null;
  requestedBy: string | null;
}

export interface RawMaterialQrBatchRow {
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
  /** How much one packet in this run holds — printed on every label. Null when no packing was set. */
  packingQuantity: number | null;
  createdAt: string;
  /** The logged-in operator who ran the generator. */
  createdBy: string | null;
  /** Whoever asked for the run, as typed by the operator (optional). */
  requestedBy: string | null;
}

export interface RawMaterialQrRow {
  id: string;
  batchId: string;
  partyId: string;
  itemId: string;
  sequence: number;
  status: string;
  createdAt: string;
}

/** One already-generated raw material packet label, for reprinting it exactly as printed. */
export interface RawMaterialQrLabel {
  qrId: string;
  displayName: string;
  partyName: string;
  categoryLine: string;
  subCategoryLine: string;
  packingQuantity: number | null;
  values: Array<Record<string, unknown>>;
}

export interface RawMaterialQrSequenceState {
  lastSequence: number;
  nextSequence: number;
}

export type QrStage =
  | "REGISTERED"
  | "VOID"
  | "PRODUCED"
  | "WAREHOUSE"
  /** Raw material only: the packet has been issued out of the store to a section. */
  | "ISSUED"
  | "TO_GATE"
  | "DISPATCHED"
  /** Returned by the customer and standing at the gate, waiting for Store Move In. */
  | "ON_GATE"
  | "SOLD"
  /** Legacy: written by the pre-ON_GATE return flow, which credited stock on the scan. */
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
  /** Business sub-kind carried in event metadata (e.g. "STORE_ENTRY" on a MOVED event). */
  subType?: string | null;
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
  /** Raw material only: the supplier the packet came from, and where it is now. */
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

// ─── QR Journey ──────────────────────────────────────────────────────────────

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

export type QrPlace = "FACTORY" | "WAREHOUSE" | "GATE" | "CUSTOMER";

/** One hop on a code's path — from → to status and place, who, where, and how long after the previous hop. */
export interface QrJourneyStep {
  index: number;
  id: string;
  kind: QrJourneyStepKind;
  eventType: string | null;
  occurredAt: string;
  fromStatus: string | null;
  toStatus: string;
  fromPlace: QrPlace | null;
  toPlace: QrPlace | null;
  /**
   * The destination in words when the status alone does not say enough — a packet is not
   * just "Issued", it is issued to PACKING. Null for a carton, whose statuses are complete
   * on their own.
   */
  toStatusLabel?: string | null;

  actor: string | null;
  deviceId: string | null;
  workstation: string | null;
  factory: string | null;
  note: string | null;
  syncStatus: string | null;
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
  counts: Partial<Record<QrJourneyStepKind, number>>;
  /** Total time spent in each status (ms); the current status is counted up to `asOf`. */
  dwellMs: Record<string, number>;
  asOf: string;
}

// ─── Store Scanning ──────────────────────────────────────────────────────────

export type StoreEntryOutcome =
  | "RECEIVED"
  | "ALREADY_IN_STORE"
  | "UNKNOWN_QR"
  | "NOT_PRODUCED"
  | "NOT_ELIGIBLE"
  | "INVALID_FORMAT"
  /** A well-formed raw material QR: recognised, but this screen cannot move it yet. */
  | "RAW_MATERIAL_NOT_SUPPORTED"
  /** The material has no packing (or no destination) set, so nothing can move safely. */
  | "NOT_CONFIGURED"
  | "STATUS_CHANGED"
  /** Main-process only: session missing or lacks the store-scanning permission. */
  | "NOT_AUTHORIZED"
  /** Main-process only: infrastructure failure; nothing was written. */
  | "ERROR";

export interface StoreEntryScanResult {
  accepted: boolean;
  outcome: StoreEntryOutcome;
  qrId?: string;
  parserVersion?: string;
  reason?: string;
  article?: string;
  color?: string;
  size?: string;
  serial?: string;
  previousStatus?: string | null;
  currentStatus?: string | null;
  registryStatus?: string | null;
  receivedAt?: string;
  eventId?: string;
  sessionId?: string;
  /** Which kind of thing was scanned, so the screen knows what to render. */
  kind?: "CARTON" | "RAW_MATERIAL";
  /** Raw material only: the material, its supplier, and what one packet holds. */
  itemDisplayName?: string;
  partyName?: string;
  packingQuantity?: number;
  packingUnitCode?: string | null;
  sectionName?: string | null;
}

// ─── Carton returns ──────────────────────────────────────────────────────────
// Recording a return is a COMMERCIAL event: the customer is credited and the carton is left
// standing ON GATE. The carton re-enters stock only when an ordinary Store Move In receives
// it. These two are never the same scan.

export type ReturnOutcome =
  /** Accepted: party credited, carton is now ON GATE. */
  | "RETURN_RECORDED"
  /** Already recorded; the carton is still waiting for Store Move In. */
  | "ALREADY_RETURNED"
  /** No produced carton exists for this code. */
  | "UNKNOWN_QR"
  /** The carton is not currently out with a customer, so there is nothing to return. */
  | "NOT_DISPATCHED"
  /** Dispatched with no bill selected, so there is no customer to credit. */
  | "NO_ATTRIBUTION"
  /** The scanned text is not a QR identity at all. */
  | "INVALID_FORMAT";

/** Who a carton is currently out with, resolved from its own latest dispatch event. */
export interface DispatchAttribution {
  dispatchEventId: string;
  dispatchedAt: string;
  dispatchSessionId: string | null;
  partyId: string;
  partyName: string;
  saleVoucherId: string | null;
  saleVoucherNumber: string | null;
  saleVoucherLineItemId: string | null;
  /** Rate and discount per pair the carton was billed at, in rupees. */
  unitPrice: number;
  discountPerPair: number;
  /** What the customer is credited for this one carton, in rupees. */
  creditAmount: number;
}

/** A return already recorded for this carton, shown when it is scanned a second time. */
export interface ExistingReturn {
  saleReturnId: string;
  returnNumber: string;
  returnedAt: string;
  partyId: string;
  partyName: string;
  saleVoucherNumber: string | null;
  creditAmount: number;
}

export interface ReturnScanResult {
  accepted: boolean;
  outcome: ReturnOutcome;
  qrId?: string;
  parserVersion?: string;
  reason?: string;
  article?: string;
  color?: string;
  size?: string;
  serial?: string;
  currentStatus?: string | null;
  attribution?: DispatchAttribution | null;
  existingReturn?: ExistingReturn | null;
  recordedAt?: string;
  saleReturnId?: string;
  returnNumber?: string;
  eventId?: string;
}

/** One recorded return, as the Return screen's feed and Return History list it. */
export interface SaleReturnRow {
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
  unitPrice: number;
  discountPerPair: number;
  creditAmount: number;
  currentStatus: string | null;
  /** True while the carton is still ON GATE — recorded, but not yet received by the store. */
  awaitingStoreIn: boolean;
}

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
  byProduct: Array<{ article: string; color: string; size: string; count: number }>;
  recent: StoreReceivedRow[];
  lastReceived: StoreReceivedRow | null;
}

// ─── Store Move Out ──────────────────────────────────────────────────────────

export type StoreExitOutcome =
  | "MOVED_OUT"
  | "ALREADY_AT_GATE"
  | "NOT_IN_STORE"
  | "UNKNOWN_QR"
  | "NOT_PRODUCED"
  | "NOT_ELIGIBLE"
  | "INVALID_FORMAT"
  /** A well-formed raw material QR: recognised, but this screen cannot move it yet. */
  | "RAW_MATERIAL_NOT_SUPPORTED"
  /** The material has no packing (or no destination) set, so nothing can move safely. */
  | "NOT_CONFIGURED"
  | "STATUS_CHANGED"
  /** Main-process only: session missing or lacks the store-scanning permission. */
  | "NOT_AUTHORIZED"
  /** Main-process only: infrastructure failure; nothing was written. */
  | "ERROR";

/**
 * The gatepass line a move-out was automatically counted against (oldest open line owing
 * the scanned variant), after that scan. Informational: the station never asks for it.
 */
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

export interface StoreExitScanResult {
  accepted: boolean;
  outcome: StoreExitOutcome;
  qrId?: string;
  parserVersion?: string;
  reason?: string;
  article?: string;
  color?: string;
  size?: string;
  serial?: string;
  previousStatus?: string | null;
  currentStatus?: string | null;
  registryStatus?: string | null;
  movedOutAt?: string;
  eventId?: string;
  sessionId?: string;
  /** Set when the move-out was counted against a gatepass reservation: that line's progress after this scan. */
  gatepass?: StoreExitGatepassProgress;
  /** Which kind of thing was scanned, so the screen knows what to render. */
  kind?: "CARTON" | "RAW_MATERIAL";
  /** Raw material only: the material, its supplier, and what one packet holds. */
  itemDisplayName?: string;
  partyName?: string;
  packingQuantity?: number;
  packingUnitCode?: string | null;
  sectionName?: string | null;
}

/** Same shape as a receiving session; the code reads SO-000042. */
export type StoreMoveOutSession = StoreReceivingSession;

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
  byProduct: Array<{ article: string; color: string; size: string; count: number }>;
  recent: StoreMovedOutRow[];
  lastMovedOut: StoreMovedOutRow | null;
}

// ─── Gatepass ────────────────────────────────────────────────────────────────
// A reservation document: party + article/colour/size quantities reserved from store stock.
// Nothing here moves a QR or a stock figure — that stays with the scanners. A plain Store
// Move Out scan of a reserved variant is what consumes the reservation (oldest open line
// first); the store operator never names a gatepass.
//
//   Current Stock    physical cartons In Store
//   Reserved         still owed to outstanding gatepasses
//   Reflected Stock  Current Stock − Reserved: what a NEW gatepass may take

export type GatepassStatus = "CREATED" | "BILLED" | "AT_GATE" | "DISPATCHED" | "DELIVERED" | "CANCELLED";

/** The delivery/builty proof standing for a Gatepass, with the photo itself to show. */
export interface GatepassDeliveryProof {
  id: string;
  gatepassId: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  originalName: string | null;
  uploadedBy: string | null;
  uploadedAt: string;
  /** The photo as a data URL, or null when the file is missing from the store. */
  dataUrl: string | null;
}

/** One line of a Gatepass as both scanning desks see it. Counts are cartons, the stored unit. */
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

/** What a Gatepass still needs at the store and at the gate. Cartons; screens show dozens. */
export interface GatepassScanProgress {
  gatepassId: string;
  code: string;
  status: GatepassStatus;
  partyName: string;
  voucherNumber: string | null;
  dispatchSessionId: string | null;
  lines: GatepassScanLine[];
  requiredCartons: number;
  storeScannedCartons: number;
  storeRemainingCartons: number;
  dispatchedCartons: number;
  dispatchRemainingCartons: number;
}

/** One step of the Gatepass journey, with the moment it was actually reached (never guessed). */
export interface GatepassJourneyStep {
  status: GatepassStatus;
  label: string;
  state: "DONE" | "CURRENT" | "PENDING";
  at: string | null;
  actor: string | null;
}

/** One colour + size of an article with its live store figures (cartons). */
export interface GatepassStockRow {
  productVariantId: string;
  article: string;
  color: string;
  size: string;
  /** Product group of the article + size; null when the article has none set. */
  groupName: string | null;
  /** Current Stock — physically In Store. */
  storeQuantity: number;
  /** Reserved — still owed to outstanding gatepasses. */
  reservedQuantity: number;
  /** Reflected Stock — storeQuantity − reservedQuantity. */
  reflectedQuantity: number;
}

export interface GatepassLineInput {
  productVariantId: string;
  /** Cartons, whole numbers only. */
  quantity: number;
  /** The Reflected Stock figure the operator saw, so a rejection can say "stock changed". */
  reflectedStockSeen?: number;
}

export type CreateGatepassOutcome =
  | "CREATED"
  | "NO_PARTY"
  | "PARTY_NOT_FOUND"
  | "PARTY_INACTIVE"
  | "NO_LINES"
  | "INVALID_QUANTITY"
  | "DUPLICATE_LINE"
  | "VARIANT_NOT_FOUND"
  | "INSUFFICIENT_STOCK"
  | "STOCK_CHANGED"
  /** Main-process only: session missing or lacks the gatepass permission. */
  | "NOT_AUTHORIZED"
  /** Main-process only: infrastructure failure; nothing was written. */
  | "ERROR";

export interface GatepassShortage {
  productVariantId: string;
  article: string;
  color: string;
  size: string;
  requested: number;
  currentStock: number;
  reserved: number;
  reflected: number;
  seen: number | null;
}

export interface CreateGatepassResult {
  accepted: boolean;
  outcome: CreateGatepassOutcome;
  reason?: string;
  gatepassId?: string;
  gatepassNumber?: number;
  code?: string;
  totalQuantity?: number;
  createdAt?: string;
  shortages?: GatepassShortage[];
  productVariantId?: string;
}

export interface GatepassLine {
  id: string;
  lineNo: number;
  productVariantId: string;
  article: string;
  color: string;
  size: string;
  /** Product group of the article + size; null when the article has none set. */
  groupName: string | null;
  quantity: number;
  storeQuantityAtCreation: number;
  /** Cartons Store Move Out has actually taken for this line. */
  dispatchedFromStoreQuantity: number;
  /** quantity − dispatchedFromStoreQuantity: still reserved. */
  outstandingQuantity: number;
}

export interface Gatepass {
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
  dispatchedFromStoreQuantity: number;
  outstandingQuantity: number;
  lineCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  lines: GatepassLine[];
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
  articles: string[];
  createdBy: string | null;
  createdAt: string;
}


export interface GatepassListQuery {
  search?: string;
  partyId?: string;
  article?: string;
  fromDate?: string;
  toDate?: string;
  status?: GatepassStatus | "ALL";
  page?: number;
  pageSize?: number;
}

export type CancelGatepassOutcome = "CANCELLED" | "NOT_FOUND" | "ALREADY_CANCELLED" | "REASON_REQUIRED" | "NOT_AUTHORIZED" | "ERROR";

export interface CancelGatepassResult {
  accepted: boolean;
  outcome: CancelGatepassOutcome;
  reason?: string;
  gatepassId?: string;
  code?: string;
  cancelledAt?: string;
  /** Cartons whose reservation the cancellation released (were still outstanding). */
  releasedQuantity?: number;
  /** Cartons already moved out of the store for it — unchanged by cancelling. */
  dispatchedFromStoreQuantity?: number;
}

/**
 * `fromDate`/`toDate` are local calendar days (YYYY-MM-DD, inclusive) compared against the
 * generation timestamp only. Article/colour/size are ANDed with each other and the dates.
 */
export interface QrGenerationFilter {
  fromDate?: string;
  toDate?: string;
  article?: string;
  color?: string;
  size?: string;
  page?: number;
  pageSize?: number;
  /** Compute the headline tallies (default true). Pass false when only the page changed. */
  includeSummary?: boolean;
}

/** One generation run: a contiguous serial range for one article + colour + size. */
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
  total: number;
  page: number;
  pageSize: number;
  /** null when the summary was not requested. */
  totalQrCount: number | null;
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
  productCount: number;
  disabledProductCount: number;
  qrCount: number;
  discountRuleCount: number;
  renameBlockedReason: string | null;
  deleteBlockedReason: string | null;
}

export interface QrSequenceState {
  article: string;
  size: string;
  color: string;
  lastSequence: number;
  nextSequence: number;
}

export interface QrCodeRow {
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

export interface PagedResult<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ReportSummary {
  totalProduction: number;
  inventoryValue: number;
  byArticle: Array<{ key: string; quantity: number }>;
  byColor: Array<{ key: string; quantity: number }>;
  bySize: Array<{ key: string; quantity: number }>;
  byHour: Array<{ key: string; quantity: number }>;
  topProducts: Array<{ key: string; quantity: number }>;
}

/**
 * What the main process reports about automatic updates.
 *
 * Mirrors UpdateStatus in main/updater.ts. The two are deliberately separate declarations: this
 * side of the bridge validates what arrives rather than trusting the shape (R25), and a shared
 * type would make that validation look unnecessary.
 */
export type AppUpdatePhase =
  | "DISABLED"
  | "IDLE"
  | "CHECKING"
  | "UP_TO_DATE"
  | "DOWNLOADING"
  | "READY"
  | "ERROR";

export interface AppUpdateStatus {
  phase: AppUpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  percent?: number;
  reason?: string;
  lastCheckedAt?: string;
  /** When a check last succeeded, across restarts. */
  lastSuccessAt?: string;
  /** This computer has gone too long without reaching the release feed — see main/updater.ts. */
  stalled?: boolean;
  stalledDays?: number;
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

export interface MoneyDriftViolation {
  table: string;
  column: string;
  id: string;
  realValue: number | null;
  paisaValue: number | null;
  expectedPaisa: number | null;
}

export interface MoneyDriftSummary {
  healthy: boolean;
  pairsChecked: number;
  violationCount: number;
  violations: MoneyDriftViolation[];
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

export interface PartyGroup {
  id: string;
  groupName: string;
  description?: string;
  isActive: boolean;
}

export interface ProductGroup {
  id: string;
  groupName: string;
  description?: string;
  isActive: boolean;
}

export interface MainGroup {
  id: string;
  groupName: string;
  description?: string;
  isActive: boolean;
}

export interface SaleVoucher {
  id: string;
  voucherNumber: string;
  partyId: string;
  partyName: string;
  partyNameUrdu?: string | null;
  partyMobile?: string;
  partyEmail?: string;
  voucherDate: string;
  bookNo: string;
  subPartyName?: string | null;
  subPartyNameUrdu?: string | null;
  subPartyNumber?: string | null;
  remarks?: string | null;
  totalQuantity: number;
  totalAmount: number;
  status: string;
  /** The gatepass this bill was made from, when it was; CANCELLED means the bill must go. */
  gatepassId?: string | null;
  gatepassCode?: string | null;
  gatepassStatus?: GatepassStatus | null;
  lineItems: Array<{
    id: string;
    productVariantId: string;
    quantity: number;
    /** The rate the line was billed at: NORMAL, or the B-TYPE derived from it (never discounted). */
    priceType: "NORMAL" | "B_TYPE";
    unitPrice: number;
    /** Total discount for the line. */
    discount: number;
    /** Per pair, what the party's discount rule gave when the line was saved (0 for NONE or B-TYPE). */
    discountPerPair: number;
    /** The rule that set the line's discount ceiling when it was saved. */
    discountSource: "ARTICLE" | "ARTICLE_SERIES" | "PRICE_RANGE" | "PRODUCT_GROUP" | "NONE";
    totalPrice: number;
    article: string;
    color: string;
    size: string;
    groupName?: string | null;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface SaleVoucherListRow {
  id: string;
  voucherNumber: string;
  partyName: string;
  voucherDate: string;
  bookNo: string;
  subPartyName?: string | null;
  totalQuantity: number;
  totalAmount: number;
  status: string;
  createdAt: string;
}

export interface PurchaseVoucherLineItem {
  id: string;
  itemId: string;
  itemCode: string;
  displayName: string;
  unitCode?: string | null;
  costPrice?: number | null;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

export interface PurchaseVoucher {
  id: string;
  voucherNumber: string;
  partyId: string;
  partyName: string;
  voucherDate: string;
  bookNo?: string | null;
  referenceNo?: string | null;
  remarks?: string | null;
  totalQuantity: number;
  totalAmount: number;
  status: string;
  lineItems: PurchaseVoucherLineItem[];
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseVoucherListRow {
  id: string;
  voucherNumber: string;
  partyName: string;
  voucherDate: string;
  referenceNo?: string | null;
  totalQuantity: number;
  totalAmount: number;
  status: string;
  createdAt: string;
}

export interface CashVoucher {
  id: string;
  voucherNumber: number;
  partyId: string;
  partyName: string;
  voucherDate: string;
  modeOfTransfer?: string;
  description: string;
  receiptAmount: number;
  paymentAmount: number;
  lines?: Array<{
    partyId: string;
    partyName: string;
    description: string;
    modeOfTransfer: string;
    bankAccountTitle: string;
    chequeNumber: string;
    chequeDate: string;
    onlineFrom: string;
    onlineTo: string;
    referenceNo: string;
    receiptAmount: number;
    paymentAmount: number;
  }>;
  status: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Party {
  id: string;
  partyCode: string;
  partyName: string;
  partyNameUrdu?: string;
  partyType: string;
  contactPerson?: string;
  mobileNumber?: string;
  whatsAppNumber?: string;
  phoneNumber?: string;
  email?: string;
  address?: string;
  city?: string | null;
  partyGroupId?: string | null;
  groupName?: string | null;
  remarks?: string;
  status: string;
  balanceLimit?: number | null;
  createdAt: string;
  updatedAt?: string;
}

export interface AuthUser {
  id: string;
  username: string;
  role: "USER" | "ADMIN";
  accessStatus: "PENDING" | "APPROVED" | "REJECTED";
  permissions: string[];
  lastLoginAt: string | null;
  roleNotification?: string | null;
  /** The name of the role assigned to the user (e.g. "Munshi"); titles their Dashboard. */
  roleName?: string | null;
}

/**
 * One voucher line as the dispatch scanner sees it. Cartons are the enforced unit — one
 * scan is one carton, a dozen is two cartons (@erp/domain units.ts); pairs are derived.
 */
export interface DispatchLineProgress {
  lineItemId: string;
  productVariantId: string;
  article: string;
  color: string;
  size: string;
  requiredDzn: number;
  requiredCartons: number;
  dispatchedCartons: number;
  requiredPairs: number;
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

export interface StoredSessionProfile {
  id: string;
  username: string;
  token: string;
  role: "USER" | "ADMIN";
  lastUsedAt?: string;
}

export interface StoredSessionState {
  activeToken: string | null;
  profiles: StoredSessionProfile[];
}

/** Encrypted, main-process persistence of the active session and saved profiles. */
export interface SessionStoreApi {
  load(): Promise<StoredSessionState>;
  save(profile: StoredSessionProfile): Promise<StoredSessionState>;
  remove(token: string): Promise<StoredSessionState>;
  clear(): Promise<StoredSessionState>;
}

export interface DesktopApi {
  getRuntime(): Promise<{
    dbPath: string;
    /** Persistent data folder (database, images, logs, backups). */
    dataRoot?: string;
    /** Outcome of the one-time move from the legacy temp location. */
    dataMigration?: "ALREADY_PRESENT" | "FRESH_INSTALL" | "MIGRATED" | "FAILED";
    appVersion: string;
  }>;
  getSession(token?: string): Promise<AuthUser | null>;
  /** Optional so older preloads and unit-test doubles keep working (the app then starts signed out). */
  sessionStore?: SessionStoreApi;
  /** True once any ADMIN account exists. False routes the renderer to first-run setup instead of sign-in. */
  hasAnyAdmin(): Promise<{ hasAdmin: boolean }>;
  /** One-time creation of the first ADMIN. The backend rejects every call once an ADMIN already exists. */
  bootstrapAdmin(username: string, password: string, confirmPassword: string): Promise<{ accepted: boolean; user?: AuthUser; token?: string; reason?: string }>;
  signIn(username: string, password: string): Promise<{ accepted: boolean; user?: AuthUser; token?: string; reason?: string }>;
  signUp(username: string, password: string, confirmPassword: string): Promise<{ accepted: boolean; user?: AuthUser; token?: string; reason?: string }>;
  changePassword(currentPassword: string, newPassword: string, confirmNewPassword: string, token?: string): Promise<{ accepted: boolean; reason?: string }>;
  logout(token?: string): Promise<{ accepted: boolean; reason?: string }>;
  requestAccess(token?: string): Promise<{ accepted: boolean; status?: "PENDING" | "APPROVED" | "REJECTED"; reason?: string }>;
  getAccessRequests(token?: string): Promise<{ accepted: boolean; requests: Array<{ id: string; username: string; status: "PENDING" | "APPROVED" | "REJECTED"; requestedAt: string; reviewedAt: string | null }>; reason?: string }>;
  getMyAccessRequest?(token?: string): Promise<{ accepted: boolean; request?: { status: "PENDING" | "APPROVED" | "REJECTED" } | null; reason?: string }>;
  reviewAccessRequest(token: string, requestId: string, decision: "APPROVED" | "REJECTED", permissions?: string[], roleCode?: string): Promise<{ accepted: boolean; reason?: string }>;
  listMembers?(token?: string): Promise<{ accepted: boolean; members: Array<{ id: string; username: string; role: "USER" | "ADMIN"; jobRole: string; authorityLevel: number; accessStatus: "PENDING" | "APPROVED" | "REJECTED"; permissions: string[]; lastLoginAt: string | null; accessRequestId: string | null; roleCode: string | null; roleName: string | null; additionalPermissions: string[] }>; reason?: string }>;
  createPermissionRequest?(token: string, permissionCode: string, reason?: string): Promise<{ accepted: boolean; id?: string; permissionCode?: string; status?: "PENDING" | "APPROVED" | "REJECTED"; reason?: string }>;
  getPermissionRequests?(token?: string): Promise<{ accepted: boolean; requests: Array<{ id: string; userId: string; username: string; permissionCode: string; reason: string | null; status: "PENDING" | "APPROVED" | "REJECTED"; createdAt: string; requestedAt: string; reviewedAt: string | null; reviewedBy: string | null; reviewNotes: string | null }>; reason?: string }>;
  getMyPermissionRequests?(token?: string): Promise<{ accepted: boolean; requests: Array<{ id: string; permissionCode: string; reason: string | null; status: "PENDING" | "APPROVED" | "REJECTED"; createdAt: string; requestedAt: string; reviewedAt: string | null; reviewNotes: string | null }>; reason?: string }>;
  reviewPermissionRequest?(token: string, requestId: string, decision: "APPROVED" | "REJECTED", reviewNotes?: string): Promise<{ accepted: boolean; permissionCode?: string; userId?: string; status?: "APPROVED" | "REJECTED"; reason?: string }>;
  setUserAdditionalPermissions?(token: string, userId: string, permissions: string[]): Promise<{ accepted: boolean; reason?: string }>;
  getUserAdditionalPermissions?(token: string, userId: string): Promise<{ accepted: boolean; permissions: string[]; reason?: string }>;
  updateUserPermissions?(token: string, userId: string, permissions: string[]): Promise<{ accepted: boolean; reason?: string }>;
  updateMemberJobRole?(token: string, userId: string, jobRole: string): Promise<{ accepted: boolean; reason?: string }>;
  updateMemberAuthority?(token: string, userId: string, authorityLevel: number): Promise<{ accepted: boolean; reason?: string }>;
  getJobRoleOptions?(token?: string): Promise<{ accepted: boolean; roles: string[]; reason?: string }>;
  listRoles?(token?: string): Promise<{ accepted: boolean; roles: Array<{ code: string; name: string; description: string | null; permissions: string[]; memberCount: number; loginPolicy?: "ALWAYS_LOGGED_IN" | "DAILY_LOGIN" }>; reason?: string }>;
  createRole?(token: string, input: { name: string; description?: string; permissions: string[]; loginPolicy?: "ALWAYS_LOGGED_IN" | "DAILY_LOGIN" }): Promise<{ accepted: boolean; role?: { code: string; name: string; description: string | null; permissions: string[]; loginPolicy?: "ALWAYS_LOGGED_IN" | "DAILY_LOGIN" }; reason?: string }>;
  updateRole?(token: string, roleCode: string, input: { name?: string; description?: string; permissions?: string[]; loginPolicy?: "ALWAYS_LOGGED_IN" | "DAILY_LOGIN" }): Promise<{ accepted: boolean; role?: { code: string; name: string; description: string | null; permissions: string[]; loginPolicy?: "ALWAYS_LOGGED_IN" | "DAILY_LOGIN" }; reason?: string }>;
  deleteRole?(token: string, roleCode: string): Promise<{ accepted: boolean; reason?: string }>;
  assignUserRole?(token: string, userId: string, roleCode: string): Promise<{ accepted: boolean; reason?: string }>;
  getUserNotifications?(token?: string): Promise<{ accepted: boolean; notifications: Array<{ id: string; title: string; message: string; createdAt: string; readAt: string | null; kind?: string | null; entityId?: string | null; severity?: "INFO" | "WARNING" | "CRITICAL" }>; reason?: string }>;
  markNotificationRead?: (
  token: string,
  notificationId: string
) => Promise<{
  accepted: boolean;
  reason?: string;
}>;
  workspaceUsers?(token?: string): Promise<{ accepted: boolean; users: Array<{ id: string; username: string; jobRole: string; authorityLevel: number; isAdmin: boolean }>; reason?: string }>;
  workspaceTaskAssignees?(token?: string): Promise<{ accepted: boolean; users: Array<{ id: string; username: string; jobRole: string }>; reason?: string }>;
  workspaceAdmin?(token?: string): Promise<{ accepted: boolean; userId?: string; reason?: string }>;
  workspaceMessages?(token?: string): Promise<{ accepted: boolean; messages: Array<{ id: string; message: string; created_at: string; sender_name: string }>; reason?: string }>;
  workspaceSendMessage?(token: string, recipientId: string, message: string): Promise<{ accepted: boolean; id?: string; reason?: string }>;
  workspaceTasks?(token: string, assignedByMe?: boolean): Promise<{ accepted: boolean; tasks: unknown[]; reason?: string }>;
  workspaceCreateTask?(token: string, input: Record<string, unknown>): Promise<{ accepted: boolean; id?: string; reason?: string }>;
  workspaceRequests?(token: string): Promise<{ accepted: boolean; requests: unknown[]; reason?: string }>;
  workspaceCreateRequest?(token: string, input: Record<string, unknown>): Promise<{ accepted: boolean; id?: string; reason?: string }>;
  workspaceUpdateStatus?(token: string, kind: "TASK" | "REQUEST", id: string, status: string): Promise<{ accepted: boolean; reason?: string }>;
  workspaceActivity?(token: string): Promise<{ accepted: boolean; activity: unknown[]; reason?: string }>;
  revokeUserAccess?(token: string, userId: string): Promise<{ accepted: boolean; reason?: string }>;
  getDashboard(): Promise<DashboardSnapshot>;
  listInventory(search: string): Promise<InventoryRow[]>;
  listInventoryUnits(): Promise<Array<Record<string, unknown>>>;
  listWorkSections(): Promise<WorkSection[]>;
  startRawMaterialReceivingSession(
    partyId: string,
    opts?: { token?: string }
  ): Promise<{ accepted: boolean; session?: RawMaterialReceivingSession; reason?: string }>;
  getOpenRawMaterialReceivingSession(): Promise<RawMaterialReceivingSession | null>;
  closeRawMaterialReceivingSession(sessionId: string): Promise<RawMaterialReceivingSession | null>;
  getRawMaterialReceivingSessionSummary(sessionId: string): Promise<RawMaterialReceivingSessionSummary | null>;
  listRawMaterialReceivingSessions(filters?: {
    status?: "OPEN" | "CLOSED";
    partyId?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  }): Promise<RawMaterialReceivingSession[]>;
  rawMaterialReceiptScan(
    rawScan: string,
    opts?: { token?: string; sessionId?: string }
  ): Promise<RawMaterialReceiptResult>;
  startRawMaterialIssueSession(
    opts?: { token?: string; startNew?: boolean }
  ): Promise<{ accepted: boolean; session?: RawMaterialIssueSession; reason?: string }>;
  /** This terminal's open issue session from today, or null. Never starts one. */
  getOpenRawMaterialIssueSession(): Promise<RawMaterialIssueSession | null>;
  closeRawMaterialIssueSession(sessionId: string): Promise<RawMaterialIssueSession | null>;
  getRawMaterialIssueSessionSummary(sessionId: string): Promise<RawMaterialIssueSessionSummary | null>;
  rawMaterialIssueScan(
    rawScan: string,
    /** issuedToPartyId: who the packet is moved out to — required by the main process. */
    opts?: { token?: string; sessionId?: string; issuedToPartyId?: string }
  ): Promise<RawMaterialIssueResult>;
  createWorkSection(name: string): Promise<{ accepted: boolean; section?: WorkSection; reason?: string }>;

  // ─── Machines and the Machine Program ───────────────────────────────────────
  // The machines are master data (Raw Material → Setup). The Machine Program is read-only: the
  // carton QRs the QR Generator registered, per product and colour, derived in the main process.
  listMachines(includeInactive?: boolean): Promise<MachineRecord[]>;
  createMachine(input: { name: string; sectionId?: string }): Promise<{ accepted: boolean; machine?: MachineRecord; reason?: string }>;
  setMachineStatus(machineId: string, status: "ACTIVE" | "INACTIVE"): Promise<{ accepted: boolean; reason?: string }>;
  /** Dana for a sole colour — Store Out's Dana issue for programs still open. */
  listMachineProgramDana(colour: string): Promise<{ accepted: boolean; rows: MachineProgramMaterial[]; reason?: string }>;
  setProductSubGroupHasNoUpper(id: string, hasNoUpper: boolean): Promise<{ accepted: boolean; reason?: string }>;
  /** Every machine's program for one business date (YYYY-MM-DD). */
  listMachineDayPrograms(programDate: string): Promise<{ accepted: boolean; rows: MachineDayProgram[]; reason?: string }>;
  /** Every program still open, whatever its date (0.3.8). */
  listOpenMachinePrograms(): Promise<{ accepted: boolean; rows: OpenMachineProgram[]; reason?: string }>;
  /** Deletes (cancels) one program. Administrators only; the reason is required and audited. */
  deleteMachineProgram(programId: string, reason: string): Promise<{ accepted: boolean; outcome: string; reason?: string }>;
  /** The runs behind one program line, each kept on its own. */
  listCartonProgramBatches(input: {
    programId: string;
    articleSizeId: string;
    color: string;
    grade: "B" | null;
  }): Promise<{ accepted: boolean; rows: CartonProgramBatch[]; reason?: string }>;
  /** + Add Machine: the machine and both of its contractors, in one step. */
  addMachine(input: {
    name: string;
    contractorPartyId: string;
    packingContractorPartyId: string;
  }): Promise<MachineProgramWriteResult & { machineId?: string }>;
  /** Reconciliation: every machine program of one business date. */
  listReconcilablePrograms(programDate: string): Promise<{ accepted: boolean; rows: ReconcilableProgram[]; reason?: string }>;
  /** Reconciliation: Upper Out against Production Received for one machine program. */
  getProgramReconciliation(programId: string): Promise<{ accepted: boolean; reconciliation: ProgramReconciliation | null; reason?: string }>;
  /** Changes one of a machine's two contractors; it stays until changed again. */
  assignMachineContractor(input: {
    machineId: string;
    role: MachineContractorRole;
    contractorPartyId: string;
  }): Promise<MachineProgramWriteResult>;
  // ── Store Out through one open Machine Program ───────────────────────────────
  /** Resolves what the operator typed, scanned or clicked through from a notification. */
  openMachineProgramStoreOut(lookup: string, opts?: { token?: string }): Promise<OpenMachineProgramStoreOutResult>;
  /** Judges one scan against the open program. Writes nothing — Save Batch does that. */
  machineProgramStoreOutCheckScan(
    input: { programId: string; rawScan: string; batchQrIds: string[] },
    opts?: { token?: string }
  ): Promise<MachineProgramScanCheckResult>;
  /** Commits the batch: every packet out of the store in one transaction, or none of them. */
  machineProgramStoreOutSaveBatch(
    input: { programId: string; batchKey: string; sessionId?: string | null; qrIds: string[] },
    opts?: { token?: string }
  ): Promise<SaveMachineProgramBatchResult>;
  /** Every batch already issued against a program, newest first. */
  listMachineProgramIssueBatches(
    programId: string,
    opts?: { token?: string }
  ): Promise<{ accepted: boolean; rows: MachineProgramIssueBatchRow[] }>;
  /** Every packet of uppers out for a program, with the cartons it is owed and whether they are printed. */
  listMachineProgramCartonPackets(
    programId: string,
    opts?: { token?: string }
  ): Promise<{
    accepted: boolean;
    reason?: string;
    rows: MachineProgramCartonPacket[];
    progress: MachineProgramLineCartons[];
    /** FIX articles: their cartons are owed by the plan, since no packet ever leaves for them. */
    fixRuns?: MachineProgramFixCartonRun[];
  }>;
  /**
   * Generates carton QR labels and records the print, exactly once.
   *
   * `eventIds` labels the cartons owed to issued packets of uppers; `runId` labels what a FIX
   * article's run plans, which has no packet to be owed to. One or the other, never both.
   */
  printMachineProgramCartons(
    input: { programId: string; eventIds?: string[]; runId?: string },
    opts?: { token?: string }
  ): Promise<{ accepted: boolean; reason?: string; batch?: QrBatchRow; qrCodes?: QrCodeRow[] }>;
  /**
   * Reconciliation for EVR FIX: `count` of a FIX run's labels that did not come back become B
   * cartons — those labels are voided and as many new MIX labels, grade B, are generated.
   */
  convertMachineProgramCartonsToB(
    input: { programId: string; runId: string; count: number },
    opts?: { token?: string }
  ): Promise<{ accepted: boolean; reason?: string; batch?: QrBatchRow; qrCodes?: QrCodeRow[]; voidedQrIds?: string[] }>;
  /** Store In: one of the program's carton labels scanned back — produced and stored in, or refused. */
  machineProgramCartonIn(
    input: { programId: string; rawScan: string },
    opts?: { token?: string }
  ): Promise<MachineProgramCartonInResult>;
  /** How a program stands against the cartons back: due, back and missing uppers per line, and how it closed. */
  getMachineProgramReconciliation(
    programId: string,
    opts?: { token?: string }
  ): Promise<{ accepted: boolean; reason?: string; reconciliation?: MachineProgramReconciliation }>;
  /** Complete Program: COMPLETE when every carton is back, otherwise RECONCILED with every remaining pair accounted for. */
  completeMachineProgramProduction(
    input: { programId: string; entries: ReconciliationEntryInput[] },
    opts?: { token?: string }
  ): Promise<{ accepted: boolean; reason?: string; closure?: MachineProgramClosure }>;
  /** Return Upper: a sealed packet that went out for the program, scanned back to the store. Moves stock. */
  returnMachineProgramUpper(
    input: { programId: string; rawScan: string },
    opts?: { token?: string }
  ): Promise<UpperReturnResult>;
  /**
   * B cartons of an upper line: `count` MIX labels, grade B, are generated, and every original label
   * of the line that is not back is voided.
   */
  convertMachineProgramUpperCartonsToB(
    input: { programId: string; lineId: string; count: number },
    opts?: { token?: string }
  ): Promise<{ accepted: boolean; reason?: string; batch?: QrBatchRow; qrCodes?: QrCodeRow[]; voidedQrIds?: string[] }>;
  /** Every Dana the store holds in a sole colour this program runs. */
  listMachineProgramDanaOptions(
    programId: string,
    opts?: { token?: string }
  ): Promise<{ accepted: boolean; rows: MachineProgramDanaOption[] }>;
  /** Issues whole bags of one Dana out of the store for a program. Moves stock. */
  issueMachineProgramDana(
    input: { programId: string; itemId: string; quantity: number; unitCode: string },
    opts?: { token?: string }
  ): Promise<MachineProgramDanaIssueResult>;
  /** Every Dana issue already made for a program, newest first. */
  listMachineProgramDanaIssues(
    programId: string,
    opts?: { token?: string }
  ): Promise<{ accepted: boolean; rows: MachineProgramDanaIssueRow[] }>;
  /** What a material may be moved by hand in this direction. Null when it is not in the master. */
  getRawMaterialHandMoveOptions(
    itemId: string,
    direction: HandMoveDirection,
    opts?: { token?: string }
  ): Promise<RawMaterialHandMoveOptions | null>;
  /** Moves a typed quantity on or off a material's balance and records that it came in or left. */
  moveRawMaterialByHand(
    input: {
      itemId: string;
      direction: HandMoveDirection;
      quantity: number;
      unitCode: string;
      /** Who delivered it. Required moving IN. */
      partyId?: string | null;
      note?: string | null;
    },
    opts?: { token?: string }
  ): Promise<RawMaterialHandMoveResult>;
  listRawMaterialMovementConfig(search?: string): Promise<RawMaterialMovementConfigRow[]>;
  setRawMaterialMovementConfig(
    itemId: string,
    input: {
      packingQuantity: number | null;
      packingUnitId: string | null;
      defaultSectionId: string | null;
      /** Left out keeps the saved name; an empty string clears it back to the default. */
      packName?: string | null;
    }
  ): Promise<{ accepted: boolean; reason?: string }>;
  getRawMaterialSetupTemplate(categoryId: string): Promise<RawMaterialSetupTemplate | null>;
  applyRawMaterialSetupToCategory(
    categoryId: string,
    setup: { packName?: string | null; packingQuantity?: number | null; packingUnitId?: string | null; hopSectionIds: string[] }
  ): Promise<{ accepted: boolean; updated?: number; reason?: string }>;
  createInventoryUnit(input: Record<string, unknown>): Promise<{ accepted: boolean; id?: string; reason?: string }>;
  listInventoryUnitConversions(): Promise<Array<Record<string, unknown>>>;
  createInventoryUnitConversion(input: Record<string, unknown>): Promise<{ accepted: boolean; id?: string; reason?: string }>;
  listInventoryCategories(): Promise<Array<Record<string, unknown>>>;
  createInventoryCategory(input: Record<string, unknown>): Promise<{ accepted: boolean; id?: string; reason?: string }>;
  updateInventoryCategory(categoryId: string, input: Record<string, unknown>): Promise<{ accepted: boolean; reason?: string }>;
  addInventoryCategoryField(input: Record<string, unknown>): Promise<{ accepted: boolean; id?: string; reason?: string }>;
  updateInventoryCategoryField(fieldId: string, input: Record<string, unknown>): Promise<{ accepted: boolean; reason?: string }>;
  removeInventoryCategoryField(fieldId: string): Promise<{ accepted: boolean; reason?: string }>;
  addInventoryFieldOption(input: Record<string, unknown>): Promise<{ accepted: boolean; id?: string; reason?: string }>;
  /** Materials still carrying a dropdown choice — what removing it would leave describing itself with a value the category no longer offers. */
  inventoryFieldOptionUsage(optionId: string): Promise<{ accepted: boolean; items?: Array<{ itemCode: string; displayName: string }>; reason?: string }>;
  deleteInventoryFieldOption(optionId: string): Promise<{ accepted: boolean; optionValue?: string; reason?: string }>;
  /** Why a material cannot be deleted, in the operator's words; empty means it is safe to delete. */
  inventoryItemDeleteBlockers(itemId: string): Promise<{ accepted: boolean; blockers?: string[]; reason?: string }>;
  deleteInventoryItem(itemId: string): Promise<{ accepted: boolean; itemCode?: string; displayName?: string; reason?: string }>;
  setInventoryItemStatus(itemId: string, status: "ACTIVE" | "INACTIVE"): Promise<{ accepted: boolean; status?: string; reason?: string }>;
  /** Why a generated run of labels cannot be erased; empty means not one of them has been scanned. */
  rawMaterialQrBatchDeleteBlockers(batchId: string): Promise<{ accepted: boolean; blockers?: string[]; reason?: string }>;
  deleteRawMaterialQrBatch(batchId: string): Promise<{ accepted: boolean; quantity?: number; nextSequence?: number; reason?: string }>;
  listInventoryItems(query?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  createInventoryItem(input: Record<string, unknown>): Promise<{ accepted: boolean; id?: string; code?: string; displayName?: string; duplicate?: boolean; reason?: string }>;
  adjustInventoryStock(input: Record<string, unknown>): Promise<{ accepted: boolean; reason?: string }>;
  queryInventoryStock(filters?: Record<string, unknown>): Promise<{ itemCount: number; totalsByUnit: Array<{ unitId: string; unitCode: string; quantity: number }>; equivalent?: { unitId: string; unitCode: string; quantity: number } }>;
  listInventoryStockEvents(itemId: string, limit?: number): Promise<InventoryStockEventRow[]>;
  createStockCorrectionRequest(input: Record<string, unknown>): Promise<{ accepted: boolean; request?: StockCorrectionRequest; reason?: string }>;
  listStockCorrectionRequests(filters?: Record<string, unknown>): Promise<StockCorrectionRequest[]>;
  listStockCorrectionRequestsForItem(itemId: string, limit?: number): Promise<StockCorrectionRequest[]>;
  reviewStockCorrectionRequest(
    requestId: string,
    decision: "APPROVED" | "REJECTED",
    reviewNotes?: string
  ): Promise<{ accepted: boolean; request?: StockCorrectionRequest; reason?: string }>;

  // Removing a category, with an administrator's approval.
  categoryRemovalBlockers(categoryId: string): Promise<{ accepted: boolean; blockers?: string[]; reason?: string }>;
  createCategoryRemovalRequest(input: {
    categoryId: string;
    reason?: string;
  }): Promise<{ accepted: boolean; request?: RemovalRequest; reason?: string }>;
  listRemovalRequestsForTarget(targetId: string, limit?: number): Promise<RemovalRequest[]>;
  reviewRemovalRequest(
    requestId: string,
    decision: "APPROVED" | "REJECTED",
    reviewNotes?: string,
  ): Promise<{ accepted: boolean; request?: RemovalRequest; reason?: string }>;
  removeInventoryCategory(
    categoryId: string,
    reason?: string,
  ): Promise<{ accepted: boolean; request?: RemovalRequest; reason?: string }>;

  // Erasing a raw material for good, with an administrator's approval. `cost` is what would
  // be erased with it — its own stock and movements.
  itemRemovalBlockers(
    itemId: string,
  ): Promise<{ accepted: boolean; blockers?: string[]; cost?: string[]; reason?: string }>;
  createItemRemovalRequest(input: {
    itemId: string;
    reason?: string;
  }): Promise<{ accepted: boolean; request?: RemovalRequest; reason?: string }>;
  removeInventoryItemForGood(
    itemId: string,
    reason?: string,
  ): Promise<{ accepted: boolean; request?: RemovalRequest; reason?: string }>;

  // Re-filing: a category under another parent, a material under another category.
  previewCategoryMove(
    categoryId: string,
    newParentId: string | null,
  ): Promise<{ accepted: boolean; preview?: CategoryMovePreview; reason?: string }>;
  moveInventoryCategory(categoryId: string, newParentId: string | null): Promise<{ accepted: boolean; reason?: string }>;
  previewInventoryItemMove(
    itemId: string,
    targetCategoryId: string,
  ): Promise<{ accepted: boolean; preview?: InventoryItemMovePreview; reason?: string }>;
  moveInventoryItem(itemId: string, targetCategoryId: string): Promise<{ accepted: boolean; reason?: string }>;

  // A material's own ladder of units: 1 ROLL = 975 METRE, 1 METRE = 40 INCH.
  getInventoryItemUnitLadder(itemId: string): Promise<{ accepted: boolean; ladder?: ItemUnitLadder; reason?: string }>;
  setInventoryItemUnitLadder(input: {
    itemId: string;
    steps: Array<{ fromUnitId: string; toUnitId: string; factor: number }>;
  }): Promise<{ accepted: boolean; ladder?: ItemUnitLadder; reason?: string }>;
  listInventoryItemUnitLadders(): Promise<Record<string, ItemUnitLadderStep[]>>;
  /** Re-states a material in another unit WITHOUT converting the figure. Carries a reason. */
  correctInventoryItemUnit(input: {
    itemId: string;
    unitId: string;
    reason: string;
    /** Change every colour of this material too. */
    alsoColours?: boolean;
  }): Promise<{
    accepted: boolean;
    result?: { fromUnitCode: string | null; toUnitCode: string; movementsRestamped: number };
    colours?: { applied: number; skipped: Array<{ displayName: string; reason: string }> };
    reason?: string;
  }>;
  inventoryItemColourSiblings(itemId: string): Promise<Array<{ id: string; displayName: string }>>;
  applyUnitLadderToColours(
    itemId: string,
  ): Promise<{ accepted: boolean; applied?: number; skipped?: Array<{ displayName: string; reason: string }>; reason?: string }>;
  listUnitLadderPresets(): Promise<UnitLadderPreset[]>;
  saveUnitLadderPreset(input: {
    name: string;
    steps: Array<{ fromUnitId: string; toUnitId: string; factor: number }>;
  }): Promise<{ accepted: boolean; preset?: UnitLadderPreset; reason?: string }>;
  deleteUnitLadderPreset(presetId: string): Promise<{ accepted: boolean; reason?: string }>;
  getInventoryImportColumns(categoryId: string): Promise<{ accepted: boolean; columns?: InventoryImportColumn[]; reason?: string }>;
  importInventoryItems(input: Record<string, unknown>): Promise<{ accepted: boolean; result?: InventoryImportResult; reason?: string }>;
  updateInventoryItemPrice(itemId: string, costPrice: number | null): Promise<{ accepted: boolean; reason?: string }>;
  /** Only while the material has no stock, movement or label yet — see setInventoryItemUnit. */
  setInventoryItemUnit(itemId: string, unitId: string): Promise<{ accepted: boolean; reason?: string }>;
  listProducts(query: Record<string, unknown>): Promise<PagedResult<ProductRow>>;
  getProduct(id: string): Promise<ProductRow | null>;
  getSaleableVariant(id: string): Promise<SaleableVariant | null>;
  generateQrBatch(input: {
    articleSizeId: string;
    color: string;
    quantity: number;
    createdBy?: string;
    requestedBy?: string;
    /** "B" registers the run as B carton labels — MIX, with a B on the sticker (migration 074). */
    grade?: "B";
    /** The machine the cartons are for; the run joins its program for the day. Required. */
    machineId: string;
  }): Promise<{ accepted: boolean; batch?: QrBatchRow; qrCodes?: QrCodeRow[]; program?: MachineDayProgramRef | null; reason?: string }>;
  listQrBatches(
    input?: number | { limit?: number; sinceIso?: string },
  ): Promise<QrBatchRow[]>;
  listQrCodesForBatch(batchId: string): Promise<QrCodeRow[]>;
  listQrColors(): Promise<string[]>;
  getQrSequenceState(input: { articleSizeId: string; color: string }): Promise<QrSequenceState | null>;
  searchQrCodes(query: string, limit?: number): Promise<QrSearchRow[]>;
  getQrDetail(qrId: string): Promise<QrDetail | null>;
  getQrJourney(qrId: string): Promise<QrJourney | null>;
  getQrGenerationOverview(filter?: QrGenerationFilter): Promise<QrGenerationOverview>;
  listQrGenerationFilterOptions(): Promise<QrGenerationFilterOptions>;
  listProductListEntries(kind: ProductListKind): Promise<ProductListEntry[]>;
  renameProductListEntry(input: { kind: ProductListKind; id: string; newName: string }): Promise<{ accepted: boolean; reason?: string; affected?: number; name?: string }>;
  deleteProductListEntry(input: { kind: ProductListKind; id: string; actor?: string | null; reason?: string }): Promise<{ accepted: boolean; reason?: string; affected?: number }>;
  listQrBatchMembers(batchId: string, opts?: { page?: number; pageSize?: number }): Promise<PagedResult<QrBatchMemberRow>>;
  voidQrCode(input: { qrId: string; reason: string; actor?: string | null }): Promise<{ accepted: boolean; reason?: string }>;
  restoreQrCode(input: { qrId: string }): Promise<{ accepted: boolean; reason?: string }>;
  markQrCodeDamaged(input: { qrId: string; reason: string; actor?: string | null }): Promise<{ accepted: boolean; reason?: string; eventId?: string }>;
  generateRawMaterialQrBatch(input: {
    partyId: string;
    itemId: string;
    quantity: number;
    /** What one packet in this run holds, in the material's stock unit. Required. */
    packingQuantity: number;
    createdBy?: string;
    requestedBy?: string;
  }): Promise<{ accepted: boolean; batch?: RawMaterialQrBatchRow; qrCodes?: RawMaterialQrRow[]; reason?: string }>;
  listRawMaterialQrBatches(input?: { limit?: number; sinceIso?: string }): Promise<RawMaterialQrBatchRow[]>;
  listRawMaterialQrsForBatch(batchId: string): Promise<RawMaterialQrRow[]>;
  /** One already-generated packet label, for reprinting it exactly as it was printed. */
  getRawMaterialQrLabel(qrId: string): Promise<RawMaterialQrLabel | null>;
  getRawMaterialQrSequenceState(input: { partyId: string; itemId: string }): Promise<RawMaterialQrSequenceState | null>;
  createProduct(input: Record<string, unknown>): Promise<string>;
  updateProduct(id: string, input: Record<string, unknown>): Promise<void>;
  disableProduct(id: string): Promise<void>;
  enableProduct(id: string): Promise<{ accepted: boolean; reason?: string }>;
  getProductImage(article: string): Promise<string | null>;
  saveProductImage(article: string, dataUrl: string): Promise<{ accepted: boolean; fileName?: string; reason?: string }>;
  saveRateList(payload: { html: string; fileName: string }): Promise<{ accepted: boolean; canceled?: boolean; filePath?: string; reason?: string }>;
  /** Prints a ready-made document on the default printer, with no dialog. Page size in inches. */
  printDocument(payload: { html: string; pageSize?: { widthIn: number; heightIn: number } }): Promise<{ accepted: boolean; reason?: string }>;
  listHistory(query: Record<string, unknown>): Promise<PagedResult<HistoryRow>>;
  listDispatchHistory(query: Record<string, unknown>): Promise<PagedResult<HistoryRow>>;
  listDispatchSessions(filter?: Record<string, unknown>): Promise<DispatchSessionSummary[]>;
  getDispatchSession(sessionId: string): Promise<DispatchSessionDetail | null>;
  getReport(query: Record<string, unknown>): Promise<ReportSummary>;
  processScan(rawScan: string): Promise<{
    accepted: boolean;
    qrId?: string;
    parserVersion?: string;
    reason?: string;
    /** The identity had never been generated and was registered by this scan. */
    registeredOnScan?: boolean;
  }>;
  /** Receive Production: one scanned or typed carton QR recorded as produced, exactly once. */
  receiveProduction(rawScan: string): Promise<ReceiveProductionResult>;
  /** One business day's receipts (YYYY-MM-DD), newest first, a page at a time. */
  listProductionReceipts(query: {
    date: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ accepted: boolean; page: ProductionReceiptPage | null; reason?: string }>;
  /** Whether a carton is recorded as produced, as the database says — for an uncertain outcome. */
  findProductionReceipt(qrId: string): Promise<{ accepted: boolean; receipt: ProductionReceipt | null; reason?: string }>;
  /** Manual Production: cartons typed in (in dozens) for a machine — its program today, store stock, the ledgers. */
  recordManualProduction(input: { requestId: string; machineId: string; articleSizeId: string; color: string; dozens: string }): Promise<ManualProductionResult>;
  /** One business day's Manual Production (YYYY-MM-DD), newest first, a page at a time. */
  listManualProduction(query: { date: string; page?: number; pageSize?: number }): Promise<{ accepted: boolean; page: ManualProductionPage | null; reason?: string }>;
  /** Upper Move Out: one upper packet issued out of the store to the named machine. */
  issueUpperToMachine(rawScan: string, machineId: string): Promise<UpperIssueResult>;
  /** One business day's issues to one machine, newest first, a page at a time. */
  listUpperIssues(query: { machineId: string; date: string; page?: number; pageSize?: number }): Promise<{ accepted: boolean; page: UpperIssuePage | null; reason?: string }>;
  /** This session / this day to one machine, and the upper stock in the store. */
  getUpperIssueSummary(query: { machineId: string; date: string }): Promise<{ accepted: boolean; summary: UpperIssueSummary | null; reason?: string }>;
  /** Every upper material with stock in the store; `search` matches name, article, size, colour. */
  listUpperStock(query: { search?: string }): Promise<{ accepted: boolean; rows: UpperStockRow[]; reason?: string }>;
  /** Whether a packet was issued to a machine, as the database says — for an uncertain outcome. */
  findUpperIssue(qrId: string): Promise<{ accepted: boolean; issue: UpperIssueRow | null; reason?: string }>;
  dispatchScan(
    rawScan: string,
    sessionId?: string,
    /** Gatepass-locked: the document is the allow-list, and it holds the carton to its colour. */
    gatepassId?: string
  ): Promise<{ accepted: boolean; qrId?: string; parserVersion?: string; reason?: string; gatepassDispatched?: boolean }>;
  // Carton returns. `returnLookup` is the read-only preview the screen shows before the
  // operator confirms; `returnScan` is the confirmation that credits the party and moves the
  // carton to ON GATE. Neither touches stock — Store Move In does that when it arrives.
  returnLookup(rawScan: string): Promise<ReturnScanResult>;
  returnScan(rawScan: string): Promise<ReturnScanResult>;
  listSaleReturns(query?: Record<string, unknown>): Promise<SaleReturnRow[]>;
  // Store Scanning — every call carries the session token; the main process authorises it.
  storeEntryScan(rawScan: string, opts?: { token?: string; sessionId?: string }): Promise<StoreEntryScanResult>;
  getStoreReceivingSession(opts?: { token?: string; startNew?: boolean }): Promise<{ accepted: boolean; session?: StoreReceivingSession; reason?: string }>;
  getStoreReceivingSessionSummary(sessionId: string, opts?: { token?: string; recentLimit?: number }): Promise<StoreReceivingSessionSummary | null>;
  // Store Move Out
  storeExitScan(rawScan: string, opts?: { token?: string; sessionId?: string; gatepassId?: string }): Promise<StoreExitScanResult>;
  getStoreMoveOutSession(opts?: { token?: string; startNew?: boolean }): Promise<{ accepted: boolean; session?: StoreMoveOutSession; reason?: string }>;
  getStoreMoveOutSessionSummary(sessionId: string, opts?: { token?: string; recentLimit?: number }): Promise<StoreMoveOutSessionSummary | null>;
  // Gatepass — every call carries the session token; the main process authorises it.
  listGatepassStock(article: string, opts?: { token?: string }): Promise<{ accepted: boolean; rows: GatepassStockRow[]; reason?: string }>;
  /** Every colour + size In Store, across all articles — the whole grid in one read. */
  listGatepassStoreStock(opts?: { token?: string }): Promise<{ accepted: boolean; rows: GatepassStockRow[]; reason?: string }>;
  createGatepass(
    input: { partyId: string; lines: GatepassLineInput[]; biltyNumber?: string | null; transportVia?: string | null; remarks?: string | null },
    opts?: { token?: string }
  ): Promise<CreateGatepassResult>;
  getGatepass(gatepassId: string, opts?: { token?: string }): Promise<Gatepass | null>;
  /** By display number (GP-000123 → 123); null when no such document. */
  getGatepassByNumber(gatepassNumber: number, opts?: { token?: string }): Promise<Gatepass | null>;
  listGatepasses(query?: GatepassListQuery, opts?: { token?: string }): Promise<PagedResult<GatepassListRow>>;
  /** How many gatepasses sit at each stage, keyed by status. One grouped count, not one query per stage. */
  countGatepassesByStage(opts?: { token?: string }): Promise<Record<string, number>>;
  /** What a Gatepass still needs at the store and at the gate, per line and in total (cartons). */
  getGatepassScanProgress(gatepassId: string, opts?: { token?: string }): Promise<GatepassScanProgress | null>;
  /** Records the builty photo. The first one delivers the Gatepass; a later one replaces it. */
  saveGatepassDeliveryProof(
    input: { gatepassId: string; dataUrl: string; originalName?: string },
    opts?: { token?: string }
  ): Promise<{ accepted: boolean; delivered?: boolean; proofId?: string; reason?: string }>;
  getGatepassDeliveryProof(gatepassId: string, opts?: { token?: string }): Promise<GatepassDeliveryProof | null>;
  getGatepassJourney(gatepassId: string, opts?: { token?: string }): Promise<GatepassJourneyStep[] | null>;
  cancelGatepass(input: { gatepassId: string; reason: string }, opts?: { token?: string }): Promise<CancelGatepassResult>;
  getItemStatus(qrId: string): Promise<{ qrId: string; wasDispatched: boolean; wasReturned: boolean }>;
  /**
   * Cloud sync. Status is read-only. A pass runs only when an administrator asks for one --
   * there is no background loop, and a computer without the four environment variables does
   * nothing at all. Neither call ever returns a key, a token or a password.
   */
  getCloudSyncStatus(): Promise<CloudSyncStatus>;
  runCloudSync(): Promise<{
    accepted: boolean;
    reason?: string;
    pushed?: number;
    fetched?: number;
    applied?: number;
    duplicates?: number;
    refused?: Array<{ reason: string }>;
    waitingFor?: string;
    outbox?: Record<string, number>;
  }>;
  /**
   * Parked sync events, and putting ONE back. Both are administrator-only, and neither sends
   * anything: a requeued event waits for the next pass an administrator asks for. The entries
   * carry no payload -- only what identifies the event and why it stopped.
   */
  listDeadLetterEvents(): Promise<{
    accepted: boolean;
    reason?: string;
    entries?: DeadLetterEvent[];
  }>;
  requeueDeadLetterEvent(outboxId: string): Promise<{
    accepted: boolean;
    reason?: string;
    entry?: DeadLetterEvent;
  }>;
  /** Read-only: which document-number range this computer holds, or why it holds none. */
  getNumberBlockStatus(): Promise<NumberBlockStatus>;
  /**
   * Records block 1 for the installation that already holds the company's numbered documents.
   * Takes no range: there is nothing to choose, and every other case is refused by the main
   * process. Administrator only, and never a second time.
   */
  adoptNumberBlock(): Promise<{
    accepted: boolean;
    range?: { block: number; lo: number; hi: number };
    reason?: string;
    code?: string;
  }>;
  /**
   * Records a range from 2 to 5 for a SECOND computer, read off the factory's own record of which
   * machine holds which range. Administrator only, never a second time, and block 1 is refused --
   * that one belongs to the installation holding the existing documents, which adopts it itself.
   */
  assignNumberBlock(block: number): Promise<{
    accepted: boolean;
    range?: { block: number; lo: number; hi: number };
    reason?: string;
    code?: string;
  }>;
  getSettings(): Promise<Record<string, string>>;
  saveSettings(entries: Record<string, string>): Promise<void>;
  resetDatabase(): Promise<{ accepted: boolean }>;
  createBackup(): Promise<BackupRecord>;
  listBackups(): Promise<BackupRecord[]>;
  getHealth(): Promise<HealthSnapshot>;
  getScannerStatus(): Promise<boolean>;
  getLogs(query: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  // Party Management
  listPartyGroups(): Promise<PartyGroup[]>;
  createPartyGroup(input: { groupName: string; description?: string }): Promise<{ accepted: boolean; groupId?: string; reason?: string }>;
  listParties(query: Record<string, unknown>): Promise<PagedResult<Party>>;
  getParty(id: string): Promise<Party | null>;
  getNextPartyCode(): Promise<string>;
  getNextProductCode(): Promise<string>;
  getCurrentPartyBalance(partyId: string): Promise<number>;
  createParty(input: Record<string, unknown>): Promise<{ accepted: boolean; partyId?: string; partyCode?: string; reason?: string }>;
  updateParty(input: Record<string, unknown>): Promise<{ accepted: boolean; reason?: string }>;
  deleteParty(partyId: string): Promise<{ accepted: boolean; reason?: string }>;
  getCustomerLedger(partyId: string, query?: Record<string, unknown>): Promise<{
    partyId: string;
    partyName: string;
    entries: Array<{
      voucherId: string;
      voucherNumber: string;
      voucherDate: string;
      bookNo: string;
      subPartyName: string | null;
      remarks: string | null;
      totalQuantity: number;
      amount: number;
      balance: number;
      lineItems: Array<{
        id: string;
        article: string;
        color: string;
        size: string;
        groupName: string | null;
        quantity: number;
        unitPrice: number;
        discount: number;
        totalPrice: number;
      }>;
    }>;
  }>;
  listCustomerBalances(query?: Record<string, unknown>): Promise<{ rows: Array<{ partyId: string; partyName: string; city: string | null; groupName: string | null; balance: number; lastVoucherDate: string | null; totalSales: number; totalReceipts: number; totalPayments: number; }>; total: number }>;
  listCities(): Promise<string[]>;
  getPartyDiscountReport(partyId: string): Promise<Array<{ partyId: string; partyName: string; type: "ARTICLE" | "ARTICLE_SERIES" | "PRICE_RANGE" | "PRODUCT_GROUP"; label: string; discountPerPair: number }>>;

  // Cash voucher methods
  getNextCashVoucherNumber(): Promise<number>;
  createCashVoucher(input: Record<string, unknown>): Promise<{ accepted: boolean; voucherId?: string; reason?: string }>;
  updateCashVoucher(voucherId: string, input: Record<string, unknown>): Promise<{ accepted: boolean; reason?: string }>;
  getCashVoucher(id: string): Promise<CashVoucher | null>;
  getCashVoucherByNumber(voucherNumber: number): Promise<CashVoucher | null>;
  listCashVouchers(query?: Record<string, unknown>): Promise<PagedResult<CashVoucher>>;
  deleteCashVoucher(id: string): Promise<{ accepted: boolean; reason?: string }>;
  getCustomerLedgerWithCash(partyId: string, query?: Record<string, unknown>): Promise<{
    partyId: string;
    partyName: string;
    balanceLimit: number | null;
    openingBalance: number;
    closingBalance: number;
    entries: Array<{
      voucherId: string;
      voucherNumber: string;
      voucherDate: string;
      voucherType: "SALE" | "CASH_RECEIPT" | "CASH_PAYMENT";
      description: string;
      modeOfTransfer?: string;
      onlineFrom?: string;
      onlineTo?: string;
      bankAccountTitle?: string;
      chequeNumber?: string;
      chequeDate?: string;
      referenceNo?: string;
      debitAmount: number;
      creditAmount: number;
      balance: number;
      lineItems?: Array<{
        id: string;
        article: string;
        color: string;
        size: string;
        groupName: string | null;
        quantity: number;
        unitPrice: number;
        discount: number;
        totalPrice: number;
      }>;
    }>;
  }>;
  resolveProductDiscount(partyId: string, productVariantId: string): Promise<{ discountPerPair: number; source: "ARTICLE" | "ARTICLE_SERIES" | "PRICE_RANGE" | "PRODUCT_GROUP" | "NONE"; ruleId?: string }>;
  resolveProductDiscountWithPrice(partyId: string, productVariantId: string, actualPrice: number): Promise<{ discountPerPair: number; source: "ARTICLE" | "ARTICLE_SERIES" | "PRICE_RANGE" | "PRODUCT_GROUP" | "NONE"; ruleId?: string }>;
  // Product Group Management
  listProductGroups(): Promise<ProductGroup[]>;
  createProductGroup(input: { groupName: string; description?: string }): Promise<{ accepted: boolean; groupId?: string; reason?: string }>;
  listArticleSeries(): Promise<Array<{ id: string; name: string; description?: string | null; isActive: boolean }>>;
  createArticleSeries(input: { name: string; description?: string }): Promise<{ accepted: boolean; id?: string; reason?: string }>;
  /** The flat Product Type list. */
  listProductTypes(): Promise<ProductTypeRow[]>;
  createProductType(input: { name: string; description?: string | null }): Promise<{ accepted: boolean; id?: string; reason?: string }>;
  /** The sub groups of one product group, or every one of them when no group is named. */
  listProductSubGroups(productGroupId?: string): Promise<ProductSubGroupRow[]>;
  createProductSubGroup(input: { productGroupId: string; name: string; description?: string | null; hasNoUpper?: boolean }): Promise<{ accepted: boolean; id?: string; reason?: string }>;
  createPartyProductGroupDiscount(input: { partyId: string; productGroupId: string; discountPerPair: number }): Promise<{ accepted: boolean; id?: string; reason?: string }>;
  createPartyArticleSeriesDiscount(input: { partyId: string; articleSeriesId: string; discountPerPair: number }): Promise<{ accepted: boolean; id?: string; reason?: string }>;
  /** `article` is the article name (a rule covers every colour of it). */
  createPartyArticleDiscount(input: { partyId: string; article: string; sizeScope?: "ALL_SIZES" | "SEPARATE_SIZES"; size?: string | null; discountPerPair: number }): Promise<{ accepted: boolean; id?: string; reason?: string }>;
  createPartyPriceRangeDiscount(input: { partyId: string; startPrice: number; endPrice: number; discountPerPair: number }): Promise<{ accepted: boolean; id?: string; reason?: string }>;
  // Main Group Management
  listMainGroups(): Promise<MainGroup[]>;
  createMainGroup(input: { groupName: string; description?: string }): Promise<{ accepted: boolean; groupId?: string; reason?: string }>;
  // Unique Product Data
  listUniqueArticles(): Promise<string[]>;
  listUniqueSizesByArticle(article: string): Promise<string[]>;
  listUniqueColorsByArticle(article: string): Promise<string[]>;
  // Sale Voucher Management
  createSaleVoucher(input: Record<string, unknown>): Promise<{ accepted: boolean; id?: string; voucherNumber?: string; reason?: string; errorCode?: string; currentBalance?: number; voucherAmount?: number; projectedBalance?: number; limit?: number; available?: number; exceeded?: number; existingVoucherId?: string | null; existingVoucherNumber?: string | null }>;
  getSaleVoucher(voucherId: string): Promise<SaleVoucher | null>;
  /** The live sale voucher made from a gatepass, if any (one at most). */
  findSaleVoucherByGatepass(gatepassId: string): Promise<{ id: string; voucherNumber: string } | null>;
  listSaleVouchers(query: Record<string, unknown>): Promise<PagedResult<SaleVoucherListRow>>;
  updateSaleVoucher(voucherId: string, input: Record<string, unknown>): Promise<{ accepted: boolean; reason?: string }>;
  addVoucherLineItem(voucherId: string, input: Record<string, unknown>): Promise<{ accepted: boolean; id?: string; reason?: string; errorCode?: string; requestedDiscount?: number; allowedMaximum?: number; exceededBy?: number }>;
  updateVoucherLineItem(itemId: string, input: Record<string, unknown>): Promise<{ accepted: boolean; reason?: string; errorCode?: string; requestedDiscount?: number; allowedMaximum?: number; exceededBy?: number }>;
  deleteVoucherLineItem(itemId: string): Promise<{ accepted: boolean; reason?: string }>;
  deleteSaleVoucher(voucherId: string): Promise<{ accepted: boolean; reason?: string; cancelled?: boolean; reversedEventCount?: number; ambiguousDispatchEventIds?: string[] }>;
  // Purchase Voucher Management (supplier bills)
  getNextPurchaseVoucherNumber(): Promise<string>;
  createPurchaseVoucher(input: Record<string, unknown>): Promise<{ accepted: boolean; id?: string; voucherNumber?: string; reason?: string }>;
  getPurchaseVoucher(voucherId: string): Promise<PurchaseVoucher | null>;
  listPurchaseVouchers(query?: Record<string, unknown>): Promise<PagedResult<PurchaseVoucherListRow>>;
  updatePurchaseVoucher(voucherId: string, input: Record<string, unknown>): Promise<{ accepted: boolean; reason?: string }>;
  deletePurchaseVoucher(voucherId: string): Promise<{ accepted: boolean; reason?: string }>;
  getSupplierLedger(partyId: string, query?: Record<string, unknown>): Promise<{
    partyId: string;
    partyName: string;
    openingBalance: number;
    closingBalance: number;
    entries: Array<{
      voucherId: string;
      voucherNumber: string;
      voucherDate: string;
      voucherType: "PURCHASE" | "CASH_PAYMENT" | "CASH_RECEIPT";
      description: string;
      modeOfTransfer?: string;
      debitAmount: number;
      creditAmount: number;
      balance: number;
    }>;
  }>;
  listSupplierBalances(query?: Record<string, unknown>): Promise<{ rows: Array<{ partyId: string; partyName: string; city: string | null; balance: number; lastVoucherDate: string | null; totalPurchases: number; totalPayments: number }>; total: number }>;
  /** Contractors a ledger can be opened for, with the work they are on record for. */
  listContractorLedgerAccounts(): Promise<{ accepted: boolean; reason?: string; accounts?: ContractorLedgerAccount[] }>;
  /** One contractor's ledger (or the printing ledger) for an inclusive `YYYY-MM-DD` range. */
  getContractorLedger(
    accountId: string,
    query: { fromDate: string; toDate: string }
  ): Promise<{ accepted: boolean; reason?: string; ledger?: ContractorLedgerReport }>;
  /**
   * One business day of Store In or Store Out: every packet scanned, quantity typed and carton,
   * with the day's totals. The shapes and the counting are @erp/domain storeDailyReport.ts.
   */
  getStoreDailyReport(query: { date: string; direction: StoreDirection; token?: string }): Promise<{ accepted: boolean; reason?: string; report?: StoreDailyReport }>;

  // ─── Automatic updates ────────────────────────────────────────────────────
  getUpdateStatus(): Promise<AppUpdateStatus>;
  checkForUpdates(): Promise<AppUpdateStatus>;
  installUpdate(): Promise<{ accepted: boolean; reason?: string }>;
  /** Admin-only: throws away a downloaded update so it cannot install on quit. */
  discardUpdate(): Promise<{ accepted: boolean; reason?: string }>;
}

// ─── Contractor Ledger ───────────────────────────────────────────────────────
// Worked out in the main process from the cartons machine programs produced, their rates and
// the cash vouchers; the shapes and the arithmetic are @erp/domain contractorLedger.ts.

export interface ContractorLedgerAccount {
  id: string;
  name: string;
  city: string | null;
  active: boolean;
  /** MACHINE and/or PACKING — from the programs and machines they were assigned to. */
  roles: ContractorRole[];
}

export interface ContractorLedgerReport extends ContractorLedger {
  account: ContractorLedgerAccount;
  fromDate: string;
  toDate: string;
}

// ─── Raw material Store movement configuration ───────────────────────────────────
// One printed raw-material label is one PACKET. How much a packet holds, and where it goes
// when it leaves the store, are set per material so the scanner never has to ask.

/** A destination a packet is issued to: PACKING, UPPER MAKER, … */
export interface WorkSection {
  id: string;
  sectionCode: string;
  name: string;
  status: string;
}

export interface RawMaterialMovementConfigRow {
  itemId: string;
  itemCode: string;
  displayName: string;
  /** The store's own word for the container a label goes on: BAG, PACKET, ROLL. */
  packName: string | null;
  /** null means this material cannot be moved through the store yet. */
  packingQuantity: number | null;
  /** Labelled packets standing in the store — counted, since each label carries its own contents. */
  packetsInStore: number;
  packingUnitId: string | null;
  packingUnitCode: string | null;
  /** The unit this material's stock is counted in — what a pack has to become. */
  stockUnitId: string | null;
  stockUnitCode: string | null;
  /** False when a pack could never reach the balance, so every scan of it would be refused. */
  packingConvertsToStock: boolean;
  /**
   * One pack, expressed in the unit stock is COUNTED in — the divisor that turns a balance
   * into a number of packs. Not always `packingQuantity`: a pack of 2 DOZEN on a material
   * stocked in PIECE is 24. Null when there is no packing, or it could never reach stock.
   */
  packSizeInStockUnit: number | null;
  defaultSectionId: string | null;
  defaultSectionName: string | null;
  /** The route, in order. Empty means the material cannot be issued yet. */
  hops: RawMaterialHop[];
}

/**
 * The setup a new material in a sub-category should start from.
 *
 * DANA — EVA — BLACK, RED and BLUE are one material in three colours: the same unit, the same
 * bag, the same machine. Rather than a second place to configure that, a sub-category remembers
 * the material in it that was set up most recently, and the next one follows it.
 *
 * Null when nothing in the category is set up yet — the first material is configured by hand.
 */
export interface RawMaterialSetupTemplate {
  /** The material this was read from, so the screen can say where the answer came from. */
  sourceItemId: string;
  sourceDisplayName: string;
  unitId: string | null;
  unitCode: string | null;
  packName: string | null;
  packingQuantity: number | null;
  packingUnitId: string | null;
  packingUnitCode: string | null;
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

/** A column the import expects, as the downloadable template describes it. */
export interface InventoryImportColumn {
  header: string;
  required: boolean;
  hint: string;
}

/** What the import decided about one spreadsheet row. */
export interface InventoryImportRowResult {
  rowNumber: number;
  outcome: "CREATE" | "DUPLICATE" | "REJECTED";
  displayName: string;
  itemCode?: string;
  problems: string[];
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
 * Stock moves by itself through the two scanners, so a manual correction is a claim that the
 * shelf disagrees with the system. It carries a reason and waits for an administrator;
 * approving it is what applies it.
 */
/**
 * A request to remove a piece of master data, awaiting an administrator's decision.
 * `targetName` is a snapshot, so the request still reads sensibly after the thing is gone.
 */
/** One rung of a material's unit ladder: 1 `fromUnit` is `factor` of `toUnit`. */
export interface ItemUnitLadderStep {
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
  steps: ItemUnitLadderStep[];
}

/** A material's ladder, with the unit its stock is actually held in. */
export interface ItemUnitLadder {
  itemId: string;
  /** Biggest unit first. Empty when the material has no ladder. */
  steps: ItemUnitLadderStep[];
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
  stockUnitCode: string | null;
  stockUnitId: string | null;
  quantityOnHand: number;
  /** Every rung of its ladder, biggest first — or just the stock unit when it has no ladder. */
  units: string[];
  steps: ItemUnitLadderStep[];
  /** Labelled packets of it currently in the store. Any at all block a move OUT by hand. */
  labelledPacketsInStore: number;
  /** Why it cannot move this way by hand, or null when it can. */
  blockedReason: string | null;
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
    | "NOT_ENOUGH_STOCK"
    | "NO_PURPOSE"
    | "NOT_AUTHORIZED";
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
  /** Empty means the move can go ahead. */
  blockers: string[];
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
  newDisplayName: string;
}

export interface RemovalRequest {
  id: string;
  /** DEL-000001 */
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

export interface StockCorrectionRequest {
  id: string;
  /** SCR-000001 */
  requestCode: string;
  itemId: string;
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
 * One movement of a raw material's stock — the ledger behind the balance on the Stock tab.
 * Every Raw Material Input scan, Raw Material Output scan and manual adjustment writes one.
 */
export interface InventoryStockEventRow {
  id: string;
  itemId: string;
  eventType: string;
  /** Signed: positive added to stock, negative took it out. */
  quantity: number;
  unitId: string;
  unitCode: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

// ─── Raw Material Input ──────────────────────────────────────────────────────────
// Receiving one supplier's delivery, one packet at a time. Its own screen and its own
// identity: a carton and a raw material packet never share a scanner.

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

export type RawMaterialReceiptOutcome =
  | "RECEIVED"
  | "ALREADY_IN_STORE"
  | "WRONG_PARTY"
  | "UNKNOWN_QR"
  | "NOT_ELIGIBLE"
  | "NOT_CONFIGURED"
  | "INVALID_FORMAT"
  | "STATUS_CHANGED"
  /** Main-process only: session missing or lacks the store-scanning permission. */
  | "NOT_AUTHORIZED"
  /** Main-process only: infrastructure failure; nothing was written. */
  | "ERROR";

export interface RawMaterialReceiptResult {
  accepted: boolean;
  outcome: RawMaterialReceiptOutcome;
  qrId?: string;
  reason?: string;
  itemDisplayName?: string;
  /** The supplier the label was generated for — not necessarily the session's. */
  partyName?: string;
  packingQuantity?: number;
  packingUnitCode?: string | null;
  /** The store's own word for the container: BAG, PACKET, ROLL. */
  packName?: string | null;
  previousStatus?: string | null;
  currentStatus?: string | null;
  receivedAt?: string;
  eventId?: string;
  sessionId?: string;
}

// ─── Raw Material Output ─────────────────────────────────────────────────────────
// Packets leaving the store for the section that consumes them. Where a packet goes is a
// property of its material, so the operator only scans.

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

export interface RawMaterialIssueSessionSummary {
  session: RawMaterialIssueSession;
  /** Who the session's packets go to: its first scan's party, or null before the first scan. */
  partyId: string | null;
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

export type RawMaterialIssueOutcome =
  | "ISSUED"
  | "NOT_IN_STORE"
  | "UNKNOWN_QR"
  | "NOT_ELIGIBLE"
  | "NOT_CONFIGURED"
  | "INVALID_FORMAT"
  | "STATUS_CHANGED"
  /**
   * Only reachable with a Machine Program open on Store Out: the program does not ask for this
   * upper, or everything it asked for has already been issued. The packet stays in the store.
   */
  | "NOT_ON_PROGRAM"
  /** Scan Out: no party chosen, or not an active supplier or contractor. Nothing was written. */
  | "NO_PARTY"
  /** Main-process only: session missing or lacks the store-scanning permission. */
  | "NOT_AUTHORIZED"
  /** Main-process only: infrastructure failure; nothing was written. */
  | "ERROR";

export interface RawMaterialIssueResult {
  accepted: boolean;
  outcome: RawMaterialIssueOutcome;
  qrId?: string;
  reason?: string;
  itemDisplayName?: string;
  partyName?: string;
  packingQuantity?: number;
  packingUnitCode?: string | null;
  /** The store's own word for the container: BAG, PACKET, ROLL. */
  packName?: string | null;
  /** Where it went — read from the material, never chosen by the operator. */
  sectionName?: string | null;
  previousStatus?: string | null;
  currentStatus?: string | null;
  issuedAt?: string;
  eventId?: string;
  sessionId?: string;
  /**
   * The machine program this bag was counted against, when one was waiting for it.
   *
   * The storekeeper chose none of this: the packet's own material and supplier found the
   * oldest program still owing it. Absent means the issue was an ordinary one and no program
   * changed.
   */
  machineProgram?: MachineProgramConsumption;
  /** Scan Out: who the packet was moved out to. */
  issuedToPartyName?: string;
}

/** What a Raw Material Output scan did to a machine program. */
export interface MachineProgramConsumption {
  programId: string;
  code: string;
  machineName: string;
  contractorName: string;
  /** What the line asked for, and how much has now been taken for it including this packet. */
  lineQuantity: number;
  lineConsumed: number;
  lineOutstanding: number;
  unitCode: string | null;
  /** True when this scan took the program's last outstanding quantity and closed it. */
  programCompleted: boolean;
}

// ─── Machine Program ──────────────────────────────────────────────────────────
// machine + date → injector → sole run (sole, sole colour, article + size) → upper lines.
// Every figure is computed by the data layer; the screens only show it.

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
  hasDana: boolean;
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
     * The product's STANDARD contractor rates, per DOZEN, in integer paisa (migration 064), so
     * the pricing boxes can open on what this article is normally paid. Null is NOT SET, never 0.
     */
    machineRatePaisa: number | null;
    packingRatePaisa: number | null;
    printingRatePaisa: number | null;
    /** FIX: no upper, moulded from an outer and an inner sole (migration 067). */
    hasNoUpper: boolean;
  }>;
}

/** One source of a material: a supplier, or stock with no supplier recorded (supplierPartyId null). */
export interface MachineProgramStockSource {
  supplierPartyId: string | null;
  supplierName: string | null;
  packets: number | null;
  physical: number;
  reserved: number;
  available: number;
}

/** A raw material as a program shows it: Dana for a sole colour, or an upper for an article + size. */
export interface MachineProgramMaterial {
  itemId: string;
  itemCode: string;
  displayName: string;
  categoryPath: string;
  subCategoryName: string;
  colour: string;
  type: string | null;
  unitCode: string | null;
  packName: string;
  physical: number;
  reserved: number;
  available: number;
  sources: MachineProgramStockSource[];
  allocatable: boolean;
  notAllocatableReason: string | null;
}

/** One upper colour on a sole run, with what Raw Material Output has taken for it. */
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
  consumed: number;
  outstanding: number;
  availableAtSave: number;
}

/** One sole run on one injector. */
export interface MachineProgramRunRecord {
  id: string;
  programId: string;
  /** 1 or 2 — or null on a FIX run, which has no injector (migration 073). */
  injectorNo: number | null;
  runNo: number;
  /** THE sole on a normal run, the OUTER sole on a fix run. */
  soleColour: string;
  /** The INNER sole, and the mark of a FIX run. Null on every normal run. */
  innerSoleColour: string | null;
  /** What a fix run plans, typed on the run. 0 on a normal run. NOT a reservation. */
  fixQuantity: number;
  articleSizeId: string;
  article: string;
  size: string;
  totalQuantity: number;
  consumedQuantity: number;
  unitCode: string | null;
  /**
   * The hours this sole colour runs, in minutes from midnight of the program date. Both null
   * when nobody timed it, which means the colour runs the whole shift.
   */
  startMinute: number | null;
  endMinute: number | null;
  lines: MachineProgramUpperLineRecord[];
}

export interface MachineProgramRecord {
  id: string;
  programNumber: number;
  code: string;
  machineId: string;
  machineName: string;
  contractorPartyId: string;
  /** The machine contractor as they were when the program was made. */
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
  unitCode: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  runs: MachineProgramRunRecord[];
  /**
   * Contractor pricing: what each article's machine, packing and printing work is paid at, per
   * DOZEN, in integer paisa. One row per article however many runs it is on; an article with no
   * row here is UNPRICED, which is not the same as priced at zero. Empty until somebody prices
   * the program. What the rates come to is `programContractorPricing` in @erp/domain.
   */
  articleRates: MachineProgramArticleRate[];
}

/** One article's three rates on one program, per DOZEN, in integer paisa. */
export interface MachineProgramArticleRate {
  articleSizeId: string;
  machineRatePaisa: number;
  packingRatePaisa: number;
  printingRatePaisa: number;
  updatedAt: string;
}

// ─── Store Out against a Machine Program ──────────────────────────────────────
// The shapes the main process answers with. Every quantity on them is computed in the data
// layer from the event log; the screen formats them and decides nothing.

export type MachineProgramStoreOutOutcome =
  | "OPENED"
  | "SAVED"
  | "ALREADY_SAVED"
  | "INVALID_LOOKUP"
  | "PROGRAM_NOT_FOUND"
  | "PROGRAM_CANCELLED"
  | "PROGRAM_COMPLETED"
  | "PROGRAM_EMPTY"
  | "NOTHING_TO_SAVE"
  | "SCAN_REFUSED"
  | "NOT_AUTHORIZED"
  | "ERROR";

export interface OpenMachineProgramStoreOutResult {
  accepted: boolean;
  outcome: MachineProgramStoreOutOutcome;
  reason?: string;
  programId?: string;
  programCode?: string;
  /** The program itself, read through the same call the Machine Program screens use. */
  program?: MachineProgramRecord | null;
}

export type MachineProgramScanVerdict =
  | "ACCEPTED"
  | "INVALID_FORMAT"
  | "UNKNOWN_QR"
  | "NOT_IN_STORE"
  | "NOT_ELIGIBLE"
  | "NOT_CONFIGURED"
  | "NOT_ON_PROGRAM"
  | "VARIANT_FULFILLED"
  | "ALREADY_IN_BATCH"
  | "PROGRAM_NOT_FOUND"
  | "PROGRAM_CLOSED"
  | "NOT_AUTHORIZED";

export interface MachineProgramScanCheckResult {
  accepted: boolean;
  verdict: MachineProgramScanVerdict;
  reason?: string;
  qrId?: string;
  itemId?: string;
  itemDisplayName?: string;
  partyName?: string;
  packingQuantity?: number;
  packName?: string | null;
  unitCode?: string | null;
  /** What the program asked for of this upper, and what has COMMITTED so far. */
  authorized?: number;
  issued?: number;
  /** What the unsaved batch would add, this packet included. */
  pending?: number;
}

/** The cartons one issued packet's output will be labelled with. */
export interface IssuedCartonPlan {
  articleSizeId: string;
  article: string;
  size: string;
  soleColour: string;
  /** The colour the carton QR identity carries — the upper's own colour. */
  colour: string;
  /** How many carton QR labels this packet's quantity needs. */
  count: number;
}

/** One packet that left the store, as the main process reports it back. */
export interface IssuedProgramPacket {
  qrId: string;
  itemId: string;
  itemDisplayName: string;
  partyName: string | null;
  quantity: number;
  unitCode: string | null;
  packName: string | null;
  cartons: IssuedCartonPlan | null;
  /** Why these cartons cannot be labelled here. Set only when `cartons` is null. */
  cartonNote: string | null;
}

export interface SaveMachineProgramBatchResult {
  accepted: boolean;
  outcome: MachineProgramStoreOutOutcome;
  reason?: string;
  batchId?: string;
  programId?: string;
  packetCount?: number;
  /** Every packet that left the store in this call, in the order it was scanned. */
  packets?: IssuedProgramPacket[];
  refusedQrId?: string;
  refusedVerdict?: MachineProgramScanVerdict;
  programCompleted?: boolean;
  /** The program re-read after the write, so progress is never patched on screen. */
  program?: MachineProgramRecord | null;
}

/** One Dana the store holds in a sole colour a machine program runs. */
export interface MachineProgramDanaOption {
  itemId: string;
  displayName: string;
  colour: string;
  /** EVA, PVC — what tells two Danas of one colour apart. */
  subCategoryName: string;
  /** The units a quantity of it can be typed in: its ladder (BAG, KG), or just its stock unit. */
  units: string[];
  /** The unit its stock is counted in, or null while it has none. */
  stockUnitCode: string | null;
  /** How much of it has gone out for THIS program so far, in its stock unit. */
  issuedQuantity: number;
  /** Why it cannot be issued by typing a quantity (labelled packets), or null when it can. */
  blockedReason: string | null;
}

export interface MachineProgramDanaIssueResult {
  accepted: boolean;
  outcome: string;
  reason?: string;
  /** What actually left, in the material own stock unit. */
  quantity?: number;
  unitCode?: string;
  quantityOnHand?: number;
}

/** One Dana issue already made for a program. */
export interface MachineProgramDanaIssueRow {
  itemId: string;
  displayName: string;
  quantity: number;
  unitCode: string | null;
  note: string | null;
  actor: string | null;
  issuedAt: string;
}

/** The carton QR run one issued packet was labelled in. */
export interface MachineProgramCartonLabel {
  qrBatchId: string;
  firstQrId: string;
  lastQrId: string;
  /** How many of the run's cartons this packet accounts for. */
  cartonCount: number;
  /** How many of the WHOLE run's cartons have come back and been stored in so far. */
  receivedInRun: number;
  /** How many of the run's labels are void — on a FIX run, the ones converted to B cartons. */
  voidedInRun: number;
  /** The colour the run's labels carry — MIX on a B run. */
  colour: string;
  /** "B" on a run of B carton labels (migration 074), null on an ordinary run. */
  grade: "B" | null;
  printedBy: string | null;
  printedAt: string;
}

/** What Store In's Carton In scan answers. `outcome` is the main process's verdict, named. */
/** Who a LOST upper is claimed against: the machine contractor, or the packing contractor. */
export type ReconciliationLossParty = "MACHINE" | "PACKING";

/**
 * What the store says became of one upper line's remaining pairs when the program closes: cut size
 * uppers, cut size pairs and priced claims. The rule they must meet is @erp/domain's.
 */
export type ReconciliationEntryInput = UpperReconciliation & { lineId: string };

/** A claim as a closed program shows it. Claims from before priced claims carry no number or amount. */
export interface SavedReconciliationClaim {
  claimNumber: string | null;
  role: ClaimPartyRole;
  partyName: string;
  pairs: number;
  amountPaisa: number | null;
  reason: string;
}

/** What was recorded for one upper line when its program closed. */
export interface SavedUpperReconciliation {
  cutSizeUppers: number;
  cutSizePairs: number;
  returnedUpperPairs: number;
  bCartons: number;
  claims: SavedReconciliationClaim[];
}

/** Return Upper's answer: the packet received back, or why it was refused. */
export interface UpperReturnResult {
  accepted: boolean;
  outcome: string;
  reason?: string;
  qrId?: string;
  itemDisplayName?: string;
  packingQuantity?: number;
  packingUnitCode?: string | null;
  packName?: string | null;
}

export interface ReconciliationParty {
  partyId: string;
  name: string;
}

/** One upper line of a program, as the reconciliation reads it. */
export interface ReconciliationLine {
  lineId: string;
  itemId: string;
  upperName: string;
  article: string;
  size: string;
  soleColour: string;
  upperColour: string;
  /** Cartons for everything that went out for the line, before any packet came back. Null when not whole. */
  issuedCartons: number | null;
  /** Sealed packets scanned back to the store, as cartons. Null when not whole. */
  returnedUpperCartons: number | null;
  /** Null when the upper is not counted in whole cartons of DOZEN. */
  cartonsDue: number | null;
  /** Stored in — B cartons included. */
  cartonsBack: number;
  /** B carton labels printed for the line, and how many are stored in. */
  bCartons: number;
  bBack: number;
  /** Cartons still missing: due, less back, less B labels not yet scanned in. */
  missingCartons: number;
  /** The pairs to account for on closing: 1 carton = 6. */
  shortfallUppers: number;
  /** Suppliers whose packets of this upper went out for the program. */
  suppliers: ReconciliationParty[];
  /** What was recorded at closing, or null while open. */
  saved: SavedUpperReconciliation | null;
}

export interface MachineProgramClosure {
  outcome: "COMPLETE" | "RECONCILED";
  cartonsDue: number;
  cartonsBack: number;
  closedBy: string;
  closedAt: string;
}

export interface MachineProgramReconciliation {
  programId: string;
  code: string;
  closure: MachineProgramClosure | null;
  machineContractor: ReconciliationParty | null;
  packingContractor: ReconciliationParty | null;
  lines: ReconciliationLine[];
  /** FIX runs (EVR FIX, no upper): cartons owed by the plan, counted beside the upper lines. */
  fixRuns: ReconciliationFixRun[];
  /** Every carton due and back — upper lines and fix runs. */
  cartonsDue: number;
  cartonsBack: number;
  /** Fix cartons not back. While any are out, the program cannot close. */
  fixCartonsShort: number;
  /** Why the program cannot be completed here at all, or null. */
  blockedReason: string | null;
}

export interface ReconciliationFixRun {
  runId: string;
  article: string;
  size: string;
  outerSoleColour: string;
  innerSoleColour: string;
  cartonsDue: number | null;
  cartonsBack: number;
  cartonNote: string | null;
  /** Printed labels not back — the most that can be turned into B cartons. */
  convertible: number;
  /** B carton labels printed for this run, and how many of them are back. */
  bCartons: number;
  bBack: number;
}

export interface MachineProgramCartonInResult {
  accepted: boolean;
  outcome: string;
  reason?: string;
  qrId?: string;
  article?: string;
  color?: string;
  size?: string;
  /** True when this scan was also the carton's production scan. */
  producedNow?: boolean;
  receivedAt?: string;
}

/** One upper line's cartons, as Store In counts them coming back. */
export interface MachineProgramLineCartons {
  lineId: string;
  /** Cartons owed for what has been issued of this upper (3 DOZEN out = 6), or null when not in whole cartons. */
  cartonsDue: number | null;
  /** Cartons of this line's printed labels that have been stored in — B cartons included. */
  cartonsBack: number;
  /** B carton labels printed for this line, and how many are stored in. */
  bCartons: number;
  bBack: number;
}

/** One packet of uppers out for a program, and the cartons it is owed back (1 DOZEN = 2 cartons). */
export interface MachineProgramCartonPacket {
  /** The issuance (STORE_EXIT event) a carton label is owed to. */
  eventId: string;
  qrId: string;
  itemDisplayName: string;
  quantity: number;
  unitCode: string | null;
  issuedAt: string;
  cartons: IssuedCartonPlan | null;
  /** Why the cartons cannot be labelled here. Set only when `cartons` is null. */
  cartonNote: string | null;
  /** Null while the cartons are still owed. */
  label: MachineProgramCartonLabel | null;
}

/**
 * A FIX article's cartons: owed by the PLAN, not by an issuance.
 *
 * A fix article is moulded from two soles and has no upper, so nothing leaves the store for it
 * and there is no packet to hang a carton label on. 32 DOZEN planned is 64 cartons, ready to
 * print from the moment the run is saved (migration 071).
 */
export interface MachineProgramFixCartonRun {
  runId: string;
  articleSizeId: string;
  article: string;
  size: string;
  /** The OUTER sole: what the slipper is sold as, and what the carton QR identity carries. */
  outerSoleColour: string;
  innerSoleColour: string;
  quantity: number;
  unitCode: string | null;
  /** The whole plan's cartons, or null when no carton figure can be said. */
  cartonsPlanned: number | null;
  /** Still to label: the plan minus what is already printed. */
  cartonsToPrint: number;
  cartonNote: string | null;
  labels: MachineProgramCartonLabel[];
}

/** One saved batch and the packets it took, for the audit trail under the program. */
export interface MachineProgramIssueBatchRow {
  batch: {
    id: string;
    batchKey: string;
    programId: string;
    sessionId: string | null;
    deviceId: string;
    issuedBy: string | null;
    packetCount: number;
    createdAt: string;
  };
  packets: Array<{ qrId: string; itemDisplayName: string; quantity: number; unitCode: string | null; issuedAt: string }>;
}
/** A machine as the board shows it for one date. */
export interface MachineProgramBoardRow {
  machine: MachineRecord;
  program: MachineProgramRecord | null;
}

/** What every machine program write answers. */
export interface MachineProgramWriteResult {
  accepted: boolean;
  outcome: string;
  reason?: string;
  programId?: string;
  runId?: string;
  lineId?: string;
  /** On NOT_ENOUGH_STOCK: the most this line may hold right now. */
  available?: number;
  unitCode?: string | null;
  removedLines?: number;
  releasedQuantity?: number;
  consumedQuantity?: number;
}

/**
 * The stretch of clock a program runs, in minutes from midnight of its own date.
 * Mirrors MachineShift in @erp/domain, declared here because this file states the shapes that
 * cross the preload bridge and imports nothing.
 */
export interface MachineShift {
  startMinute: number;
  endMinute: number;
}

/**
 * Which of a machine's two contractors is meant: the one who RUNS it, or the one who PACKS what
 * it makes. Mirrors MachineContractorRole in @erp/domain, for the same reason as MachineShift.
 */
export type MachineContractorRole = "MACHINE" | "PACKING";

/** The sole colour and the article + size of a run. */
export interface MachineProgramRunHeader {
  soleColour: string;
  articleSizeId: string;
}

export interface SaveMachineProgramLineInput {
  machineId: string;
  programDate: string;
  /** The shift to give the date's program when this is the first thing saved on it. */
  shift?: MachineShift | null;
  injectorNo: number;
  /** The run the line goes on — or `run` for the first line of a new one. */
  runId?: string | null;
  run?: MachineProgramRunHeader | null;
  /** Present when changing the quantity of a line already on the run. */
  lineId?: string | null;
  itemId: string;
  quantity: number;
}
