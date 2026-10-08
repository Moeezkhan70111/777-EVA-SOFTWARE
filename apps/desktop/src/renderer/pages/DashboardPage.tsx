import React, { useEffect, useState } from "react";
import { KpiCard } from "../components/dashboard/KpiCard";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { DashboardSnapshot, HealthSnapshot } from "../types/desktopApi";
import { money, toLocal } from "../app/format";
import { copy } from "../config/copy";

export const DashboardPage = () => {
  const api = useDesktopApi();
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const [s, h] = await Promise.all([api.getDashboard(), api.getHealth()]);
    setSnapshot(s);
    setHealth(h);
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  if (loading || !snapshot) {
    return <div className="empty-state">Loading dashboard…</div>;
  }

  const scannerOnline = health?.scannerConnected ?? false;
  const systemHealthy = !!health;

  return (
    <div className="stack">
      {/* KPI Row */}
      <div className="kpi-grid">
        <KpiCard label="Today's Production" value={snapshot.todaysProduction} tone="accent" />
        <KpiCard label="Current Stock" value={snapshot.currentStockTotal.toLocaleString()} />
        <KpiCard label="Inventory Value" value={money(snapshot.inventoryValue)} />
        <KpiCard label="Pending Sync" value={snapshot.syncQueuePending} tone={snapshot.syncQueuePending > 0 ? "warn" : "default"} />
        <KpiCard
          label="Scanner"
          value={scannerOnline ? "Online" : "Offline"}
          tone={scannerOnline ? "ok" : "default"}
        />
        <KpiCard
          label="System"
          value={systemHealthy ? "Healthy" : "Unknown"}
          tone={systemHealthy ? "ok" : "default"}
        />
      </div>

      {/* Main content grid */}
      <div className="dashboard-grid">
        {/* Recent Scans */}
        <div className="card">
          <div className="card-header">
            <div>
              <p className="card-eyebrow">Live Activity</p>
              <h3 className="card-title mt-0">Recent Production</h3>
            </div>
            <span className="badge badge-ok">Live</span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>QR ID</th>
                  <th>{copy.columns.article}</th>
                  <th>{copy.columns.color}</th>
                  <th>{copy.columns.size}</th>
                  <th>{copy.columns.time}</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.recentScans.length === 0 ? (
                  <tr><td colSpan={5} className="empty-state">No recent scans</td></tr>
                ) : snapshot.recentScans.map((r) => (
                  <tr key={`${r.qrId}-${r.occurredAt}`}>
                    <td className="cell-mono">{r.qrId}</td>
                    <td>{r.article}</td>
                    <td>{r.color}</td>
                    <td>{r.size}</td>
                    <td className="text-muted text-small">{toLocal(r.occurredAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Production Summary */}
        <div className="card">
          <div className="card-header mb-0">
            <div>
              <p className="card-eyebrow">Operations Overview</p>
              <h3 className="card-title mt-0">Production Breakdown</h3>
            </div>
          </div>
          <div className="summary-grid">
            {[
              { title: "By Hour",    data: snapshot.byHour },
              { title: "By Article", data: snapshot.byProduct },
              { title: "By Color",   data: snapshot.byColor },
              { title: "By Size",    data: snapshot.bySize },
            ].map(({ title, data }) => (
              <div className="summary-block" key={title}>
                <p className="summary-block-title">{title}</p>
                {data.length === 0
                  ? <div className="text-muted text-small">—</div>
                  : data.map((x) => (
                    <div className="summary-row" key={x.key}>
                      <span className="summary-row-key">{x.key || "—"}</span>
                      <span className="summary-row-val">{x.quantity}</span>
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
