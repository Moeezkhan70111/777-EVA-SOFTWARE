import React, { useCallback, useEffect, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { copy } from "../../config/copy";
import { StateView } from "../../components/shared/StateView";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog";
import { formatDateTime } from "../../utils/dates";
import { formatQuantity } from "../rawMaterial/rawMaterial";
import type { BackfillPlan } from "../../types/desktopApi";

// The one-time backfill, for an administrator on the store computer (main/ipc/backfill.ts). Shows
// what would go before anything goes, and refuses -- listing them -- while any material's stock does
// not add up, because sent as it is every other computer would show a wrong number with confidence.

export const BackfillPanel: React.FC = () => {
  const api = useDesktopApi();
  const [plan, setPlan] = useState<BackfillPlan | null>(null);
  const [lastAt, setLastAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [sent, setSent] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const reply = await api.getBackfillPlan();
      if (reply.accepted) {
        setPlan(reply.value.plan);
        setLastAt(reply.value.lastAt);
      } else setError(reply.reason ?? copy.backfill.failed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.backfill.failed);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async (): Promise<string | null> => {
    try {
      const reply = await api.runBackfill();
      if (!reply.accepted) return reply.reason ?? copy.backfill.failed;
      setSent(true);
      await load();
      return null;
    } catch (cause) {
      // A lease refusal is also announced, naming the holder, by the API wrapper.
      return cause instanceof Error ? cause.message : copy.backfill.failed;
    }
  };

  return (
    <div className="stack">
      <div className="settings-section-title">{copy.backfill.title}</div>
      <p className="text-small">{copy.backfill.intro}</p>
      {loading ? <StateView kind="loading" compact message={copy.backfill.loading} /> : null}
      {!loading && error !== null ? <StateView kind="error" compact message={error} onRetry={() => void load()} /> : null}
      {!loading && error === null && plan !== null ? (
        <PlanView plan={plan} lastAt={lastAt} sent={sent} onSend={() => setConfirming(true)} />
      ) : null}
      {confirming ? (
        <ConfirmDialog
          title={copy.backfill.confirmTitle}
          facts={[]}
          explain={copy.backfill.confirmExplain}
          warning={copy.backfill.confirmWarning}
          confirmLabel={copy.backfill.send}
          busyLabel={copy.backfill.sending}
          tone="primary"
          onConfirm={send}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
};

const PlanView: React.FC<{ plan: BackfillPlan; lastAt: string | null; sent: boolean; onSend: () => void }> = ({ plan, lastAt, sent, onSend }) => {
  const records = Object.values(plan.masterRecords).reduce((sum, value) => sum + value, 0);
  const hasLeases = plan.masterEpoch !== null && plan.storeEpoch !== null;
  const blocked = !hasLeases || plan.mismatches.length > 0;
  return (
    <>
      <div className="section-label">{copy.backfill.willSend}</div>
      <ul className="sync-wait-list">
        <li>{copy.backfill.masterRecords(records)}</li>
        <li>{copy.backfill.stockMovements(plan.stockMovements)}</li>
        <li>{copy.backfill.labels(plan.labelRunsToQueue, plan.packetsToQueue)}</li>
        {plan.variantsToQueue > 0 ? <li>{copy.backfill.variants(plan.variantsToQueue)}</li> : null}
        {plan.unstampedQueued > 0 ? <li>{copy.backfill.unstamped(plan.unstampedQueued)}</li> : null}
      </ul>
      {!hasLeases ? <p className="text-small" role="status">🔒 {copy.backfill.noLease}</p> : null}
      {plan.mismatches.length > 0 ? <Mismatches plan={plan} /> : null}
      {lastAt !== null ? <p className="text-small">{copy.backfill.lastSent(formatDateTime(lastAt))}</p> : null}
      {sent ? <p className="text-small" role="status">✓ {copy.backfill.sent}</p> : null}
      <div>
        <button type="button" className="btn btn-primary" disabled={blocked} onClick={onSend}>
          {copy.backfill.send}
        </button>
      </div>
    </>
  );
};

const Mismatches: React.FC<{ plan: BackfillPlan }> = ({ plan }) => (
  <div className="sync-notice is-warning" role="status">
    <span className="sync-notice-icon" aria-hidden="true">⚠</span>
    <div className="sync-notice-body">
      <p className="sync-notice-title">{copy.backfill.mismatchTitle}</p>
      <p>{copy.backfill.mismatchHint}</p>
      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{copy.columns.items}</th>
              <th scope="col" className="num">{copy.backfill.mismatchBalance}</th>
              <th scope="col" className="num">{copy.backfill.mismatchMovements}</th>
              <th scope="col">{copy.backfill.mismatchUnit}</th>
            </tr>
          </thead>
          <tbody>
            {plan.mismatches.map((item) => (
              <tr key={item.itemId}>
                <td>{item.displayName}</td>
                <td className="num">{formatQuantity(item.balance)}</td>
                <td className="num">{formatQuantity(item.fromMovements)}</td>
                <td>{item.unitDiffers ? `⚠ ${copy.backfill.mismatchUnit}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  </div>
);
