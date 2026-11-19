import { LEDGER_ARCHIVE_TYPE_LABEL, fromPaisa } from "@erp/domain";
import type { ArchiveEntry } from "./archiveReplies";

// THE ONE CUSTOMER LEDGER (docs/50): the ERP's live entries and the archived rows of the previous software, in one
// chronological list. Combined HERE, for the screen and its downloads, and nowhere else: the live balance is still
// worked out only by the data layer from the ERP's own documents, and an archived row keeps the balance the old
// software printed. Neither is added to the other.
//
// Order: by date. On the same day an archived row comes first (it was written before the ERP existed for it), and
// each side keeps its own order.

/** What this needs of a live entry: the page's own LedgerEntry has all of it. */
export interface LiveLedgerEntry {
  voucherId: string;
  voucherNumber: string;
  voucherDate: string;
  voucherType: string;
  description: string;
  modeOfTransfer?: string;
  debitAmount: number;
  creditAmount: number;
  balance: number;
  lineItems?: ReadonlyArray<{ article: string; groupName: string | null; size: string; quantity: number; unitPrice: number; totalPrice: number }>;
}

export type LedgerTimelineItem<L extends LiveLedgerEntry> = { kind: "live"; entry: L } | { kind: "archived"; entry: ArchiveEntry };

/** Both lists, each already in its own order, merged by date. */
export function mergeLedgerTimeline<L extends LiveLedgerEntry>(live: readonly L[], archived: readonly ArchiveEntry[]): LedgerTimelineItem<L>[] {
  const merged: LedgerTimelineItem<L>[] = [];
  let a = 0;
  let l = 0;
  while (a < archived.length || l < live.length) {
    const takeArchived = l >= live.length || (a < archived.length && archived[a].entryDate <= live[l].voucherDate);
    if (takeArchived) merged.push({ kind: "archived", entry: archived[a++] });
    else merged.push({ kind: "live", entry: live[l++] });
  }
  return merged;
}

/** The old software's type code in words, or the code itself when it is not a known one. */
export const archiveTypeLabel = (code: string): string => LEDGER_ARCHIVE_TYPE_LABEL[code] ?? code;

/** Whether an archived row answers a search: any of its printed words or numbers. */
export function archivedMatches(entry: ArchiveEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [entry.voucherNumber, entry.billNumber, entry.description, entry.transactionType, archiveTypeLabel(entry.transactionType), entry.originalDateText]
    .some((value) => value.toLowerCase().includes(needle));
}

/** What the archived rows in view add up to. The balance is the last one printed, never one worked out here. */
export interface ArchiveSummary {
  rows: number;
  debitPaisa: number;
  creditPaisa: number;
  quantity: number;
  lastBalancePaisa: number | null;
  lastDate: string | null;
}

export function summarizeArchive(entries: readonly ArchiveEntry[]): ArchiveSummary {
  const last = entries[entries.length - 1];
  return {
    rows: entries.length,
    debitPaisa: entries.reduce((sum, entry) => sum + entry.debitPaisa, 0),
    creditPaisa: entries.reduce((sum, entry) => sum + entry.creditPaisa, 0),
    // Dozens, summed in hundredths so halves stay exact.
    quantity: entries.reduce((sum, entry) => sum + Math.round((entry.quantity ?? 0) * 100), 0) / 100,
    lastBalancePaisa: last ? last.balancePaisa : null,
    lastDate: last ? last.entryDate : null,
  };
}

// ─── One row for a download ─────────────────────────────────────────────────

/** A ledger line as the downloads write it: amounts in rupees, the source said in words. */
export interface LedgerExportRow {
  archived: boolean;
  date: string;
  voucherNumber: string;
  type: string;
  billNumber: string;
  description: string;
  quantity: number | null;
  debit: number;
  credit: number;
  balance: number;
}

const liveQuantity = (entry: LiveLedgerEntry): number | null =>
  entry.lineItems && entry.lineItems.length > 0 ? entry.lineItems.reduce((sum, line) => sum + Math.round(line.quantity * 100), 0) / 100 : null;

/** A live sale's description is its lines, one per line, as the screen shows them. */
const liveDescription = (entry: LiveLedgerEntry): string => {
  if (!entry.lineItems || entry.lineItems.length === 0) return [entry.description, entry.modeOfTransfer].filter(Boolean).join(" · ");
  return entry.lineItems.map((line) => [line.article, line.groupName, line.size, `${String(line.quantity)} x ${String(line.unitPrice)}`].filter(Boolean).join(" | ")).join("\n");
};

export function ledgerExportRows<L extends LiveLedgerEntry>(items: readonly LedgerTimelineItem<L>[], liveTypeLabel: (type: string) => string): LedgerExportRow[] {
  return items.map((item) => {
    if (item.kind === "archived") {
      const entry = item.entry;
      return {
        archived: true,
        date: entry.entryDate,
        voucherNumber: entry.voucherNumber,
        type: archiveTypeLabel(entry.transactionType),
        billNumber: entry.billNumber,
        description: entry.description,
        quantity: entry.quantity,
        debit: fromPaisa(entry.debitPaisa),
        credit: fromPaisa(entry.creditPaisa),
        balance: fromPaisa(entry.balancePaisa),
      };
    }
    const entry = item.entry;
    return {
      archived: false,
      date: entry.voucherDate,
      voucherNumber: entry.voucherNumber,
      type: liveTypeLabel(entry.voucherType),
      billNumber: "",
      description: liveDescription(entry),
      quantity: liveQuantity(entry),
      debit: entry.debitAmount,
      credit: entry.creditAmount,
      balance: entry.balance,
    };
  });
}
