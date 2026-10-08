import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import type { Party, PurchaseVoucher, RawMaterialReceivingSession } from "../../types/desktopApi";
import type { AppRoute } from "../../app/routes";
import { SearchableCombobox } from "../../components/shared/SearchableCombobox";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { formatDate, formatDateTime, isoDateDaysAgo, toIsoDate } from "../../utils/dates";
import { formatWholeMoney } from "../../app/format";
import { openReceivingReceiptPrintWindow } from "./receivingReceipt";
import { downloadCsv, exportFileName } from "../../utils/exportFile";
import { buildPurchaseLinesSheet } from "./rawMaterialExports";
import { formatQuantity } from "./rawMaterial";

// What came in — told twice, because it genuinely is two facts.
//
//   Purchase bills   what we bought and owe for      purchase_vouchers
//   Deliveries       what physically reached the     raw_material_receiving_sessions
//                    store, packet by packet
//
// They are deliberately NOT reconciled here, because the system does not reconcile them:
// createPurchaseVoucher writes no stock, and a receiving scan writes no money. Showing them
// side by side is the honest presentation; implying one balances the other would not be.

/** High enough to be "every delivery" for any realistic history, without rendering an unbounded table. */
const SESSION_LIST_LIMIT = 200;
type SessionStatusFilter = "ALL" | "OPEN" | "CLOSED";
const today = () => toIsoDate();
const monthAgo = () => {
  const date = new Date();
  date.setMonth(date.getMonth() - 1);
  return toIsoDate(date);
};
const fmtAmount = (value: number) => `Rs. ${formatWholeMoney(value)}`;

interface MaterialTotal {
  displayName: string;
  itemCode: string;
  unitCode: string | null;
  totalQty: number;
  totalAmount: number;
}

interface ReceiptsTabProps {
  /** The logged-in operator; printed on a reprinted voucher as who reprinted it. */
  username?: string;
  onNavigate: (route: AppRoute) => void;
}

export const ReceiptsTab: React.FC<ReceiptsTabProps> = ({ username, onNavigate }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [dateFrom, setDateFrom] = useState(monthAgo());
  const [dateTo, setDateTo] = useState(today());
  const [partyId, setPartyId] = useState("");
  const [search, setSearch] = useState("");

  const [parties, setParties] = useState<Party[]>([]);
  const [vouchers, setVouchers] = useState<PurchaseVoucher[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [sessions, setSessions] = useState<RawMaterialReceivingSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionStatus, setSessionStatus] = useState<SessionStatusFilter>("ALL");
  // The session open on THIS terminal right now, if any — kept separately from the (possibly
  // filtered) list below so "continue where you left off" always finds it regardless of the
  // date/status filters, and so a session open on a DIFFERENT terminal is never offered as
  // continuable here: a receiving session belongs to one device, and resuming it means
  // opening Raw Material Input on that same device.
  const [openSession, setOpenSession] = useState<RawMaterialReceivingSession | null>(null);

  useEffect(() => {
    void api
      .listParties({ pageSize: 500, status: "ACTIVE" })
      .then((result) => {
        const sorted = [...result.rows].sort((a, b) => {
          const aSupplier = a.partyType === "SUPPLIER" ? 0 : 1;
          const bSupplier = b.partyType === "SUPPLIER" ? 0 : 1;
          return aSupplier - bSupplier || a.partyName.localeCompare(b.partyName);
        });
        setParties(sorted);
      })
      .catch(() => setParties([]));
  }, [api]);

  const loadVouchers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listPurchaseVouchers({
        search: search || undefined,
        partyId: partyId || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        pageSize: 500,
        page: 1,
      });
      const details = await Promise.all(result.rows.map((row) => api.getPurchaseVoucher(row.id)));
      setVouchers(details.filter((voucher): voucher is PurchaseVoucher => voucher !== null));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.states.loadFailedBody);
    } finally {
      setLoading(false);
    }
  }, [api, search, partyId, dateFrom, dateTo]);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      setSessions(
        await api.listRawMaterialReceivingSessions({
          status: sessionStatus === "ALL" ? undefined : sessionStatus,
          partyId: partyId || undefined,
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
          limit: SESSION_LIST_LIMIT,
        })
      );
    } catch {
      setSessions([]);
    } finally {
      setSessionsLoading(false);
    }
  }, [api, sessionStatus, partyId, dateFrom, dateTo]);

  useEffect(() => {
    void loadVouchers();
  }, [loadVouchers]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (typeof api.getOpenRawMaterialReceivingSession !== "function") return;
    let cancelled = false;
    void api
      .getOpenRawMaterialReceivingSession()
      .then((result) => {
        if (!cancelled) setOpenSession(result);
      })
      .catch(() => {
        if (!cancelled) setOpenSession(null);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const materialTotals = useMemo<MaterialTotal[]>(() => {
    const byItem = new Map<string, MaterialTotal>();
    for (const voucher of vouchers) {
      for (const line of voucher.lineItems) {
        const existing = byItem.get(line.itemId);
        if (existing) {
          existing.totalQty += line.quantity;
          existing.totalAmount += line.totalPrice;
        } else {
          byItem.set(line.itemId, {
            displayName: line.displayName,
            itemCode: line.itemCode,
            unitCode: line.unitCode ?? null,
            totalQty: line.quantity,
            totalAmount: line.totalPrice,
          });
        }
      }
    }
    return Array.from(byItem.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [vouchers]);

  const grandTotal = useMemo(() => vouchers.reduce((sum, voucher) => sum + voucher.totalAmount, 0), [vouchers]);
  const grandQty = useMemo(() => vouchers.reduce((sum, voucher) => sum + voucher.totalQuantity, 0), [vouchers]);

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const printSession = async (session: RawMaterialReceivingSession) => {
    try {
      const summary = await api.getRawMaterialReceivingSessionSummary(session.id);
      if (!summary) {
        push("error", copy.toast.notFound, "That delivery could not be read.");
        return;
      }
      if (!openReceivingReceiptPrintWindow(summary, username)) {
        push("error", copy.toast.popupBlocked, "Allow popups to print the receipt");
      }
    } catch {
      push("error", copy.toast.failed, "That delivery could not be read.");
    }
  };

  // Raw Material Input auto-resumes whatever session is open on this terminal, so
  // "continuing" a session is just going there — nothing to pass, nothing to re-open.
  const continueSession = () => onNavigate("raw-material-input");

  const partyOptions = useMemo(
    () => parties.map((party) => ({ value: party.id, label: party.partyName })),
    [parties]
  );

  return (
    <div className="rm-receipts">
      {/* ── Filters ──────────────────────────────────────────────── */}
      <div className="rm-toolbar">
        <div className="form-group rm-toolbar-field">
          <label className="input-label" htmlFor="rm-date-from">
            From
          </label>
          <input
            id="rm-date-from"
            type="date"
            className="form-input"
            value={dateFrom}
            onChange={(event) => setDateFrom(event.target.value)}
          />
        </div>
        <div className="form-group rm-toolbar-field">
          <label className="input-label" htmlFor="rm-date-to">
            To
          </label>
          <input
            id="rm-date-to"
            type="date"
            className="form-input"
            value={dateTo}
            onChange={(event) => setDateTo(event.target.value)}
          />
        </div>

        <div className="form-group rm-toolbar-field rm-toolbar-field--wide">
          <span className="input-label">Supplier</span>
          <SearchableCombobox
            value={partyId}
            options={partyOptions}
            placeholder="All suppliers"
            emptyLabel="No suppliers found"
            ariaLabel="Filter by supplier"
            onChange={setPartyId}
          />
        </div>

        <div className="search-wrap rm-search">
          <svg className="search-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path
              fillRule="evenodd"
              d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
              clipRule="evenodd"
            />
          </svg>
          <input
            value={search}
            aria-label="Search purchase bills"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Bill no., material, reference…"
          />
        </div>

        <div className="rm-toolbar-actions">
          {[
            { label: "This month", from: `${today().slice(0, 7)}-01`, to: today() },
            { label: "30 days", from: monthAgo(), to: today() },
            { label: "90 days", from: isoDateDaysAgo(90), to: today() },
            { label: "This year", from: `${today().slice(0, 4)}-01-01`, to: today() },
          ].map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="rm-chip"
              onClick={() => {
                setDateFrom(preset.from);
                setDateTo(preset.to);
              }}
            >
              {preset.label}
            </button>
          ))}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onNavigate("purchase-voucher-form")}>
            + New purchase bill
          </button>
        </div>
      </div>

      {/* ── Purchase bills ───────────────────────────────────────── */}
      <section className="rm-section">
        <div className="rm-section-head">
          <h2 className="rm-section-title">Purchase bills</h2>
          <span className="rm-section-note">What was bought and billed — money, not stock.</span>
          {vouchers.length > 0 ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm rm-section-action"
              onClick={() =>
                downloadCsv(exportFileName("raw-material-purchases"), buildPurchaseLinesSheet(vouchers, [
                  `Dates: ${dateFrom} to ${dateTo}`,
                  ...(partyId ? [`Supplier: ${parties.find((party) => party.id === partyId)?.partyName ?? ""}`] : []),
                  ...(search.trim() ? [`Search: ${search.trim()}`] : []),
                ]))
              }
            >
              Export bills (Excel)
            </button>
          ) : null}
        </div>

        {loading ? (
          <StateView kind="loading" message="Loading purchase bills…" />
        ) : error ? (
          <StateView kind="error" message={error} onRetry={() => void loadVouchers()} />
        ) : vouchers.length === 0 ? (
          <StateView
            kind="empty"
            title="No purchase bills in this range"
            hint="Widen the dates, clear the supplier, or enter a bill."
            action={{ label: "+ New purchase bill", onClick: () => onNavigate("purchase-voucher-form") }}
          />
        ) : (
          <>
            <div className="rm-kpis">
              <div className="rm-kpi">
                <span className="rm-kpi-label">Bills</span>
                <strong className="rm-kpi-value">{vouchers.length}</strong>
              </div>
              <div className="rm-kpi">
                <span className="rm-kpi-label">Total qty</span>
                <strong className="rm-kpi-value">{formatQuantity(grandQty)}</strong>
              </div>
              <div className="rm-kpi rm-kpi--eq">
                <span className="rm-kpi-label">Total amount</span>
                <strong className="rm-kpi-value">{fmtAmount(grandTotal)}</strong>
              </div>
              <div className="rm-kpi-spacer" />
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setExpanded(new Set(vouchers.map((v) => v.id)))}>
                Expand all
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setExpanded(new Set())}>
                Collapse all
              </button>
            </div>

            {materialTotals.length > 0 ? (
              <div className="rml-material-chips">
                {materialTotals.map((material) => (
                  <div key={material.itemCode} className="rml-material-chip">
                    <span className="rml-mat-name">{material.displayName}</span>
                    <span className="rml-mat-qty">
                      {formatQuantity(material.totalQty)}
                      {material.unitCode ? ` ${material.unitCode}` : ""}
                    </span>
                    <span className="rml-mat-amt">{fmtAmount(material.totalAmount)}</span>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="rml-ledger">
              {vouchers.map((voucher) => {
                const isOpen = expanded.has(voucher.id);
                return (
                  <div key={voucher.id} className={`rml-voucher-block${isOpen ? " rml-voucher-block--open" : ""}`}>
                    <button type="button" className="rml-voucher-header" onClick={() => toggle(voucher.id)} aria-expanded={isOpen}>
                      <span className="rml-chevron" aria-hidden="true">
                        {isOpen ? "▾" : "▸"}
                      </span>
                      <span className="rml-vno cell-mono">{voucher.voucherNumber}</span>
                      <span className="rml-vdate">{formatDate(voucher.voucherDate)}</span>
                      <span className="rml-vparty">{voucher.partyName}</span>
                      <span className="rml-vref">
                        {voucher.referenceNo ? (
                          <span className="cell-mono">{voucher.referenceNo}</span>
                        ) : (
                          <span className="rm-muted">—</span>
                        )}
                      </span>
                      <span className="rml-vqty rm-stock-qty">{formatQuantity(voucher.totalQuantity)}</span>
                      <span className="rml-vamt">{fmtAmount(voucher.totalAmount)}</span>
                    </button>

                    {isOpen ? (
                      <div className="rml-line-items">
                        <div className="rml-line-thead">
                          <span>Material</span>
                          <span>{copy.columns.code}</span>
                          <span className="rm-num">{copy.columns.qty}</span>
                          <span className="rm-num">Unit price</span>
                          <span className="rm-num">{copy.columns.total}</span>
                        </div>
                        {voucher.lineItems.map((line) => (
                          <div key={line.id} className="rml-line-row">
                            <span className="rml-line-name">{line.displayName}</span>
                            <span className="cell-mono rm-muted">{line.itemCode}</span>
                            <span className="rml-line-qty">
                              {formatQuantity(line.quantity)}
                              {line.unitCode ? <em className="rml-unit">{line.unitCode}</em> : null}
                            </span>
                            <span className="rml-line-num">{fmtAmount(line.unitPrice)}</span>
                            <span className="rml-line-num rml-line-total">{fmtAmount(line.totalPrice)}</span>
                          </div>
                        ))}
                        {voucher.remarks ? (
                          <div className="rml-line-remarks">
                            <span>Remarks: </span>
                            {voucher.remarks}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}

              <div className="rml-grand-footer">
                <span />
                <span />
                <span />
                <span className="rml-grand-label">Grand total</span>
                <span className="rml-grand-qty">{formatQuantity(grandQty)}</span>
                <span className="rml-grand-amount">{fmtAmount(grandTotal)}</span>
              </div>
            </div>
          </>
        )}
      </section>

      {/* ── Scanned deliveries ───────────────────────────────────── */}
      <section className="rm-section">
        <div className="rm-section-head">
          <h2 className="rm-section-title">Deliveries received</h2>
          <span className="rm-section-note">
            Every Raw Material Input session — what physically reached the store, scanned packet by packet.
          </span>
          <div className="rm-toolbar-actions rm-section-action">
            {(["ALL", "OPEN", "CLOSED"] as SessionStatusFilter[]).map((status) => (
              <button
                key={status}
                type="button"
                className={`rm-chip${sessionStatus === status ? " is-active" : ""}`}
                aria-pressed={sessionStatus === status}
                onClick={() => setSessionStatus(status)}
              >
                {status === "ALL" ? "All" : status === "OPEN" ? "Open" : "Closed"}
              </button>
            ))}
          </div>
        </div>

        {openSession ? (
          <div className="rm-resume-banner">
            <div>
              <strong>Session in progress on this terminal</strong>
              <span>
                {openSession.code} — {openSession.partyName}
              </span>
            </div>
            <button type="button" className="btn btn-sm btn-primary" onClick={continueSession}>
              Continue session
            </button>
          </div>
        ) : null}

        {sessionsLoading ? (
          <StateView kind="loading" compact message="Loading deliveries…" />
        ) : sessions.length === 0 ? (
          <StateView
            kind="empty"
            compact
            title="No deliveries in this range"
            hint="Widen the dates, clear the status filter, or scan one in on Raw Material Input."
          />
        ) : (
          <div className="table-container">
            <table className="data-table rm-table">
              <thead>
                <tr>
                  <th scope="col">Session</th>
                  <th scope="col">Supplier</th>
                  <th scope="col">Started</th>
                  <th scope="col">Closed</th>
                  <th scope="col">Received by</th>
                  <th scope="col">Status</th>
                  <th scope="col" aria-label={copy.columns.actions} />
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => {
                  const isOpenHere = openSession?.id === session.id;
                  return (
                    <tr key={session.id}>
                      <td className="cell-mono">{session.code}</td>
                      <td>
                        <strong>{session.partyName}</strong>
                      </td>
                      <td>{formatDateTime(session.startedAt)}</td>
                      <td>{session.closedAt ? formatDateTime(session.closedAt) : "—"}</td>
                      <td>{session.startedBy ?? "—"}</td>
                      <td>
                        <span className={`badge ${session.status === "OPEN" ? "badge-ok" : "badge-muted"}`}>
                          {session.status === "OPEN" ? "Open" : "Closed"}
                        </span>
                        {session.status === "OPEN" && !isOpenHere ? (
                          <span className="rm-section-note"> · another terminal</span>
                        ) : null}
                      </td>
                      <td className="rm-row-actions">
                        {isOpenHere ? (
                          <button type="button" className="btn btn-sm btn-primary" onClick={continueSession}>
                            Continue
                          </button>
                        ) : null}
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => void printSession(session)}>
                          🖨 Receipt
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
