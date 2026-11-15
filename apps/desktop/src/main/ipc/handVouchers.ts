// Store hand vouchers: Store > Move in / Move out > By hand (docs/49; data layer, database/handVouchers.ts).
//
//   saveHandVoucher     a new voucher, in or out: every line moved, or none
//   editHandVoucher     today's voucher, said again: old lines reversed, new lines moved in, or nothing
//   deleteHandVoucher   today's voucher, taken back: every line reversed, the voucher kept as DELETED
//   getHandVoucher      one voucher of a direction by number (or the newest), with the numbers either side
//
// IPC handlers are registered per feature; every call is authorised through ctx.authorizer (see ../authorize.ts) and
// every channel name comes from shared/ipcChannels.ts.
//
// WHO. The same Store Scanning permission as moving one material in by hand, and written on the store computer only
// (leaseChannels.ts). Nothing the screen sends is trusted: who wrote it comes from the session; every line, the
// supplier, the day and the revision are checked again by the data layer inside its write lock.

import type { IpcMainInvokeEvent } from "electron";
// Lease-gated (leaseChannels.ts): a voucher moves the raw-material balance, and travels under the store lease.
import { ipcMain } from "../leaseGuard";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { PERMISSION, STORE_DIRECTION, STORE_HAND_VOUCHER_MAX_LINES, asRecord, asString } from "@erp/domain";
import { rejection } from "../authorize";
import { refusalReason } from "../writeRefusal";

/** What an operator is told. One place, for translation later (R21). */
export const STORE_HAND_VOUCHER_MESSAGES = {
  BUSY: "The voucher was not saved because another stock operation is in progress. Nothing was changed. Please try again.",
  NOT_SAVED: "The voucher could not be saved. Nothing was changed.",
  NOT_LOADED: "The voucher could not be loaded. Try again.",
  NOT_ALLOWED: "Your account does not have Store Scanning access.",
  TOO_MANY: `One voucher may hold at most ${String(STORE_HAND_VOUCHER_MAX_LINES)} lines.`,
} as const;

/** The lines as sent, each field read as text. More than the limit is refused before anything is read. */
const linesOf = (value: unknown) => {
  const lines = Array.isArray(value) ? value : [];
  if (lines.length > STORE_HAND_VOUCHER_MAX_LINES) throw new Error(STORE_HAND_VOUCHER_MESSAGES.TOO_MANY);
  return lines.map((line) => {
    const fields = asRecord(line);
    return { itemId: asString(fields.itemId), quantity: asString(fields.quantity), unitCode: asString(fields.unitCode) };
  });
};

/** The voucher's own words as sent: supplier, note, lines. */
const bodyOf = (fields: Record<string, unknown>) => ({
  partyId: asString(fields.partyId),
  note: asString(fields.note) || null,
  lines: linesOf(fields.lines),
});

/** A voucher number as sent; null asks for the newest. */
const numberOf = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
};

export function registerHandVoucherHandlers(ctx: IpcContext): void {
  const { db, logger, authorizer, deviceId } = ctx;

  const log = (severity: "INFO" | "WARNING" | "ERROR", operation: string, message: string, userId?: string) =>
    logger.log({ module: "hand-voucher", severity, operation, deviceId, userId, message });

  const operator = (event: IpcMainInvokeEvent, opts: unknown) => {
    try {
      return { ok: true as const, user: authorizer.requirePermission(event, PERMISSION.STORE_SCANNING, asRecord(opts).token) };
    } catch (error) {
      return { ok: false as const, ...rejection(error, STORE_HAND_VOUCHER_MESSAGES.NOT_ALLOWED) };
    }
  };

  /** Runs one write and answers with the voucher, or with why nothing was written. */
  const write = (operation: string, user: { id: string; username: string }, run: () => unknown) => {
    try {
      const voucher = run();
      log("INFO", operation, JSON.stringify({ ok: true }), user.id);
      return { accepted: true, voucher };
    } catch (error) {
      const reason = refusalReason(error, STORE_HAND_VOUCHER_MESSAGES.BUSY, STORE_HAND_VOUCHER_MESSAGES.NOT_SAVED);
      log("WARNING", operation, reason, user.id);
      return { accepted: false, reason };
    }
  };

  ipcMain.handle(IPC.saveHandVoucher, (event, input?: unknown, opts?: unknown) => {
    const who = operator(event, opts);
    if (!who.ok) return { accepted: false, reason: who.reason };
    const fields = asRecord(input);
    return write("save", who.user, () => db.saveHandVoucher({ direction: asString(fields.direction), requestId: asString(fields.requestId), ...bodyOf(fields), actor: who.user.username }).voucher);
  });

  ipcMain.handle(IPC.editHandVoucher, (event, input?: unknown, opts?: unknown) => {
    const who = operator(event, opts);
    if (!who.ok) return { accepted: false, reason: who.reason };
    const fields = asRecord(input);
    return write("edit", who.user, () =>
      db.editHandVoucher({ voucherId: asString(fields.voucherId), revision: Number(fields.revision), ...bodyOf(fields), actor: who.user.username }).voucher
    );
  });

  ipcMain.handle(IPC.deleteHandVoucher, (event, input?: unknown, opts?: unknown) => {
    const who = operator(event, opts);
    if (!who.ok) return { accepted: false, reason: who.reason };
    const fields = asRecord(input);
    return write("delete", who.user, () => db.deleteHandVoucher({ voucherId: asString(fields.voucherId), revision: Number(fields.revision), actor: who.user.username }));
  });

  ipcMain.handle(IPC.getHandVoucher, (event, direction?: unknown, voucherNumber?: unknown, opts?: unknown) => {
    const who = operator(event, opts);
    if (!who.ok) return { accepted: false, reason: who.reason };
    try {
      const side = direction === STORE_DIRECTION.OUT ? STORE_DIRECTION.OUT : STORE_DIRECTION.IN;
      return { accepted: true, view: db.handVoucherView(side, numberOf(voucherNumber)) };
    } catch (error) {
      log("ERROR", "read", error instanceof Error ? error.message : String(error), who.user.id);
      return { accepted: false, reason: STORE_HAND_VOUCHER_MESSAGES.NOT_LOADED };
    }
  });
}
