import React, { useCallback, useEffect, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog";
import { copy } from "../../config/copy";

// What can be done with a material that should not be in the list any more.
//
// Three outcomes, and which ones are offered is the data layer's answer, not this
// component's:
//
//   Disable   hides it from the pickers and from stock, keeping everything it took part in.
//   Enable    puts a disabled one back.
//   Erase     takes it away for good, along with its OWN stock ledger. Refused outright when
//             anything outside the material names it — a printed label, a scan, a purchase
//             line, a machine program line, a stock correction — because those are records of
//             what happened elsewhere and would be left pointing at nothing.
//
// Erasing is an administrator's decision, so everybody else asks for it. The rule about who
// may erase what lives in the main process — hiding a button is not authorisation.

interface DeleteMaterialSectionProps {
  itemId: string;
  displayName: string;
  /** Already INACTIVE: the section offers to switch it back on. */
  disabled: boolean;
  isAdmin: boolean;
  /** Closes the drawer once the material is gone. */
  onDeleted: () => void;
  /** Re-reads the list after a disable, an enable or a refusal. */
  onChanged: () => Promise<void>;
}

export const DeleteMaterialSection: React.FC<DeleteMaterialSectionProps> = ({
  itemId,
  displayName,
  disabled,
  isAdmin,
  onDeleted,
  onChanged,
}) => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [blockers, setBlockers] = useState<string[] | null>(null);
  /** What erasing would take with it — its own stock and movements. */
  const [cost, setCost] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await api.itemRemovalBlockers(itemId);
    setBlockers(result.accepted ? (result.blockers ?? []) : [result.reason ?? copy.common.unknownError]);
    setCost(result.accepted ? (result.cost ?? []) : []);
  }, [api, itemId]);

  useEffect(() => {
    void load();
  }, [load]);

  const eraseMaterial = async (): Promise<string | null> => {
    const result = await api.removeInventoryItemForGood(itemId, reason.trim() || undefined);
    if (!result.accepted) return result.reason ?? copy.common.unknownError;
    push("success", copy.removal.deleteMaterialDone(displayName));
    await onChanged();
    onDeleted();
    return null;
  };

  const askToErase = async () => {
    setBusy(true);
    try {
      const result = await api.createItemRemovalRequest({ itemId, reason: reason.trim() || undefined });
      if (!result.accepted) {
        push("error", copy.toast.failed, result.reason ?? copy.common.unknownError);
        return;
      }
      push("success", copy.removal.removalSent(displayName));
      setReason("");
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status: "ACTIVE" | "INACTIVE") => {
    setBusy(true);
    try {
      const result = await api.setInventoryItemStatus(itemId, status);
      if (!result.accepted) {
        push("error", copy.toast.failed, result.reason ?? copy.common.unknownError);
        return;
      }
      push("success", status === "ACTIVE" ? copy.removal.enabled(displayName) : copy.removal.disabled(displayName));
      await onChanged();
      if (status === "INACTIVE") onDeleted();
    } finally {
      setBusy(false);
    }
  };

  const blocked = blockers !== null && blockers.length > 0;

  return (
    <section className="rm-drawer-section rm-danger-zone" data-testid="material-removal">
      <h3 className="rm-drawer-heading">{copy.removal.deleteMaterial}</h3>

      {/* A disabled material is out of the way but still here, so the way back comes first. */}
      {disabled ? (
        <>
          <p className="field-help">{copy.removal.disabledNow}</p>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            data-testid="material-enable"
            onClick={() => void setStatus("ACTIVE")}
          >
            {copy.removal.enableAgain}
          </button>
        </>
      ) : null}

      {blockers === null ? (
        <p className="field-help">{copy.removal.checking}</p>
      ) : blocked ? (
        <>
          <p className="rm-danger-reason" role="status">
            ⚠ {copy.removal.cannotDeleteBody(blockers.join(", "))}
          </p>
          {disabled ? null : (
            <>
              <p className="field-help">{copy.removal.disableExplain}</p>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void setStatus("INACTIVE")}>
                {copy.removal.disableInstead}
              </button>
            </>
          )}
        </>
      ) : (
        <>
          <p className="field-help">
            {cost.length > 0 ? copy.removal.eraseAlsoTakes(cost.join(" and ")) : copy.removal.deleteMaterialExplain}
          </p>
          {isAdmin ? null : <p className="field-help">{copy.removal.askAdminExplain}</p>}
          <label className="input-label" htmlFor={`rm-item-removal-reason-${itemId}`}>
            {copy.removal.removalReasonLabel}
          </label>
          <input
            id={`rm-item-removal-reason-${itemId}`}
            className="form-input"
            value={reason}
            placeholder="e.g. entered by mistake"
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="rm-correction-actions">
            <button
              type="button"
              className={isAdmin ? "btn btn-danger" : "btn btn-secondary"}
              disabled={busy}
              data-testid="material-erase"
              onClick={() => (isAdmin ? setConfirming(true) : void askToErase())}
            >
              {busy ? copy.removal.sending : isAdmin ? copy.removal.eraseForGood : copy.removal.askAdminToRemove}
            </button>
            {disabled ? null : (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void setStatus("INACTIVE")}>
                {copy.removal.disableInstead}
              </button>
            )}
          </div>
        </>
      )}

      {confirming ? (
        <ConfirmDialog
          title={copy.removal.deleteMaterialTitle(displayName)}
          facts={[
            { label: "Raw Material", value: displayName },
            ...(cost.length > 0 ? [{ label: "Also erased", value: cost.join(", ") }] : []),
          ]}
          explain={cost.length > 0 ? copy.removal.eraseAlsoTakes(cost.join(" and ")) : copy.removal.deleteMaterialExplain}
          warning={copy.removal.deleteMaterialWarning}
          confirmLabel={copy.actions.delete}
          busyLabel={copy.removal.deleting}
          onConfirm={eraseMaterial}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </section>
  );
};
