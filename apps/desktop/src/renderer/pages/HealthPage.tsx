import React, { useEffect, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { CloudSyncStatus, HealthSnapshot } from "../types/desktopApi";
import { copy } from "../config/copy";
import { useSession } from "../features/auth/SessionContext";
import { WaitingHere } from "../features/sync/WaitingHere";
import { OtherComputers } from "../features/sync/OtherComputers";

const bytes = (n: number): string => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
};

interface HealthItemProps {
  label: string;
  value: string | number | boolean;
  tone?: "ok" | "err" | "warn" | "default";
}

const HealthItem = ({ label, value, tone = "default" }: HealthItemProps) => {
  const displayValue = typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
  const colorMap: Record<string, string> = {
    ok:      "var(--ok)",
    err:     "var(--err)",
    warn:    "var(--warn)",
    default: "var(--text)",
  };
  return (
    <div className="health-item">
      <div className="health-item-label">{label}</div>
      <div className="health-item-value" style={{ color: colorMap[tone] }}>
        {tone === "ok" && "● "}
        {tone === "err" && "● "}
        {displayValue}
      </div>
    </div>
  );
};

/** Never "a moment ago" when nothing has happened: an absent timestamp says so plainly. */
const when = (iso: string | null): string => (iso === null ? "Never" : new Date(iso).toLocaleString());

export const HealthPage = () => {
  const api = useDesktopApi();
  const { isAdmin } = useSession();
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [sync, setSync] = useState<CloudSyncStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const [snapshot, cloud] = await Promise.all([
      api.getHealth(),
      // The queue counts are local facts and worth showing on a computer that is not set up for
      // cloud sync at all. If the call fails, the rest of the page still renders.
      api.getCloudSyncStatus().catch(() => null),
    ]);
    setHealth(snapshot);
    setSync(cloud);
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  if (loading) return <div className="empty-state">Loading health data…</div>;
  if (!health)  return <div className="empty-state">Health data unavailable</div>;

  return (
    <div className="stack">
      <div className="toolbar">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>{copy.common.refresh}</button>
        <span className="text-muted text-small">
          Device: <strong>{health.deviceId}</strong> · v{health.appVersion}
        </span>
      </div>

      <div>
        <div className="section-label mb-8">Database &amp; Storage</div>
        <div className="health-grid">
          <HealthItem label="SQLite Status"   value={health.sqliteStatus}        tone={health.sqliteStatus === "ok" ? "ok" : "err"} />
          <HealthItem label="Database Size"   value={bytes(health.databaseSizeBytes)} />
          <HealthItem label="Disk Free"       value={bytes(health.diskFreeBytes)} tone={health.diskFreeBytes < 1e8 ? "warn" : "default"} />
          <HealthItem label="Backup Status"   value={health.backupStatus}        tone={health.backupStatus === "ok" ? "ok" : "warn"} />
        </div>
      </div>

      <div>
        <div className="section-label mb-8">System Resources</div>
        <div className="health-grid">
          <HealthItem label="Memory Usage"    value={bytes(health.memoryUsageBytes)} />
          <HealthItem label="CPU Load Avg"    value={health.cpuLoadAverage.toFixed(3)} tone={health.cpuLoadAverage > 2 ? "warn" : "default"} />
        </div>
      </div>

      <div>
        <div className="section-label mb-8">Sync Queue</div>
        <div className="health-grid">
          <HealthItem label="Pending Sync"    value={health.pendingSyncQueue}    tone={health.pendingSyncQueue > 0  ? "warn" : "ok"} />
          <HealthItem label="Failed Sync"     value={health.failedSyncQueue}     tone={health.failedSyncQueue > 0   ? "err"  : "ok"} />
          <HealthItem label="Scanner Status"  value={health.scannerConnected ? "Connected" : "Disconnected"} tone={health.scannerConnected ? "ok" : "err"} />
        </div>
      </div>

      {sync !== null && (
        <div>
          <div className="section-label mb-8">Cloud Sync</div>
          <div className="health-grid">
            <HealthItem
              label="Cloud Sync"
              value={sync.configured ? `Set up (${sync.host ?? ""})` : "Not set up on this computer"}
              tone={sync.configured ? "ok" : "default"}
            />
            <HealthItem label="Ready To Send"  value={sync.queue.pushableNow}  tone={sync.queue.pushableNow > 0 ? "warn" : "ok"} />
            <HealthItem label="Waiting To Retry" value={sync.queue.pushableWaiting} tone={sync.queue.pushableWaiting > 0 ? "warn" : "default"} />
            <HealthItem label="No Transport Yet" value={sync.queue.notPushable} />
            <HealthItem label="Parked (Dead Letter)" value={sync.queue.counts.DEAD_LETTER} tone={sync.queue.counts.DEAD_LETTER > 0 ? "err" : "ok"} />
            <HealthItem label="Sent So Far"    value={sync.queue.counts.SYNCED} />
            <HealthItem label="Last Sent"      value={when(sync.queue.lastSyncedAt)} />
            <HealthItem label="Last Failure"   value={when(sync.queue.lastFailureAt)} tone={sync.queue.lastFailureAt === null ? "ok" : "warn"} />
            <HealthItem label="Cloud Log Read To" value={sync.pullCursor} />
            {sync.waitingFor !== undefined && (
              <HealthItem
                label="Pull Waiting At"
                value={`${String(sync.waitingFor.parked)} parked — oldest at position ${String(sync.waitingFor.seq)} (${sync.waitingFor.reason}), retry after ${when(sync.waitingFor.retryAfter)}`}
                tone="warn"
              />
            )}
          </div>
        </div>
      )}

      <div>
        <div className="section-label mb-8">{copy.syncWaiting.hereTitle}</div>
        <WaitingHere />
      </div>

      {isAdmin && (
        <div>
          <div className="section-label mb-8">{copy.syncWaiting.othersTitle}</div>
          <OtherComputers />
        </div>
      )}

      <div>
        <div className="section-label mb-8">Data Integrity</div>
        <div className="health-grid">
          <HealthItem
            label="Money Integrity"
            value={health.moneyDrift.healthy ? "Money integrity check passed" : "Money integrity issue detected"}
            tone={health.moneyDrift.healthy ? "ok" : "err"}
          />
          <HealthItem label="Monetary Pairs Checked" value={health.moneyDrift.pairsChecked} />
          <HealthItem label="Mismatches Found"        value={health.moneyDrift.violationCount} tone={health.moneyDrift.violationCount > 0 ? "err" : "ok"} />
        </div>
        {!health.moneyDrift.healthy && (
          <div className="table-container mt-8">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Table</th>
                  <th>Column</th>
                  <th>Row ID</th>
                  <th className="num">Real Value</th>
                  <th className="num">Paisa Value</th>
                  <th className="num">Expected Paisa</th>
                </tr>
              </thead>
              <tbody>
                {health.moneyDrift.violations.map((violation, index) => (
                  <tr key={`${violation.table}-${violation.column}-${violation.id}-${index}`}>
                    <td>{violation.table}</td>
                    <td>{violation.column}</td>
                    <td>{violation.id}</td>
                    <td className="num">{violation.realValue ?? "—"}</td>
                    <td className="num">{violation.paisaValue ?? "—"}</td>
                    <td className="num">{violation.expectedPaisa ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
