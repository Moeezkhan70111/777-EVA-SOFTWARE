import React, { useEffect, useMemo, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { HistoryRow } from "../types/desktopApi";
import { formatDate, formatDateTime } from "../app/format";
import { shiftIsoDate, toIsoDate } from "../utils/dates";
import { useNotifications } from "../state/NotificationsContext";
import { copy } from "../config/copy";
import { downloadCsv, exportFileName } from "../utils/exportFile";
import { openPrintDocument } from "../platform/print";
import { escapeHtml } from "../utils/html";

const PAGE_SIZE = 50;

/* ── Build summary: article → size → color → qty ─────── */
interface ColorEntry   { color: string; qty: number; }
interface SizeGroup    { size: string; total: number; colors: ColorEntry[]; }
interface ArticleGroup { article: string; total: number; sizes: SizeGroup[]; }

function buildSummary(rows: HistoryRow[]): ArticleGroup[] {
  const map = new Map<string, Map<string, Map<string, number>>>();
  for (const r of rows) {
    if (!map.has(r.article)) map.set(r.article, new Map());
    const sm = map.get(r.article)!;
    if (!sm.has(r.size)) sm.set(r.size, new Map());
    const cm = sm.get(r.size)!;
    cm.set(r.color, (cm.get(r.color) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([article, sm]) => {
      let articleTotal = 0;
      const sizes = [...sm.entries()].map(([size, cm]) => {
        const colors = [...cm.entries()]
          .map(([color, qty]) => ({ color, qty }))
          .sort((a, b) => b.qty - a.qty);
        const total = colors.reduce((s, c) => s + c.qty, 0);
        articleTotal += total;
        return { size, total, colors };
      }).sort((a, b) => a.size.localeCompare(b.size));
      return { article, total: articleTotal, sizes };
    })
    .sort((a, b) => a.article.localeCompare(b.article));
}

/* ══════════════════════════════════════════════════════
   SUMMARY VIEW - Clean, minimal, easy to read
══════════════════════════════════════════════════════ */
const SummaryView = ({ rows, expandAll, articleImages }: { rows: HistoryRow[]; expandAll: boolean; articleImages: Record<string, string> }) => {
  const groups = useMemo(() => buildSummary(rows), [rows]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Auto-expand all when expandAll prop changes
  useEffect(() => {
    if (expandAll && groups.length > 0) {
      const allKeys = new Set<string>();
      for (const g of groups) {
        for (const s of g.sizes) {
          allKeys.add(`${g.article}__${s.size}`);
        }
      }
      setExpanded(allKeys);
    } else if (!expandAll) {
      setExpanded(new Set());
    }
  }, [expandAll, groups]);

  const toggle = (key: string) =>
    setExpanded((p) => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; });

  if (groups.length === 0)
    return <div className="history-empty-state">No records found</div>;

  const grandTotal = groups.reduce((s, g) => s + g.total, 0);

  return (
    <div className="history-summary-panel">
      <div className="history-summary-head"><span>Summary</span><span>Details</span><span aria-hidden="true">◈</span></div>
      {groups.map((g, gIdx) => (
        <div key={g.article} className="history-article-group">
          {gIdx > 0 && <div className="history-group-divider" />}
          
          {/* Article header */}
          <div className="history-article-header"><span>{g.article}</span><strong>{g.total.toLocaleString()}</strong></div>

          {/* Size rows */}
          {g.sizes.map((s) => {
            const key = `${g.article}__${s.size}`;
            const isOpen = expanded.has(key);
            return (
              <div key={key}>
                {/* Size row */}
                <div onClick={() => toggle(key)} className={`history-size-row${isOpen ? " is-open" : ""}`}>
                  <span className={`history-chevron${isOpen ? " is-open" : ""}`}>▶</span>
                  <div className="history-size-identity"><div className="history-product-image">{articleImages[g.article] ? <img src={articleImages[g.article]} alt={`${g.article} product`} /> : <span>{copy.empty.noImage}</span>}</div><div><strong>{g.article}</strong><span>{s.size}</span></div></div>
                  <span className="history-size-total">{s.total.toLocaleString()}</span>
                </div>

                {/* Expanded color breakdown */}
                {isOpen && (
                  <div className="history-color-breakdown">
                    {s.colors.map((c, idx) => (
                      <div key={c.color} className="history-color-row" style={{ borderBottom: idx < s.colors.length - 1 ? "1px solid var(--border-soft)" : "none" }}>
                        <span className="history-color-swatch" style={{ background: c.color.toLowerCase() }} />
                        <span>{c.color}</span><strong>{c.qty.toLocaleString()}</strong>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {/* Grand total */}
      <div className="history-total-row"><strong>{copy.columns.total}</strong><strong>{grandTotal.toLocaleString()}</strong></div>
    </div>
  );
};

/* ══════════════════════════════════════════════════════
   MAIN PAGE
══════════════════════════════════════════════════════ */
export const ProductionHistoryPage = () => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [rows,       setRows]       = useState<HistoryRow[]>([]);
  const [search,     setSearch]     = useState("");
  const [fromDate,   setFromDate]   = useState("");
  const today = toIsoDate(); // Today's business date as YYYY-MM-DD
  const [toDate,     setToDate]     = useState(today);
  const [sortOrder,  setSortOrder]  = useState("DESC");
  const [page,       setPage]       = useState(1);
  const [total,      setTotal]      = useState(0);
  const [view,       setView]       = useState<"details" | "summary">("summary");
  const [expandAll,  setExpandAll]  = useState(false);
  const [articleImages, setArticleImages] = useState<Record<string, string>>({});

  const load = async (p = page) => {
    // Add 1 day to toDate to include all records from that day (until end of day)
    const adjustedToDate = toDate ? shiftIsoDate(toDate, 1) : toDate;

    // Don't send search to server - fetch all and filter client-side for combination search
    const res = await api.listHistory({
      search: undefined, // Don't use server search - we'll do combination search client-side
      fromDate: fromDate || undefined,
      toDate:   adjustedToDate || undefined,
      sortBy: "event_ts_local",
      sortOrder,
      page: p,
      pageSize: PAGE_SIZE * 10, // Fetch more to allow client-side filtering
    });
    
    // Client-side combination search filtering
    let filtered = res.rows;
    if (search) {
      const terms = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
      filtered = res.rows.filter((r) => {
        const haystack = `${r.qrId} ${r.article} ${r.color} ${r.size}`.toLowerCase();
        return terms.every((t) => haystack.includes(t));
      });
    }
    
    setRows(filtered);
    setTotal(filtered.length);
    const images: Record<string, string> = {};
    for (const article of [...new Set(filtered.map((row) => row.article))]) {
      try {
        const image = await api.getProductImage(article);
        if (image) images[article] = image;
      } catch {
        // History remains usable when an article has no image.
      }
    }
    setArticleImages(images);
  };

  // Load immediately on any filter change (no apply button)
  useEffect(() => {
    setPage(1);
  }, [search, fromDate, toDate, sortOrder, view]);

  useEffect(() => {
    void load(page);
  }, [page, search, fromDate, toDate, sortOrder, view]);

  /* ── Export ─── */
  const handleExport = (format: "pdf" | "csv") => {
    const date = formatDate(new Date());
    if (format === "pdf") {
      const e = escapeHtml;
      const tableRows = rows.map((r) => `
        <tr><td>${e(r.qrId)}</td><td>${e(r.article)}</td><td>${e(r.color)}</td><td>${e(r.size)}</td>
        <td>${e(formatDateTime(r.timestamp))}</td><td>${e(r.operator ?? "—")}</td><td>${e(r.status)}</td></tr>
      `).join("");
      const html = `
        <html><head><title>${e(copy.reports.productionHistory)} — ${e(date)}</title>
        <style>body{font-family:sans-serif;font-size:12px;padding:24px}h1{font-size:18px}
        p{color:#666;margin-bottom:20px}table{width:100%;border-collapse:collapse}
        th{background:#f0f0f0;padding:8px;text-align:left;font-size:11px;text-transform:uppercase}
        td{padding:7px 8px;border-bottom:1px solid #eee}@media print{button{display:none}}</style>
        </head><body>
        <h1>777 Manufacturing — ${e(copy.reports.productionHistory)}</h1>
        <p>${e(fromDate || "All time")} → ${e(toDate || "today")} | ${e(total)} records | Generated: ${e(date)}</p>
        <table><thead><tr><th>QR ID</th><th>Article</th><th>Color</th><th>Size</th>
        <th>Timestamp</th><th>Operator</th><th>Status</th></tr></thead>
        <tbody>${tableRows}</tbody></table>
        <br/><button onclick="window.print()">${copy.reports.printOrSave}</button>
        </body></html>
      `;
      if (!openPrintDocument(html).opened) { push("error", copy.toast.popupBlocked, copy.common.popupBlocked); return; }
    } else {
      downloadCsv(exportFileName("history"), {
        headers: ["QR ID", "Article", "Color", "Size", "Timestamp", "Operator", "Device", "Status"],
        rows: rows.map((r) => [r.qrId, r.article, r.color, r.size, formatDateTime(r.timestamp), r.operator ?? "", r.device, r.status]),
      });
    }
    push("success", "Export ready");
  };

  return (
    <div className="stack">

      {/* ── Top bar ── */}
      <div className="history-toolbar">

        {/* Search */}
        <div className="TopHeaderRowToolbar">
        <div className="search-wrap history-search-wrap">
          <svg className="search-icon" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search article, color, QR…"
            style={{ width: "100%" }}
          />
        </div>

        {/* Date range */}
        <input className="history-date-input" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} title="From" />
        <span style={{ color: "var(--text-3)", fontSize: "0.8rem" }}>→</span>
        <input className="history-date-input" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} title="To" />

        {/* Spacer */}
        <div style={{ flex: 1 }} />
<div className="Buttons-pdf">
        {/* Export */}
        <button type="button" className="btn btn-pdf btn-sm history-export-button" onClick={() => handleExport("pdf")}>↓ Download PDF</button>
        <button type="button" className="btn btn-excel btn-sm history-export-button" onClick={() => handleExport("csv")}>↓ Download Excel</button>
      </div>
       
</div>

        <div className="BottomHeaderRowToolbar">
 {/* Expand All (only in summary) */}
 {/* Details / Summary toggle */}
        <div
          style={{
            display: "flex",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            padding: 3,
            gap: 2,
          }}
        >
          {(["summary", "details"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              style={{
                padding: "5px 14px",
                borderRadius: "var(--radius-sm)",
                border: "none",
                fontSize: "0.78rem",
                fontWeight: 600,
                cursor: "pointer",
                background: view === v ? "var(--primary-blue)" : "transparent",
                color: view === v ? "var(--white)" : "var(--text-2)",
                transition: "background 0.15s, color 0.15s",
                textTransform: "capitalize",
              }}
            >
              {v}
            </button>
          ))}
        </div>
        {view === "summary" && (
          <button
            type="button"
            className={expandAll ? "btn btn-primary btn-sm" : "btn btn-secondary btn-sm"}
            onClick={() => setExpandAll((v) => !v)}
          >
            {expandAll ? "✓ All Expanded" : "Expand All"}
          </button>
        )}
        

      </div>
      </div>




      {/* ── SUMMARY VIEW ── */}
      {view === "summary" && <SummaryView rows={rows} expandAll={expandAll} articleImages={articleImages} />}

      {/* ── DETAILS VIEW ── */}
      {view === "details" && (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{copy.columns.article}</th>
                  <th>{copy.columns.color}</th>
                  <th>{copy.columns.size}</th>
                  <th>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ padding: "2px 0", fontSize: "0.7rem" }}
                      onClick={() => setSortOrder((v) => (v === "DESC" ? "ASC" : "DESC"))}
                    >
                      Timestamp {sortOrder === "DESC" ? "↓" : "↑"}
                    </button>
                  </th>
                  <th>QR ID</th>
                  <th>{copy.columns.status}</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={6} className="empty-state">No records found</td></tr>
                ) : (
                  rows.map((r) => (
                    <tr key={`${r.qrId}-${r.timestamp}`}>
                      <td><strong>{r.article}</strong></td>
                      <td>{r.color}</td>
                      <td><span className="tag">{r.size}</span></td>
                      <td className="text-muted text-small">{formatDateTime(r.timestamp)}</td>
                      <td className="cell-mono text-small">{r.qrId}</td>
                      <td>
                        <span className={`badge ${r.status === "ACCEPTED" ? "badge-ok" : r.status === "REJECTED" ? "badge-err" : "badge-warn"}`}>
                          {r.status.toLowerCase()}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pager */}
          <div className="pager">
            <span className="pager-info">Page {page} of {Math.max(1, Math.ceil(total / PAGE_SIZE))} · {total} records</span>
            <button type="button" className="btn btn-secondary btn-sm" disabled={page <= 1}        onClick={() => setPage((p) => p - 1)}>← Prev</button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={page >= Math.max(1, Math.ceil(total / PAGE_SIZE))} onClick={() => setPage((p) => p + 1)}>Next →</button>
          </div>
        </>
      )}

    </div>
  );
};
