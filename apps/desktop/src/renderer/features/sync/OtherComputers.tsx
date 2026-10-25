import React, { useCallback, useEffect, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { copy } from "../../config/copy";
import { StateView } from "../../components/shared/StateView";
import { formatDateTime, formatRelative } from "../../utils/dates";
import type { DeviceSyncHealthReport } from "../../types/desktopApi";

// What every computer of the factory last reported about its own waits (cloud migration 014), so
// whoever can fix a wait sees it without visiting the computer that has it (owner decision
// 2026-10-25, point 4). A wait that sending a master record would end carries a Send Again button:
// on the computer holding the master-data lease it marks that record, and the next pass sends it.
//
// Read from the cloud when the page opens and on Refresh -- never polled.

export const OtherComputers: React.FC = () => {
  const api = useDesktopApi();
  const [devices, setDevices] = useState<DeviceSyncHealthReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const reply = await api.getFactorySyncHealth();
      if (reply.accepted) setDevices(reply.value);
      else setError(reply.reason ?? copy.syncWaiting.othersFailed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.syncWaiting.othersFailed);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <StateView kind="loading" compact message={copy.syncWaiting.othersLoading} />;
  if (error !== null) return <StateView kind="error" compact message={error} onRetry={() => void load()} />;
  if (devices === null || devices.length === 0) return <StateView kind="empty" compact title={copy.syncWaiting.othersEmpty} />;

  return (
    <div>
      {devices.map((device) => (
        <DeviceReport key={device.deviceId} device={device} />
      ))}
    </div>
  );
};

const DeviceReport: React.FC<{ device: DeviceSyncHealthReport }> = ({ device }) => {
  const healthy = device.stuck === 0 && device.stale === 0;
  return (
    <div className="sync-device">
      <div className="sync-device-head">
        <strong>{device.label}</strong>
        <span className="text-small text-muted" title={formatDateTime(device.reportedAt)}>
          {copy.syncWaiting.reportedAgo(formatRelative(device.reportedAt))}
        </span>
      </div>
      <p className="text-small">
        {healthy ? `✓ ${copy.syncWaiting.othersHealthy}` : `⚠ ${copy.syncWaiting.othersCounts(device.stuck, device.stale)}`}
      </p>
      {device.unsentMarks > 0 ? <p className="text-small">{copy.syncWaiting.unsentMarks(device.unsentMarks)}</p> : null}
      {device.deadLetters > 0 ? <p className="text-small">{copy.syncWaiting.deadLetters(device.deadLetters)}</p> : null}
      <ul className="sync-wait-list">
        {device.sample.map((item) => (
          <li key={`${item.subject}|${item.since}`} className="sync-device-sample">
            <span>
              <strong>{item.subject}</strong> — {item.waitingFor}
            </span>
            {item.needs !== undefined ? <SendAgain recordKey={item.needs} subject={item.subject} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
};

/** One record sent again. The outcome is said beside the button that caused it. */
const SendAgain: React.FC<{ recordKey: string; subject: string }> = ({ recordKey, subject }) => {
  const api = useDesktopApi();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    try {
      const reply = await api.sendMasterRecordAgain(recordKey);
      setOutcome(reply.accepted ? copy.syncWaiting.sentAgain : reply.reason ?? copy.syncWaiting.sendAgainFailed);
    } catch (cause) {
      // A refusal by the lease gate is announced, naming the holder, by the API wrapper itself.
      setOutcome(cause instanceof Error && cause.message ? cause.message : copy.syncWaiting.sendAgainFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="sync-notice-actions">
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={busy}
        aria-label={copy.syncWaiting.sendAgainLabel(subject)}
        onClick={() => void send()}
      >
        {copy.syncWaiting.sendAgain}
      </button>
      {outcome !== null ? <span className="text-small" role="status">{outcome}</span> : null}
    </span>
  );
};
