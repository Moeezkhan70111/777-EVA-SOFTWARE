import React, { useCallback, useEffect, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog";
import { StateView } from "../../components/shared/StateView";
import type { RemovalRequest } from "../../types/desktopApi";
import { formatDateTime } from "../../utils/dates";
import { copy } from "../../config/copy";

// Removing a category.
//
// What would stop it is the data layer's answer, not this component's: it asks, and shows
// that answer. Only an empty category can go — anything filed under it would be left pointing
// at nothing.
//
// Removing it is an administrator's decision, so everyone else asks. An administrator sees
// the same panel with the decision in it: approve carries the removal out, decline leaves
// everything alone. The rule about who may remove what lives in the main process (see
// ipc/rawMaterials.ts) — hiding a button is not authorisation.

interface DeleteCategorySectionProps {
  categoryId: string;
  name: string;
  isAdmin: boolean;
  /** Re-reads the category tree once something actually changed. */
  onChanged: () => Promise<void>;
}

export const DeleteCategorySection: React.FC<DeleteCategorySectionProps> = ({
  categoryId,
  name,
  isAdmin,
  onChanged,
}) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [blockers, setBlockers] = useState<string[] | null>(null);
  const [requests, setRequests] = useState<RemovalRequest[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [declineNote, setDeclineNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [check, history] = await Promise.all([
        api.categoryRemovalBlockers(categoryId),
        api.listRemovalRequestsForTarget(categoryId, 10),
      ]);
      if (!check.accepted) {
        setLoadError(check.reason ?? copy.common.unknownError);
        return;
      }
      setBlockers(check.blockers ?? []);
      setRequests(history);
    } catch {
      setLoadError(copy.common.unknownError);
    }
  }, [api, categoryId]);

  useEffect(() => {
    setBlockers(null);
    setReason("");
    void load();
  }, [load]);

  const pending = requests.find((request) => request.status === "PENDING") ?? null;
  const blocked = blockers !== null && blockers.length > 0;

  // An administrator removes it outright; everyone else asks for it.
  const remove = async (): Promise<string | null> => {
    const result = await api.removeInventoryCategory(categoryId, reason.trim() || undefined);
    if (!result.accepted) return result.reason ?? copy.common.unknownError;
    push("success", copy.removal.deleteCategoryDone(name));
    await onChanged();
    return null;
  };

  const askForRemoval = async () => {
    setBusy(true);
    try {
      const result = await api.createCategoryRemovalRequest({ categoryId, reason: reason.trim() || undefined });
      if (!result.accepted) {
        push("error", copy.toast.failed, result.reason ?? copy.common.unknownError);
        return;
      }
      push("success", copy.removal.removalSent(name));
      setReason("");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: "APPROVED" | "REJECTED", notes?: string) => {
    if (!pending) return;
    setBusy(true);
    try {
      const result = await api.reviewRemovalRequest(pending.id, decision, notes);
      if (!result.accepted) {
        push("error", copy.toast.failed, result.reason ?? copy.common.unknownError);
        return;
      }
      push("success", decision === "APPROVED" ? copy.removal.deleteCategoryDone(name) : copy.removal.removalDeclined);
      setDeclining(false);
      setDeclineNote("");
      await onChanged();
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <section className="rm-drawer-section rm-danger-zone">
        <h3 className="rm-drawer-heading">{copy.removal.deleteCategory}</h3>
        <StateView kind="error" message={loadError} onRetry={() => void load()} />
      </section>
    );
  }

  return (
    <section className="rm-drawer-section rm-danger-zone" data-testid="category-removal">
      <h3 className="rm-drawer-heading">{copy.removal.deleteCategory}</h3>

      {blockers === null ? (
        <p className="field-help">{copy.removal.checking}</p>
      ) : pending ? (
        <>
          <p className="rm-danger-reason" role="status">
            ⏳ {copy.removal.removalPending(pending.requestCode, pending.requestedByName ?? "Someone")}
          </p>
          {pending.reason ? <p className="field-help">“{pending.reason}”</p> : null}
          {isAdmin ? (
            declining ? (
              // Declining asks for a note first: a refusal with no explanation cannot be
              // acted on. Same shape as a declined stock correction.
              <div className="rm-correction-decline">
                <label className="input-label" htmlFor={`rm-cat-decline-${categoryId}`}>
                  {copy.removal.declineNoteLabel}
                </label>
                <input
                  id={`rm-cat-decline-${categoryId}`}
                  className="form-input"
                  autoFocus
                  value={declineNote}
                  placeholder="e.g. we still file last season's stock under it"
                  onChange={(event) => setDeclineNote(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void decide("REJECTED", declineNote.trim() || undefined);
                    }
                  }}
                />
                <div className="rm-correction-actions">
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={busy}
                    onClick={() => void decide("REJECTED", declineNote.trim() || undefined)}
                  >
                    {busy ? copy.removal.sending : copy.removal.declineRemoval}
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDeclining(false)}>
                    {copy.common.back}
                  </button>
                </div>
              </div>
            ) : (
              <div className="rm-correction-actions">
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={busy}
                  data-testid="category-removal-approve"
                  onClick={() => void decide("APPROVED")}
                >
                  {copy.removal.approveRemoval}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setDeclining(true)}>
                  {copy.removal.declineRemoval}
                </button>
              </div>
            )
          ) : null}
        </>
      ) : blocked ? (
        <p className="rm-danger-reason" role="status">
          ⚠ {copy.removal.categoryNotEmpty(blockers.join(" and "))}
        </p>
      ) : (
        <>
          <p className="field-help">
            {isAdmin ? copy.removal.deleteCategoryExplain : copy.removal.askAdminExplain}
          </p>
          <label className="input-label" htmlFor={`rm-cat-removal-reason-${categoryId}`}>
            {copy.removal.removalReasonLabel}
          </label>
          <input
            id={`rm-cat-removal-reason-${categoryId}`}
            className="form-input"
            value={reason}
            placeholder="e.g. created by mistake"
            onChange={(event) => setReason(event.target.value)}
          />
          <button
            type="button"
            className={isAdmin ? "btn btn-danger" : "btn btn-secondary"}
            disabled={busy}
            data-testid="category-removal-start"
            onClick={() => (isAdmin ? setConfirming(true) : void askForRemoval())}
          >
            {busy ? copy.removal.sending : isAdmin ? copy.removal.deleteCategory : copy.removal.askAdminToRemove}
          </button>
        </>
      )}

      <RemovalHistory requests={requests.filter((request) => request.status !== "PENDING")} />

      {confirming ? (
        <ConfirmDialog
          title={copy.removal.deleteCategoryTitle(name)}
          facts={[{ label: "Category", value: name }]}
          explain={copy.removal.deleteCategoryExplain}
          warning={copy.removal.deleteCategoryWarning}
          confirmLabel={copy.actions.delete}
          busyLabel={copy.removal.deleting}
          onConfirm={remove}
          onClose={() => setConfirming(false)}
        />
      ) : null}

    </section>
  );
};

/** What was decided before, so a declined request does not look like nothing happened. */
const RemovalHistory: React.FC<{ requests: RemovalRequest[] }> = ({ requests }) => {
  if (requests.length === 0) return null;
  return (
    <ul className="rm-removal-history">
      {requests.map((request) => (
        <li key={request.id} className="rm-removal-history-row">
          <span className="rm-muted">{formatDateTime(request.reviewedAt ?? request.requestedAt)}</span>{" "}
          {request.status === "APPROVED" ? "Removed" : "Declined"}
          {request.reviewedByName ? ` by ${request.reviewedByName}` : ""}
          {request.reviewNotes ? ` — “${request.reviewNotes}”` : ""} ({request.requestCode})
        </li>
      ))}
    </ul>
  );
};
