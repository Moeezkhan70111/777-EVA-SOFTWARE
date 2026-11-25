import { useMemo, useState } from "react";
import type { ArchiveEntry } from "../ledgerArchive/archiveReplies";
import { archivedMatches, archiveTypeLabel, mergeLedgerTimeline, summarizeArchive } from "../ledgerArchive/unifiedLedger";
import { amountText, looseMatches } from "./looseSearch";
import { typeLabel } from "./LedgerRows";
import { ALL_FILTER, type LedgerFilter } from "./LedgerToolbar";
import { LEDGER_TYPE, type LedgerEntry } from "./ledgerTypes";

// What the ledger table shows: the ERP's entries and the imported rows that pass the search and the filter, merged
// by date (docs/50) into one ledger (owner, 25 Nov 2026: "there is no old and new"). The downloads carry exactly this.

/** Which of the filter's choices an imported row answers to: SL is a sale, CV a receipt or a payment by its side. */
export const archivedFilterOf = (entry: ArchiveEntry): LedgerFilter | null => {
  if (entry.transactionType === "SL") return LEDGER_TYPE.SALE;
  if (entry.transactionType !== "CV") return null;
  return entry.creditPaisa > 0 ? LEDGER_TYPE.CASH_RECEIPT : LEDGER_TYPE.CASH_PAYMENT;
};

// Searched loosely (looseSearch.ts): numbers, amounts and articles as people type them.
const liveMatches = (entry: LedgerEntry, query: string): boolean => looseMatches([
  entry.voucherNumber, entry.description, entry.modeOfTransfer ?? "", typeLabel(entry.voucherType), amountText(entry.debitAmount), amountText(entry.creditAmount),
  ...(entry.lineItems ?? []).map((line) => `${line.article} ${line.color} ${line.size}`),
], query);

const archivedLooseMatches = (entry: ArchiveEntry, query: string): boolean => archivedMatches(entry, query) || looseMatches([
  entry.voucherNumber, entry.billNumber, entry.description, archiveTypeLabel(entry.transactionType), entry.originalDateText, amountText(entry.debitPaisa / 100), amountText(entry.creditPaisa / 100),
], query);

export function useLedgerView(entries: readonly LedgerEntry[], archived: readonly ArchiveEntry[]) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<LedgerFilter>(ALL_FILTER);

  const liveEntries = useMemo(
    () => entries.filter((entry) => liveMatches(entry, search) && (filter === ALL_FILTER || entry.voucherType === filter)),
    [entries, filter, search],
  );
  const archivedEntries = useMemo(
    () => archived.filter((entry) => archivedLooseMatches(entry, search) && (filter === ALL_FILTER || archivedFilterOf(entry) === filter)),
    [archived, filter, search],
  );
  const timeline = useMemo(() => mergeLedgerTimeline(liveEntries, archivedEntries), [liveEntries, archivedEntries]);
  const archiveSummary = useMemo(() => summarizeArchive(archivedEntries), [archivedEntries]);
  return { search, setSearch, filter, setFilter, liveEntries, archivedEntries, timeline, archiveSummary };
}

export type LedgerView = ReturnType<typeof useLedgerView>;
