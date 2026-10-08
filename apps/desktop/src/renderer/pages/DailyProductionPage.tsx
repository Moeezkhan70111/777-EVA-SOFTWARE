import React, { useCallback, useEffect, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { ReportSummary } from "../types/desktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { StateView } from "../components/shared/StateView";
import { copy } from "../config/copy";
import { loadLogoDataUrl, openPrintDocument } from "../platform/print";
import { toIsoDate } from "../utils/dates";
import { buildHierarchy, dozNum, formatReportDate, renderDailyReportHtml } from "../features/reports/dailyReport";

// ─── Component ────────────────────────────────────────────────────────────────

export const DailyProductionPage = () => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [report, setReport] = useState<ReportSummary | null>(null);
  const [date, setDate] = useState(() => toIsoDate());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (d: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      setReport(await api.getReport({ range: "CUSTOM", fromDate: d, toDate: d }));
    } catch (error) {
      setReport(null);
      setLoadError(error instanceof Error ? error.message : copy.common.unknownError);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load(date);
    // Initial load only; date changes load explicitly through handleDateChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDateChange = (d: string) => {
    setDate(d);
    if (d) void load(d);
  };

  /* ── PDF export (shared daily-sheet template) ── */
  const exportPDF = async () => {
    if (!report) return;
    const html = renderDailyReportHtml({
      title: copy.reports.dailyProduction,
      dateLabel: "Production Date",
      date,
      groups: buildHierarchy(report.topProducts),
      emptyText: "No production recorded for this date",
      logoDataUrl: await loadLogoDataUrl(),
    });
    if (!openPrintDocument(html).opened) {
      push("error", copy.toast.popupBlocked, copy.common.popupBlocked);
      return;
    }
    push("success", copy.reports.pdfReadyTitle, copy.common.printReady);
  };

  const formatDateLabel = formatReportDate;
  const groups = report ? buildHierarchy(report.topProducts) : [];

  return (
    <div className="stack">
      {/* ── Toolbar ── */}
      <div className="toolbar">
        <div className="toolbarHeadings">
        <div className="page-title" >Daily Production</div>
              <div style={styles.pageDate}>
                Production Date: {formatDateLabel(date)}
              </div></div>
        

        

        <div className="flex-1" />

        <button
          type="button"
          className="btn btn-pdf"
          onClick={exportPDF}
          disabled={!report || loading}
          style={{ alignSelf: "flex-end" }}
        >
          ⬇ Download PDF
        </button>
      </div>

      {/* ── Loading / Error / Empty ── */}
      {loading && <StateView kind="loading" />}
      {!loading && loadError && <StateView kind="error" message={loadError} onRetry={() => void load(date)} />}
      {!loading && !loadError && !report && <StateView kind="empty" title={copy.reports.selectDateProduction} />}

      {/* ── Content ── */}
      {!loading && report && (
        <div style={styles.pageWrap}>
          {/* Page header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" , borderBottom: "1px solid var(--chrome-line)" , padding: "15px 5px" }}>
            <div style={{display:"flex"}}>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span className="input-label">{copy.columns.date}</span>
          <input
            type="date"
            value={date}
            onChange={(e) => handleDateChange(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => void load(date)}
          disabled={!date || loading}
          style={{ alignSelf: "flex-end" , marginLeft:10}}
        >
          ↺ Refresh
        </button>
              
            </div>
            <div style={styles.totalPill}>
              <span style={styles.totalPillLabel}>{copy.columns.total}</span>
              <span style={styles.totalPillValue}>
                {dozNum(report.totalProduction)}<span style={{...styles.unit, fontSize: "0.75rem"}}>Dzn</span>
              </span>
            </div>
          </div>

          {/* Production list */}
          {groups.length === 0 ? (
            <div className="empty-state">No production recorded for this date</div>
          ) : (
            <div style={styles.listWrap}>
              {/* Column header */}
              <div style={styles.columnHeader}>
                <span>{copy.columns.article}</span>
                <span style={styles.colRight}>{copy.columns.qty}</span>
              </div>

              {groups.map((group) => (
                <div key={`${group.article}__${group.size}`} style={styles.articleBlock}>
                  {/* Article + size row */}
                  <div style={styles.articleRow}>
                    <span style={styles.articleName}>{group.article}</span>
                    <span style={styles.articleSize}>{group.size}</span>
                  </div>

                  {/* Color rows */}
                  {group.colors.map((c) => (
                    <div key={c.color} style={styles.colorRow}>
                      <span style={styles.colorName}>{c.color}</span>
                      <span style={styles.colorQty}>
                        {dozNum(c.quantity)}<span style={styles.unit}>Dzn</span>
                      </span>
                    </div>
                  ))}

                  {/* Total row */}
                  <div style={styles.totalRow}>
                    <span style={styles.totalLabel}>{copy.columns.total}</span>
                    <span style={styles.totalQty}>
                      {dozNum(group.total)}<span style={styles.unit}>Dzn</span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Inline styles (Apple-style, light only) ──────────────────────────────────

const styles = {
  pageWrap: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 0,
  },

  // Page header: title + compact total pill
  pageHeader: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    marginBottom: 24,
    paddingBottom: 18,
    borderBottom: "1px solid var(--chrome-line)",
  },
  pageEyebrow: {
    fontSize: "0.68rem",
    fontWeight: 700,
    letterSpacing: "0.1em",
    textTransform: "uppercase" as const,
    color: "var(--chrome-link-strong)",
    marginBottom: 4,
  },
  pageDate: {
    fontSize: "0.9rem",
    fontWeight: 700,
    color: "var(--chrome-ink)",
    opacity: 0.7,
    letterSpacing: "-0.01em",
  },

  // Compact total pill top-right
  totalPill: {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    padding: "8px 18px",
    background: "white",
    border: "1px solid var(--line-grey-60)",
    boxShadow: "0 1px 2px rgba(15, 23, 42, 0.05)",
    borderRadius: "6px",
    // boxShadow: "4px 6px 14px rgba(166, 180, 200, 0.45), -3px -3px 8px var(--white), inset 2px 2px 4px var(--glass-80), inset -2px -2px 4px rgba(166, 180, 200, 0.25)",
  },
  totalPillLabel: {
    fontSize: "0.7rem",
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color: "var(--chrome-muted)",
  },
  totalPillValue: {
    fontSize: "1.45rem",
    fontWeight: 800,
    color: "var(--chrome-link)",
    fontVariantNumeric: "tabular-nums" as const,
    letterSpacing: "-0.02em",
    lineHeight: 1,
  },

  // Column header row
  columnHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "15px",
    paddingTop: "20px",
    fontSize: "0.8rem",
    fontWeight: 750,
    letterSpacing: "0.1em",
    textTransform: "uppercase" as const,
    color: "var(--primary-blue)",
    paddingBottom: "0px",

  },
  colRight: {
    textAlign: "right" as const,
  },

  // Wrapper for all article blocks
  listWrap: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 16,
    boxShadow: "rgba(15, 23, 42, 0.05) 0px 1px 2px",
    margin: "16px 0",
  },

  // Individual article section card
  articleBlock: {
    background: "var(--chrome-bg)",
    border: "1px solid var(--glass-85)",
    borderRadius: 8,
    overflow: "hidden" as const,
    // boxShadow: "6px 8px 18px rgba(166, 180, 200, 0.45), -5px -5px 12px var(--white), inset 3px 3px 6px var(--glass-85), inset -3px -3px 6px rgba(166, 180, 200, 0.3)",
  },

  // Article + size header row
  articleRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 20px",
    borderBottom: "1px solid var(--chrome-line)",
    background: "var(--surface-2)",
  },
  articleName: {
    fontSize: "0.95rem",
    fontWeight: 800,
    color: "var(--chrome-ink)",
    letterSpacing: "-0.01em",
  },
  articleSize: {
    fontSize: "0.82rem",
    fontWeight: 700,
    color: "var(--chrome-muted)",
  },
  articleTotalNum: {
    fontSize: "0.95rem",
    fontWeight: 800,
    color: "var(--chrome-ink)",
    fontVariantNumeric: "tabular-nums" as const,
  },
  articleTotalUnit: {
    fontSize: "0.72rem",
    fontWeight: 600,
    color: "var(--chrome-muted)",
    marginLeft: 3,
  },

  // Color breakdown list inside article card
  colorList: {
    display: "flex",
    flexDirection: "column" as const,
  },
  colorRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 20px",
    borderBottom: "1px solid var(--line-35)",
    background: "white",

  },
  colorLeft: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  colorName: {
    fontSize: "0.84rem",
    color: "var(--neutral-600)",
    fontWeight: 600,
  },
  colorQty: {
    fontSize: "0.84rem",
    color: "var(--neutral-700)",
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums" as const,
  },
  colorTotalNum: {
    fontSize: "0.84rem",
    fontWeight: 700,
    color: "var(--neutral-700)",
    fontVariantNumeric: "tabular-nums" as const,
  },
  colorTotalUnit: {
    fontSize: "0.68rem",
    fontWeight: 600,
    color: "var(--neutral-400)",
    marginLeft: 2,
  },

  // Empty state
  emptyCard: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    padding: "64px 24px",
    background: "var(--chrome-bg)",
    border: "1px solid var(--glass-85)",
    borderRadius: 18,
    boxShadow: "6px 8px 18px rgba(166, 180, 200, 0.45), -5px -5px 12px var(--white)",
    textAlign: "center" as const,
  },
  emptyIcon: {
    fontSize: "2.4rem",
    marginBottom: 12,
    lineHeight: 1,
    opacity: 0.5,
  },
  emptyTitle: {
    fontSize: "0.92rem",
    fontWeight: 750,
    color: "var(--neutral-600)",
    marginBottom: 4,
  },
  emptySub: {
    fontSize: "0.78rem",
    color: "var(--neutral-400)",
  },

  // Total row
  totalRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 18px",
    borderTop: "1px solid var(--chrome-line)",
    background: "var(--surface-2)",
  },
  totalLabel: {
    fontSize: "0.75rem",
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color: "var(--chrome-muted)",
  },
  totalQty: {
    fontSize: "0.95rem",
    fontWeight: 800,
    color: "var(--chrome-ink)",
    fontVariantNumeric: "tabular-nums" as const,
    textAlign: "right" as const,
    minWidth: 40,
  },

  // Inline unit label
  unit: {
    fontSize: "0.68rem",
    fontWeight: 600,
    color: "var(--chrome-muted)",
    marginLeft: "3px",
    letterSpacing: "0.03em",
  },
} as const;
