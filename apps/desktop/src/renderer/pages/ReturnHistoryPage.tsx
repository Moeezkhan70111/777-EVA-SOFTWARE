import React, { useEffect, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { HistoryRow } from "../types/desktopApi";
import { copy } from "../config/copy";
import { formatDateTime, shiftIsoDate, toIsoDate } from "../utils/dates";

export const ReturnHistoryPage = () => {
  const api = useDesktopApi();
  const [dispatchHistory, setDispatchHistory] = useState<HistoryRow[]>([]);
  const [filteredHistory, setFilteredHistory] = useState<HistoryRow[]>([]);
  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState(toIsoDate());
  const [toDate, setToDate] = useState(toIsoDate());
  const [page, setPage] = useState(1);
  const pageSize = 50;

  /* Load dispatch history */
  useEffect(() => {
    const loadHistory = async () => {
      try {
        const result = await api.listDispatchHistory({
          search,
          fromDate,
          toDate: shiftIsoDate(toDate, 1),
          page,
          pageSize,
        });
        if (result && typeof result === "object" && "rows" in result) {
          setDispatchHistory(result.rows ?? []);
        }
      } catch (err) {
        console.error("Failed to load dispatch history:", err);
      }
    };

    void loadHistory();
  }, [api, search, fromDate, toDate, page]);

  /* Filter locally by search terms (all combinations) */
  useEffect(() => {
    const searchTerms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);

    const filtered = dispatchHistory.filter((row) => {
      if (searchTerms.length === 0) return true;
      const text = `${row.qrId || ""} ${row.article || ""} ${row.color || ""} ${row.size || ""}`.toLowerCase();
      return searchTerms.every((term) => text.includes(term));
    });

    setFilteredHistory(filtered);
  }, [dispatchHistory, search]);

  return (
    <div className="page-content">
      <h1 className="page-title">Return History</h1>

      {/* Search & Filters */}
      <div className="toolbar">
        <div className="search-wrap" style={{ flex: 1 }}>
          <svg className="search-icon" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
          </svg>
          <input
            type="text"
            placeholder="Search by QR, article, color, or size…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1 }}
          />
        </div>

        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
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
              <th>Returned At</th>
            </tr>
          </thead>
          <tbody>
            {filteredHistory.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ textAlign: "center", color: "var(--text-3)" }}>
                  No returns found
                </td>
              </tr>
            ) : (
              filteredHistory.map((row, idx) => (
                <tr key={idx}>
                  <td className="cell-mono">{row.qrId || "—"}</td>
                  <td>{row.article || "—"}</td>
                  <td>{row.color || "—"}</td>
                  <td>{row.size || "—"}</td>
                  <td className="cell-mono">
                    {formatDateTime(row.timestamp)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="pager">
        <div className="pager-info">
          Page {page} · Showing {filteredHistory.length} of {dispatchHistory.length} returns
        </div>
        <div>
          <button className="btn btn-secondary btn-sm" onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1}>
            ← Prev
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => setPage(page + 1)} style={{ marginLeft: "4px" }}>
            Next →
          </button>
        </div>
      </div>
    </div>
  );
};
