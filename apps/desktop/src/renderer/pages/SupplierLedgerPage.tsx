import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { AppRoute } from "../app/routes";
import { useDesktopApi } from "../hooks/useDesktopApi";
import { useDataChanged } from "../hooks/useDataChanged";
import { DATA_KIND } from "../../shared/dataChange";
import type { Party } from "../types/desktopApi";
import { copy } from "../config/copy";
import { toIsoDate } from "../utils/dates";
import { formatWholeMoney } from "../app/format";
import { StateView } from "../components/shared/StateView";
import { ArchiveStrip } from "../features/ledgerArchive/ArchiveStrip";
import { LedgerHistoryActions } from "../features/ledgerArchive/LedgerHistoryActions";
import { OpeningBalancePanel } from "../features/ledgerArchive/OpeningBalancePanel";
import { useLedgerArchive } from "../features/ledgerArchive/useLedgerArchive";
import { useLedgerDownloads } from "../features/ledgerArchive/useLedgerDownloads";
import { archivedMatches, ledgerExportRows, mergeLedgerTimeline, summarizeArchive } from "../features/ledgerArchive/unifiedLedger";
import { SupplierLedgerTable, supplierTypeLabel, type SupplierLedgerEntry, type SupplierLedgerType } from "../features/supplierLedger/SupplierLedgerTable";

// THE SUPPLIER LEDGER (docs/53): purchases, payments and claims, the supplier's opening balance carried in from the
// old software (which IS in the balance), and the old software's archived rows (which are not), in one date order.

interface SupplierLedgerPageProps { onNavigate: (route: AppRoute, id?: string) => void; }

const MONEY_CHANGES = [DATA_KIND.BILLING, DATA_KIND.CASH];
const ARCHIVED_FILTER = "ARCHIVED";
const archiveText = copy.ledgerArchive;
const fmtNum = formatWholeMoney;
const FILTERS: SupplierLedgerType[] = ["PURCHASE", "CASH_PAYMENT", "CASH_RECEIPT", "CLAIM", "OPENING_BALANCE"];

interface LedgerState { entries: SupplierLedgerEntry[]; openingBalance: number; closingBalance: number; partyName: string }
const EMPTY: LedgerState = { entries: [], openingBalance: 0, closingBalance: 0, partyName: "" };

/** The supplier's live ledger for the range, reloaded when money moves here or arrives from another computer. */
function useSupplierLedger(partyId: string, fromDate: string, toDate: string) {
  const api = useDesktopApi();
  const [ledger, setLedger] = useState<LedgerState>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((count) => count + 1), []);
  useDataChanged(MONEY_CHANGES, reload);
  useEffect(() => {
    if (!partyId) { setLedger(EMPTY); setFailed(false); return; }
    let current = true;
    setLoading(true);
    void api.getSupplierLedger(partyId, { fromDate, toDate })
      .then((result) => { if (current) { setLedger({ entries: result.entries, openingBalance: result.openingBalance, closingBalance: result.closingBalance, partyName: result.partyName }); setFailed(false); } })
      .catch(() => { if (current) { setLedger(EMPTY); setFailed(true); } })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [api, partyId, fromDate, toDate, reloads]);
  return { ...ledger, loading, failed, reload };
}

export const SupplierLedgerPage: React.FC<SupplierLedgerPageProps> = ({ onNavigate }) => {
  const api = useDesktopApi();
  const [parties, setParties] = useState<Party[]>([]);
  const [selectedPartyId, setSelectedPartyId] = useState("");
  const [fromDate, setFromDate] = useState("2026-01-01");
  const [toDate, setToDate] = useState(toIsoDate());
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const ledger = useSupplierLedger(selectedPartyId, fromDate, toDate);
  const archive = useLedgerArchive(selectedPartyId, fromDate, toDate);
  const downloads = useLedgerDownloads();

  useEffect(() => {
    void api.listParties({ pageSize: 1000 }).then((result) => setParties(result.rows.filter((p) => p.partyType === "SUPPLIER")));
  }, [api]);

  const filteredEntries = useMemo(() => typeFilter === ARCHIVED_FILTER ? [] : ledger.entries.filter((entry) => {
    const q = search.trim().toLowerCase();
    return (!q || [entry.voucherNumber, entry.description, entry.modeOfTransfer || "", supplierTypeLabel(entry.voucherType)].some((v) => v.toLowerCase().includes(q)))
      && (typeFilter === "ALL" || entry.voucherType === typeFilter);
  }), [ledger.entries, search, typeFilter]);
  const archivedEntries = useMemo(() => typeFilter === "ALL" || typeFilter === ARCHIVED_FILTER ? archive.view.entries.filter((entry) => archivedMatches(entry, search)) : [], [archive.view.entries, search, typeFilter]);
  const timeline = useMemo(() => mergeLedgerTimeline(filteredEntries, archivedEntries), [filteredEntries, archivedEntries]);
  const archiveSummary = useMemo(() => summarizeArchive(archivedEntries), [archivedEntries]);

  const { entries, openingBalance, closingBalance, partyName } = ledger;
  const totalPurchases = entries.filter((e) => e.voucherType === "PURCHASE").reduce((s, e) => s + e.creditAmount, 0);
  const totalPayments = entries.filter((e) => e.voucherType === "CASH_PAYMENT").reduce((s, e) => s + e.debitAmount, 0);
  const totalDebit = filteredEntries.reduce((s, e) => s + (e.debitAmount || 0), 0);
  const totalCredit = filteredEntries.reduce((s, e) => s + (e.creditAmount || 0), 0);
  const party = parties.find((p) => p.id === selectedPartyId);
  const initials = (partyName || party?.partyName || "Supplier").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const downloadInput = () => ({ side: "SUPPLIER" as const, customerName: partyName || party?.partyName || "Supplier", customerCode: party?.partyCode ?? "", fromDate, toDate, liveOpening: openingBalance, liveClosing: closingBalance, rows: ledgerExportRows(timeline, (type) => supplierTypeLabel(type as SupplierLedgerType)) });

  return (
    <div className="page customer-ledger-page">
      <div className="customer-ledger-heading">
        <div>
          <button type="button" className="customer-ledger-back" onClick={() => onNavigate("supplier-balance")}>‹ <span>{copy.common.back}</span></button>
          <h1>Supplier Ledger</h1>
          <p>Purchases and payments — amount we owe the supplier</p>
        </div>
        <div className="customer-ledger-actions">
          <div className="customer-ledger-search"><span>⌕</span><input aria-label="Search transactions" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search transactions..." /></div>
          <select aria-label="Filter transactions" className="customer-ledger-filter" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="ALL">Filter</option>
            {FILTERS.map((type) => <option key={type} value={type}>{supplierTypeLabel(type)}</option>)}
            <option value={ARCHIVED_FILTER}>{archiveText.filterArchived}</option>
          </select>
          <LedgerHistoryActions side="SUPPLIER" parties={parties} noParty={!selectedPartyId} making={downloads.making} onDownloadExcel={() => downloads.downloadExcel(downloadInput())} onDownloadPdf={() => void downloads.downloadPdf(downloadInput())} onImported={archive.reload} />
        </div>
      </div>

      <section className="customer-ledger-customer-card">
        <div className="customer-ledger-identity">
          <div className="customer-ledger-avatar">{initials}</div>
          <div>
            <div className="customer-ledger-name-row">
              <select aria-label="Select supplier" value={selectedPartyId} onChange={(e) => setSelectedPartyId(e.target.value)}>
                <option value="">Select supplier</option>
                {parties.map((p) => <option key={p.id} value={p.id}>{p.partyName}</option>)}
              </select>
              {party && <span className="customer-ledger-status">{party.status === "ACTIVE" ? "Active" : "Inactive"}</span>}
            </div>
            <div className="customer-ledger-contact">☎ {party?.mobileNumber || party?.phoneNumber || "No phone number"}</div>
            <div className="customer-ledger-contact">⌖ {party?.city || party?.address || "Location not provided"}</div>
          </div>
        </div>
        <div className={`customer-ledger-highlight ${closingBalance >= 0 ? "is-payable" : "is-credit"}`}>
          <span>Amount Owed</span>
          <strong>Rs. {fmtNum(Math.abs(closingBalance))}</strong>
          <small>{closingBalance >= 0 ? "Payable to supplier" : "Advance / overpaid"}</small>
        </div>
        <div className="customer-ledger-highlight">
          <span>Total Transactions</span>
          <strong>{entries.length}</strong>
          <small>{fromDate} to {toDate}</small>
        </div>
      </section>

      <section className="customer-ledger-workspace">
        <div className="customer-ledger-tabs">
          <span className="supplier-ledger-tab-title">Ledger</span>
          <div className="customer-ledger-date">
            <span>▣</span>
            <input aria-label={copy.filters.fromDate} type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            <b>to</b>
            <input aria-label={copy.filters.toDate} type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>
        </div>
        <div className="customer-ledger-summary-grid">
          <div className="customer-ledger-summary-card"><div><span>Opening Balance</span><strong>Rs. {fmtNum(Math.abs(openingBalance))}</strong><small>{fromDate}</small></div></div>
          <div className="customer-ledger-summary-card"><div><span>Total Purchases</span><strong className="negative">Rs. {fmtNum(totalPurchases)}</strong><small>{entries.filter((e) => e.voucherType === "PURCHASE").length} bills</small></div></div>
          <div className="customer-ledger-summary-card"><div><span>Total Payments</span><strong className="positive">Rs. {fmtNum(totalPayments)}</strong><small>{entries.filter((e) => e.voucherType === "CASH_PAYMENT").length} payments</small></div></div>
          <div className="customer-ledger-summary-card"><div><span>Closing Balance</span><strong>Rs. {fmtNum(Math.abs(closingBalance))}</strong><small>{toDate}</small></div></div>
        </div>
        {selectedPartyId && <OpeningBalancePanel side="SUPPLIER" partyId={selectedPartyId} partyName={partyName || party?.partyName || ""} statements={archive.view.statements} onChanged={ledger.reload} />}
        {selectedPartyId && <ArchiveStrip state={archive.state} summary={archiveSummary} statements={archive.view.statements} onRetry={archive.reload} />}
        <div className="customer-ledger-table-wrap">
          {ledger.failed
            ? <StateView kind="error" compact title={archiveText.ledgerFailed} onRetry={ledger.reload} />
            : <SupplierLedgerTable loading={ledger.loading} hasParty={Boolean(selectedPartyId)} openingBalance={openingBalance} fromDate={fromDate} timeline={timeline} liveCount={filteredEntries.length} archiveSummary={archiveSummary} totals={{ debit: totalDebit, credit: totalCredit, net: totalCredit - totalDebit }} />}
        </div>
      </section>
    </div>
  );
};
