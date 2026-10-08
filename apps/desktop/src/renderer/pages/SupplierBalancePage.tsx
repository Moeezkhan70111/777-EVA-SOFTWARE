import React, { useEffect, useMemo, useState } from "react";
import type { AppRoute } from "../app/routes";
import { useDesktopApi } from "../hooks/useDesktopApi";
import { copy } from "../config/copy";
import { formatDate, toIsoDate } from "../utils/dates";

interface SupplierBalanceRow {
  partyId: string;
  partyName: string;
  city: string | null;
  balance: number;
  lastVoucherDate: string | null;
  totalPurchases: number;
  totalPayments: number;
}

export const SupplierBalancePage: React.FC<{ onNavigate: (route: AppRoute) => void }> = ({ onNavigate }) => {
  const api = useDesktopApi();
  const [rows, setRows] = useState<SupplierBalanceRow[]>([]);
  const [asOfDate, setAsOfDate] = useState(toIsoDate());
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  const loadBalances = async () => {
    setLoading(true);
    try {
      const result = await api.listSupplierBalances({ asOfDate });
      setRows(result.rows);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadBalances(); }, [asOfDate]);

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.trim().toLowerCase();
    return rows.filter((r) => r.partyName.toLowerCase().includes(q) || (r.city ?? "").toLowerCase().includes(q));
  }, [rows, search]);

  const totalOutstanding = useMemo(() => filtered.reduce((sum, row) => sum + row.balance, 0), [filtered]);
  const totalPurchases = useMemo(() => filtered.reduce((sum, row) => sum + row.totalPurchases, 0), [filtered]);
  const totalPayments = useMemo(() => filtered.reduce((sum, row) => sum + row.totalPayments, 0), [filtered]);

  return (
    <div className="page customer-balance-page">
      <div className="page-header">
        <h1>Supplier Balance</h1>
        <button type="button" className="btn btn-primary" onClick={() => onNavigate("supplier-ledger")}>
          Open Ledger
        </button>
      </div>

      <div className="filter-bar" style={{ display: "flex", gap: "12px", alignItems: "end", flexWrap: "wrap" }}>
        <div className="form-group">
          <label htmlFor="sb-date">Balance till</label>
          <input id="sb-date" type="date" className="form-input" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
        </div>
        <div className="form-group" style={{ minWidth: 200 }}>
          <label htmlFor="sb-search">{copy.actions.search}</label>
          <input id="sb-search" type="text" className="form-input" placeholder="Name or city…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      <div style={{ margin: "18px 0", padding: "18px 24px", borderRadius: "18px", boxShadow: "6px 8px 18px rgba(166, 180, 200, 0.45), -5px -5px 12px var(--white), inset 3px 3px 6px var(--glass-85), inset -3px -3px 6px rgba(166, 180, 200, 0.3)", display: "flex", justifyContent: "space-between", gap: "18px" }}>
        <div>
          <div style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--chrome-muted)", fontWeight: 700 }}>All Suppliers</div>
          <div style={{ fontSize: "20px", fontWeight: 800, color: "var(--chrome-ink)", marginTop: "2px" }}>{filtered.length} supplier{filtered.length !== 1 ? "s" : ""}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--chrome-muted)", fontWeight: 700 }}>Total Purchases</div>
          <div style={{ fontSize: "18px", fontWeight: 800, color: "var(--err)", marginTop: "2px" }}>PKR {totalPurchases.toFixed(0)}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--chrome-muted)", fontWeight: 700 }}>Total Payments</div>
          <div style={{ fontSize: "18px", fontWeight: 800, color: "var(--ok)", marginTop: "2px" }}>PKR {totalPayments.toFixed(0)}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--chrome-muted)", fontWeight: 700 }}>Payable as of {asOfDate}</div>
          <div style={{ fontSize: "26px", fontWeight: 800, color: totalOutstanding >= 0 ? "var(--danger-strong)" : "#0f766e", marginTop: "2px" }}>PKR {totalOutstanding.toFixed(0)}</div>
        </div>
      </div>

      <div className="table-container">
        {loading ? (
          <div className="loading">Loading balances…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">No supplier balances found.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{copy.columns.supplier}</th>
                <th>{copy.columns.city}</th>
                <th style={{ textAlign: "right" }}>Last Activity</th>
                <th style={{ textAlign: "right" }}>Total Purchases</th>
                <th style={{ textAlign: "right" }}>Payments</th>
                <th style={{ textAlign: "right" }}>Balance (Owed)</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, idx) => (
                <tr key={row.partyId} style={{ cursor: "pointer" }} onClick={() => onNavigate("supplier-ledger")}>
                  <td style={{ color: "#9ca3af", fontSize: "11px" }}>{idx + 1}</td>
                  <td style={{ fontWeight: 600 }}>{row.partyName}</td>
                  <td style={{ fontSize: "12px" }}>{row.city || "—"}</td>
                  <td style={{ textAlign: "right", fontSize: "12px" }}>{formatDate(row.lastVoucherDate)}</td>
                  <td style={{ textAlign: "right" }}>{row.totalPurchases.toFixed(0)}</td>
                  <td style={{ textAlign: "right" }}>{row.totalPayments.toFixed(0)}</td>
                  <td style={{ textAlign: "right", fontWeight: 700, color: row.balance >= 0 ? "var(--danger-strong)" : "#0f766e" }}>{row.balance.toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
