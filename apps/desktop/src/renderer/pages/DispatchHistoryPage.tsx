import React, { useEffect, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { HistoryRow } from "../types/desktopApi";
import { toLocal } from "../app/format";
import { formatDate, shiftIsoDate, toIsoDate } from "../utils/dates";
import { copy } from "../config/copy";

const PAGE_SIZE = 50;

export const DispatchHistoryPage = () => {
  const api = useDesktopApi();
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState(toIsoDate());
  const [sortOrder, setSortOrder] = useState("DESC");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  const load = async (p = page) => {
    const res = await api.listDispatchHistory({
      search: search || undefined,
      fromDate: fromDate || undefined,
      toDate: toDate ? shiftIsoDate(toDate, 1) : undefined,
      sortBy: "event_ts_local",
      sortOrder,
      page: p,
      pageSize: PAGE_SIZE,
    });

    const filtered = search
      ? res.rows.filter((r) => `${r.qrId} ${r.article} ${r.color} ${r.size}`.toLowerCase().includes(search.toLowerCase()))
      : res.rows;

    setRows(filtered);
    setTotal(filtered.length);
  };

  useEffect(() => {
    void load(page);
  }, [page, search, fromDate, toDate, sortOrder]);

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="search-wrap" style={{ flex: 1, maxWidth: 320 }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search QR, article, color, size…" style={{ width: "100%" }} />
        </div>
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        <select value={sortOrder} onChange={(e) => setSortOrder(e.target.value)}>
          <option value="DESC">Newest First</option>
          <option value="ASC">Oldest First</option>
        </select>
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <p className="card-eyebrow">Audit Trail</p>
            <h3 className="card-title mb-0">Dispatch History</h3>
          </div>
          <span className="badge badge-ok">{total} Total</span>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>QR ID</th>
                <th>{copy.columns.article}</th>
                <th>{copy.columns.color}</th>
                <th>{copy.columns.size}</th>
                <th>Dispatch Date</th>
                <th>Dispatch Time</th>
                <th>{copy.columns.operator}</th>
                <th>Device</th>
                <th>Factory</th>
                <th>{copy.columns.status}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={10} className="empty-state">No dispatch records found</td></tr>
              ) : rows.map((r) => (
                <tr key={`${r.qrId}-${r.timestamp}`}>
                  <td className="cell-mono">{r.qrId}</td>
                  <td>{r.article}</td>
                  <td>{r.color}</td>
                  <td>{r.size}</td>
                  <td>{formatDate(r.timestamp)}</td>
                  <td>{toLocal(r.timestamp)}</td>
                  <td>{r.operator ?? "—"}</td>
                  <td>{r.device}</td>
                  <td>{r.factory}</td>
                  <td>{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="pagination" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 12 }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>Previous</button>
          <span className="text-muted">Page {page}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      </div>
    </div>
  );
};
