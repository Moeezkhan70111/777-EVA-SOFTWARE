import React, { useCallback, useEffect, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { copy } from "../../config/copy";
import { StateView } from "../../components/shared/StateView";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog";
import { formatDateTime } from "../../utils/dates";
import type { CartonCloudStatus } from "../../types/desktopApi";

// Carton Cloud activation, for an administrator (main/ipc/cartonCloud.ts). Off until activated: carton stock,
// gatepasses, bills and cash vouchers made here stay here. Activating is once, for ever, and only what is made after it
// may ever reach the cloud. The screen says what stops it, and asks before it does it.
//
// READ AGAIN WHENEVER THE CLOUD SYNC SECTION READS AGAIN (`refreshKey`). It used to read once, when Settings opened. On
// a new computer that is before its first pull, so after Sync Now the section showed the log read to the end while
// this panel still said the computer had never read from the cloud and named no lease holder (PC1, 11 Nov 2026).

interface CartonCloudPanelProps {
  /** Changes each time the surrounding Cloud Sync section has read its status again. */
  readonly refreshKey?: number;
}

export const CartonCloudPanel: React.FC<CartonCloudPanelProps> = ({ refreshKey = 0 }) => {
  const api = useDesktopApi();
  const [status, setStatus] = useState<CartonCloudStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const reply = await api.getCartonCloudStatus();
      if (reply.accepted) setStatus(reply.value);
      else setError(reply.reason ?? copy.cartonCloud.failed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.cartonCloud.failed);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const activate = async (): Promise<string | null> => {
    if (status?.projectKey == null) return copy.cartonCloud.failed;
    try {
      const reply = await api.activateCartonCloud(status.projectKey);
      if (!reply.accepted) return reply.reason ?? copy.cartonCloud.failed;
      setStatus(reply.value);
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : copy.cartonCloud.failed;
    }
  };

  return (
    <div className="stack">
      <div className="settings-section-title">{copy.cartonCloud.title}</div>
      {loading && status === null ? <StateView kind="loading" compact message={copy.cartonCloud.loading} /> : null}
      {!loading && error !== null ? <StateView kind="error" compact message={error} onRetry={() => void load()} /> : null}
      {error === null && status !== null ? <StatusView status={status} onActivate={() => setConfirming(true)} /> : null}
      {confirming && status !== null ? (
        <ConfirmDialog
          title={copy.cartonCloud.confirmTitle}
          facts={[{ label: copy.cartonCloud.project, value: status.projectKey ?? "—" }]}
          explain={copy.cartonCloud.confirmExplain}
          warning={copy.cartonCloud.confirmWarning}
          confirmLabel={copy.cartonCloud.activate}
          busyLabel={copy.cartonCloud.activating}
          tone="primary"
          onConfirm={activate}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
};

const StatusView: React.FC<{ status: CartonCloudStatus; onActivate: () => void }> = ({ status, onActivate }) => (
  <>
    <StateLine status={status} />
    <div className="section-label">{copy.cartonCloud.leasesTitle}</div>
    <ul className="sync-wait-list">
      {status.leases.map((lease) => (
        <li key={lease.domain}>{copy.cartonCloud.lease(lease.domain, lease.holderLabel, lease.heldHere)}</li>
      ))}
    </ul>
    {status.parkedLocalStock > 0 ? <p className="text-small">{copy.cartonCloud.parked(status.parkedLocalStock)}</p> : null}
    {status.state === "NOT_ACTIVATED" ? <ActivateSection status={status} onActivate={onActivate} /> : null}
  </>
);

const StateLine: React.FC<{ status: CartonCloudStatus }> = ({ status }) => {
  if (status.state === "ACTIVE" && status.activation !== null) {
    return (
      <p className="text-small" role="status">
        ✓ {copy.cartonCloud.active(formatDateTime(status.activation.activatedAt), status.activation.activatedBy)}
      </p>
    );
  }
  if (status.state === "INVALID") {
    return (
      <p className="text-small" role="alert">
        ⚠ {copy.cartonCloud.invalid(status.invalidReason ?? "")}
      </p>
    );
  }
  return (
    <p className="text-small" role="status">
      🔒 {copy.cartonCloud.off(status.localOnlyMarks)}
    </p>
  );
};

const ActivateSection: React.FC<{ status: CartonCloudStatus; onActivate: () => void }> = ({ status, onActivate }) => (
  <>
    {status.problems.length > 0 ? (
      <div className="sync-notice is-warning" role="status" aria-label={copy.cartonCloud.notReadyTitle}>
        <span className="sync-notice-icon" aria-hidden="true">⚠</span>
        <div className="sync-notice-body">
          <p className="sync-notice-title">{copy.cartonCloud.notReadyTitle}</p>
          <ul className="sync-wait-list">
            {status.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      </div>
    ) : null}
    <div>
      <button type="button" className="btn btn-primary" disabled={status.problems.length > 0} onClick={onActivate}>
        {copy.cartonCloud.activate}
      </button>
    </div>
  </>
);
