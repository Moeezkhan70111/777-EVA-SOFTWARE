import React, { useCallback, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import type { InventoryItemMovePreview } from "../../types/desktopApi";
import { copy } from "../../config/copy";
import { categoryPath, type CategoryRow } from "./rawMaterial";

// Filing a material under another category.
//
// A material belongs to a LEAF — a category with sub-categories is a grouping — so only
// leaves are offered. Its attribute values travel with it by name, and the ones the new
// category does not ask for are let go; what exactly will happen is the data layer's answer,
// shown before anything is pressed. The Move button is live only when that answer has nothing
// against it, and the same rules refuse the move itself.

interface MoveMaterialSectionProps {
  itemId: string;
  displayName: string;
  categoryId: string;
  categories: CategoryRow[];
  /** Re-reads the list once the material has actually moved. */
  onChanged: () => Promise<void>;
}

export const MoveMaterialSection: React.FC<MoveMaterialSectionProps> = ({
  itemId,
  displayName,
  categoryId,
  categories,
  onChanged,
}) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [choice, setChoice] = useState("");
  const [preview, setPreview] = useState<InventoryItemMovePreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);

  const check = useCallback(
    async (target: string) => {
      setChecking(true);
      try {
        const result = await api.previewInventoryItemMove(itemId, target);
        setPreview(
          result.accepted
            ? (result.preview ?? null)
            : { blockers: [result.reason ?? copy.common.unknownError], carried: [], dropped: [], missingRequired: [], from: "", to: "", newDisplayName: "" },
        );
      } finally {
        setChecking(false);
      }
    },
    [api, itemId],
  );

  const choose = (value: string) => {
    setChoice(value);
    setPreview(null);
    if (value) void check(value);
  };

  const move = async () => {
    setBusy(true);
    try {
      const result = await api.moveInventoryItem(itemId, choice);
      if (!result.accepted) {
        push("error", copy.toast.failed, result.reason ?? copy.common.unknownError);
        return;
      }
      push("success", copy.removal.moveDone(displayName, preview?.to ?? ""));
      setChoice("");
      setPreview(null);
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  // A material can be filed at any level, beside sub-categories or not — anywhere but where
  // it already is.
  const destinations = categories
    .filter((row) => String(row.id) !== categoryId)
    .sort((a, b) => categoryPath(a).localeCompare(categoryPath(b)));

  const blocked = (preview?.blockers.length ?? 0) > 0;

  return (
    <section className="rm-drawer-section" data-testid="material-move">
      <h3 className="rm-drawer-heading">{copy.removal.moveMaterial}</h3>
      <p className="field-help">{copy.removal.moveMaterialExplain}</p>

      <select
        className="form-input"
        aria-label={copy.removal.moveMaterial}
        value={choice}
        data-testid="material-move-target"
        onChange={(event) => choose(event.target.value)}
      >
        <option value="">{copy.removal.moveChoose}</option>
        {destinations.map((row) => (
          <option key={String(row.id)} value={String(row.id)}>
            {categoryPath(row)}
          </option>
        ))}
      </select>

      {checking ? <p className="field-help">{copy.removal.checking}</p> : null}

      {preview && choice ? (
        blocked ? (
          <p className="rm-danger-reason" role="status">
            ⚠ {preview.blockers.join(" ")}
          </p>
        ) : (
          <div className="rm-move-preview" role="status">
            <p className="field-help">
              {preview.from} → <strong>{preview.to}</strong>
            </p>
            {preview.carried.length > 0 ? (
              <p className="field-help">
                {copy.removal.moveCarried}: {preview.carried.map((entry) => `${entry.label} ${entry.value}`).join(" · ")}
              </p>
            ) : null}
            {preview.dropped.length > 0 ? (
              <p className="rm-danger-reason">
                ⚠ {copy.removal.moveDropped}: {preview.dropped.map((entry) => `${entry.label} ${entry.value}`).join(" · ")}
              </p>
            ) : null}
            <p className="field-help">
              {copy.removal.moveNewName}: <strong>{preview.newDisplayName}</strong>
            </p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              data-testid="material-move-do"
              onClick={() => void move()}
            >
              {busy ? copy.removal.moving : copy.removal.moveDo}
            </button>
          </div>
        )
      ) : null}
    </section>
  );
};
