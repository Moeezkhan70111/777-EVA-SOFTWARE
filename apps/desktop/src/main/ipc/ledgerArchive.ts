// Historical ledger archive: Customer Ledger and Supplier Ledger > Import old ledger (docs/50 and 53; data layer,
// database/ledgerArchive.ts). An import names its side, CUSTOMER or SUPPLIER, and the data layer refuses a party of
// the other type.
//
//   previewLedgerArchive         what an import of this file would do: each customer matched here, what is already stored
//   importLedgerArchive          every statement and its rows, all or nothing, under the ACCOUNTS lease
//   getLedgerArchive             one customer's archived rows in a date range, for the Customer Ledger screen
//   attachLedgerArchiveSource    keeps the original PDF on this computer, named by its SHA-256
//   openLedgerArchiveSource      opens a kept PDF in the computer's own PDF viewer
//   getLedgerArchiveBatch        every statement one import wrote, withdrawn or not, for the withdrawal dialog
//   withdrawLedgerArchiveBatch   takes one import out of every ledger, with a reason. Its rows are kept (migration 114)
//
// ONE IMPORT, SEVERAL FILES. The previous software's reports (.xls, read in the screen) may be chosen together,
// customers and suppliers mixed: each statement names its own side, file and the report's own title, code, period and
// Total line, and the data layer checks all of it again.
//
// WITHDRAWING is an ADMINISTRATOR's, on the computer holding the ACCOUNTS lease, like an opening balance.
//
// WHO. Importing is accounts work: the Cash Voucher permission, on the computer holding the ACCOUNTS lease
// (leaseChannels.ts), like writing a cash voucher. Reading is the Customer Ledger permission for a customer's archive,
// the Supplier Ledger permission for a supplier's. Nothing the screen sends
// is trusted: who imported comes from the session, and every row is read again by the data layer.
//
// THE PDF stays on the computer it was attached on, in its own folder, named by its hash (the delivery-proof store's
// rule: a name the person typed is never joined onto a path). The statement records its name and hash and travels;
// the file does not. Another computer shows the name and says the file is not on it.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "../leaseGuard";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { LEDGER_ARCHIVE_LIMITS, LEDGER_ARCHIVE_SIDE, PERMISSION, asRecord, asString, isLedgerArchiveSide, type LedgerArchiveRowInput, type LedgerArchiveSide, type LegacyReportInfo, type PermissionCode } from "@erp/domain";
import { rejection, type SessionUser } from "../authorize";
import { refusalReason } from "../writeRefusal";
import { DATA_KIND, type DataKind } from "../../shared/dataChange";

/** What an operator is told. One place, for translation later (R21). */
export const LEDGER_ARCHIVE_MESSAGES = {
  BUSY: "The import was not saved because another write is in progress. Nothing was changed. Please try again.",
  NOT_SAVED: "The import could not be saved. Nothing was changed.",
  NOT_LOADED: "The archived ledger could not be loaded. Try again.",
  NOT_ALLOWED_IMPORT: "Your account does not have Cash Voucher access, which importing an old ledger needs.",
  NOT_ALLOWED_VIEW: "Your account does not have access to this ledger.",
  TOO_MANY: `One import may hold at most ${String(LEDGER_ARCHIVE_LIMITS.MAX_ROWS)} rows. Split the file.`,
  NOT_PDF: "Only a PDF can be kept as the original ledger.",
  PDF_TOO_LARGE: "That PDF is larger than 15 MB.",
  PDF_NOT_SAVED: "The PDF could not be kept on this computer.",
  PDF_NOT_HERE: "The original PDF is not on this computer. It is kept on the computer it was imported on.",
  REPORT_UNREADABLE: "A statement's report details could not be read. Choose the file again.",
  ADMIN_ONLY_WITHDRAW: "Only an administrator can withdraw an imported old ledger.",
  NOT_WITHDRAWN: "The import could not be withdrawn. Nothing was changed.",
  WITHDRAW_BUSY: "The import was not withdrawn because another write is in progress. Nothing was changed. Please try again.",
} as const;

/** The side an import names: customers unless it says suppliers. */
const sideOf = (value: unknown): LedgerArchiveSide => (isLedgerArchiveSide(value) ? value : LEDGER_ARCHIVE_SIDE.CUSTOMER);

/** The permission that reads a side's ledger. */
export const LEDGER_PERMISSION: Readonly<Record<LedgerArchiveSide, PermissionCode>> = {
  CUSTOMER: PERMISSION.CUSTOMER_LEDGER,
  SUPPLIER: PERMISSION.SUPPLIER_LEDGER,
};

const MAX_PDF_BYTES = 15 * 1024 * 1024;
const SOURCES_FOLDER = "ledger-archive-sources";
const SHA256 = /^[0-9a-f]{64}$/;

/** One row as sent: every cell read as text, nothing else carried. */
const rowOf = (value: unknown): LedgerArchiveRowInput => {
  const row = asRecord(value);
  const cell = (key: string) => asString(row[key]);
  return {
    rowNumber: Number.isSafeInteger(row.rowNumber) ? Number(row.rowNumber) : 0,
    partyCode: cell("partyCode"), customerName: cell("customerName"), transactionDate: cell("transactionDate"),
    voucherNumber: cell("voucherNumber"), transactionType: cell("transactionType"), billNumber: cell("billNumber"),
    description: cell("description"), quantity: cell("quantity"), debit: cell("debit"), credit: cell("credit"),
    runningBalance: cell("runningBalance"), sequence: cell("sequence"),
  };
};

const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** What the previous software's report said of itself, as sent: absent for a template CSV. Checked by the data layer. */
const reportOf = (value: unknown): LegacyReportInfo | null => {
  if (value === undefined || value === null) return null;
  const fields = asRecord(value);
  const totals = asRecord(fields.printedTotals);
  const debit = textOrNull(totals.debit);
  const credit = textOrNull(totals.credit);
  const closing = textOrNull(totals.closing);
  if (!isLedgerArchiveSide(fields.side) || debit === null || credit === null || closing === null) throw new Error(LEDGER_ARCHIVE_MESSAGES.REPORT_UNREADABLE);
  return {
    title: asString(fields.title), side: fields.side, partyCode: asString(fields.partyCode), partyName: asString(fields.partyName),
    periodFrom: asString(fields.periodFrom), periodTo: asString(fields.periodTo),
    printedTotals: { quantity: textOrNull(totals.quantity), debit, credit, closing },
  };
};

/** The file one statement came from, when an import holds several. */
const sourceFileOf = (value: unknown): { name: string; hash: string } | null => {
  const fields = asRecord(value);
  return SHA256.test(asString(fields.hash)) ? { name: asString(fields.name).slice(0, 200), hash: asString(fields.hash) } : null;
};

/** The statements as sent. More rows than an import may hold are refused before any is read. */
const statementsOf = (value: unknown) => {
  const statements = Array.isArray(value) ? value : [];
  const rowCount = statements.reduce((sum: number, item) => sum + (Array.isArray(asRecord(item).rows) ? (asRecord(item).rows as unknown[]).length : 0), 0);
  if (rowCount > LEDGER_ARCHIVE_LIMITS.MAX_ROWS) throw new Error(LEDGER_ARCHIVE_MESSAGES.TOO_MANY);
  return statements.map((item) => {
    const fields = asRecord(item);
    const source = asRecord(fields.sourceDocument);
    return {
      partyId: asString(fields.partyId) || undefined,
      rows: (Array.isArray(fields.rows) ? fields.rows : []).map(rowOf),
      sourceDocument: asString(source.hash) ? { name: asString(source.name), hash: asString(source.hash), bytes: Number(source.bytes) } : null,
      side: isLedgerArchiveSide(fields.side) ? fields.side : undefined,
      sourceFile: sourceFileOf(fields.sourceFile),
      report: reportOf(fields.report),
    };
  });
};

export function registerLedgerArchiveHandlers(ctx: IpcContext & { announce?: (kinds: readonly DataKind[]) => void }): void {
  const { db, logger, authorizer, deviceId, paths } = ctx;
  const announce = ctx.announce ?? (() => undefined);
  const sourcesDir = path.join(paths.dataRoot, SOURCES_FOLDER);

  const log = (severity: "INFO" | "WARNING" | "ERROR", operation: string, message: string, userId?: string) =>
    logger.log({ module: "ledger-archive", severity, operation, deviceId, userId, message });

  const who = (event: IpcMainInvokeEvent, opts: unknown, permission: PermissionCode, refused: string) => {
    try {
      return { ok: true as const, user: authorizer.requirePermission(event, permission, asRecord(opts).token) };
    } catch (error) {
      return { ok: false as const, ...rejection(error, refused) };
    }
  };

  /** The kept PDF for a hash, or null. The name is the hash: nothing typed reaches the path. */
  const sourcePath = (hash: string): string | null => (SHA256.test(hash) ? path.join(sourcesDir, `${hash}.pdf`) : null);

  ipcMain.handle(IPC.previewLedgerArchive, (event, input?: unknown, opts?: unknown) => {
    const user = who(event, opts, PERMISSION.CASH_VOUCHER_FORM, LEDGER_ARCHIVE_MESSAGES.NOT_ALLOWED_IMPORT);
    if (!user.ok) return { accepted: false, reason: user.reason };
    try {
      const fields = asRecord(input);
      return { accepted: true, preview: db.previewLedgerArchiveImport({ fileHash: asString(fields.fileHash), statements: statementsOf(fields.statements), side: sideOf(fields.side) }) };
    } catch (error) {
      log("WARNING", "preview", error instanceof Error ? error.message : String(error), user.user.id);
      return { accepted: false, reason: error instanceof Error ? error.message : LEDGER_ARCHIVE_MESSAGES.NOT_LOADED };
    }
  });

  ipcMain.handle(IPC.importLedgerArchive, (event, input?: unknown, opts?: unknown) => {
    const user = who(event, opts, PERMISSION.CASH_VOUCHER_FORM, LEDGER_ARCHIVE_MESSAGES.NOT_ALLOWED_IMPORT);
    if (!user.ok) return { accepted: false, reason: user.reason };
    const fields = asRecord(input);
    try {
      const result = db.importLedgerArchive({
        batchId: asString(fields.batchId),
        fileName: asString(fields.fileName),
        fileHash: asString(fields.fileHash),
        statements: statementsOf(fields.statements),
        side: sideOf(fields.side),
        actor: user.user.username,
      });
      const rows = result.statements.reduce((sum, statement) => sum + statement.rowCount, 0);
      log("INFO", "import", JSON.stringify({ batchId: result.batchId, side: sideOf(fields.side), duplicate: result.duplicate, statements: result.statements.length, rows }), user.user.id);
      return { accepted: true, result };
    } catch (error) {
      const reason = refusalReason(error, LEDGER_ARCHIVE_MESSAGES.BUSY, LEDGER_ARCHIVE_MESSAGES.NOT_SAVED);
      log("WARNING", "import", reason, user.user.id);
      return { accepted: false, reason };
    }
  });

  ipcMain.handle(IPC.getLedgerArchive, (event, partyId?: unknown, query?: unknown, opts?: unknown) => {
    // A supplier's archive is read with Supplier Ledger access, anyone else's with Customer Ledger access.
    const side = db.getParty(asString(partyId))?.partyType === LEDGER_ARCHIVE_SIDE.SUPPLIER ? LEDGER_ARCHIVE_SIDE.SUPPLIER : LEDGER_ARCHIVE_SIDE.CUSTOMER;
    const user = who(event, opts, LEDGER_PERMISSION[side], LEDGER_ARCHIVE_MESSAGES.NOT_ALLOWED_VIEW);
    if (!user.ok) return { accepted: false, reason: user.reason };
    try {
      const range = asRecord(query);
      const fromDate = asString(range.fromDate) || undefined;
      const toDate = asString(range.toDate) || undefined;
      return { accepted: true, view: db.ledgerArchiveForParty(asString(partyId), { fromDate, toDate }) };
    } catch (error) {
      log("ERROR", "read", error instanceof Error ? error.message : String(error), user.user.id);
      return { accepted: false, reason: LEDGER_ARCHIVE_MESSAGES.NOT_LOADED };
    }
  });

  ipcMain.handle(IPC.getLedgerArchiveBatch, (event, batchId?: unknown, opts?: unknown) => {
    const user = who(event, opts, PERMISSION.CASH_VOUCHER_FORM, LEDGER_ARCHIVE_MESSAGES.NOT_ALLOWED_IMPORT);
    if (!user.ok) return { accepted: false, reason: user.reason };
    try {
      return { accepted: true, statements: db.getLedgerArchiveBatch(asString(batchId)) };
    } catch (error) {
      log("ERROR", "read-batch", error instanceof Error ? error.message : String(error), user.user.id);
      return { accepted: false, reason: LEDGER_ARCHIVE_MESSAGES.NOT_LOADED };
    }
  });

  ipcMain.handle(IPC.withdrawLedgerArchiveBatch, (event, input?: unknown, opts?: unknown) => {
    let actor: SessionUser;
    try {
      actor = authorizer.requireAdmin(event, asRecord(opts).token);
    } catch (error) {
      return rejection(error, LEDGER_ARCHIVE_MESSAGES.ADMIN_ONLY_WITHDRAW);
    }
    const fields = asRecord(input);
    try {
      const result = db.withdrawLedgerArchiveBatch({ requestId: asString(fields.requestId), batchId: asString(fields.batchId), reason: fields.reason, actor: actor.username });
      log("INFO", "withdraw", JSON.stringify({ batchId: result.batchId, duplicate: result.duplicate, statements: result.statements.length }), actor.id);
      // Archived rows left the ledgers: every open ledger and its reconciliation reload (useLedgerArchive listens for BILLING).
      announce([DATA_KIND.BILLING]);
      return { accepted: true, result };
    } catch (error) {
      const reason = refusalReason(error, LEDGER_ARCHIVE_MESSAGES.WITHDRAW_BUSY, LEDGER_ARCHIVE_MESSAGES.NOT_WITHDRAWN);
      log("WARNING", "withdraw", reason, actor.id);
      return { accepted: false, reason };
    }
  });

  ipcMain.handle(IPC.attachLedgerArchiveSource, (event, input?: unknown, opts?: unknown) => {
    const user = who(event, opts, PERMISSION.CASH_VOUCHER_FORM, LEDGER_ARCHIVE_MESSAGES.NOT_ALLOWED_IMPORT);
    if (!user.ok) return { accepted: false, reason: user.reason };
    const fields = asRecord(input);
    const match = /^data:application\/pdf;base64,(.+)$/i.exec(asString(fields.dataUrl));
    if (!match) return { accepted: false, reason: LEDGER_ARCHIVE_MESSAGES.NOT_PDF };
    const bytes = Buffer.from(match[1] ?? "", "base64");
    if (bytes.byteLength > MAX_PDF_BYTES) return { accepted: false, reason: LEDGER_ARCHIVE_MESSAGES.PDF_TOO_LARGE };
    if (bytes.byteLength === 0 || bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return { accepted: false, reason: LEDGER_ARCHIVE_MESSAGES.NOT_PDF };
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    const target = sourcePath(hash);
    if (!target) return { accepted: false, reason: LEDGER_ARCHIVE_MESSAGES.PDF_NOT_SAVED };
    try {
      fs.mkdirSync(sourcesDir, { recursive: true });
      // The same file kept twice is the same file: written once.
      if (!fs.existsSync(target)) fs.writeFileSync(target, bytes);
    } catch (error) {
      log("ERROR", "attach-source", String(error), user.user.id);
      return { accepted: false, reason: LEDGER_ARCHIVE_MESSAGES.PDF_NOT_SAVED };
    }
    const name = asString(fields.name).replace(/[\\/:*?"<>|\x00-\x1F]/g, " ").trim().slice(0, 200) || "ledger.pdf";
    return { accepted: true, source: { name, hash, bytes: bytes.byteLength } };
  });

  ipcMain.handle(IPC.openLedgerArchiveSource, async (event, hash?: unknown, opts?: unknown) => {
    try {
      authorizer.requireAnyPermission(event, [PERMISSION.CUSTOMER_LEDGER, PERMISSION.SUPPLIER_LEDGER], asRecord(opts).token);
    } catch (error) {
      return rejection(error, LEDGER_ARCHIVE_MESSAGES.NOT_ALLOWED_VIEW);
    }
    const target = sourcePath(asString(hash));
    if (!target || !fs.existsSync(target)) return { accepted: false, reason: LEDGER_ARCHIVE_MESSAGES.PDF_NOT_HERE };
    const failure = await shell.openPath(target);
    return failure ? { accepted: false, reason: failure } : { accepted: true };
  });
}
