// The store's day, one direction at a time: everything that came IN, or everything that went OUT.
//
//   Daily Report Store In · 13 Oct
//     Scanned in   12 packets      DANA EVA BLACK   250 KG
//     By hand       2 entries      NAWAAR 5 SOOTAR  1,950 INCH
//     Cartons      40 received     SK6 7/10 BLACK   40 cartons
//
// Nothing here reads the database. The data layer hands over every movement of the day already
// shaped as entries, and these rules decide the rest — which way a stock event moved, what kind
// of movement it was, and the totals — so the report, its printout and any later reader (an AI
// summary included) all count the same day the same way.

/** Which side of the store a report covers. */
export const STORE_DIRECTION = {
  IN: "IN",
  OUT: "OUT",
} as const;

export type StoreDirection = (typeof STORE_DIRECTION)[keyof typeof STORE_DIRECTION];

/**
 * How a movement was made — what the report groups by and the operator reads in each row.
 *
 * A machine program is not a source of its own: a packet scanned out for one is still a SCAN, and
 * carries the program's code beside it. Dana is the exception because it has no label and is only
 * ever typed out FOR a program, so "typed out for MP-000012" is the whole of what it is.
 */
export const STORE_MOVEMENT_SOURCE = {
  /** A labelled raw material packet, scanned. */
  SCAN: "SCAN",
  /** Loose stock with no label, typed in or out by hand. */
  MANUAL: "MANUAL",
  /** Dana typed out of the store for a machine program. */
  DANA: "DANA",
  /** Cut size uppers or pairs returned when a machine program was reconciled. */
  CUT_SIZE: "CUT_SIZE",
  /** The opening stock given when the material was created or imported. */
  OPENING: "OPENING",
  /** An administrator-approved stock correction. */
  CORRECTION: "CORRECTION",
  /** A finished carton scanned into, or out of, the store. */
  CARTON: "CARTON",
  /** A finished carton brought back into the store from the gate. */
  GATE_RETURN: "GATE_RETURN",
  /** A stock event no known screen writes — shown rather than hidden. */
  OTHER: "OTHER",
} as const;

export type StoreMovementSource = (typeof STORE_MOVEMENT_SOURCE)[keyof typeof STORE_MOVEMENT_SOURCE];

/** The order sources are listed in, most common first. */
export const STORE_MOVEMENT_SOURCE_ORDER: readonly StoreMovementSource[] = [
  STORE_MOVEMENT_SOURCE.SCAN,
  STORE_MOVEMENT_SOURCE.MANUAL,
  STORE_MOVEMENT_SOURCE.DANA,
  STORE_MOVEMENT_SOURCE.CUT_SIZE,
  STORE_MOVEMENT_SOURCE.CARTON,
  STORE_MOVEMENT_SOURCE.GATE_RETURN,
  STORE_MOVEMENT_SOURCE.OPENING,
  STORE_MOVEMENT_SOURCE.CORRECTION,
  STORE_MOVEMENT_SOURCE.OTHER,
];

/**
 * How each writer of `inventory_stock_events` begins its note. The writers use these constants, so
 * the note a movement is written with and the way it is read back here cannot drift apart.
 */
export const STOCK_EVENT_NOTE = {
  SCAN_IN: "Raw Material Input",
  SCAN_OUT: "Raw Material Output",
  MANUAL_IN: "Manual move in",
  MANUAL_OUT: "Manual move out",
  OPENING: "Initial stock",
  CUT_SIZE: "Cut size returned",
} as const;

/** Never more rows than this go to a screen; the summary always counts the whole day. */
export const STORE_DAY_ENTRY_LIMIT = 1000;

const IN_EVENT_TYPES: ReadonlySet<string> = new Set(["RECEIVE", "TRANSFER_IN", "RETURN"]);
const OUT_EVENT_TYPES: ReadonlySet<string> = new Set(["TRANSFER_OUT", "CONSUME"]);
const CORRECTION_EVENT_TYPE = "ADJUST";

/**
 * Which way a stock event moved stock, or null when it moved none.
 *
 * Read from the event TYPE, never from the sign alone: a scanned packet's TRANSFER_OUT is written
 * with a positive quantity while a typed one is written negative. Only a correction carries its
 * direction in its sign, because ADJUST is both.
 */
export const stockEventDirection = (eventType: string, quantity: number): StoreDirection | null => {
  if (IN_EVENT_TYPES.has(eventType)) return STORE_DIRECTION.IN;
  if (OUT_EVENT_TYPES.has(eventType)) return STORE_DIRECTION.OUT;
  if (eventType !== CORRECTION_EVENT_TYPE || !Number.isFinite(quantity) || quantity === 0) return null;
  return quantity > 0 ? STORE_DIRECTION.IN : STORE_DIRECTION.OUT;
};

const startsWithNote = (note: string | null, prefix: string): boolean => (note ?? "").trim().startsWith(prefix);

/**
 * True for the stock event a packet SCAN writes beside its QR event. The report reads scans from
 * the QR event log, which also knows the supplier and the section, so these are left out of the
 * stock events to keep every scan counted exactly once.
 */
export const isScanStockEvent = (note: string | null): boolean =>
  startsWithNote(note, STOCK_EVENT_NOTE.SCAN_IN) || startsWithNote(note, STOCK_EVENT_NOTE.SCAN_OUT);

/** What kind of movement a (non-scan) stock event was. */
export const stockEventSource = (event: { eventType: string; note: string | null; machineProgramId: string | null }): StoreMovementSource => {
  if (event.machineProgramId) return STORE_MOVEMENT_SOURCE.DANA;
  if (event.eventType === CORRECTION_EVENT_TYPE) return STORE_MOVEMENT_SOURCE.CORRECTION;
  if (startsWithNote(event.note, STOCK_EVENT_NOTE.MANUAL_IN) || startsWithNote(event.note, STOCK_EVENT_NOTE.MANUAL_OUT)) {
    return STORE_MOVEMENT_SOURCE.MANUAL;
  }
  if (startsWithNote(event.note, STOCK_EVENT_NOTE.OPENING)) return STORE_MOVEMENT_SOURCE.OPENING;
  if (startsWithNote(event.note, STOCK_EVENT_NOTE.CUT_SIZE)) return STORE_MOVEMENT_SOURCE.CUT_SIZE;
  return STORE_MOVEMENT_SOURCE.OTHER;
};

/** One raw material movement of the day. */
export interface StoreDayMaterialEntry {
  kind: "MATERIAL";
  id: string;
  source: StoreMovementSource;
  /** When it happened: a UTC instant, or a zone-less business-local time for a scan. */
  at: string;
  itemId: string;
  itemDisplayName: string;
  /** Always positive — the direction is the report's. */
  quantity: number;
  unitCode: string;
  qrId: string | null;
  /** Who supplied it: the label's supplier for a scan, the named supplier for a typed receipt. */
  partyName: string | null;
  /** The work section a scanned packet went out to. */
  sectionName: string | null;
  programCode: string | null;
  note: string | null;
  actor: string | null;
}

/** One finished carton received into, or moved out of, the store. */
export interface StoreDayCartonEntry {
  kind: "CARTON";
  id: string;
  source: StoreMovementSource;
  at: string;
  qrId: string;
  article: string;
  color: string;
  size: string;
  programCode: string | null;
  actor: string | null;
}

export type StoreDayEntry = StoreDayMaterialEntry | StoreDayCartonEntry;

export interface StoreDaySourceTotal {
  source: StoreMovementSource;
  /** Movements of this kind: packets for a scan, entries for a typed move, cartons for a carton. */
  count: number;
}

export interface StoreDayMaterialTotal {
  itemId: string;
  itemDisplayName: string;
  unitCode: string;
  quantity: number;
  /** Labelled packets scanned. */
  packets: number;
  /** Typed movements: by hand, Dana, opening stock and corrections. */
  typed: number;
}

export interface StoreDayCartonTotal {
  article: string;
  color: string;
  size: string;
  cartons: number;
}

export interface StoreDaySummary {
  movements: number;
  packets: number;
  cartons: number;
  bySource: StoreDaySourceTotal[];
  byMaterial: StoreDayMaterialTotal[];
  byProduct: StoreDayCartonTotal[];
}

export interface StoreDailyReport {
  /** The business day, `YYYY-MM-DD`. */
  date: string;
  direction: StoreDirection;
  summary: StoreDaySummary;
  /** Newest first, at most STORE_DAY_ENTRY_LIMIT. */
  entries: StoreDayEntry[];
  /** Every movement of the day, including any not in `entries`. */
  entryCount: number;
}

/** Stock is kept to three decimals; a day's sum is too, so 0.1 + 0.2 reads 0.3. */
const roundStock = (value: number): number => Number(value.toFixed(3));

const sourceTotals = (entries: readonly StoreDayEntry[]): StoreDaySourceTotal[] => {
  const counts = new Map<StoreMovementSource, number>();
  for (const entry of entries) counts.set(entry.source, (counts.get(entry.source) ?? 0) + 1);
  return STORE_MOVEMENT_SOURCE_ORDER.filter((source) => counts.has(source)).map((source) => ({ source, count: counts.get(source) ?? 0 }));
};

const materialTotals = (entries: readonly StoreDayMaterialEntry[]): StoreDayMaterialTotal[] => {
  // Keyed by unit as well: a packet is recorded in its packing unit, which can differ from the
  // unit the balance is kept in, and adding KG to BAG would be a wrong number.
  const totals = new Map<string, StoreDayMaterialTotal>();
  for (const entry of entries) {
    const key = `${entry.itemId}|${entry.unitCode}`;
    const total = totals.get(key) ?? { itemId: entry.itemId, itemDisplayName: entry.itemDisplayName, unitCode: entry.unitCode, quantity: 0, packets: 0, typed: 0 };
    total.quantity = roundStock(total.quantity + entry.quantity);
    if (entry.source === STORE_MOVEMENT_SOURCE.SCAN) total.packets += 1;
    else total.typed += 1;
    totals.set(key, total);
  }
  return [...totals.values()].sort((a, b) => a.itemDisplayName.localeCompare(b.itemDisplayName) || a.unitCode.localeCompare(b.unitCode));
};

const cartonTotals = (entries: readonly StoreDayCartonEntry[]): StoreDayCartonTotal[] => {
  const totals = new Map<string, StoreDayCartonTotal>();
  for (const entry of entries) {
    const key = `${entry.article}|${entry.color}|${entry.size}`;
    const total = totals.get(key) ?? { article: entry.article, color: entry.color, size: entry.size, cartons: 0 };
    total.cartons += 1;
    totals.set(key, total);
  }
  return [...totals.values()].sort(
    (a, b) => a.article.localeCompare(b.article) || a.size.localeCompare(b.size) || a.color.localeCompare(b.color)
  );
};

/** The day's totals, counted over every movement — never over a capped list. */
export const summariseStoreDay = (materials: readonly StoreDayMaterialEntry[], cartons: readonly StoreDayCartonEntry[]): StoreDaySummary => ({
  movements: materials.length + cartons.length,
  packets: materials.filter((entry) => entry.source === STORE_MOVEMENT_SOURCE.SCAN).length,
  cartons: cartons.length,
  bySource: sourceTotals([...materials, ...cartons]),
  byMaterial: materialTotals(materials),
  byProduct: cartonTotals(cartons),
});

/** Milliseconds since the epoch; a zone-less local time is read as local, as it was written. */
const timeOf = (entry: StoreDayEntry): number => {
  const time = Date.parse(entry.at);
  return Number.isNaN(time) ? 0 : time;
};

/** The whole report for one day and direction: its totals and its movements, newest first. */
export const buildStoreDailyReport = (input: {
  date: string;
  direction: StoreDirection;
  materials: readonly StoreDayMaterialEntry[];
  cartons: readonly StoreDayCartonEntry[];
  limit?: number;
}): StoreDailyReport => {
  const all: StoreDayEntry[] = [...input.materials, ...input.cartons].sort((a, b) => timeOf(b) - timeOf(a) || b.id.localeCompare(a.id));
  return {
    date: input.date,
    direction: input.direction,
    summary: summariseStoreDay(input.materials, input.cartons),
    entries: all.slice(0, input.limit ?? STORE_DAY_ENTRY_LIMIT),
    entryCount: all.length,
  };
};
