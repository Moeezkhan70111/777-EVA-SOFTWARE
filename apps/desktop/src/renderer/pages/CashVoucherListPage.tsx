import React, { useCallback, useEffect, useState } from "react";
import type { AppRoute } from "../app/routes";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { CashVoucher } from "../types/desktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { copy } from "../config/copy";
import { formatBookDate } from "../utils/dates";
import { formatWholeMoney } from "../app/format";

interface CashVoucherListPageProps {
  onNavigate: (route: AppRoute, id?: string) => void;
}

const fmtDate = formatBookDate;
const fmtNum = formatWholeMoney;

export const CashVoucherListPage: React.FC<CashVoucherListPageProps> = ({ onNavigate }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [rows, setRows] = useState<CashVoucher[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  const PAGE_SIZE = 20;

  const load = useCallback(async (p = 1, q = search) => {
    setLoading(true);
    try {
      const result = await api.listCashVouchers({ search: q, page: p, pageSize: PAGE_SIZE });
      setRows(result.rows);
      setTotal(result.total);
      setPage(p);
    } catch {
      push("error", copy.toast.error, "Failed to load cash vouchers");
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => { void load(1, ""); }, []);

  const handleSearch = (val: string) => {
    setSearch(val);
    void load(1, val);
  };

  const totalReceipts = rows.reduce((s, r) => s + r.receiptAmount, 0);
  const totalPayments = rows.reduce((s, r) => s + r.paymentAmount, 0);
  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="page cash-voucher-list-page">
      {/* ── Header ── */}
      <div className="page-header">
        <h1>Cash Vouchers</h1>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onNavigate("cash-voucher-form")}
        >
          + New Cash Voucher
        </button>
      </div>

      {/* ── Summary Cards ── */}
      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        <div className="kpi-card ok">
          <div className="kpi-label">Total Receipts</div>
          <div className="kpi-value" style={{ color: "var(--ok)" }}>Rs. {fmtNum(totalReceipts)}</div>
        </div>
        <div className="kpi-card warn">
          <div className="kpi-label">Total Payments</div>
          <div className="kpi-value" style={{ color: "var(--err)" }}>Rs. {fmtNum(totalPayments)}</div>
        </div>
        <div className="kpi-card accent">
          <div className="kpi-label">Net Balance</div>
          <div className="kpi-value" style={{ color: "var(--primary-blue)" }}>Rs. {fmtNum(totalReceipts - totalPayments)}</div>
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className="toolbar">
        <input
          type="text"
          placeholder="Search by party or description…"
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
          style={{ minWidth: 320 }}
        />
        <span className="flex-1" />
        <span className="text-muted text-small">
          {total} voucher{total !== 1 ? "s" : ""}
        </span>
      </div>

      {/* ── Table ── */}
      <div className="table-wrap">
        {loading ? (
          <div className="empty-state">{copy.common.loading}</div>
        ) : rows.length === 0 ? (
          <div className="empty-state">
            <div style={{ fontSize: "36px", marginBottom: "8px" }}>💵</div>
            No cash vouchers found.{" "}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => onNavigate("cash-voucher-form")}
              style={{ display: "inline-block", marginLeft: 4 }}
            >
              Create one
            </button>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{copy.columns.date}</th>
                <th>{copy.columns.party}</th>
                <th>{copy.columns.description}</th>
                <th style={{ textAlign: "right" }}>Receipt (Rs.)</th>
                <th style={{ textAlign: "right" }}>Payment (Rs.)</th>
                <th>{copy.columns.type}</th>
                <th>{copy.columns.actions}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isReceipt = row.receiptAmount > 0;
                return (
                  <tr key={row.id}>
                    <td><strong>{row.voucherNumber}</strong></td>
                    <td>{fmtDate(row.voucherDate)}</td>
                    <td><strong style={{ color: "var(--text)" }}>{row.partyName}</strong></td>
                    <td style={{ color: "var(--text-2)" }}>{row.description}</td>
                    <td style={{ textAlign: "right", color: "var(--ok)", fontWeight: isReceipt ? 700 : 500 }}>
                      {isReceipt ? `Rs. ${fmtNum(row.receiptAmount)}` : "—"}
                    </td>
                    <td style={{ textAlign: "right", color: "var(--err)", fontWeight: !isReceipt ? 700 : 500 }}>
                      {!isReceipt ? `Rs. ${fmtNum(row.paymentAmount)}` : "—"}
                    </td>
                    <td>
                      <span className={`badge ${isReceipt ? "badge-ok" : "badge-err"}`}>
                        {isReceipt ? "RECEIPT" : "PAYMENT"}
                      </span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => onNavigate("cash-voucher-form", row.id)}
                      >{copy.actions.edit}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div className="pager" style={{ marginTop: 16 }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={page <= 1}
            onClick={() => void load(page - 1)}
          >
            ‹ Prev
          </button>
          <span className="page-info">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={page >= totalPages}
            onClick={() => void load(page + 1)}
          >
            Next ›
          </button>
        </div>
      )}
    </div>
  );
};
