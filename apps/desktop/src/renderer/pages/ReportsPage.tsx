import React, { useEffect, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { ReportSummary } from "../types/desktopApi";
import { money } from "../app/format";

interface BreakdownItem { key: string; quantity: number }

const BreakdownCard = ({ title, data }: { title: string; data: BreakdownItem[] }) => (
  <div className="card card-sm">
    <div className="card-header">
      <h4 className="card-title">{title}</h4>
    </div>
    {data.length === 0
      ? <div className="text-muted text-small">No data</div>
      : data.map((x) => (
        <div className="summary-row" key={x.key}>
          <span className="summary-row-key">{x.key || "—"}</span>
          <span className="summary-row-val">{x.quantity.toLocaleString()}</span>
        </div>
      ))}
  </div>
);

export const ReportsPage = () => {
  const api = useDesktopApi();
  const [range, setRange]       = useState("DAILY");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate]     = useState("");
  const [report, setReport]     = useState<ReportSummary | null>(null);
  const [loading, setLoading]   = useState(false);

  const load = async () => {
    setLoading(true);
    setReport(await api.getReport({
      range,
      fromDate: fromDate || undefined,
      toDate:   toDate   || undefined,
    }));
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  return (
    <div className="stack">
      {/* Toolbar */}
      <div className="toolbar">
        <select value={range} onChange={(e) => setRange(e.target.value)}>
          <option value="DAILY">Daily</option>
          <option value="WEEKLY">Weekly</option>
          <option value="MONTHLY">Monthly</option>
          <option value="CUSTOM">Custom Range</option>
        </select>
        {range === "CUSTOM" && (
          <>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            <input type="date" value={toDate}   onChange={(e) => setToDate(e.target.value)} />
          </>
        )}
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void load()}>
          Generate
        </button>
      </div>

      {loading && <div className="empty-state">Loading report…</div>}

      {!loading && report && (
        <>
          {/* Totals */}
          <div className="report-totals">
            <div className="report-total-item">
              <div className="report-total-label">Total Production</div>
              <div className="report-total-value">{report.totalProduction.toLocaleString()}</div>
            </div>
            <div className="report-total-item">
              <div className="report-total-label">Inventory Value</div>
              <div className="report-total-value">{money(report.inventoryValue)}</div>
            </div>
          </div>

          {/* Breakdowns */}
          <div className="reports-grid">
            <BreakdownCard title="Top Products"       data={report.topProducts} />
            <BreakdownCard title="By Article"         data={report.byArticle} />
            <BreakdownCard title="By Color"           data={report.byColor} />
            <BreakdownCard title="By Size"            data={report.bySize} />
            <BreakdownCard title="Hourly Production"  data={report.byHour} />
          </div>
        </>
      )}

      {!loading && !report && (
        <div className="empty-state">No report data. Click Generate to load.</div>
      )}
    </div>
  );
};
