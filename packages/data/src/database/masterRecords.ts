// What a master record IS, and how this computer turns a marked one into a queued revision.
//
// A leased record (cloud migration 013) travels WHOLE: the root row and every row that belongs to
// it -- a material with its field values and unit steps, a category with its fields and their
// options. MASTER_RECORDS says, once, which tables make up each record, how a child row names its
// parent, and which other records a row needs present first. The builder snapshots by it, the
// receiving computer validates and writes by it (packages/sync/src/leasedRecordContracts.ts), and a
// record that has to wait names what it waits for from it.
//
// It must cover exactly the tables MASTER_CAPTURE marks (masterCapture.ts): masterRecords.test.ts
// checks the two agree, so a table cannot be captured and then never sent, or sent and never captured.

import crypto from "node:crypto";
import { enqueueSyncEvent, heldLeaseEpoch, leaseDomainOf, SYNC_AGGREGATE, type SyncAggregateType, type SyncWriteHandle } from "./syncEvents.js";
import { STOCK_RECORD_TYPES, cartonCloudIsActive, isLocalStockRecord } from "./stockProtection.js";

/** How many pages of marks a builder reads, so held-back marks cannot fill a page by themselves. */

export type MasterRecordType =
  | typeof SYNC_AGGREGATE.PARTY_GROUP
  | typeof SYNC_AGGREGATE.PARTY
  | typeof SYNC_AGGREGATE.INVENTORY_UNIT
  | typeof SYNC_AGGREGATE.UNIT_LADDER_PRESET
  | typeof SYNC_AGGREGATE.INVENTORY_CATEGORY
  | typeof SYNC_AGGREGATE.INVENTORY_ITEM
  | typeof SYNC_AGGREGATE.WORK_SECTION
  | typeof SYNC_AGGREGATE.MACHINE
  | typeof SYNC_AGGREGATE.MAIN_GROUP
  | typeof SYNC_AGGREGATE.PRODUCT_GROUP
  | typeof SYNC_AGGREGATE.ARTICLE_SERIES
  | typeof SYNC_AGGREGATE.PRODUCT_TYPE
  | typeof SYNC_AGGREGATE.PRODUCT_SUB_GROUP
  | typeof SYNC_AGGREGATE.ARTICLE_SIZE
  | typeof SYNC_AGGREGATE.COLOR_TRANSLATION
  | typeof SYNC_AGGREGATE.MANUAL_PRODUCTION_ENTRY
  | typeof SYNC_AGGREGATE.GATEPASS
  | typeof SYNC_AGGREGATE.SALE_VOUCHER
  | typeof SYNC_AGGREGATE.CASH_VOUCHER
  | typeof SYNC_AGGREGATE.CARTON_STOCK_ADJUSTMENT
  | typeof SYNC_AGGREGATE.PRODUCTION_DAY
  | typeof SYNC_AGGREGATE.STORE_HAND_VOUCHER
  | typeof SYNC_AGGREGATE.LEDGER_ARCHIVE_STATEMENT
  | typeof SYNC_AGGREGATE.LEDGER_ARCHIVE_ENTRY_PAGE
  | typeof SYNC_AGGREGATE.PARTY_OPENING_BALANCE
  | typeof SYNC_AGGREGATE.PURCHASE_VOUCHER
  | typeof SYNC_AGGREGATE.PARTY_CLAIM_REQUEST
  | typeof SYNC_AGGREGATE.PARTY_CLAIM
  | typeof SYNC_AGGREGATE.PARTY_CLAIM_REJECTION
  | typeof SYNC_AGGREGATE.SALE_RETURN
  | typeof SYNC_AGGREGATE.CUSTOMER_ORDER
  | typeof SYNC_AGGREGATE.GATEPASS_ORDER_ALLOCATION;

/** A column naming another record that must be on this computer before this row can be written. */
export interface RecordReference {
  readonly column: string;
  /** The table the id is looked up in. */
  readonly table: string;
  /** The record that brings that row. */
  readonly record: MasterRecordType;
}

export interface RecordTableSpec {
  readonly table: string;
  /** The column holding the parent row's id. Absent on the root, whose key is always `id`. */
  readonly parentColumn?: string;
  readonly references?: readonly RecordReference[];
  readonly children?: readonly RecordTableSpec[];
  /**
   * Columns that mean something only on this computer, and never travel: a Manual Production entry's link
   * to a machine program, which does not replicate. A receiver leaves its own value alone.
   */
  readonly localColumns?: readonly string[];
}

const unitRef = (column: string): RecordReference => ({ column, table: "inventory_units", record: SYNC_AGGREGATE.INVENTORY_UNIT });
const partyRef = (column: string): RecordReference => ({ column, table: "parties", record: SYNC_AGGREGATE.PARTY });
const variantRef: RecordReference = { column: "product_variant_id", table: "product_variants", record: SYNC_AGGREGATE.ARTICLE_SIZE };
/** What a product and its colours are classified by. */
const PRODUCT_GROUPING: readonly RecordReference[] = [
  { column: "main_group_id", table: "main_groups", record: SYNC_AGGREGATE.MAIN_GROUP },
  { column: "product_group_id", table: "product_groups", record: SYNC_AGGREGATE.PRODUCT_GROUP },
  { column: "article_series_id", table: "article_series", record: SYNC_AGGREGATE.ARTICLE_SERIES },
  { column: "product_type_id", table: "product_types", record: SYNC_AGGREGATE.PRODUCT_TYPE },
  { column: "product_sub_group_id", table: "product_sub_groups", record: SYNC_AGGREGATE.PRODUCT_SUB_GROUP },
];

/**
 * Every master record type, IN PREREQUISITE ORDER: a record only refers to types before it, except
 * a category's parent category. The builder queues in this order, so a reader usually receives what
 * a record needs before the record itself.
 */
export const MASTER_RECORD_TYPES: readonly MasterRecordType[] = [
  SYNC_AGGREGATE.PARTY_GROUP,
  SYNC_AGGREGATE.INVENTORY_UNIT,
  SYNC_AGGREGATE.WORK_SECTION,
  SYNC_AGGREGATE.UNIT_LADDER_PRESET,
  SYNC_AGGREGATE.INVENTORY_CATEGORY,
  SYNC_AGGREGATE.PARTY,
  SYNC_AGGREGATE.INVENTORY_ITEM,
  SYNC_AGGREGATE.MACHINE,
  SYNC_AGGREGATE.MAIN_GROUP,
  SYNC_AGGREGATE.PRODUCT_GROUP,
  SYNC_AGGREGATE.ARTICLE_SERIES,
  SYNC_AGGREGATE.PRODUCT_TYPE,
  SYNC_AGGREGATE.PRODUCT_SUB_GROUP,
  SYNC_AGGREGATE.ARTICLE_SIZE,
  SYNC_AGGREGATE.COLOR_TRANSLATION,
  SYNC_AGGREGATE.MANUAL_PRODUCTION_ENTRY,
  SYNC_AGGREGATE.GATEPASS,
  SYNC_AGGREGATE.SALE_VOUCHER,
  SYNC_AGGREGATE.CASH_VOUCHER,
  SYNC_AGGREGATE.CARTON_STOCK_ADJUSTMENT,
  SYNC_AGGREGATE.PRODUCTION_DAY,
  SYNC_AGGREGATE.STORE_HAND_VOUCHER,
  SYNC_AGGREGATE.LEDGER_ARCHIVE_STATEMENT,
  // After its statement: a page names the statement it belongs to.
  SYNC_AGGREGATE.LEDGER_ARCHIVE_ENTRY_PAGE,
  SYNC_AGGREGATE.PARTY_OPENING_BALANCE,
  // After PARTY and INVENTORY_ITEM: a bill names its supplier, each line its material.
  SYNC_AGGREGATE.PURCHASE_VOUCHER,
  // After PARTY and INVENTORY_ITEM: a request names its party and material. A claim and a rejection name the request.
  SYNC_AGGREGATE.PARTY_CLAIM_REQUEST,
  SYNC_AGGREGATE.PARTY_CLAIM,
  SYNC_AGGREGATE.PARTY_CLAIM_REJECTION,
  // After SALE_VOUCHER and ARTICLE_SIZE: a return names its customer, its bill and its product.
  SYNC_AGGREGATE.SALE_RETURN,
  // After GATEPASS: an allocation names the gatepass's lines and the order's lines.
  SYNC_AGGREGATE.CUSTOMER_ORDER,
  SYNC_AGGREGATE.GATEPASS_ORDER_ALLOCATION,
];

export const MASTER_RECORDS: Readonly<Record<MasterRecordType, RecordTableSpec>> = {
  [SYNC_AGGREGATE.PARTY_GROUP]: { table: "party_groups" },
  [SYNC_AGGREGATE.PARTY]: {
    table: "parties",
    references: [{ column: "party_group_id", table: "party_groups", record: SYNC_AGGREGATE.PARTY_GROUP }],
    // A customer's discount rules travel with the customer (owner, 27 Nov 2026: "make discount policies sync to the
    // cloud"), so a bill applies the same discount on every computer and the rules survive a lost PC. They are written
    // only where PARTIES is held (leaseChannels.ts), and a receiver holds exactly the sender's rules. A receiver on an
    // older build has no such children in its spec and writes the party alone: the party still lands.
    children: [
      { table: "party_product_group_discounts", parentColumn: "party_id", references: [{ column: "product_group_id", table: "product_groups", record: SYNC_AGGREGATE.PRODUCT_GROUP }] },
      { table: "party_article_series_discounts", parentColumn: "party_id", references: [{ column: "article_series_id", table: "article_series", record: SYNC_AGGREGATE.ARTICLE_SERIES }] },
      { table: "party_article_discounts", parentColumn: "party_id" },
      { table: "party_price_range_discounts", parentColumn: "party_id" },
    ],
  },
  [SYNC_AGGREGATE.INVENTORY_UNIT]: {
    table: "inventory_units",
    children: [{ table: "inventory_unit_conversions", parentColumn: "from_unit_id", references: [unitRef("to_unit_id")] }],
  },
  [SYNC_AGGREGATE.UNIT_LADDER_PRESET]: {
    table: "unit_ladder_presets",
    children: [{ table: "unit_ladder_preset_steps", parentColumn: "preset_id", references: [unitRef("from_unit_id"), unitRef("to_unit_id")] }],
  },
  [SYNC_AGGREGATE.INVENTORY_CATEGORY]: {
    table: "inventory_categories",
    references: [{ column: "parent_id", table: "inventory_categories", record: SYNC_AGGREGATE.INVENTORY_CATEGORY }],
    children: [
      {
        table: "inventory_category_fields",
        parentColumn: "category_id",
        children: [{ table: "inventory_category_field_options", parentColumn: "field_id" }],
      },
    ],
  },
  [SYNC_AGGREGATE.INVENTORY_ITEM]: {
    table: "inventory_items",
    references: [
      { column: "category_id", table: "inventory_categories", record: SYNC_AGGREGATE.INVENTORY_CATEGORY },
      unitRef("default_unit_id"),
      unitRef("packing_unit_id"),
      { column: "default_section_id", table: "work_sections", record: SYNC_AGGREGATE.WORK_SECTION },
    ],
    children: [
      {
        table: "inventory_item_values",
        parentColumn: "item_id",
        // A value names a field, and the field comes with its category's record.
        references: [{ column: "field_id", table: "inventory_category_fields", record: SYNC_AGGREGATE.INVENTORY_CATEGORY }],
      },
      { table: "inventory_item_unit_steps", parentColumn: "item_id", references: [unitRef("from_unit_id"), unitRef("to_unit_id")] },
    ],
  },
  [SYNC_AGGREGATE.WORK_SECTION]: { table: "work_sections" },
  [SYNC_AGGREGATE.MACHINE]: {
    table: "machines",
    references: [
      { column: "section_id", table: "work_sections", record: SYNC_AGGREGATE.WORK_SECTION },
      { column: "contractor_party_id", table: "parties", record: SYNC_AGGREGATE.PARTY },
      { column: "packing_contractor_party_id", table: "parties", record: SYNC_AGGREGATE.PARTY },
    ],
  },
  [SYNC_AGGREGATE.MAIN_GROUP]: { table: "main_groups" },
  [SYNC_AGGREGATE.PRODUCT_GROUP]: { table: "product_groups" },
  [SYNC_AGGREGATE.ARTICLE_SERIES]: { table: "article_series" },
  [SYNC_AGGREGATE.PRODUCT_TYPE]: { table: "product_types" },
  [SYNC_AGGREGATE.PRODUCT_SUB_GROUP]: {
    table: "product_sub_groups",
    references: [{ column: "product_group_id", table: "product_groups", record: SYNC_AGGREGATE.PRODUCT_GROUP }],
  },
  [SYNC_AGGREGATE.ARTICLE_SIZE]: {
    table: "article_sizes",
    references: PRODUCT_GROUPING,
    children: [{ table: "product_variants", parentColumn: "article_size_id", references: PRODUCT_GROUPING, localColumns: ["replicated_at"] }],
  },
  // A colour refers to nothing, and nothing refers to it by id: colours are stored in English and only shown in Urdu (docs/45).
  [SYNC_AGGREGATE.COLOR_TRANSLATION]: { table: "color_translations" },
  [SYNC_AGGREGATE.MANUAL_PRODUCTION_ENTRY]: {
    table: "manual_production_entries",
    localColumns: ["machine_program_id"],
    references: [
      { column: "machine_id", table: "machines", record: SYNC_AGGREGATE.MACHINE },
      { column: "article_size_id", table: "article_sizes", record: SYNC_AGGREGATE.ARTICLE_SIZE },
      variantRef,
      partyRef("contractor_party_id"),
      partyRef("packing_contractor_party_id"),
    ],
  },
  // Request ids and fingerprints (migration 105) answer a retry on the computer that made the document, and
  // nowhere else: they stay here.
  [SYNC_AGGREGATE.GATEPASS]: {
    table: "gatepasses",
    localColumns: ["request_id", "request_fingerprint"],
    references: [partyRef("party_id")],
    // Its versions (local migration 118) travel with it, so its edit history reads the same on every computer. A
    // receiver on an older build has no such table and writes only the children it knows: the gatepass still lands.
    children: [
      { table: "gatepass_lines", parentColumn: "gatepass_id", references: [variantRef] },
      { table: "gatepass_versions", parentColumn: "gatepass_id" },
    ],
  },
  [SYNC_AGGREGATE.SALE_VOUCHER]: {
    table: "sale_vouchers",
    localColumns: ["request_id", "request_fingerprint"],
    references: [partyRef("party_id"), { column: "gatepass_id", table: "gatepasses", record: SYNC_AGGREGATE.GATEPASS }],
    children: [
      { table: "sale_voucher_line_items", parentColumn: "voucher_id", references: [variantRef] },
      { table: "dispatch_sessions", parentColumn: "voucher_id" },
    ],
  },
  [SYNC_AGGREGATE.CASH_VOUCHER]: {
    table: "cash_vouchers",
    localColumns: ["request_fingerprint"],
    references: [partyRef("party_id")],
    children: [{ table: "cash_voucher_lines", parentColumn: "voucher_id", references: [partyRef("party_id")] }],
  },
  // A Stock Adjustment document (docs/46). Each line names the movement it made; the movement travels on its own.
  [SYNC_AGGREGATE.CARTON_STOCK_ADJUSTMENT]: {
    table: "carton_stock_adjustments",
    children: [{ table: "carton_stock_adjustment_lines", parentColumn: "adjustment_id", references: [variantRef] }],
  },
  // A completed production day (docs/48): one row, referring to nothing. It is a mark, not stock.
  [SYNC_AGGREGATE.PRODUCTION_DAY]: { table: "production_days" },
  // A store hand voucher (docs/49): its party, and each line's material. Its movements travel as STOCK_EVENT.
  [SYNC_AGGREGATE.STORE_HAND_VOUCHER]: {
    table: "store_hand_vouchers",
    references: [partyRef("party_id")],
    children: [{ table: "store_hand_voucher_lines", parentColumn: "voucher_id", references: [{ column: "item_id", table: "inventory_items", record: SYNC_AGGREGATE.INVENTORY_ITEM }] }],
  },
  // A party's archived statement from the old software (docs/50): its header only, naming its party. Never accounting.
  // Its rows travel as pages (below): the whole statement in one record could be over the cloud's 256 KB a record,
  // and was refused RECORD_TOO_LARGE before local 117.
  [SYNC_AGGREGATE.LEDGER_ARCHIVE_STATEMENT]: {
    table: "ledger_archive_statements",
    references: [partyRef("party_id")],
  },
  // Up to LEDGER_ARCHIVE_PAGE_ROWS of a statement's rows (local 117). Its id is the statement's id and its number,
  // the same on every computer. A statement shows only once all its rows are here (ARCHIVE_STATEMENT_COMPLETE_SQL).
  [SYNC_AGGREGATE.LEDGER_ARCHIVE_ENTRY_PAGE]: {
    table: "ledger_archive_entry_pages",
    references: [{ column: "statement_id", table: "ledger_archive_statements", record: SYNC_AGGREGATE.LEDGER_ARCHIVE_STATEMENT }],
    children: [{ table: "ledger_archive_entries", parentColumn: "page_id" }],
  },
  // A supplier's purchase bill (docs/54). A replaced line stays, marked deleted, so the bill's history travels with it.
  [SYNC_AGGREGATE.PURCHASE_VOUCHER]: {
    table: "purchase_vouchers",
    references: [partyRef("party_id")],
    children: [
      {
        table: "purchase_voucher_line_items",
        parentColumn: "voucher_id",
        references: [{ column: "item_id", table: "inventory_items", record: SYNC_AGGREGATE.INVENTORY_ITEM }],
      },
    ],
  },
  // Claims (docs/55). Program and upper line ids are the store's references, kept for tracing: programs do not travel,
  // so they are not looked up. The program's code and the material's name travel as text with the record.
  [SYNC_AGGREGATE.PARTY_CLAIM_REQUEST]: {
    table: "party_claim_requests",
    references: [partyRef("party_id"), { column: "item_id", table: "inventory_items", record: SYNC_AGGREGATE.INVENTORY_ITEM }],
  },
  [SYNC_AGGREGATE.PARTY_CLAIM]: {
    table: "party_claims",
    references: [
      partyRef("party_id"),
      { column: "item_id", table: "inventory_items", record: SYNC_AGGREGATE.INVENTORY_ITEM },
      { column: "request_id", table: "party_claim_requests", record: SYNC_AGGREGATE.PARTY_CLAIM_REQUEST },
    ],
  },
  [SYNC_AGGREGATE.PARTY_CLAIM_REJECTION]: {
    table: "party_claim_rejections",
    references: [{ column: "request_id", table: "party_claim_requests", record: SYNC_AGGREGATE.PARTY_CLAIM_REQUEST }],
  },
  // A customer's carton return credit (docs/55). Its QR, dispatch and bill line ids are the sales computer's references:
  // the QR flows do not travel, and only the customer's ledger and balance read a return.
  [SYNC_AGGREGATE.SALE_RETURN]: {
    table: "sale_returns",
    references: [partyRef("party_id"), variantRef, { column: "sale_voucher_id", table: "sale_vouchers", record: SYNC_AGGREGATE.SALE_VOUCHER }],
  },
  // A party's opening balance (docs/53): its party, the archived statement it was checked against if any, and every
  // posting and reversal. A correction is one revision, so a receiver never holds two positions for one party.
  [SYNC_AGGREGATE.PARTY_OPENING_BALANCE]: {
    table: "party_opening_balances",
    references: [partyRef("party_id"), { column: "archive_statement_id", table: "ledger_archive_statements", record: SYNC_AGGREGATE.LEDGER_ARCHIVE_STATEMENT }],
    children: [{ table: "party_opening_balance_entries", parentColumn: "opening_balance_id" }],
  },
  // A customer order (docs/52): its party, and each line's product. It moves nothing.
  [SYNC_AGGREGATE.CUSTOMER_ORDER]: {
    table: "customer_orders",
    references: [partyRef("party_id")],
    children: [{ table: "customer_order_lines", parentColumn: "order_id", references: [variantRef] }],
  },
  // One gatepass's allocation against orders (docs/52): the gatepass and its party, and each line's gatepass line and
  // order line, so a receiver writes it only once both documents are there.
  [SYNC_AGGREGATE.GATEPASS_ORDER_ALLOCATION]: {
    table: "gatepass_order_allocations",
    references: [partyRef("party_id"), { column: "gatepass_id", table: "gatepasses", record: SYNC_AGGREGATE.GATEPASS }],
    children: [
      {
        table: "gatepass_order_allocation_lines",
        parentColumn: "allocation_id",
        references: [
          { column: "gatepass_line_id", table: "gatepass_lines", record: SYNC_AGGREGATE.GATEPASS },
          { column: "order_line_id", table: "customer_order_lines", record: SYNC_AGGREGATE.CUSTOMER_ORDER },
        ],
      },
    ],
  },
};

export const isMasterRecordType = (value: string): value is MasterRecordType =>
  (MASTER_RECORD_TYPES as readonly string[]).includes(value);

/** Every table of a record spec, root first. */
export function specTables(spec: RecordTableSpec): RecordTableSpec[] {
  return [spec, ...(spec.children ?? []).flatMap((child) => specTables(child))];
}

// ─── The record on the wire ─────────────────────────────────────────────────

/** One row, and the rows that belong to it, by child table. */
export interface RecordNode {
  readonly row: Readonly<Record<string, string | number | null>>;
  readonly children: Readonly<Record<string, readonly RecordNode[]>>;
}

/** What a leased-record revision carries (cloud migration 013's body, inside the log payload). */
export interface LeasedRecordPayload {
  readonly recordId: string;
  readonly revision: number;
  readonly deleted: boolean;
  /** The whole record. Null exactly when it was deleted. */
  readonly body: RecordNode | null;
}

/** A revision of one record is its own event: a reader applies them in order. */
export const leasedRecordDedupeKey = (type: string, recordId: string, revision: number): string =>
  `${type}:${recordId}:${String(revision)}`;

type SqlRow = Record<string, unknown>;

/** What a snapshot needs: to read rows. */
export interface RecordReadHandle {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

const plainRow = (row: SqlRow, localColumns: readonly string[] = []): Record<string, string | number | null> => {
  const copy: Record<string, string | number | null> = {};
  for (const [column, value] of Object.entries(row)) {
    if (localColumns.includes(column)) continue;
    copy[column] = typeof value === "string" || typeof value === "number" ? value : value === null || value === undefined ? null : String(value);
  }
  return copy;
};

/** The record as this computer holds it now, or null when its root row is gone. */
export function snapshotRecord(db: RecordReadHandle, type: MasterRecordType, recordId: string): RecordNode | null {
  const spec = MASTER_RECORDS[type];
  const root = db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).all(recordId)[0] as SqlRow | undefined;
  if (root === undefined) return null;
  return snapshotNode(db, spec, root);
}

function snapshotNode(db: RecordReadHandle, spec: RecordTableSpec, row: SqlRow): RecordNode {
  const children: Record<string, RecordNode[]> = {};
  for (const child of spec.children ?? []) {
    const rows = db.prepare(`SELECT * FROM ${child.table} WHERE ${child.parentColumn ?? "id"} = ? ORDER BY id`).all(String(row.id)) as SqlRow[];
    children[child.table] = rows.map((childRow) => snapshotNode(db, child, childRow));
  }
  return { row: plainRow(row, spec.localColumns), children };
}

// ─── Reading a revision off the wire (R25) ──────────────────────────────────

const isCell = (value: unknown): value is string | number | null =>
  value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));

function readNode(value: unknown, spec: RecordTableSpec, parentId: string | null): RecordNode | null {
  if (typeof value !== "object" || value === null) return null;
  const node = value as Record<string, unknown>;
  if (typeof node.row !== "object" || node.row === null || typeof node.children !== "object" || node.children === null) return null;
  const row = node.row as Record<string, unknown>;
  if (!Object.values(row).every(isCell)) return null;
  if (typeof row.id !== "string" || row.id.trim() === "") return null;
  if (spec.parentColumn !== undefined && row[spec.parentColumn] !== parentId) return null;
  const given = node.children as Record<string, unknown>;
  const allowed = new Set((spec.children ?? []).map((child) => child.table));
  if (!Object.keys(given).every((table) => allowed.has(table))) return null;
  const children: Record<string, RecordNode[]> = {};
  for (const child of spec.children ?? []) {
    const list = given[child.table] ?? [];
    if (!Array.isArray(list)) return null;
    const read: RecordNode[] = [];
    for (const item of list) {
      const childNode = readNode(item, child, row.id);
      if (childNode === null) return null;
      read.push(childNode);
    }
    children[child.table] = read;
  }
  return { row: row as Record<string, string | number | null>, children };
}

/**
 * A revision as it arrives, validated whole against the record's spec, or null. A body naming a
 * table the spec does not have, a child that names another parent, or a value that is not a plain
 * cell is refused rather than partly written.
 */
export function readLeasedRecordPayload(type: string, payload: Record<string, unknown>): LeasedRecordPayload | null {
  if (!isMasterRecordType(type)) return null;
  const { recordId, revision, deleted } = payload;
  if (typeof recordId !== "string" || recordId.trim() === "") return null;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) return null;
  if (typeof deleted !== "boolean") return null;
  if (deleted) return payload.body === null || payload.body === undefined ? { recordId, revision, deleted, body: null } : null;
  const body = readNode(payload.body, MASTER_RECORDS[type], null);
  if (body === null || body.row.id !== recordId) return null;
  return { recordId, revision, deleted, body };
}

// ─── Building revisions from marks ──────────────────────────────────────────

export interface BuildHandle extends SyncWriteHandle {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: Array<string | number | null>): { changes: number | bigint; lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
  };
}

export interface BuildResult {
  /** Revisions queued. */
  readonly queued: number;
  /** Marks that could not be queued and were left marked (the outbox refused the row). */
  readonly unqueued: number;
  /**
   * Marks of stock records made before Carton Cloud was activated here, found after activation: retired, never queued
   * (stockProtection.ts). Counted, so a pass says so rather than look complete.
   */
  readonly heldBack?: number;
}

const ORDER = MASTER_RECORD_TYPES.map((type, index) => `WHEN '${type}' THEN ${String(index)}`).join(" ");
/** Only master records: other captured types (stock events) have builders of their own. */
const MASTER_TYPES_SQL = MASTER_RECORD_TYPES.map((type) => `'${type}'`).join(", ");
/** Before Carton Cloud is activated, stock documents are not built at all: their marks wait, untouched (stockProtection.ts). */
const MASTER_TYPES_WITHOUT_STOCK_SQL = MASTER_RECORD_TYPES.filter((type) => !STOCK_RECORD_TYPES.has(type)).map((type) => `'${type}'`).join(", ");

/**
 * Turns marked records into queued revisions, prerequisites first, in one transaction.
 *
 * Only marks that carry a lease epoch are built: a change made while this computer held the
 * master-data lease. Each revision is stamped with THAT epoch, not the one held now, so a change
 * made under a lease since lost is refused visibly when pushed (NOT_LEASE_HOLDER, a dead letter).
 * A mark with no epoch -- made while this computer was not set up for sync -- stays marked for the
 * backfill.
 *
 * A record whose root row is gone is queued as a deletion. A mark the outbox will not take is left
 * marked and counted, never cleared: clearing it would lose the change.
 */
export function buildLeasedRecordRevisions(db: BuildHandle, nowIso: string, limit = 200): BuildResult {
  const stockMayGo = cartonCloudIsActive(db);
  const marks = db
    .prepare(
      `SELECT aggregate_type, record_id, lease_epoch FROM sync_dirty_records
        WHERE lease_epoch IS NOT NULL AND aggregate_type IN (${stockMayGo ? MASTER_TYPES_SQL : MASTER_TYPES_WITHOUT_STOCK_SQL})
        ORDER BY CASE aggregate_type ${ORDER} ELSE 99 END, marked_at, record_id
        LIMIT ?`
    )
    .all(limit) as Array<{ aggregate_type: string; record_id: string; lease_epoch: number }>;
  if (marks.length === 0) return { queued: 0, unqueued: 0, heldBack: 0 };

  let queued = 0;
  let unqueued = 0;
  let heldBack = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const mark of marks) {
      if (!isMasterRecordType(mark.aggregate_type)) {
        unqueued += 1;
        continue;
      }
      const type = mark.aggregate_type;
      // A stock document made before activation (an edit of an old test gatepass, bill, voucher or entry): excluded
      // for ever, so its mark is retired rather than left to wait. Counted; the pass logs it.
      if (isLocalStockRecord(db, type, mark.record_id)) {
        db.prepare("DELETE FROM sync_dirty_records WHERE aggregate_type = ? AND record_id = ?").run(type, mark.record_id);
        heldBack += 1;
        continue;
      }
      const current = db.prepare("SELECT revision FROM sync_record_revisions WHERE aggregate_type = ? AND record_id = ?").all(type, mark.record_id)[0] as
        | { revision: number }
        | undefined;
      const revision = Number(current?.revision ?? 0) + 1;
      const body = snapshotRecord(db, type, mark.record_id);
      const payload: LeasedRecordPayload = { recordId: mark.record_id, revision, deleted: body === null, body };
      const ok = enqueueSyncEvent(db, {
        outboxId: crypto.randomUUID(),
        aggregateType: type as SyncAggregateType,
        aggregateId: mark.record_id,
        dedupeKey: leasedRecordDedupeKey(type, mark.record_id, revision),
        payload: { ...payload },
        nowIso,
        leaseEpoch: Number(mark.lease_epoch),
      });
      if (!ok) {
        unqueued += 1;
        continue;
      }
      db.prepare(
        `INSERT INTO sync_record_revisions (aggregate_type, record_id, revision) VALUES (?, ?, ?)
         ON CONFLICT (aggregate_type, record_id) DO UPDATE SET revision = excluded.revision`
      ).run(type, mark.record_id, revision);
      db.prepare("DELETE FROM sync_dirty_records WHERE aggregate_type = ? AND record_id = ?").run(type, mark.record_id);
      queued += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { queued, unqueued, heldBack };
}

// ─── Sending a record again ─────────────────────────────────────────────────

export type SendAgainOutcome =
  /** Marked under the lease held now: the next pass sends a new revision of it. */
  | "MARKED"
  | "UNKNOWN_TYPE"
  /** This computer does not have the record, so it has nothing to send. */
  | "NOT_HERE"
  /** This computer does not hold the record's lease, so a revision from here would be refused. */
  | "NO_LEASE"
  /** Local test stock data, made before Carton Cloud was activated here: never sent (stockProtection.ts). */
  | "LOCAL_STOCK_DATA"
  /** A stock document, and Carton Cloud is not active on this computer: no stock document is sent. */
  | "CARTON_CLOUD_NOT_ACTIVE";

/**
 * Marks one record to be sent again, as a new revision -- for a record another computer is waiting
 * for and never received (its change was made before this computer synced, or its revision became a
 * dead letter). The mark is the one a capture trigger writes, stamped with the epoch held now, so the
 * next pass builds and sends it like any other change. Nothing about the record itself changes.
 *
 * The caller is the lease-guarded write path: only the domain's holder may send a revision.
 */
export function markRecordToSendAgain(db: BuildHandle, type: string, recordId: string, nowIso: string): SendAgainOutcome {
  if (!isMasterRecordType(type)) return "UNKNOWN_TYPE";
  const present = db.prepare(`SELECT 1 AS here FROM ${MASTER_RECORDS[type].table} WHERE id = ?`).all(recordId);
  if (present.length === 0) return "NOT_HERE";
  // A stock record is refused, not marked, unless Carton Cloud is active and the record was made after activation.
  if (STOCK_RECORD_TYPES.has(type) && !cartonCloudIsActive(db)) return "CARTON_CLOUD_NOT_ACTIVE";
  if (isLocalStockRecord(db, type, recordId)) return "LOCAL_STOCK_DATA";
  const domain = leaseDomainOf(type);
  const epoch = domain === null ? null : heldLeaseEpoch(db, domain);
  if (epoch === null) return "NO_LEASE";
  db.prepare(
    `INSERT INTO sync_dirty_records (aggregate_type, record_id, lease_epoch, marked_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (aggregate_type, record_id) DO UPDATE SET lease_epoch = excluded.lease_epoch, marked_at = excluded.marked_at`
  ).run(type, recordId, Number(epoch), nowIso);
  return "MARKED";
}
