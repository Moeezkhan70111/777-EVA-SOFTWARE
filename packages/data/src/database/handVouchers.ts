// STORE HAND VOUCHERS (docs/49, local migration 110): raw material moved in or out of the store without labels, as one
// numbered voucher.
//
//   WRITE  saveHandVoucher     SIV-100012 IN from SHEHZAD RUBBER · SOV-100007 OUT to ASLAM for cutting: all or none
//   WRITE  editHandVoucher     today only: every old line reversed, the new lines moved, all or none
//   WRITE  deleteHandVoucher   today only: every line reversed, the voucher kept and marked DELETED
//   READ   handVoucherView     one voucher of a direction by number (or the newest), with the numbers either side
//
// EVERY LINE IS A HAND MOVE, checked and written by rawMaterialHandMove.ts (checkHandMove, applyCheckedHandMove): the
// material's own unit ladder, its retired state, the supplier rule moving in, and moving out the labelled-packet rule
// and what is in the store. Nothing about a hand move is decided twice. Moving out, the voucher's party is stamped on
// each movement, so the day's report says who it went to.
//
// NOTHING IS REWRITTEN. A reversal is a new movement naming the voucher: a Move In line is taken back by a RECEIVE
// written NEGATIVE, a Move Out line put back by a TRANSFER_IN noted as a manual move out. Each counts against its own
// side of the day (stockEventReportQuantity). A change may not take back material that has already gone out: when a
// material's balance falls, what is left must still cover its labelled packets in the store, or nothing changes.
//
// TODAY ONLY (owner, 15 Nov 2026): a voucher may be edited or deleted on the business day it was written. Every write
// carries the revision the screen was showing, so a change made since is never overwritten blind. A save retried
// after a lost answer finds the voucher it already made; an edit that changes nothing writes nothing.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import crypto from "node:crypto";
import {
  STOCK_EVENT_NOTE,
  STORE_DIRECTION,
  STORE_HAND_VOUCHER_MAX_LINES,
  STORE_HAND_VOUCHER_NOTE_MAX,
  STORE_HAND_VOUCHER_STATUS,
  businessDateOf,
  formatHandVoucherCode,
  handVoucherEditable,
  handVoucherNeedsNote,
  isRawMaterialIssuePartyType,
  isStoreDirection,
  type HandVoucherStatus,
  type StoreDirection,
} from "@erp/domain";
import type { SqliteDatabase } from "../sqliteDatabase.js";
import { allocateNumberInRange } from "./numberRange.js";
import type { CheckedHandMove } from "./rawMaterialHandMove.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Record<string, unknown>;
const text = (value: unknown): string => (value == null ? "" : String(value));
const textOrNull = (value: unknown): string | null => (value == null || String(value) === "" ? null : String(value));
const round = (value: number): number => Number(value.toFixed(3));

/** One line as the screen sends it. */
export interface HandVoucherLineInput {
  readonly itemId: string;
  readonly quantity: unknown;
  readonly unitCode: string;
}

/** The voucher's own words, the same for a new voucher and an edited one. */
export interface HandVoucherBody {
  /** Supplier moving in; supplier or contractor moving out. */
  readonly partyId: string;
  /** Moving in, a reference (optional). Moving out, what it is for (required). */
  readonly note?: string | null;
  readonly lines: readonly HandVoucherLineInput[];
  /** Who is writing it; from the session, never the screen. */
  readonly actor: string;
}

export interface HandVoucherSaveInput extends HandVoucherBody {
  readonly direction: string;
  /** The screen's id for this voucher: a Save retried after a lost answer finds it. */
  readonly requestId: string;
}

export interface HandVoucherEditInput extends HandVoucherBody {
  readonly voucherId: string;
  /** The revision the screen was showing. */
  readonly revision: number;
}

export interface HandVoucherDeleteInput {
  readonly voucherId: string;
  readonly revision: number;
  readonly actor: string;
}

export interface HandVoucherLine {
  readonly lineNo: number;
  readonly itemId: string;
  readonly itemName: string;
  readonly typedQuantity: number;
  readonly typedUnitCode: string;
  readonly quantity: number;
  readonly stockUnitCode: string;
}

export interface HandVoucher {
  readonly id: string;
  readonly direction: StoreDirection;
  readonly voucherNumber: number;
  readonly code: string;
  readonly businessDate: string;
  readonly partyId: string;
  readonly partyName: string;
  readonly note: string | null;
  readonly status: HandVoucherStatus;
  readonly revision: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedBy: string | null;
  readonly updatedAt: string;
  readonly deletedBy: string | null;
  readonly deletedAt: string | null;
  /** Whether it may still be edited or deleted: posted, and written today. */
  readonly editable: boolean;
  readonly lines: readonly HandVoucherLine[];
}

/** One voucher and where it sits in its direction's run, for Previous / Next. */
export interface HandVoucherView {
  /** Null when there is no voucher by that number, or none at all. */
  readonly voucher: HandVoucher | null;
  readonly previousNumber: number | null;
  readonly nextNumber: number | null;
  readonly latestNumber: number | null;
}

/** A refusal the screen shows as it is: nothing was written. */
export class HandVoucherRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandVoucherRefused";
  }
}

/** A line every rule accepted, ready to be written. */
interface CheckedLine {
  readonly move: CheckedHandMove;
  readonly itemName: string;
}

const todayDate = (): string => businessDateOf(new Date().toISOString());

const numberSite = (direction: StoreDirection) => (direction === STORE_DIRECTION.OUT ? "storeOutVoucher" : "storeInVoucher");

/** The voucher's note, trimmed; null when empty. Refused when too long to print, or missing moving out. */
function checkedNote(direction: StoreDirection, note: unknown): string | null {
  const value = text(note).trim();
  if (value.length > STORE_HAND_VOUCHER_NOTE_MAX) throw new HandVoucherRefused(`Keep the note under ${STORE_HAND_VOUCHER_NOTE_MAX} characters.`);
  if (!value && handVoucherNeedsNote(direction)) throw new HandVoucherRefused("Say what this is going out for — e.g. cutting table.");
  return value || null;
}

function checkedBody(direction: StoreDirection, body: HandVoucherBody): void {
  if (!text(body.actor).trim()) throw new HandVoucherRefused("This voucher must name who wrote it. Sign in again.");
  if (!text(body.partyId).trim()) {
    throw new HandVoucherRefused(direction === STORE_DIRECTION.OUT ? "Choose who this is going out to." : "Choose the supplier this delivery came from.");
  }
  if (!Array.isArray(body.lines) || body.lines.length === 0) throw new HandVoucherRefused("Add at least one material.");
  if (body.lines.length > STORE_HAND_VOUCHER_MAX_LINES) throw new HandVoucherRefused(`One voucher may hold at most ${STORE_HAND_VOUCHER_MAX_LINES} lines.`);
}

const lineRow = (row: Row): HandVoucherLine => ({
  lineNo: Number(row.line_no),
  itemId: text(row.item_id),
  itemName: text(row.item_name),
  typedQuantity: Number(row.typed_quantity),
  typedUnitCode: text(row.typed_unit_code),
  quantity: Number(row.quantity),
  stockUnitCode: text(row.stock_unit_code),
});

/** The request says what the voucher already says: same party, note and lines (as typed) in the same order. */
function sameBody(voucher: HandVoucher, partyId: string, note: string | null, lines: readonly HandVoucherLineInput[]): boolean {
  if (voucher.partyId !== partyId || voucher.note !== note || voucher.lines.length !== lines.length) return false;
  return lines.every((line, index) => {
    const held = voucher.lines[index];
    return (
      held !== undefined &&
      held.itemId === text(line.itemId) &&
      held.typedQuantity === round(Number(line.quantity)) &&
      held.typedUnitCode === text(line.unitCode).trim().toUpperCase()
    );
  });
}

/** How a line is taken back: the movement that undoes it, noted with the voucher. */
const reversalOf = (direction: StoreDirection, line: HandVoucherLine, code: string, why: string) =>
  direction === STORE_DIRECTION.OUT
    ? { eventType: "TRANSFER_IN" as const, quantity: line.quantity, note: `${STOCK_EVENT_NOTE.MANUAL_OUT} — reversed ${line.typedQuantity} ${line.typedUnitCode} · ${code} ${why}` }
    : { eventType: "RECEIVE" as const, quantity: -line.quantity, note: `${STOCK_EVENT_NOTE.MANUAL_IN} — reversed ${line.typedQuantity} ${line.typedUnitCode} · ${code} ${why}` };

export const handVoucherMethods = {
  /** Writes a new voucher and moves every line, in one transaction. */
  saveHandVoucher(this: SqliteDatabase, input: HandVoucherSaveInput): { voucher: HandVoucher; duplicate: boolean } {
    if (!UUID.test(text(input.requestId))) throw new HandVoucherRefused("This voucher could not be identified. Nothing was saved. Try again.");
    if (!isStoreDirection(input.direction)) throw new HandVoucherRefused("Say whether this voucher moves material in or out.");
    const direction = input.direction;
    checkedBody(direction, input);
    const note = checkedNote(direction, input.note);
    return this.inHandTransaction(() => {
      if (this.db.prepare("SELECT 1 AS here FROM store_hand_vouchers WHERE id = ?").get(input.requestId)) {
        return { voucher: this.requireHandVoucher(input.requestId), duplicate: true };
      }
      const voucherNumber = allocateNumberInRange(this, numberSite(direction));
      const code = formatHandVoucherCode(direction, voucherNumber);
      const lines = this.checkedHandLines(direction, input, code, note);
      const nowIso = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO store_hand_vouchers (id, direction, voucher_number, business_date, party_id, note, status, revision, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
        )
        .run(input.requestId, direction, voucherNumber, todayDate(), text(input.partyId).trim(), note, STORE_HAND_VOUCHER_STATUS.POSTED, input.actor, nowIso, nowIso);
      this.writeHandLines(input.requestId, lines, input.actor);
      return { voucher: this.requireHandVoucher(input.requestId), duplicate: false };
    });
  },

  /** Today's voucher, said again: every old line reversed and the new lines moved, or nothing. */
  editHandVoucher(this: SqliteDatabase, input: HandVoucherEditInput): { voucher: HandVoucher; changed: boolean } {
    return this.inHandTransaction(() => {
      const held = this.changeableHandVoucher(input.voucherId);
      checkedBody(held.direction, input);
      const note = checkedNote(held.direction, input.note);
      const partyId = text(input.partyId).trim();
      if (sameBody(held, partyId, note, input.lines)) return { voucher: held, changed: false };
      this.requireHandRevision(held, input.revision);
      const before = this.handBalances([...held.lines.map((line) => line.itemId), ...input.lines.map((line) => text(line.itemId))]);
      // Reversed FIRST, so a Move Out line raised from 5 to 7 is checked against the store with its 5 put back.
      this.reverseHandLines(held, input.actor, "edited");
      const lines = this.checkedHandLines(held.direction, input, held.code, note);
      this.db.prepare("DELETE FROM store_hand_voucher_lines WHERE voucher_id = ?").run(held.id);
      this.writeHandLines(held.id, lines, input.actor);
      this.requireHandStockStillCovered(before);
      this.db
        .prepare("UPDATE store_hand_vouchers SET party_id = ?, note = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE id = ?")
        .run(partyId, note, input.actor, new Date().toISOString(), held.id);
      return { voucher: this.requireHandVoucher(held.id), changed: true };
    });
  },

  /** Today's voucher, taken back: every line reversed, the voucher kept under its number and marked DELETED. */
  deleteHandVoucher(this: SqliteDatabase, input: HandVoucherDeleteInput): HandVoucher {
    if (!text(input.actor).trim()) throw new HandVoucherRefused("This voucher must name who deleted it. Sign in again.");
    return this.inHandTransaction(() => {
      const held = this.changeableHandVoucher(input.voucherId);
      this.requireHandRevision(held, input.revision);
      const before = this.handBalances(held.lines.map((line) => line.itemId));
      this.reverseHandLines(held, input.actor, "deleted");
      this.requireHandStockStillCovered(before);
      const nowIso = new Date().toISOString();
      this.db
        .prepare("UPDATE store_hand_vouchers SET status = ?, revision = revision + 1, deleted_by = ?, deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ?")
        .run(STORE_HAND_VOUCHER_STATUS.DELETED, input.actor, nowIso, input.actor, nowIso, held.id);
      return this.requireHandVoucher(held.id);
    });
  },

  /** One voucher of `direction` by number, or the newest when `voucherNumber` is null, with its neighbours. */
  handVoucherView(this: SqliteDatabase, direction: StoreDirection, voucherNumber: number | null): HandVoucherView {
    const scalar = (sql: string, ...args: Array<string | number>): number | null => {
      const value = (this.db.prepare(sql).get(direction, ...args) as Row).n;
      return value == null ? null : Number(value);
    };
    const latestNumber = scalar("SELECT MAX(voucher_number) AS n FROM store_hand_vouchers WHERE direction = ?");
    const wanted = voucherNumber ?? latestNumber;
    if (wanted === null) return { voucher: null, previousNumber: null, nextNumber: null, latestNumber: null };
    const row = this.db.prepare("SELECT id FROM store_hand_vouchers WHERE direction = ? AND voucher_number = ?").get(direction, wanted) as Row | undefined;
    return {
      voucher: row ? this.requireHandVoucher(text(row.id)) : null,
      previousNumber: scalar("SELECT MAX(voucher_number) AS n FROM store_hand_vouchers WHERE direction = ? AND voucher_number < ?", wanted),
      nextNumber: scalar("SELECT MIN(voucher_number) AS n FROM store_hand_vouchers WHERE direction = ? AND voucher_number > ?", wanted),
      latestNumber,
    };
  },

  /** @internal The voucher and its lines, as the screen reads it. */
  requireHandVoucher(this: SqliteDatabase, voucherId: string): HandVoucher {
    const row = this.db
      .prepare("SELECT v.*, p.party_name FROM store_hand_vouchers v LEFT JOIN parties p ON p.id = v.party_id WHERE v.id = ?")
      .get(voucherId) as Row | undefined;
    if (!row) throw new HandVoucherRefused("This voucher is not on this computer.");
    const lines = (this.db.prepare("SELECT * FROM store_hand_voucher_lines WHERE voucher_id = ? ORDER BY line_no").all(voucherId) as Row[]).map(lineRow);
    const status = text(row.status) === STORE_HAND_VOUCHER_STATUS.DELETED ? STORE_HAND_VOUCHER_STATUS.DELETED : STORE_HAND_VOUCHER_STATUS.POSTED;
    const direction = text(row.direction) === STORE_DIRECTION.OUT ? STORE_DIRECTION.OUT : STORE_DIRECTION.IN;
    return {
      id: text(row.id),
      direction,
      voucherNumber: Number(row.voucher_number),
      code: formatHandVoucherCode(direction, Number(row.voucher_number)),
      businessDate: text(row.business_date),
      partyId: text(row.party_id),
      partyName: text(row.party_name),
      note: textOrNull(row.note),
      status,
      revision: Number(row.revision),
      createdBy: text(row.created_by),
      createdAt: text(row.created_at),
      updatedBy: textOrNull(row.updated_by),
      updatedAt: text(row.updated_at),
      deletedBy: textOrNull(row.deleted_by),
      deletedAt: textOrNull(row.deleted_at),
      editable: handVoucherEditable(text(row.business_date), todayDate(), status),
      lines,
    };
  },

  /** @internal Runs `work` in one BEGIN IMMEDIATE transaction: all of it, or none. */
  inHandTransaction<T>(this: SqliteDatabase, work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  /** @internal A voucher that may still be changed: here, posted, and written today. */
  changeableHandVoucher(this: SqliteDatabase, voucherId: string): HandVoucher {
    const held = this.requireHandVoucher(text(voucherId));
    if (held.status === STORE_HAND_VOUCHER_STATUS.DELETED) throw new HandVoucherRefused(`${held.code} has been deleted. Nothing was changed.`);
    if (!held.editable) throw new HandVoucherRefused(`${held.code} was written on an earlier day. Only today's vouchers can be edited or deleted.`);
    return held;
  },

  /** @internal Refuses a change made from an out-of-date screen. */
  requireHandRevision(this: SqliteDatabase, held: HandVoucher, revision: number): void {
    if (Number(revision) !== held.revision) {
      throw new HandVoucherRefused(`${held.code} was changed by ${held.updatedBy ?? held.createdBy} since you opened it. Open it again, then make your change.`);
    }
  },

  /** @internal Moving out, the party must be a supplier or contractor here (moving in, checkHandMove asks for a supplier). */
  requireIssueParty(this: SqliteDatabase, partyId: string): void {
    const party = this.db.prepare("SELECT party_name, party_type FROM parties WHERE id = ? AND deleted_at IS NULL").get(partyId) as Row | undefined;
    if (!party) throw new HandVoucherRefused("That party is not in the Party Master.");
    if (!isRawMaterialIssuePartyType(text(party.party_type))) {
      throw new HandVoucherRefused(`Material goes out only to a supplier or contractor, and ${text(party.party_name)} is neither. Nothing was moved.`);
    }
  },

  /** @internal Every line checked as a hand move of the voucher's direction. Duplicates are refused. */
  checkedHandLines(this: SqliteDatabase, direction: StoreDirection, body: HandVoucherBody, code: string, note: string | null): CheckedLine[] {
    const partyId = text(body.partyId).trim();
    if (direction === STORE_DIRECTION.OUT) this.requireIssueParty(partyId);
    const seen = new Set<string>();
    return body.lines.map((line, index) => {
      const checked = this.checkHandMove({
        itemId: text(line.itemId),
        direction,
        quantity: Number(text(line.quantity).trim() === "" ? Number.NaN : line.quantity),
        unitCode: text(line.unitCode),
        partyId,
        note: [code, note].filter(Boolean).join(" · "),
      });
      if ("refused" in checked) throw new HandVoucherRefused(`Line ${index + 1}: ${checked.refused.reason ?? "This line cannot be saved."}`);
      const itemName = checked.options.displayName;
      if (seen.has(checked.options.itemId)) throw new HandVoucherRefused(`${itemName} is entered twice. Put it on one line.`);
      seen.add(checked.options.itemId);
      // A hand move out names nobody; a voucher's does, so the day's report says who it went to.
      return { move: { ...checked, partyId }, itemName };
    });
  },

  /** @internal Moves every line and writes it, numbered from 1. Call ONLY inside BEGIN IMMEDIATE. */
  writeHandLines(this: SqliteDatabase, voucherId: string, lines: readonly CheckedLine[], actor: string): void {
    const insert = this.db.prepare(
      `INSERT INTO store_hand_voucher_lines (id, voucher_id, line_no, item_id, item_name, typed_quantity, typed_unit_code, quantity, stock_unit_code, stock_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    lines.forEach((line, index) => {
      const applied = this.applyCheckedHandMove(line.move, { actor });
      const { move } = line;
      insert.run(crypto.randomUUID(), voucherId, index + 1, move.options.itemId, line.itemName, move.typed, move.typedUnit, move.moving, move.stockUnit, applied.eventId);
    });
  },

  /** @internal One reversing movement per line, naming the voucher. Call ONLY inside BEGIN IMMEDIATE. */
  reverseHandLines(this: SqliteDatabase, held: HandVoucher, actor: string, why: "edited" | "deleted"): void {
    for (const line of held.lines) {
      const item = this.db.prepare("SELECT status FROM inventory_items WHERE id = ?").get(line.itemId) as Row | undefined;
      if (!item || text(item.status) !== "ACTIVE") {
        throw new HandVoucherRefused(`${line.itemName} has been retired, so ${held.code} can no longer be changed. Nothing was changed.`);
      }
      const reversal = reversalOf(held.direction, line, held.code, why);
      this.applyInventoryStockChange({ itemId: line.itemId, ...reversal, createdBy: actor, partyId: held.partyId });
    }
  },

  /** @internal Each material's balance now, before a change. */
  handBalances(this: SqliteDatabase, itemIds: readonly string[]): Map<string, number> {
    const balances = new Map<string, number>();
    for (const itemId of new Set(itemIds)) balances.set(itemId, this.handBalance(itemId));
    return balances;
  },

  /** @internal One material's balance, in its stock unit. */
  handBalance(this: SqliteDatabase, itemId: string): number {
    const row = this.db.prepare("SELECT quantity_on_hand FROM inventory_stock_balances WHERE item_id = ?").get(itemId) as Row | undefined;
    return round(Number(row?.quantity_on_hand ?? 0));
  },

  /**
   * @internal Refuses a change that takes back material already gone out. Only a balance the change lowered is
   * checked: what is left must not be below zero, nor below what the material's labelled packets in the store hold.
   */
  requireHandStockStillCovered(this: SqliteDatabase, before: ReadonlyMap<string, number>): void {
    for (const [itemId, was] of before) {
      const now = this.handBalance(itemId);
      if (now >= was) continue;
      const labelled = round(this.labelledRawMaterialPackets(this.db, itemId).get(itemId)?.contents ?? 0);
      if (now >= 0 && now >= labelled) continue;
      const item = this.db
        .prepare(
          `SELECT ii.display_name, u.code AS unit_code FROM inventory_items ii
           LEFT JOIN inventory_stock_balances b ON b.item_id = ii.id LEFT JOIN inventory_units u ON u.id = b.unit_id WHERE ii.id = ?`
        )
        .get(itemId) as Row | undefined;
      const loose = `${round(Math.max(was - labelled, 0))} ${text(item?.unit_code)}`.trim();
      throw new HandVoucherRefused(
        `${text(item?.display_name) || "A material"} on this voucher has already been used: only ${loose} of it is still loose in the store. Nothing was changed.`
      );
    }
  },
};

export type HandVoucherMethods = typeof handVoucherMethods;
