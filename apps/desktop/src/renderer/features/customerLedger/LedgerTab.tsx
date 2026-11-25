import React, { useEffect, useMemo, useState } from "react";
import { Pager } from "../../components/shared/Pager";
import { copy } from "../../config/copy";
import { ArchiveStrip } from "../ledgerArchive/ArchiveStrip";
import type { useLedgerArchive } from "../ledgerArchive/useLedgerArchive";
import { LedgerEquation } from "./LedgerEquation";
import { importedSums, ledgerTotals, periodSum } from "./ledgerFigures";
import { LedgerTable } from "./LedgerTable";
import { LedgerToolbar } from "./LedgerToolbar";
import type { CustomerLedgerData, LedgerEntry } from "./ledgerTypes";
import type { LedgerView } from "./useLedgerView";

// The Ledger tab: the period's sum, the imported ledgers' files in one section that opens on request (progressive
// disclosure), the search and filter, the one table, and its pages. One ledger (owner, 25 Nov 2026: "there is no old
// and new"): every sum and total here counts the imported rows and the ERP's entries together.

const text = copy.customerLedger;
const PAGE_SIZES = [10, 25, 50] as const;
const DETAILS_KEY = "customer-ledger.more-columns";

/** "More columns" is remembered on this computer: a convenience, so a storage that cannot be read just means "off". */
const readDetails = (): boolean => { try { return window.localStorage.getItem(DETAILS_KEY) === "1"; } catch { return false; } };
const saveDetails = (on: boolean) => { try { window.localStorage.setItem(DETAILS_KEY, on ? "1" : "0"); } catch { /* not kept */ } };

interface LedgerTabProps {
  data: CustomerLedgerData;
  view: LedgerView;
  archive: ReturnType<typeof useLedgerArchive>;
  fromDate: string;
  /** Changes whenever what is listed changes, so the list starts again from page 1. */
  resetKey: string;
  refreshing: boolean;
  toDate: string;
  onOpen: (entry: LedgerEntry) => void;
}

export const LedgerTab: React.FC<LedgerTabProps> = ({ data, view, archive, fromDate, toDate, resetKey, refreshing, onOpen }) => {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0]);
  const [details, setDetails] = useState(readDetails);
  const showDetails = (on: boolean) => { setDetails(on); saveDetails(on); };
  useEffect(() => { setPage(1); }, [resetKey, view.search, view.filter]);
  const sum = useMemo(() => periodSum(data.closingBalance, ledgerTotals(data.entries), importedSums(archive.view.entries)), [data.closingBalance, data.entries, archive.view.entries]);
  const shown = useMemo(() => periodSum(0, ledgerTotals(view.liveEntries), importedSums(view.archivedEntries)), [view.liveEntries, view.archivedEntries]);
  const pages = Math.max(1, Math.ceil(view.timeline.length / pageSize));
  const visible = view.timeline.slice((page - 1) * pageSize, page * pageSize);
  const first = view.timeline.length ? (page - 1) * pageSize + 1 : 0;
  return (
    <div className="cl-ledger-tab">
      <LedgerEquation sum={sum} closingBalance={data.closingBalance} />
      <details className="cl-history">
        <summary><span className="cl-history-title">{text.historyTitle}</span><span className="cl-history-status">{archive.view.statements.length ? text.historyStatus(archive.view.statements.length) : text.historyNone}</span></summary>
        <div className="cl-history-body">
          <ArchiveStrip state={archive.state} summary={view.archiveSummary} statements={archive.view.statements} onRetry={archive.reload} note={text.historyNote} />
        </div>
      </details>
      <LedgerToolbar search={view.search} onSearch={view.setSearch} filter={view.filter} onFilter={view.setFilter} details={details} onDetails={showDetails} />
      <LedgerTable items={visible} broughtForward={data.openingBalance} fromDate={fromDate} count={view.timeline.length} debit={shown.debit} credit={shown.credit} refreshing={refreshing} details={details}
        closingBalance={data.closingBalance} toDate={toDate} onOpen={onOpen} />
      <div className="customer-ledger-footer cl-footer">
        <span className="cl-footer-count">{text.showing(first, Math.min(page * pageSize, view.timeline.length), view.timeline.length)}</span>
        {pages > 1 && <Pager page={page} pages={pages} onPage={setPage} numbered />}
        <select className="input cl-page-size" aria-label={text.rowsPerPage} value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>
          {PAGE_SIZES.map((size) => <option key={size} value={size}>{text.perPage(size)}</option>)}
        </select>
      </div>
    </div>
  );
};
