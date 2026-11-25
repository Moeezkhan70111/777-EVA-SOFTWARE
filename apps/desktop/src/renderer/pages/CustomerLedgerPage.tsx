import React, { useState } from "react";
import { LEDGER_SIDE } from "@erp/domain";
import type { AppRoute } from "../app/routes";
import { StateView } from "../components/shared/StateView";
import { copy } from "../config/copy";
import { useDesktopApi } from "../hooks/useDesktopApi";
import { useTodayFollowingDate } from "../hooks/useTodayFollowingDate";
import type { CashVoucher, SaleVoucher } from "../types/desktopApi";
import { toIsoDate } from "../utils/dates";
import { withViewTransition } from "../utils/withViewTransition";
import { BalanceHero } from "../features/customerLedger/BalanceHero";
import { CustomerCard } from "../features/customerLedger/CustomerCard";
import { HeroSkeleton, WorkspaceSkeleton } from "../features/customerLedger/LedgerSkeleton";
import { importedSums, ledgerTotals, periodSum } from "../features/customerLedger/ledgerFigures";
import { DEFAULT_LEDGER_PERIOD, periodStart } from "../features/customerLedger/ledgerPeriods";
import { typeLabel } from "../features/customerLedger/LedgerRows";
import { LedgerTab } from "../features/customerLedger/LedgerTab";
import { opensVoucher, type LedgerEntry, type LedgerType } from "../features/customerLedger/ledgerTypes";
import { PeriodBar } from "../features/customerLedger/PeriodBar";
import { StatementsTab } from "../features/customerLedger/StatementsTab";
import { SummaryTab } from "../features/customerLedger/SummaryTab";
import { useCustomerLedger, useLedgerCustomers } from "../features/customerLedger/useCustomerLedger";
import { useLedgerView } from "../features/customerLedger/useLedgerView";
import { VoucherDetail } from "../features/customerLedger/VoucherDetail";
import { LedgerHistoryActions } from "../features/ledgerArchive/LedgerHistoryActions";
import { useLedgerArchive } from "../features/ledgerArchive/useLedgerArchive";
import { useLedgerDownloads } from "../features/ledgerArchive/useLedgerDownloads";
import { ledgerExportRows } from "../features/ledgerArchive/unifiedLedger";

// CUSTOMER LEDGER (docs/50): one customer's bills, returns, cash and the old software's history, in one ledger.
//
//   [ Customer ▾ ]  Balance limit ███████░░ 70% used        ┌ CURRENT BALANCE ───────────┐
//                                                            │ Rs. 40,000    ↓ Receivable  │
//   Ledger | Summary | Statement     [This month][3 months][This year][All time]  from – to
//   Brought forward  + Debit  − Credit  = Balance
//
// ONE LEDGER (owner, 25 Nov 2026: "there is no old and new, both are real values"): an imported ledger is part of the
// customer's ledger. The balance on any day is the imported ledger's balance on its last line up to then plus every ERP
// entry up to then, worked out by the main process (customerOldLedgerPaisaSql); nothing is carried in or posted.

const text = copy.customerLedger;
const TABS = ["LEDGER", "SUMMARY", "STATEMENT"] as const;
type LedgerTabName = (typeof TABS)[number];
const SIDE = LEDGER_SIDE.CUSTOMER;

interface CustomerLedgerPageProps { onNavigate: (route: AppRoute, id?: string) => void; }

export const CustomerLedgerPage: React.FC<CustomerLedgerPageProps> = ({ onNavigate }) => {
  const api = useDesktopApi();
  const customers = useLedgerCustomers();
  const [partyId, setPartyId] = useState("");
  const [fromDate, setFromDate] = useState(() => periodStart(DEFAULT_LEDGER_PERIOD, toIsoDate()));
  const [toDate, setToDate] = useTodayFollowingDate();
  const [tab, setTab] = useState<LedgerTabName>("LEDGER");
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
  const chooseTab = (next: LedgerTabName) => withViewTransition(() => setTab(next));
  // One ledger: the download's brought forward is the screen's, worked over the ERP's entries and the imported rows.
  const broughtForward = () => (data ? periodSum(data.closingBalance, ledgerTotals(data.entries), importedSums(archive.view.entries)).broughtForward : 0);
  const downloadInput = () => ({ side: SIDE, customerName: partyName || "Customer", customerCode: party?.partyCode ?? "", fromDate, toDate, liveOpening: broughtForward(), liveClosing: data?.closingBalance ?? 0, merged: true, rows: ledgerExportRows(view.timeline, (type) => typeLabel(type as LedgerType)) });

  const workspace = () => {
    if (!partyId) return <StateView kind="empty" title={text.chooseTitle} hint={text.chooseHint} />;
    if (ledger.state.status === "error") return <StateView kind="error" message={text.failed} onRetry={ledger.reload} />;
    if (!data) return <WorkspaceSkeleton />;
    const totalReceipts = data.entries.filter((entry) => entry.voucherType === "CASH_RECEIPT").reduce((sum, entry) => sum + entry.creditAmount, 0);
    const totalPayments = data.entries.filter((entry) => entry.voucherType === "CASH_PAYMENT").reduce((sum, entry) => sum + entry.debitAmount, 0);
    return (
      <section className="cl-workspace card">
        <div className="cl-workspace-head">
          <div className="cl-tabs" role="tablist" aria-label={text.tabsLabel}>
            {TABS.map((name) => <button key={name} type="button" role="tab" aria-selected={tab === name} className={tab === name ? "cl-tab is-on" : "cl-tab"} onClick={() => chooseTab(name)}>{text.tabs[name]}</button>)}
          </div>
          <PeriodBar fromDate={fromDate} toDate={toDate} onFrom={setFromDate} onTo={setToDate} />
        </div>
        <div className="cl-tab-body" role="tabpanel" aria-label={text.tabs[tab]}>
          {tab === "LEDGER" && <LedgerTab data={data} view={view} archive={archive} fromDate={fromDate} toDate={toDate} resetKey={`${partyId}|${fromDate}|${toDate}`} refreshing={refreshing} onOpen={(entry) => void openVoucher(entry)} />}
          {tab === "SUMMARY" && <SummaryTab entries={data.entries} openingBalance={data.openingBalance} closingBalance={data.closingBalance} totalReceipts={totalReceipts} totalPayments={totalPayments} fromDate={fromDate} toDate={toDate} selectedPartyId={partyId} loading={false} />}
          {tab === "STATEMENT" && <StatementsTab entries={data.entries} openingBalance={data.openingBalance} closingBalance={data.closingBalance} partyName={partyName} party={party} fromDate={fromDate} toDate={toDate} selectedPartyId={partyId} loading={false} balanceLimit={data.balanceLimit} />}
        </div>
      </section>
    );
  };

  return (
    <div className="page customer-ledger-page doc-themed cl-page">
      {detail && <VoucherDetail voucher={detail.voucher} type={detail.type} onClose={() => setDetail(null)} onEdit={editVoucher} />}
      <header className="cl-head">
        <div className="cl-head-title">
          <button type="button" className="customer-ledger-back" onClick={() => onNavigate("customer-balance")}>‹ <span>{text.back}</span></button>
          <h1>{text.title}</h1>
        </div>
        <div className="cl-head-actions">
          <LedgerHistoryActions side={SIDE} parties={customers.customers} noParty={!partyId} making={downloads.making} onDownloadExcel={() => downloads.downloadExcel(downloadInput())} onDownloadPdf={() => void downloads.downloadPdf(downloadInput())} onImported={archive.reload} grouped />
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
