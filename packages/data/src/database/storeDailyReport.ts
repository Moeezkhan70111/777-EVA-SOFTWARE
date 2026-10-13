// The store's daily report: everything that came IN to the store on one day, or went OUT of it.
//
// Read-only. Three ledgers already record every movement, and this reads all three for the day:
//
//   raw_material_qr_events   a labelled packet scanned in or out (with supplier, section, program)
//   inventory_stock_events   a quantity typed in or out by hand, Dana for a program, opening stock
//                            and approved corrections — the scans' own stock rows are left out,
//                            because the QR event above already counts each scan once
//   production_events        a finished carton scanned into the store, or out of it to the gate
//
// The day is the BUSINESS day: every one of these is stamped with a UTC instant, so the day's
// window is converted through localDayStartIso rather than read off the stored UTC date, which
// would put a 2 AM scan on the day before. What each row was and the day's totals are decided by
// @erp/domain (storeDailyReport.ts), never here.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import { formatMachineProgramCode } from "@erp/application";
import {
  STORE_DIRECTION,
  STORE_MOVEMENT_SOURCE,
  buildStoreDailyReport,
  isScanStockEvent,
  stockEventDirection,
  stockEventSource,
  type StoreDailyReport,
  type StoreDayCartonEntry,
  type StoreDayMaterialEntry,
  type StoreDirection,
} from "@erp/domain";
import type { SqliteDatabase } from "../sqliteDatabase.js";

type Row = Record<string, unknown>;

const text = (value: unknown): string => (value == null ? "" : String(value));
const textOrNull = (value: unknown): string | null => (value == null || value === "" ? null : String(value));
const programCode = (programNumber: unknown): string | null =>
  programNumber == null ? null : formatMachineProgramCode(Number(programNumber));

/** The UTC window of one business day, and the stored UTC dates it can fall on. */
interface DayWindow {
  fromIso: string;
  toIso: string;
  fromDate: string;
  toDate: string;
}

const PACKET_EVENT: Record<StoreDirection, string> = { IN: "STORE_ENTRY", OUT: "STORE_EXIT" };
const CARTON_EVENT: Record<StoreDirection, string> = { IN: "STORE_ENTRY", OUT: "STORE_EXIT" };

const CARTON_PROGRAM_SQL = `(
  SELECT mp.program_number FROM qr_codes qc
  JOIN machine_programs mp ON mp.id = (
    SELECT l.program_id FROM machine_program_carton_labels l WHERE l.qr_batch_id = qc.batch_id
    UNION ALL
    SELECT f.program_id FROM machine_program_fix_carton_labels f WHERE f.qr_batch_id = qc.batch_id
    LIMIT 1
  )
  WHERE qc.id = pe.qr_id LIMIT 1)`;

export const storeDailyReportMethods = {
  /**
   * One business day of the store, one direction: every packet scanned, every quantity typed,
   * every carton — with the day's totals. Null when the date is not a `YYYY-MM-DD`.
   */
  getStoreDailyReport(this: SqliteDatabase, date: string, direction: StoreDirection): StoreDailyReport | null {
    const fromIso = this.localDayStartIso(date);
    const toIso = this.localDayStartIso(date, 1);
    if (!fromIso || !toIso) return null;
    const way = direction === STORE_DIRECTION.OUT ? STORE_DIRECTION.OUT : STORE_DIRECTION.IN;
    // The stored event_date is the UTC date, so a business day spans up to two of them.
    const window: DayWindow = { fromIso, toIso, fromDate: fromIso.slice(0, 10), toDate: toIso.slice(0, 10) };

    return buildStoreDailyReport({
      date,
      direction: way,
      materials: [...this.storeDayPacketScans(window, way), ...this.storeDayTypedMoves(window, way)],
      cartons: this.storeDayCartons(window, way),
    });
  },

  /** @internal Labelled raw material packets scanned in or out during the day. */
  storeDayPacketScans(this: SqliteDatabase, window: DayWindow, direction: StoreDirection): StoreDayMaterialEntry[] {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.qr_id, e.item_id, e.item_display_name, e.quantity, u.code AS unit_code,
                e.event_ts_local, e.actor, p.party_name, ws.name AS section_name, mp.program_number
         FROM raw_material_qr_events e
         LEFT JOIN inventory_units u ON u.id = e.unit_id
         LEFT JOIN parties p ON p.id = e.party_id
         LEFT JOIN work_sections ws ON ws.id = e.section_id
         LEFT JOIN machine_program_upper_lines mul ON mul.id = e.machine_program_upper_line_id
         LEFT JOIN machine_program_runs mpr ON mpr.id = mul.run_id
         LEFT JOIN machine_programs mp ON mp.id = mpr.program_id
         WHERE e.event_type = ? AND e.event_date BETWEEN ? AND ?
           AND e.event_ts_local >= ? AND e.event_ts_local < ?`
      )
      .all(PACKET_EVENT[direction], window.fromDate, window.toDate, window.fromIso, window.toIso) as Row[];

    return rows.map((row) => ({
      kind: "MATERIAL",
      id: text(row.id),
      source: STORE_MOVEMENT_SOURCE.SCAN,
      at: text(row.event_ts_local),
      itemId: text(row.item_id),
      itemDisplayName: text(row.item_display_name),
      quantity: Math.abs(Number(row.quantity ?? 0)),
      unitCode: text(row.unit_code),
      qrId: textOrNull(row.qr_id),
      partyName: textOrNull(row.party_name),
      sectionName: textOrNull(row.section_name),
      programCode: programCode(row.program_number),
      note: null,
      actor: textOrNull(row.actor),
    }));
  },

  /** @internal Quantities typed in or out during the day — everything on the ledger but a scan. */
  storeDayTypedMoves(this: SqliteDatabase, window: DayWindow, direction: StoreDirection): StoreDayMaterialEntry[] {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.item_id, ii.display_name, e.event_type, e.quantity, u.code AS unit_code,
                e.note, e.created_by, e.created_at, e.machine_program_id, p.party_name, mp.program_number
         FROM inventory_stock_events e
         JOIN inventory_items ii ON ii.id = e.item_id
         LEFT JOIN inventory_units u ON u.id = e.unit_id
         LEFT JOIN parties p ON p.id = e.party_id
         LEFT JOIN machine_programs mp ON mp.id = e.machine_program_id
         WHERE e.created_at >= ? AND e.created_at < ?`
      )
      .all(window.fromIso, window.toIso) as Row[];

    return rows
      .filter((row) => !isScanStockEvent(textOrNull(row.note)))
      .filter((row) => stockEventDirection(text(row.event_type), Number(row.quantity ?? 0)) === direction)
      .map((row) => ({
        kind: "MATERIAL",
        id: text(row.id),
        source: stockEventSource({ eventType: text(row.event_type), note: textOrNull(row.note), machineProgramId: textOrNull(row.machine_program_id) }),
        at: text(row.created_at),
        itemId: text(row.item_id),
        itemDisplayName: text(row.display_name),
        // Typed moves out are stored negative; the report's direction already says which way.
        quantity: Math.abs(Number(row.quantity ?? 0)),
        unitCode: text(row.unit_code),
        qrId: null,
        partyName: textOrNull(row.party_name),
        sectionName: null,
        programCode: programCode(row.program_number),
        note: textOrNull(row.note),
        actor: textOrNull(row.created_by),
      }));
  },

  /** @internal Finished cartons scanned into the store, or out of it to the gate, during the day. */
  storeDayCartons(this: SqliteDatabase, window: DayWindow, direction: StoreDirection): StoreDayCartonEntry[] {
    const rows = this.db
      .prepare(
        `SELECT pe.id, pe.qr_id, pe.article_snapshot, pe.color_snapshot, pe.size_snapshot, pe.event_ts_local,
                pe.gatepass_id, json_extract(pe.metadata_json, '$.actor') AS actor,
                ${CARTON_PROGRAM_SQL} AS program_number
         FROM production_events pe
         WHERE pe.event_type = 'MOVED' AND pe.event_date BETWEEN ? AND ?
           AND pe.event_ts_local >= ? AND pe.event_ts_local < ?
           AND json_extract(pe.metadata_json, '$.eventType') = ?`
      )
      .all(window.fromDate, window.toDate, window.fromIso, window.toIso, CARTON_EVENT[direction]) as Row[];

    return rows.map((row) => ({
      kind: "CARTON",
      id: text(row.id),
      // A carton entering with a Gatepass on it is the bring-back of one that went to the gate.
      source: direction === STORE_DIRECTION.IN && row.gatepass_id ? STORE_MOVEMENT_SOURCE.GATE_RETURN : STORE_MOVEMENT_SOURCE.CARTON,
      at: text(row.event_ts_local),
      qrId: text(row.qr_id),
      article: text(row.article_snapshot),
      color: text(row.color_snapshot),
      size: text(row.size_snapshot),
      programCode: programCode(row.program_number),
      actor: textOrNull(row.actor),
    }));
  },
};

export type StoreDailyReportMethods = typeof storeDailyReportMethods;
