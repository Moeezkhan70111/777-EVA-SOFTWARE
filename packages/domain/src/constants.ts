// Domain constants — the stable vocabulary of 777 ERP.
//
// These mirror the CHECK constraints in packages/data/src/local-schema.sql. Use them
// instead of string literals so a renamed status is a compile error, not a silent bug.
// (Only stable domain concepts belong here; do not add every trivial string.)

export const APP_TIMEZONE = "Asia/Karachi";

// ─── Users, sessions, access ─────────────────────────────────────────────────

export const USER_ROLE = { USER: "USER", ADMIN: "ADMIN" } as const;
export type UserRole = (typeof USER_ROLE)[keyof typeof USER_ROLE];

export const ACCESS_STATUS = { PENDING: "PENDING", APPROVED: "APPROVED", REJECTED: "REJECTED" } as const;
export type AccessStatus = (typeof ACCESS_STATUS)[keyof typeof ACCESS_STATUS];

export const LOGIN_POLICY = { ALWAYS_LOGGED_IN: "ALWAYS_LOGGED_IN", DAILY_LOGIN: "DAILY_LOGIN" } as const;
export type LoginPolicy = (typeof LOGIN_POLICY)[keyof typeof LOGIN_POLICY];

/**
 * Permission codes. Each code is both a navigation permission in the renderer and the
 * authorisation required by the corresponding write operations in the main process.
 */
export const PERMISSION = {
  /**
   * Retired: every approved role now has the sidebar, so this no longer gates anything and
   * is no longer offered in the role editor. Kept because existing role/user rows hold it.
   */
  NAVBAR: "navbar",
  DASHBOARD: "dashboard",
  WORKSPACE: "workspace",
  LIVE_PRODUCTION: "live-production",
  DAILY_PRODUCTION: "daily-production",
  PRODUCTION_HISTORY: "production-history",
  LIVE_DISPATCH: "live-dispatch",
  DAILY_DISPATCH: "daily-dispatch",
  DISPATCH_HISTORY: "dispatch-history",
  LIVE_RETURN: "live-return",
  RETURN_HISTORY: "return-history",
  STORE_SCANNING: "store-scanning",
  /**
   * The Munshi's own station screen (tile cards), the same way STORE_SCANNING opens the
   * store operator's station. It grants no business operation of
   * its own — each card is still gated by the permission that action has always needed.
   */
  MUNSHI: "munshi",
  GATEPASS: "gatepass",
  GATEPASS_CANCEL: "gatepass-cancel",
  STOCK: "stock",
  HISTORY: "history",
  PARTY_LIST: "party-list",
  PARTY_FORM: "party-form",
  PRODUCT_LIST: "product-list",
  PRODUCT_FORM: "product-form",
  QR_GENERATOR: "qr-generator",
  QR_MANAGEMENT: "qr-management",
  RAW_MATERIAL_QR_GENERATOR: "raw-material-qr-generator",
  /** Raw material categories, attributes, units and conversions — without the rest of Settings. */
  RAW_MATERIAL_SETUP: "raw-material-setup",
  /**
   * Opening the Raw Material Input / Output scanner pages. The scans themselves are still
   * authorised by STORE_SCANNING in the main process; these only decide whether the page is
   * offered to a user who is not a store operator.
   */
  RAW_MATERIAL_INPUT: "raw-material-input",
  RAW_MATERIAL_OUTPUT: "raw-material-output",
  MACHINE_PROGRAM: "machine-program",
  DISCOUNT_POLICY: "discount-policy",
  CUSTOMER_LEDGER: "customer-ledger",
  CUSTOMER_BALANCE: "customer-balance",
  SALE_VOUCHER_FORM: "sale-voucher-form",
  SALE_VOUCHER_LIST: "sale-voucher-list",
  PURCHASE_VOUCHER_FORM: "purchase-voucher-form",
  PURCHASE_VOUCHER_LIST: "purchase-voucher-list",
  SUPPLIER_LEDGER: "supplier-ledger",
  SUPPLIER_BALANCE: "supplier-balance",
  CASH_VOUCHER_FORM: "cash-voucher-form",
  CASH_VOUCHER_LIST: "cash-voucher-list",
  SETTINGS: "settings",
  HEALTH: "health",
  LOGS: "logs",
} as const;
export type PermissionCode = (typeof PERMISSION)[keyof typeof PERMISSION];

// ─── QR lifecycle ────────────────────────────────────────────────────────────

export const QR_STATUS = {
  PRODUCED: "PRODUCED",
  WAREHOUSE: "WAREHOUSE",
  TO_GATE: "TO_GATE",
  DISPATCHED: "DISPATCHED",
  /**
   * The carton came back from the customer and its return has been recorded on the gate,
   * but it has NOT physically re-entered the store yet: it is not counted in stock and the
   * only scan that moves it on is a normal Store Move In. Recording the commercial return
   * and receiving the physical carton are two separate events (see ReturnScanUseCase).
   */
  ON_GATE: "ON_GATE",
  SOLD: "SOLD",
  /** Legacy: written by the pre-ON_GATE return flow, which credited stock on the return scan. */
  RETURNED: "RETURNED",
  DAMAGED: "DAMAGED",
  SCRAPPED: "SCRAPPED",
} as const;
export type QrStatus = (typeof QR_STATUS)[keyof typeof QR_STATUS];

/** Registry status of a generated (not yet produced) code. */
export const QR_REGISTRY_STATUS = { GENERATED: "GENERATED", VOID: "VOID" } as const;

export const LOCATION_TYPE = {
  FACTORY: "FACTORY",
  WAREHOUSE: "WAREHOUSE",
  GATE: "GATE",
  VEHICLE: "VEHICLE",
  CUSTOMER: "CUSTOMER",
  UNKNOWN: "UNKNOWN",
} as const;
export type LocationType = (typeof LOCATION_TYPE)[keyof typeof LOCATION_TYPE];

export const PRODUCTION_EVENT_TYPE = {
  PRODUCED: "PRODUCED",
  MOVED: "MOVED",
  PACKED: "PACKED",
  DISPATCHED: "DISPATCHED",
  RETURNED: "RETURNED",
  DAMAGED: "DAMAGED",
  SOLD: "SOLD",
  ADJUSTMENT: "ADJUSTMENT",
} as const;
export type ProductionEventType = (typeof PRODUCTION_EVENT_TYPE)[keyof typeof PRODUCTION_EVENT_TYPE];

export const SYNC_STATUS = { PENDING: "PENDING", SYNCED: "SYNCED", FAILED: "FAILED" } as const;

// ─── Products ────────────────────────────────────────────────────────────────

export const PRODUCT_STATUS = { ACTIVE: "ACTIVE", DISABLED: "DISABLED" } as const;

export const PRICE_TYPE = { NORMAL: "NORMAL", B_TYPE: "B_TYPE" } as const;
export type PriceType = (typeof PRICE_TYPE)[keyof typeof PRICE_TYPE];

// ─── Billing ─────────────────────────────────────────────────────────────────

export const VOUCHER_STATUS = { DRAFT: "DRAFT", FINALIZED: "FINALIZED", CANCELLED: "CANCELLED" } as const;
export type VoucherStatus = (typeof VOUCHER_STATUS)[keyof typeof VOUCHER_STATUS];

export const CASH_VOUCHER_STATUS = { ACTIVE: "ACTIVE", CANCELLED: "CANCELLED" } as const;

/** A recorded carton return. CANCELLED keeps the row but stops it crediting the ledger. */
export const SALE_RETURN_STATUS = { ACTIVE: "ACTIVE", CANCELLED: "CANCELLED" } as const;
export type SaleReturnStatus = (typeof SALE_RETURN_STATUS)[keyof typeof SALE_RETURN_STATUS];

export const DISPATCH_SESSION_STATUS = {
  PENDING: "PENDING",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
} as const;
export type DispatchSessionStatus = (typeof DISPATCH_SESSION_STATUS)[keyof typeof DISPATCH_SESSION_STATUS];

export const DISCOUNT_SOURCE = {
  ARTICLE: "ARTICLE",
  ARTICLE_SERIES: "ARTICLE_SERIES",
  PRICE_RANGE: "PRICE_RANGE",
  PRODUCT_GROUP: "PRODUCT_GROUP",
  NONE: "NONE",
} as const;
export type DiscountSource = (typeof DISCOUNT_SOURCE)[keyof typeof DISCOUNT_SOURCE];

export const DISCOUNT_SIZE_SCOPE = { ALL_SIZES: "ALL_SIZES", SEPARATE_SIZES: "SEPARATE_SIZES" } as const;

// ─── The Gatepass journey ────────────────────────────────────────────────────
// Where the goods on a Gatepass have reached. The Gatepass is the master operational
// document: the QR code stays the physical carton's identity, and this says how far the
// document those cartons travel on has got.
//
// CREATED is what the screens call "Gatepass Issued" — the stored value is kept as CREATED
// because every existing row and query already uses it (see migration 051).
//
// AT_GATE, never ON_GATE: QR_STATUS.ON_GATE already means a carton the customer sent back
// that has not re-entered the store. Two different things must not share one word.
export const GATEPASS_STATUS = {
  /** Cut and reserved. Billing must make its sale voucher before anything physical happens. */
  CREATED: "CREATED",
  /** A live sale voucher exists for it. The store may now scan its cartons out. */
  BILLED: "BILLED",
  /** Every line has been scanned out of the store and stands at the gate, ready to dispatch. */
  AT_GATE: "AT_GATE",
  /** Every line has been scanned onto the vehicle for the party. */
  DISPATCHED: "DISPATCHED",
  /** The builty/delivery photo has been recorded. The journey is complete. */
  DELIVERED: "DELIVERED",
  CANCELLED: "CANCELLED",
} as const;
export type GatepassStatusValue = (typeof GATEPASS_STATUS)[keyof typeof GATEPASS_STATUS];

/**
 * The only status moves the system allows, and nothing else — there is no manual status
 * control anywhere in the UI. Each move is the consequence of one business operation:
 *
 *   CREATED    → BILLED      a sale voucher was made from the Gatepass
 *   BILLED     → CREATED     that sale voucher was deleted (the inverse, same transaction)
 *   BILLED     → AT_GATE     the last outstanding carton was scanned out of the store
 *   AT_GATE    → DISPATCHED  the last carton was dispatch-scanned to the party
 *   DISPATCHED → DELIVERED   the delivery photo was recorded
 *   CREATED    → CANCELLED   cancelled before anything physical happened
 *
 * Deliberately absent: anything that would walk the journey backwards past a physical move.
 * Once a carton has left the store the document cannot be cancelled or reopened — that needs
 * a controlled reversal, which does not exist yet.
 */
export const GATEPASS_TRANSITIONS: Readonly<Record<GatepassStatusValue, readonly GatepassStatusValue[]>> = {
  CREATED: ["BILLED", "CANCELLED"],
  BILLED: ["CREATED", "AT_GATE"],
  AT_GATE: ["DISPATCHED"],
  DISPATCHED: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
} as const;

/** Whether one status may legally become another. The data layer asks this before every move. */
export const canTransitionGatepass = (from: string, to: string): boolean =>
  (GATEPASS_TRANSITIONS[from as GatepassStatusValue] as readonly string[] | undefined)?.includes(to) ?? false;

/** What the operator reads. "Gatepass Issued" rather than the stored CREATED. */
export const GATEPASS_STATUS_LABEL: Readonly<Record<GatepassStatusValue, string>> = {
  CREATED: "Gatepass Issued",
  BILLED: "Billed",
  AT_GATE: "At Gate",
  DISPATCHED: "Dispatched",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
} as const;

/** The journey in order, for the timeline on the Gatepass. CANCELLED is not a step on it. */
export const GATEPASS_JOURNEY: readonly GatepassStatusValue[] = ["CREATED", "BILLED", "AT_GATE", "DISPATCHED", "DELIVERED"] as const;

/**
 * Each status is one desk's queue. There is one Gatepass and one status: these are views of
 * the same rows, never separate records — the stage IS the status.
 *
 *   CREATED    Pending Billing    the billing desk makes its sale voucher
 *   BILLED     Pending Store      the store scans its cartons out
 *   AT_GATE    At Gate            dispatch loads it onto the vehicle
 *   DISPATCHED Pending Builties   someone records the delivery photo
 *
 * DELIVERED and CANCELLED are nobody's queue: finished work and torn-up paper are history,
 * and `pending: false` is what keeps them out of the counts an operator is measured by.
 *
 * `permission` is who that desk is — the same permission codes the rest of the app uses, so
 * a notification about a stage reaches exactly the people who can act on it, and a screen can
 * open on the queue its user actually works.
 */
export interface GatepassStage {
  status: GatepassStatusValue;
  /** The queue's name, as the operator reads it. */
  label: string;
  /** Who works this queue. Null for the two that are nobody's work. */
  permission: string | null;
  /** Whether it is outstanding work, and so belongs in the pending counts. */
  pending: boolean;
}

export const GATEPASS_STAGES: readonly GatepassStage[] = [
  { status: "CREATED", label: "Pending Billing", permission: PERMISSION.SALE_VOUCHER_FORM, pending: true },
  { status: "BILLED", label: "Pending Store", permission: PERMISSION.STORE_SCANNING, pending: true },
  { status: "AT_GATE", label: "At Gate", permission: PERMISSION.LIVE_DISPATCH, pending: true },
  { status: "DISPATCHED", label: "Pending Builties", permission: PERMISSION.GATEPASS, pending: true },
  { status: "DELIVERED", label: "Delivered", permission: null, pending: false },
  { status: "CANCELLED", label: "Cancelled", permission: null, pending: false },
] as const;

/** The desk a status belongs to, or undefined for a status with no queue. */
export const gatepassStage = (status: string): GatepassStage | undefined =>
  GATEPASS_STAGES.find((stage) => stage.status === status);

// ─── User notifications ──────────────────────────────────────────────────────
// What a notification is about (so the shell can open the right screen) and how loudly it
// must be shown. Plain notices (messages, tasks, role changes) have no kind.

export const NOTIFICATION_KIND = {
  /** A gatepass was created: billing should make its sale voucher. entity = gatepass id. */
  GATEPASS_CREATED: "GATEPASS_CREATED",
  /** A gatepass was cancelled: any bill made from it must be deleted. entity = gatepass id. */
  GATEPASS_CANCELLED: "GATEPASS_CANCELLED",
  /** A gatepass has been billed: the store may now take its cartons out. entity = gatepass id. */
  GATEPASS_BILLED: "GATEPASS_BILLED",
  /** Every carton is out of the store and at the gate: dispatch may load it. entity = gatepass id. */
  GATEPASS_AT_GATE: "GATEPASS_AT_GATE",
  /** The goods have gone: the delivery photo is now what is waiting. entity = gatepass id. */
  GATEPASS_DISPATCHED: "GATEPASS_DISPATCHED",
  /** Someone asked to correct a raw material's count. entity = inventory item id. */
  STOCK_CORRECTION_REQUESTED: "STOCK_CORRECTION_REQUESTED",
  /** A stock correction was approved and has been applied. entity = inventory item id. */
  STOCK_CORRECTION_APPROVED: "STOCK_CORRECTION_APPROVED",
  /** A stock correction was declined; nothing changed. entity = inventory item id. */
  STOCK_CORRECTION_REJECTED: "STOCK_CORRECTION_REJECTED",
  /** Someone asked to remove a category or a material. entity = the thing's id. */
  REMOVAL_REQUESTED: "REMOVAL_REQUESTED",
  /** A removal was approved and has been carried out. entity = the thing's id. */
  REMOVAL_APPROVED: "REMOVAL_APPROVED",
  /** A removal was declined; nothing was deleted. entity = the thing's id. */
  REMOVAL_REJECTED: "REMOVAL_REJECTED",
} as const;
export type NotificationKind = (typeof NOTIFICATION_KIND)[keyof typeof NOTIFICATION_KIND];

export const NOTIFICATION_SEVERITY = { INFO: "INFO", WARNING: "WARNING", CRITICAL: "CRITICAL" } as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITY)[keyof typeof NOTIFICATION_SEVERITY];

/**
 * What a status move tells the next desk. Only the moves that hand work to somebody are
 * here: the one notification per transition, written in the same transaction as the move, so
 * a notice can never exist for a change that did not happen — or be sent twice for one that did.
 */
export const GATEPASS_TRANSITION_NOTICE: Readonly<
  Partial<Record<GatepassStatusValue, { kind: string; permission: string; title: string }>>
> = {
  BILLED: { kind: NOTIFICATION_KIND.GATEPASS_BILLED, permission: PERMISSION.STORE_SCANNING, title: "Gatepass ready for Store" },
  AT_GATE: { kind: NOTIFICATION_KIND.GATEPASS_AT_GATE, permission: PERMISSION.LIVE_DISPATCH, title: "Gatepass ready for Dispatch" },
  DISPATCHED: { kind: NOTIFICATION_KIND.GATEPASS_DISPATCHED, permission: PERMISSION.GATEPASS, title: "Gatepass dispatched — delivery photo needed" },
  CREATED: { kind: NOTIFICATION_KIND.GATEPASS_CREATED, permission: PERMISSION.SALE_VOUCHER_FORM, title: "Gatepass waiting to be billed" },
} as const;

// ─── Stock corrections ───────────────────────────────────────────────────────
// A manual correction to a raw material's count is a claim that the shelf disagrees with
// the system, so it is reviewed before it is applied. Approving one is what applies it.

export const STOCK_CORRECTION_STATUS = { PENDING: "PENDING", APPROVED: "APPROVED", REJECTED: "REJECTED" } as const;
export type StockCorrectionStatus = (typeof STOCK_CORRECTION_STATUS)[keyof typeof STOCK_CORRECTION_STATUS];

/** A correction with no usable cause cannot be judged, so the data layer refuses it. */
export const STOCK_CORRECTION_MIN_REASON = 4;

// ─── Removals awaiting approval ──────────────────────────────────────────────
// Deleting master data is irreversible, so it is a request an administrator decides, exactly
// as a stock correction is. ITEM is defined alongside CATEGORY because the table was shaped
// for both; only CATEGORY is raised today.

export const REMOVAL_TARGET = { CATEGORY: "CATEGORY", ITEM: "ITEM" } as const;
export type RemovalTarget = (typeof REMOVAL_TARGET)[keyof typeof REMOVAL_TARGET];

export const REMOVAL_STATUS = { PENDING: "PENDING", APPROVED: "APPROVED", REJECTED: "REJECTED" } as const;
export type RemovalStatus = (typeof REMOVAL_STATUS)[keyof typeof REMOVAL_STATUS];

// ─── Reporting ───────────────────────────────────────────────────────────────

export const REPORT_RANGE = { DAILY: "DAILY", WEEKLY: "WEEKLY", MONTHLY: "MONTHLY", CUSTOM: "CUSTOM" } as const;
export type ReportRange = (typeof REPORT_RANGE)[keyof typeof REPORT_RANGE];
