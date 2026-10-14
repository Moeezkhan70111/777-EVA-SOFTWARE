// Upper Move Out — the machine an upper is issued to, the issues per machine and day, and the
// upper stock in the store (Phase 3).
//
// Nothing here moves stock: an upper leaves the store through issueRawMaterialPacket (application),
// the one place any raw material packet does. These are the reads around it:
//
//   getMachineForIssue     the machine as the database holds it, read inside the issue's lock
//   listUpperIssues        STORE_EXIT events stamped with that machine (migration 079), a page at a time
//   getUpperIssueSummary   this session / this day / in the store — three measures, kept apart
//   listUpperStock         every UPPER material's stock balance and packets in the store
//
// "Upper" is a material whose top-level category is UPPER (RAW_MATERIAL_KIND, KIND_SQL) — the same
// rule the store already uses. Quantities stay in each material's own stock unit and are added up
// per unit, never across units. A business day is Asia/Karachi (businessDayStartIso).
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { TransactionContext } from "@erp/application";
import type { MutableTransactionContext } from "./shared.js";
import { EFFECTIVE_PACK_NAME_SQL } from "./shared.js";
import { ARTICLE_SQL, COLOUR_SQL, KIND_JOINS, KIND_SQL, SIZE_SQL, TYPE_SQL } from "./machineProgramSql.js";
import type { UpperIssuePage, UpperIssueRow, UpperIssueSummary, UpperIssueTotals, UpperQuantity, UpperStockRow } from "./types.js";
import { RAW_MATERIAL_KIND, RAW_MATERIAL_QR_STATUS, businessDayStartIso, roundQuantity } from "@erp/domain";

type Row = Record<string, unknown>;

const text = (value: unknown): string => (value == null ? "" : String(value));
const textOrNull = (value: unknown): string | null => (value == null || value === "" ? null : String(value));
const MAX_PAGE_SIZE = 100;

/** An issue to a machine: a STORE_EXIT event that names one. */
const ISSUE_WHERE = "e.event_type = 'STORE_EXIT' AND e.machine_id = ?";
/** The business day window on event_ts_local, narrowed through the stored UTC event_date. */
const DAY_WHERE = "e.event_date BETWEEN ? AND ? AND e.event_ts_local >= ? AND e.event_ts_local < ?";

const dayWindow = (date: string): string[] | null => {
  const fromIso = businessDayStartIso(date);
  const toIso = businessDayStartIso(date, 1);
  return fromIso && toIso ? [fromIso.slice(0, 10), toIso.slice(0, 10), fromIso, toIso] : null;
};

/** One issue row, everything the screen shows of it. Expects WHERE / ORDER after it. */
const ISSUE_SELECT = `SELECT e.id, e.qr_id, e.item_display_name, e.quantity, e.event_ts_local, e.actor, e.machine_id,
                u.code AS unit_code, m.name AS machine_name, q.current_status,
                ${ARTICLE_SQL} AS article, ${SIZE_SQL} AS size, ${COLOUR_SQL} AS colour, ${EFFECTIVE_PACK_NAME_SQL} AS pack_name
         FROM raw_material_qr_events e
         JOIN machines m ON m.id = e.machine_id
         JOIN inventory_items ii ON ii.id = e.item_id
         LEFT JOIN raw_material_qrs q ON q.id = e.qr_id
         LEFT JOIN inventory_units u ON u.id = e.unit_id`;

const toIssueRow = (row: Row): UpperIssueRow => ({
  eventId: text(row.id),
  qrId: text(row.qr_id),
  itemDisplayName: text(row.item_display_name),
  article: textOrNull(row.article),
  size: textOrNull(row.size),
  colour: textOrNull(row.colour),
  quantity: roundQuantity(Number(row.quantity ?? 0)),
  unitCode: text(row.unit_code),
  packName: textOrNull(row.pack_name),
  machineId: text(row.machine_id),
  machineName: text(row.machine_name),
  issuedAt: text(row.event_ts_local),
  issuedBy: textOrNull(row.actor),
  status: text(row.current_status) || RAW_MATERIAL_QR_STATUS.ISSUED,
});

const toQuantities = (rows: Row[]): UpperQuantity[] =>
  rows.map((row) => ({ unitCode: text(row.unit_code), quantity: roundQuantity(Number(row.quantity ?? 0)) }));

export const upperMoveOutMethods = {
  getMachineForIssue(this: SqliteDatabase, machineId: string, tx: TransactionContext): { id: string; name: string; status: string } | null {
    const row = (tx as MutableTransactionContext).db
      .prepare("SELECT id, name, status FROM machines WHERE id = ? LIMIT 1")
      .get(text(machineId).trim()) as Row | undefined;
    return row ? { id: text(row.id), name: text(row.name), status: text(row.status) } : null;
  },

  /** @internal Packets and quantity per unit of the issues matching `where`. */
  upperIssueTotals(this: SqliteDatabase, where: string, args: string[]): UpperIssueTotals {
    const packets = this.db.prepare(`SELECT COUNT(*) AS n FROM raw_material_qr_events e WHERE ${where}`).get(...args) as { n: number };
    const quantities = this.db
      .prepare(
        `SELECT u.code AS unit_code, SUM(e.quantity) AS quantity
         FROM raw_material_qr_events e LEFT JOIN inventory_units u ON u.id = e.unit_id
         WHERE ${where} GROUP BY u.code ORDER BY u.code`
      )
      .all(...args) as Row[];
    return { packets: Number(packets.n ?? 0), quantities: toQuantities(quantities) };
  },

  /** One business day's issues to one machine, newest first. Null for a bad date. */
  listUpperIssues(this: SqliteDatabase, input: { machineId: string; date: string; page?: number; pageSize?: number }): UpperIssuePage | null {
    const window = dayWindow(input.date);
    if (!window) return null;
    const machineId = text(input.machineId).trim();
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(input.pageSize) || 25)));
    const page = Math.max(1, Math.trunc(Number(input.page) || 1));
    const where = `${ISSUE_WHERE} AND ${DAY_WHERE}`;
    const args = [machineId, ...window];

    const rows = this.db
      .prepare(`${ISSUE_SELECT} WHERE ${where} ORDER BY e.event_ts_local DESC, e.rowid DESC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, (page - 1) * pageSize) as Row[];

    return {
      machineId,
      date: input.date,
      rows: rows.map(toIssueRow),
      page,
      pageSize,
      totals: this.upperIssueTotals(where, args),
    };
  },

  /**
   * The latest issue of one packet to a machine, or null when it has never been issued to one — how
   * the screen settles a scan whose answer never arrived, from the database rather than a guess.
   */
  findUpperIssue(this: SqliteDatabase, qrId: string): UpperIssueRow | null {
    const row = this.db
      .prepare(`${ISSUE_SELECT} WHERE e.event_type = 'STORE_EXIT' AND e.machine_id IS NOT NULL AND e.qr_id = ? ORDER BY e.event_ts_local DESC LIMIT 1`)
      .get(text(qrId).trim().toUpperCase()) as Row | undefined;
    return row ? toIssueRow(row) : null;
  },

  /**
   * The device's issue session an issue would go into now — the one startOrResumeRawMaterialIssueSession
   * would resume (open, and started today) — or null. Reading never opens a session.
   */
  currentUpperIssueSessionId(this: SqliteDatabase, deviceId: string): string | null {
    const todayStart = this.localDayStartIso(this.localYmd(new Date()));
    const row = this.db
      .prepare("SELECT id, started_at FROM raw_material_issue_sessions WHERE device_id = ? AND status = 'OPEN' ORDER BY started_at DESC LIMIT 1")
      .get(text(deviceId).trim()) as Row | undefined;
    return row && todayStart && text(row.started_at) >= todayStart ? text(row.id) : null;
  },

  /** This session, this day and the store — for one machine. Null for an unknown machine or bad date. */
  getUpperIssueSummary(this: SqliteDatabase, input: { machineId: string; sessionId: string | null; date: string }): UpperIssueSummary | null {
    const machine = this.db.prepare("SELECT id, name FROM machines WHERE id = ? LIMIT 1").get(text(input.machineId).trim()) as Row | undefined;
    const window = dayWindow(input.date);
    if (!machine || !window) return null;
    const machineId = text(machine.id);
    const session = input.sessionId ? this.getRawMaterialIssueSession(input.sessionId) : null;

    return {
      machineId,
      machineName: text(machine.name),
      session: {
        sessionNumber: session ? session.sessionNumber : null,
        ...(session ? this.upperIssueTotals(`${ISSUE_WHERE} AND e.session_id = ?`, [machineId, session.id]) : { packets: 0, quantities: [] }),
      },
      day: { date: input.date, ...this.upperIssueTotals(`${ISSUE_WHERE} AND ${DAY_WHERE}`, [machineId, ...window]) },
      stock: this.upperStockTotals(),
    };
  },

  /** @internal Upper stock in the store now: packets in store, and the balances per unit. */
  upperStockTotals(this: SqliteDatabase): UpperIssueTotals {
    const packets = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM raw_material_qrs q JOIN inventory_items ii ON ii.id = q.item_id ${KIND_JOINS}
         WHERE q.current_status = ? AND q.status <> 'VOID' AND ${KIND_SQL} = ?`
      )
      .get(RAW_MATERIAL_QR_STATUS.IN_STORE, RAW_MATERIAL_KIND.UPPER) as { n: number };
    const quantities = this.db
      .prepare(
        `SELECT u.code AS unit_code, SUM(isb.quantity_on_hand) AS quantity
         FROM inventory_stock_balances isb
         JOIN inventory_items ii ON ii.id = isb.item_id
         ${KIND_JOINS}
         LEFT JOIN inventory_units u ON u.id = isb.unit_id
         WHERE ${KIND_SQL} = ? AND isb.quantity_on_hand > 0
         GROUP BY u.code ORDER BY u.code`
      )
      .all(RAW_MATERIAL_KIND.UPPER) as Row[];
    return { packets: Number(packets.n ?? 0), quantities: toQuantities(quantities) };
  },

  /**
   * Every upper material with stock in the store, by article, size and colour. `search` matches the
   * material's name and its article, size, colour and type, every word in any order.
   */
  listUpperStock(this: SqliteDatabase, input: { search?: string } = {}): UpperStockRow[] {
    const words = text(input.search).trim().toUpperCase().split(/\s+/).filter(Boolean);
    const haystack = `UPPER(COALESCE(ii.display_name, '') || ' ' || COALESCE(${ARTICLE_SQL}, '') || ' ' || COALESCE(${SIZE_SQL}, '') || ' ' || COALESCE(${COLOUR_SQL}, '') || ' ' || COALESCE(${TYPE_SQL}, ''))`;
    const searchSql = words.map(() => `AND ${haystack} LIKE ?`).join(" ");

    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT ii.id, ii.item_code, ii.display_name, kind_cat.name AS category_name,
                  ${ARTICLE_SQL} AS article, ${SIZE_SQL} AS size, ${COLOUR_SQL} AS colour, ${TYPE_SQL} AS type,
                  COALESCE(isb.quantity_on_hand, 0) AS on_hand, su.code AS unit_code, ${EFFECTIVE_PACK_NAME_SQL} AS pack_name,
                  (SELECT COUNT(*) FROM raw_material_qrs q WHERE q.item_id = ii.id AND q.current_status = ? AND q.status <> 'VOID') AS packets
           FROM inventory_items ii
           ${KIND_JOINS}
           LEFT JOIN inventory_stock_balances isb ON isb.item_id = ii.id
           LEFT JOIN inventory_units su ON su.id = COALESCE(isb.unit_id, ii.default_unit_id)
           WHERE ${KIND_SQL} = ? ${searchSql}
         ) WHERE on_hand > 0 OR packets > 0
         ORDER BY UPPER(COALESCE(article, display_name)), UPPER(COALESCE(size, '')), UPPER(COALESCE(colour, ''))`
      )
      .all(RAW_MATERIAL_QR_STATUS.IN_STORE, RAW_MATERIAL_KIND.UPPER, ...words.map((word) => `%${word}%`)) as Row[];

    return rows.map((row) => ({
      itemId: text(row.id),
      itemCode: text(row.item_code),
      displayName: text(row.display_name),
      categoryName: text(row.category_name),
      article: textOrNull(row.article),
      size: textOrNull(row.size),
      colour: textOrNull(row.colour),
      type: textOrNull(row.type),
      onHand: roundQuantity(Number(row.on_hand ?? 0)),
      unitCode: text(row.unit_code),
      packetsInStore: Number(row.packets ?? 0),
      packName: textOrNull(row.pack_name),
    }));
  },
};

export type UpperMoveOutMethods = typeof upperMoveOutMethods;
