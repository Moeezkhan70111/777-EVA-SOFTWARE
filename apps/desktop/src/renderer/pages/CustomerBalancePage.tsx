import React, { useEffect, useMemo, useState } from "react";
import type { AppRoute } from "../app/routes";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { PartyGroup } from "../types/desktopApi";
import { copy } from "../config/copy";
import { formatDate, toIsoDate } from "../utils/dates";

interface CustomerBalanceRow {
  partyId: string;
  partyName: string;
  city: string | null;
  balance: number;
  lastVoucherDate: string | null;
  totalSales: number;
  totalReceipts: number;
  totalPayments: number;
  groupName?: string | null;
}

export const CustomerBalancePage: React.FC<{ onNavigate: (route: AppRoute) => void }> = ({
  onNavigate,
}) => {
  const api = useDesktopApi();

  const [rows,        setRows]        = useState<CustomerBalanceRow[]>([]);
  const [groups,      setGroups]      = useState<PartyGroup[]>([]);
  const [asOfDate,    setAsOfDate]    = useState(toIsoDate());
  const [groupFilter, setGroupFilter] = useState("");   // "" = all
  const [search,      setSearch]      = useState("");
  const [loading,     setLoading]     = useState(false);

  // Load party groups once
  useEffect(() => {
    void (async () => {
      const result = await api.listPartyGroups();
      setGroups(result.filter((g) => g.isActive));
    })();
  }, [api]);

  const loadBalances = async () => {
    setLoading(true);
    try {
      const result = await api.listCustomerBalances({ asOfDate });
      setRows(result.rows);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadBalances(); }, [asOfDate]);

  // Client-side filter by group and search
  const filtered = useMemo(() => {
    let data = rows;
    if (groupFilter) {
      const gName = groups.find((g) => g.id === groupFilter)?.groupName ?? "";
      data = data.filter((r) => (r.groupName ?? "") === gName);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      data = data.filter(
        (r) =>
          r.partyName.toLowerCase().includes(q) ||
          (r.city ?? "").toLowerCase().includes(q),
      );
    }
    return data;
  }, [rows, groupFilter, search, groups]);

  const totalOutstanding = useMemo(
    () => filtered.reduce((sum, row) => sum + row.balance, 0),
    [filtered],
  );
  const totalSales = useMemo(
    () => filtered.reduce((sum, row) => sum + row.totalSales, 0),
    [filtered],
  );
  const totalReceipts = useMemo(
    () => filtered.reduce((sum, row) => sum + (row.totalReceipts ?? 0), 0),
    [filtered],
  );

  return (
    <div className="page customer-balance-page">
      <div className="page-header">
        <h1>Customer Balance</h1>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onNavigate("customer-ledger")}
        >
          Open Ledger
        </button>
      </div>

      {/* ── FILTERS ── */}
      <div
        className="filter-bar"
        style={{ display: "flex", gap: "12px", alignItems: "end", flexWrap: "wrap" }}
      >
        <div className="form-group">
          <label htmlFor="cb-date">Balance till</label>
          <input
            id="cb-date"
            type="date"
            className="form-input"
            value={asOfDate}
            onChange={(e) => setAsOfDate(e.target.value)}
          />
        </div>

        <div className="form-group" style={{ minWidth: 180 }}>
          <label htmlFor="cb-group">Group</label>
          <select
            id="cb-group"
            className="form-input"
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
          >
            <option value="">All Groups</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.groupName}
              </option>
            ))}
          </select>
        </div>

        <div className="form-group" style={{ minWidth: 200 }}>
          <label htmlFor="cb-search">{copy.actions.search}</label>
          <input
            id="cb-search"
            type="text"
            className="form-input"
            placeholder="Name or city…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* ── SUMMARY ── */}
      <div
        style={{
          margin: "18px 0",
          padding: "18px 24px",
          borderRadius: "18px",
          boxShadow: "6px 8px 18px rgba(166, 180, 200, 0.45), -5px -5px 12px var(--white), inset 3px 3px 6px var(--glass-85), inset -3px -3px 6px rgba(166, 180, 200, 0.3)",
          display: "flex",
          justifyContent: "space-between",
          gap: "18px",
        }}
      >
        <div>
          <div style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--chrome-muted)", fontWeight: 700 }}>
            {groupFilter
              ? `Group: ${groups.find((g) => g.id === groupFilter)?.groupName ?? ""}`
              : "All Customers"}
          </div>
          <div style={{ fontSize: "20px", fontWeight: 800, color: "var(--chrome-ink)", marginTop: "2px" }}>
            {filtered.length} customer{filtered.length !== 1 ? "s" : ""}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--chrome-muted)", fontWeight: 700 }}>
            Total Sales
          </div>
          <div style={{ fontSize: "18px", fontWeight: 800, color: "var(--chrome-link)", marginTop: "2px" }}>
            PKR {totalSales.toFixed(0)}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--chrome-muted)", fontWeight: 700 }}>
            Total Receipts
          </div>
          <div style={{ fontSize: "18px", fontWeight: 800, color: "var(--ok)", marginTop: "2px" }}>
            PKR {totalReceipts.toFixed(0)}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--chrome-muted)", fontWeight: 700 }}>
            Outstanding as of {asOfDate}
          </div>
          <div
            style={{
              fontSize: "26px",
              fontWeight: 800,
              color: totalOutstanding >= 0 ? "#0f766e" : "var(--err)",
              marginTop: "2px",
            }}
          >
            PKR {totalOutstanding.toFixed(0)}
          </div>
        </div>
      </div>

      {/* ── TABLE ── */}
      <div className="table-container">
        {loading ? (
          <div className="loading">Loading balances…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">No customer balances found.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{copy.columns.customer}</th>
                <th>Group</th>
                <th>{copy.columns.city}</th>
                <th style={{ textAlign: "right" }}>Last Activity</th>
                <th style={{ textAlign: "right" }}>Total Sales</th>
                <th style={{ textAlign: "right" }}>Cash Receipts</th>
                <th style={{ textAlign: "right" }}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, idx) => (
                <tr key={row.partyId}>
                  <td style={{ color: "#9ca3af", fontSize: "11px" }}>{idx + 1}</td>
                  <td style={{ fontWeight: 600 }}>{row.partyName}</td>
                  <td style={{ fontSize: "11px", color: "var(--text-3)" }}>
                    {row.groupName ? (
                      <span style={{ background: "#ede9fe", color: "#5b21b6", padding: "1px 7px", borderRadius: "4px", fontWeight: 600, fontSize: "11px" }}>
                        {row.groupName}
                      </span>
                    ) : <span style={{ color: "#d1d5db" }}>—</span>}
                  </td>
                  <td style={{ fontSize: "12px" }}>{row.city || "—"}</td>
                  <td style={{ textAlign: "right", fontSize: "12px" }}>
                    {formatDate(row.lastVoucherDate)}
                  </td>
                  <td style={{ textAlign: "right", color: "var(--accent-strong)" }}>{row.totalSales.toFixed(0)}</td>
                  <td style={{ textAlign: "right", color: "#15803d" }}>
                    {(row.totalReceipts ?? 0) > 0 ? `${(row.totalReceipts ?? 0).toFixed(0)}` : "—"}
                  </td>
                  <td style={{ textAlign: "right", fontWeight: 700, color: row.balance >= 0 ? "#0f766e" : "var(--danger-strong)" }}>
                    {row.balance.toFixed(0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
