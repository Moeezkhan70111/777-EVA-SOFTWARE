import React, { useEffect, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { HistoryRow } from "../types/desktopApi";
import { toLocal } from "../app/format";
import { copy } from "../config/copy";

const PAGE_SIZE = 50;

const STATUS_BADGE: Record<string, string> = {
  ACCEPTED: "badge-ok",
  REJECTED: "badge-err",
  DUPLICATE: "badge-warn",
};

export const HistoryPage = () => {
  const api = useDesktopApi();
  const [rows, setRows]       = useState<HistoryRow[]>([]);
  const [search, setSearch]   = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate]   = useState("");
  const [sortBy, setSortBy]   = useState("event_ts_local");
  const [sortOrder, setSortOrder] = useState("DESC");
  const [page, setPage]       = useState(1);
  const [total, setTotal]     = useState(0);

  const load = async () => {
    const res = await api.listHistory({
      search,
      fromDate: fromDate || undefined,
      toDate:   toDate   || undefined,
      sortBy,
      sortOrder,
      page,
      pageSize: PAGE_SIZE,
    });
    setRows(res.rows);
    setTotal(res.total);
  };

  useEffect(() => { void load(); }, [page]);

  const applyFilters = () => { setPage(1); void load(); };
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="stack">
      {/* Filters */}
      <div className="toolbar">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && applyFilters()}
          placeholder="Search QR, article, color…"
          style={{ minWidth: 200 }}
        />
        <input
          type="date"
          value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
          title={copy.filters.fromDate}
        />
        <input
          type="date"
          value={toDate}
          onChange={(e) => setToDate(e.target.value)}
          title={copy.filters.toDate}
        />
        <div className="toolbar-sep" />
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
          <option value="event_ts_local">{copy.columns.timestamp}</option>
          <option value="article_snapshot">{copy.columns.article}</option>
          <option value="color_snapshot">{copy.columns.color}</option>
          <option value="size_snapshot">{copy.columns.size}</option>
        </select>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setSortOrder((v) => (v === "DESC" ? "ASC" : "DESC"))}
        >
          {sortOrder === "DESC" ? "↓ Newest" : "↑ Oldest"}
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={applyFilters}>{copy.actions.apply}</button>
        <span className="flex-1" />
        <span className="text-muted text-small">{total} records</span>
      </div>

      {/* Table */}
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>QR ID</th>
              <th>{copy.columns.article}</th>
              <th>{copy.columns.color}</th>
              <th>{copy.columns.size}</th>
              <th>{copy.columns.timestamp}</th>
              <th>{copy.columns.operator}</th>
              <th>Device</th>
              <th>Factory</th>
              <th>{copy.columns.status}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={9} className="empty-state">No history records found</td></tr>
            ) : rows.map((r) => (
              <tr key={`${r.qrId}-${r.timestamp}`}>
                <td className="cell-mono">{r.qrId}</td>
                <td><strong>{r.article}</strong></td>
                <td>{r.color}</td>
                <td><span className="tag">{r.size}</span></td>
                <td className="text-muted text-small">{toLocal(r.timestamp)}</td>
                <td className="text-muted">{r.operator ?? "—"}</td>
                <td className="text-muted text-small">{r.device}</td>
                <td className="text-muted text-small">{r.factory}</td>
                <td>
                  <span className={`badge ${STATUS_BADGE[r.status] ?? "badge-muted"}`}>
                    {r.status.toLowerCase()}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pager */}
      <div className="pager">
        <span className="pager-info">
          Page {page} of {pageCount} · {total} total records
        </span>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          ← Prev
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={page >= pageCount}
          onClick={() => setPage((p) => p + 1)}
        >
          Next →
        </button>
      </div>
    </div>
  );
};
