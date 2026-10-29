import React, { useCallback, useEffect, useState } from "react";
import { copy } from "../../../config/copy";
import { StateView } from "../../../components/shared/StateView";
import { useDesktopApi } from "../../../hooks/useDesktopApi";
import { formatTime, toIsoDate } from "../../../utils/dates";
import type { RawMaterialIssueSessionRow } from "../../../types/desktopApi";

// ISSUED TODAY — every issue session started today, on every computer, as Receipts lists every
// receiving session (owner, 0.3.9). Each says who its packets went to and how many, whether it is
// still open, and offers its slip again.

const text = copy.storePage.issuedToday;

interface IssuedTodayProps {
  /** Changes whenever this computer's own session moves, so the list follows it. */
  refreshKey: string;
  onReprint: (sessionId: string) => void;
}

const useIssuedToday = (refreshKey: string) => {
  const api = useDesktopApi();
  const [rows, setRows] = useState<RawMaterialIssueSessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const today = toIsoDate();
      setRows(await api.listRawMaterialIssueSessions({ dateFrom: today, dateTo: today }));
    } catch {
      setError(text.failed);
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);
  return { rows, loading, error, reload };
};

const IssuedRow: React.FC<{ row: RawMaterialIssueSessionRow; onReprint: (sessionId: string) => void }> = ({ row, onReprint }) => (
  <li className="sp-issued-row">
    <span className="sp-issued-code">{row.session.code}</span>
    <span>{row.partyName ?? text.noParty}</span>
    <span>{copy.storeStation.packets(row.packets)}</span>
    <span>
      {row.session.status === "OPEN" ? text.open : text.closed} · {formatTime(row.session.startedAt)}
    </span>
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      aria-label={text.reprintFor(row.session.code)}
      disabled={row.packets === 0}
      onClick={() => onReprint(row.session.id)}
    >
      {copy.storeStation.reprintSlip}
    </button>
  </li>
);

export const IssuedToday: React.FC<IssuedTodayProps> = ({ refreshKey, onReprint }) => {
  const { rows, loading, error, reload } = useIssuedToday(refreshKey);
  return (
    <section aria-labelledby="sp-issued-title">
      <h2 id="sp-issued-title" className="section-label">
        {text.title}
      </h2>
      <p className="field-help">{text.line}</p>
      {loading && rows.length === 0 ? <StateView kind="loading" compact message={text.loading} /> : null}
      {error ? <StateView kind="error" compact message={error} onRetry={() => void reload()} /> : null}
      {!loading && !error && rows.length === 0 ? <StateView kind="empty" compact title={text.empty} hint={text.emptyHint} /> : null}
      {rows.length > 0 ? (
        <ul className="sp-issued-list">
          {rows.map((row) => (
            <IssuedRow key={row.session.id} row={row} onReprint={onReprint} />
          ))}
        </ul>
      ) : null}
    </section>
  );
};
