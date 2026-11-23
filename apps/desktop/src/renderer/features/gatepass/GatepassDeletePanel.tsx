import React, { useState } from "react";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import type { Gatepass } from "../../types/desktopApi";
import { formatGatepassDateTime } from "../../utils/gatepassPrint";

// DELETING A CANCELLED GATEPASS (local migration 118): it leaves every list and is kept, read-only, in Deleted
// gatepasses. The reason is required. Whether it may be deleted is DeleteGatepassUseCase's to decide.

/** Shown on a deleted gatepass: who deleted it, when and why. */
export const DeletedGatepassBanner: React.FC<{ document: Gatepass }> = ({ document }) =>
  document.deletedAt ? (
    <div className="gp-alert gp-alert--warn" role="status" data-testid="gatepass-deleted-banner">
      <strong>{copy.gatepass.deletedAt}</strong>{" "}
      {copy.gatepass.deletedBanner(document.deletedBy ?? "—", formatGatepassDateTime(document.deletedAt), document.deleteReason ?? "")}
    </div>
  ) : null;

interface GatepassDeletePanelProps {
  document: Gatepass;
  token: string;
  onClose: () => void;
  onDeleted: () => void;
}

export const GatepassDeletePanel: React.FC<GatepassDeletePanelProps> = ({ document, token, onClose, onDeleted }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (!reason.trim()) {
      setError(copy.gatepass.deleteReasonNeeded);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.deleteGatepass({ gatepassId: document.id, reason: reason.trim() }, { token });
      if (!result.accepted) {
        setError(result.reason ?? copy.gatepass.deleteFailed);
        return;
      }
      push("success", copy.gatepass.deletedToast(document.code), copy.gatepass.deletedToastBody);
      onDeleted();
    } catch {
      setError(copy.gatepass.deleteFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card gp-card gp-cancel-panel" data-testid="gatepass-delete-panel" aria-label={copy.gatepass.deleteTitle(document.code)}>
      <h2 className="gp-section-title">{copy.gatepass.deleteTitle(document.code)}</h2>
      <p className="gp-party-meta">{copy.gatepass.deleteHint}</p>
      <label className="gp-edit-reason">
        <span>{copy.gatepass.deleteReasonLabel}</span>
        <input className="form-input" type="text" maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      {error ? <p className="gp-alert gp-alert--error" role="alert">{error}</p> : null}
      <div className="gp-header-side">
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
          {copy.common.back}
        </button>
        <button type="button" className="btn btn-danger" onClick={() => void confirm()} disabled={busy} data-testid="gatepass-delete-confirm">
          {busy ? copy.gatepass.deleting : copy.gatepass.deleteConfirm}
        </button>
      </div>
    </section>
  );
};
