// WHAT KIND OF DATA JUST CHANGED, said by the main process to every open screen.
//
// A screen loads its data when it opens and when its own user acts. Data that arrives from another
// computer arrives behind its back: without being told, a stock screen shows the old figure until
// somebody refreshes it -- however fast the sync was. So after a pass applies anything, the main
// process announces the kinds of data it touched (main/dataChanged.ts), and each screen that shows
// one of them reloads in place (renderer/hooks/useDataChanged.ts).
//
// Kinds, not tables: a screen says what it shows in the words of the business, and this one map
// says which synchronised record types each kind covers.

export const DATA_KIND = {
  /** Stock movements and balances. */
  STOCK: "STOCK",
  /** Materials and everything that describes them: categories, units, ladders, sections, machines. */
  MATERIALS: "MATERIALS",
  /** Parties and party groups. */
  PARTIES: "PARTIES",
  /** Raw-material label runs and packets. */
  LABELS: "LABELS",
  /** Carton identities and production scans. */
  CARTONS: "CARTONS",
  /** Products, their colours and rates, and what groups them. */
  PRODUCTS: "PRODUCTS",
  /** Gatepasses and bills, so customer balances and gatepass queues too. */
  BILLING: "BILLING",
  /** Cash vouchers, so party balances too. */
  CASH: "CASH",
  /** The colour list: what each English colour is called in Urdu (docs/45). */
  COLORS: "COLORS",
  /** What this computer is waiting on: anything arriving can settle or start a wait. */
  SYNC: "SYNC",
} as const;

export type DataKind = (typeof DATA_KIND)[keyof typeof DATA_KIND];

/** What the main process sends with IPC.dataChanged. */
export interface DataChange {
  readonly kinds: readonly DataKind[];
  /**
   * One id per announcement, so one change can be followed through app.log: the pass that applied
   * it, the screen that heard it, its re-read and what it then showed (IPC.traceDataChange).
   */
  readonly id?: string;
}

/** The steps a screen reports for one announced change, in the order they happen. */
export const DATA_CHANGE_TRACE_STAGE = {
  RECEIVED: "received",
  REREAD_STARTED: "reread-started",
  REREAD_DONE: "reread-done",
  SHOWN: "shown",
} as const;

export type DataChangeTraceStage = (typeof DATA_CHANGE_TRACE_STAGE)[keyof typeof DATA_CHANGE_TRACE_STAGE];

/** What a screen sends with IPC.traceDataChange. */
export interface DataChangeTrace {
  readonly id: string;
  readonly screen: string;
  readonly stage: DataChangeTraceStage;
  readonly detail?: string;
}

const CHANGE_ID = /^[A-Za-z0-9-]{1,64}$/;
const SCREEN = /^[a-z][a-z-]{0,39}$/;
const STAGES: ReadonlySet<string> = new Set(Object.values(DATA_CHANGE_TRACE_STAGE));
const MAX_TRACE_DETAIL = 160;

/** A trace as the main process receives it, checked (R25): anything malformed is dropped, never logged. */
export const readDataChangeTrace = (value: unknown): DataChangeTrace | null => {
  if (typeof value !== "object" || value === null) return null;
  const { id, screen, stage, detail } = value as Record<string, unknown>;
  if (typeof id !== "string" || !CHANGE_ID.test(id)) return null;
  if (typeof screen !== "string" || !SCREEN.test(screen)) return null;
  if (typeof stage !== "string" || !STAGES.has(stage)) return null;
  const note = typeof detail === "string" ? detail.replace(/[^\x20-\x7E]/g, " ").slice(0, MAX_TRACE_DETAIL) : undefined;
  return { id, screen, stage: stage as DataChangeTraceStage, ...(note ? { detail: note } : {}) };
};

const KIND_OF_TYPE: Readonly<Record<string, DataKind>> = {
  STOCK_EVENT: DATA_KIND.STOCK,
  INVENTORY_ITEM: DATA_KIND.MATERIALS,
  INVENTORY_CATEGORY: DATA_KIND.MATERIALS,
  INVENTORY_UNIT: DATA_KIND.MATERIALS,
  UNIT_LADDER_PRESET: DATA_KIND.MATERIALS,
  WORK_SECTION: DATA_KIND.MATERIALS,
  MACHINE: DATA_KIND.MATERIALS,
  PARTY: DATA_KIND.PARTIES,
  PARTY_GROUP: DATA_KIND.PARTIES,
  RAW_MATERIAL_QR_BATCH: DATA_KIND.LABELS,
  RAW_MATERIAL_QR: DATA_KIND.LABELS,
  QR_MASTER: DATA_KIND.CARTONS,
  PRODUCTION_PRODUCED: DATA_KIND.CARTONS,
  PRODUCT_VARIANT: DATA_KIND.CARTONS,
  CARTON_STOCK_EVENT: DATA_KIND.CARTONS,
  MANUAL_PRODUCTION_ENTRY: DATA_KIND.CARTONS,
  CARTON_STOCK_ADJUSTMENT: DATA_KIND.CARTONS,
  PRODUCTION_DAY: DATA_KIND.CARTONS,
  MAIN_GROUP: DATA_KIND.PRODUCTS,
  PRODUCT_GROUP: DATA_KIND.PRODUCTS,
  ARTICLE_SERIES: DATA_KIND.PRODUCTS,
  PRODUCT_TYPE: DATA_KIND.PRODUCTS,
  PRODUCT_SUB_GROUP: DATA_KIND.PRODUCTS,
  ARTICLE_SIZE: DATA_KIND.PRODUCTS,
  GATEPASS: DATA_KIND.BILLING,
  SALE_VOUCHER: DATA_KIND.BILLING,
  CASH_VOUCHER: DATA_KIND.CASH,
  COLOR_TRANSLATION: DATA_KIND.COLORS,
};

/**
 * The kinds a set of applied record types touched. SYNC is always among them: whatever arrived may
 * have settled something this computer was waiting on. A type with no kind here still announces
 * SYNC, so a screen never misses a change because the map lagged behind a new type.
 */
export const dataKindsOf = (aggregateTypes: readonly string[]): DataKind[] => {
  const kinds = new Set<DataKind>([DATA_KIND.SYNC]);
  for (const type of aggregateTypes) {
    const kind = KIND_OF_TYPE[type];
    if (kind !== undefined) kinds.add(kind);
  }
  return [...kinds].sort();
};

const KINDS: ReadonlySet<string> = new Set(Object.values(DATA_KIND));

/** The message as it arrives in a screen, checked (R25): unknown kinds are dropped. */
export const readDataChange = (value: unknown): DataChange | null => {
  if (typeof value !== "object" || value === null) return null;
  const { kinds, id } = value as { kinds?: unknown; id?: unknown };
  if (!Array.isArray(kinds)) return null;
  const known = kinds.filter((kind): kind is DataKind => typeof kind === "string" && KINDS.has(kind));
  return typeof id === "string" && CHANGE_ID.test(id) ? { kinds: known, id } : { kinds: known };
};
