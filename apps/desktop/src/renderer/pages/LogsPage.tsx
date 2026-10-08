import React, { useEffect, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import { copy } from "../config/copy";

const LEVELS = ["ALL", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] as const;

const levelClass: Record<string, string> = {
  ERROR:    "level-error",
  CRITICAL: "level-critical",
  WARNING:  "level-warning",
  INFO:     "level-info",
};

export const LogsPage = () => {
  const api = useDesktopApi();
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [level, setLevel] = useState("ALL");

  const load = async () => setRows(await api.getLogs({ level }));

  useEffect(() => { void load(); }, []);

  return (
    <div className="stack">
      <div className="toolbar">
        <select value={level} onChange={(e) => setLevel(e.target.value)}>
          {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void load()}>{copy.common.refresh}</button>
        <span className="flex-1" />
        <span className="text-muted text-small">{rows.length} entries</span>
      </div>

      {rows.length === 0 ? (
        <div className="empty-state">No log entries</div>
      ) : (
        <div className="log-list">
          {rows.map((row, idx) => {
            const sev = typeof row.severity === "string" ? row.severity : "";
            const cls = levelClass[sev] ?? "";
            return (
              <div
                key={`${String(row.timestamp)}-${idx}`}
                className={`log-entry ${cls}`}
              >
                {JSON.stringify(row, null, 2)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
