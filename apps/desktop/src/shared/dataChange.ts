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
  /** What this computer is waiting on: anything arriving can settle or start a wait. */
  SYNC: "SYNC",
} as const;

export type DataKind = (typeof DATA_KIND)[keyof typeof DATA_KIND];

/** What the main process sends with IPC.dataChanged. */
export interface DataChange {
  readonly kinds: readonly DataKind[];
}

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
  const kinds = (value as { kinds?: unknown }).kinds;
  if (!Array.isArray(kinds)) return null;
  return { kinds: kinds.filter((kind): kind is DataKind => typeof kind === "string" && KINDS.has(kind)) };
};
