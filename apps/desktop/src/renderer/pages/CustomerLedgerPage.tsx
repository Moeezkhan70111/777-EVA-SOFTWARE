import React, { useState } from "react";
import { LEDGER_SIDE } from "@erp/domain";
import type { AppRoute } from "../app/routes";
import { Modal } from "../components/shared/Modal";
import { StateView } from "../components/shared/StateView";
import { copy } from "../config/copy";
import { useDesktopApi } from "../hooks/useDesktopApi";
import { useTodayFollowingDate } from "../hooks/useTodayFollowingDate";
import type { CashVoucher, SaleVoucher } from "../types/desktopApi";
import { toIsoDate } from "../utils/dates";
import { BalanceHero } from "../features/customerLedger/BalanceHero";
import { CustomerCard } from "../features/customerLedger/CustomerCard";
import { HeroSkeleton, WorkspaceSkeleton } from "../features/customerLedger/LedgerSkeleton";
import { importedSums, ledgerTotals, periodSum } from "../features/customerLedger/ledgerFigures";
import { DEFAULT_LEDGER_PERIOD, periodStart } from "../features/customerLedger/ledgerPeriods";
import { typeLabel } from "../features/customerLedger/LedgerRows";
import { LedgerTab } from "../features/customerLedger/LedgerTab";
import { opensVoucher, type LedgerEntry, type LedgerType } from "../features/customerLedger/ledgerTypes";
import { PeriodBar } from "../features/customerLedger/PeriodBar";
import { useCustomerLedger, useLedgerCustomers } from "../features/customerLedger/useCustomerLedger";
import { useLedgerView } from "../features/customerLedger/useLedgerView";
import { VoucherDetail } from "../features/customerLedger/VoucherDetail";
import { ArchiveStrip } from "../features/ledgerArchive/ArchiveStrip";
import { LedgerHistoryActions } from "../features/ledgerArchive/LedgerHistoryActions";
import { useLedgerArchive } from "../features/ledgerArchive/useLedgerArchive";
import { useLedgerDownloads } from "../features/ledgerArchive/useLedgerDownloads";
import { ledgerExportRows } from "../features/ledgerArchive/unifiedLedger";

// CUSTOMER LEDGER (docs/50): one customer's bills, returns, cash and the old software's history, in one ledger.
//
//   [ Customer ▾ ]  Balance limit ███████░░ 70% used        ┌ CURRENT BALANCE ───────────┐
//                                                            │ Rs. 40,000    ↓ Receivable  │
//   [This month][3 months][This year][All time]  from – to      one ledger: no Summary or Statement (owner, 26 Nov 2026)
//   Brought forward  + Debit  − Credit  = Balance
//
// ONE LEDGER (owner, 25 Nov 2026: "there is no old and new, both are real values"): an imported ledger is part of the
// customer's ledger. The balance on any day is the imported ledger's balance on its last line up to then plus every ERP
// entry up to then, worked out by the main process (customerOldLedgerPaisaSql); nothing is carried in or posted.

const text = copy.customerLedger;
const SIDE = LEDGER_SIDE.CUSTOMER;

interface CustomerLedgerPageProps {
  onNavigate: (route: AppRoute, id?: string) => void;
  /** The customer to open on, when Customer Balance sent us here from their row. */
  initialPartyId?: string;
}

export const CustomerLedgerPage: React.FC<CustomerLedgerPageProps> = ({ onNavigate, initialPartyId }) => {
  const api = useDesktopApi();
  const customers = useLedgerCustomers();
  const [partyId, setPartyId] = useState(initialPartyId ?? "");
  const [fromDate, setFromDate] = useState(() => periodStart(DEFAULT_LEDGER_PERIOD, toIsoDate()));
  const [toDate, setToDate] = useTodayFollowingDate();
  const [showImported, setShowImported] = useState(false);
  const [detail, setDetail] = useState<{ voucher: CashVoucher | SaleVoucher; type: LedgerType } | null>(null);
  const ledger = useCustomerLedger(partyId, fromDate, toDate);
  const archive = useLedgerArchive(partyId, fromDate, toDate);
  const downloads = useLedgerDownloads();
  const data = ledger.data;
  const view = useLedgerView(data?.entries ?? [], archive.view.entries);
  const party = customers.customers.find((item) => item.id === partyId);
  const partyName = data?.partyName || party?.partyName || "";
  const refreshing = ledger.state.status === "loading" && data !== null;

  const openVoucher = async (entry: LedgerEntry) => {
    if (!opensVoucher(entry.voucherType)) return;
    const voucher = entry.voucherType === "SALE" ? await api.getSaleVoucher(entry.voucherId) : await api.getCashVoucher(entry.voucherId);
    if (voucher) setDetail({ voucher, type: entry.voucherType });
  };
  const editVoucher = () => {
    if (!detail) return;
    const target = detail.type === "SALE" ? "sale-voucher-form" : "cash-voucher-form";
    setDetail(null);
    onNavigate(target, detail.voucher.id);
  };
  // One ledger: the download's brought forward is the screen's, worked over the ERP's entries and the imported rows.
  const broughtForward = () => (data ? periodSum(data.closingBalance, ledgerTotals(data.entries), importedSums(archive.view.entries)).broughtForward : 0);
  const downloadInput = () => ({ side: SIDE, customerName: partyName || "Customer", customerCode: party?.partyCode ?? "", fromDate, toDate, liveOpening: broughtForward(), liveClosing: data?.closingBalance ?? 0, merged: true, rows: ledgerExportRows(view.timeline, (type) => typeLabel(type as LedgerType)) });

  const workspace = () => {
    if (!partyId) return <StateView kind="empty" title={text.chooseTitle} hint={text.chooseHint} />;
    if (ledger.state.status === "error") return <StateView kind="error" message={text.failed} onRetry={ledger.reload} />;
    if (!data) return <WorkspaceSkeleton />;
    return (
      <section className="cl-workspace card">
        <div className="cl-workspace-head">
          <h2 className="cl-section-title">{text.transactionsTitle}</h2>
          <PeriodBar fromDate={fromDate} toDate={toDate} onFrom={setFromDate} onTo={setToDate} />
        </div>
        <LedgerTab data={data} view={view} archive={archive} fromDate={fromDate} toDate={toDate} resetKey={`${partyId}|${fromDate}|${toDate}`} refreshing={refreshing} onOpen={(entry) => void openVoucher(entry)} />
      </section>
    );
  };

  return (
    <div className="page customer-ledger-page doc-themed cl-page">
      {showImported && (
        <Modal title={text.historyTitle} subtitle={partyName} onClose={() => setShowImported(false)} wide>
          <ArchiveStrip state={archive.state} summary={view.archiveSummary} statements={archive.view.statements} onRetry={archive.reload} note={text.historyNote} />
        </Modal>
      )}
      {detail && <VoucherDetail voucher={detail.voucher} type={detail.type} onClose={() => setDetail(null)} onEdit={editVoucher} />}
      <header className="cl-head">
        <div className="cl-head-title">
          <button type="button" className="customer-ledger-back" onClick={() => onNavigate("customer-balance")}>‹ <span>{text.back}</span></button>
          <h1>{text.title}</h1>
        </div>
        <div className="cl-head-actions">
          <LedgerHistoryActions side={SIDE} parties={customers.customers} noParty={!partyId} making={downloads.making} onDownloadExcel={() => downloads.downloadExcel(downloadInput())} onDownloadPdf={() => void downloads.downloadPdf(downloadInput())} onImported={archive.reload} grouped
            onShowImported={() => setShowImported(true)} importedHint={archive.view.statements.length ? text.historyStatus(archive.view.statements.length) : text.historyNone} />
        </div>
      </header>
      {customers.failed && <StateView kind="error" compact message={text.partiesFailed} onRetry={customers.reload} />}
      <div className={partyId ? "cl-top has-party" : "cl-top"}>
        <CustomerCard customers={customers.customers} value={partyId} onChange={setPartyId} limit={data?.balanceLimit ?? null} closingBalance={data?.closingBalance ?? 0} />
        {partyId && data && <BalanceHero closingBalance={data.closingBalance} toDate={toDate} refreshing={refreshing} limit={data.balanceLimit} />}
        {partyId && !data && ledger.state.status !== "error" && <HeroSkeleton />}
      </div>
      {workspace()}
    </div>
  );
};
