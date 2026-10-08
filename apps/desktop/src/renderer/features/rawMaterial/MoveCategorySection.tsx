import React, { useCallback, useEffect, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import type { CategoryMovePreview } from "../../types/desktopApi";
import { copy } from "../../config/copy";
import { categoryPath, descendantsOf, type CategoryRow } from "./rawMaterial";

// Filing a category somewhere else — under another kind of material, or back out to the top.
//
// What a move would do, and what would stop it, is the data layer's answer: picking a
// destination asks for a preview and shows it, and the Move button is only live when that
// preview has nothing against it. The same rules refuse the move itself, so this screen can
// never talk anybody past a guard.

interface MoveCategorySectionProps {
  category: CategoryRow;
  categories: CategoryRow[];
  /** Re-reads the tree once something actually moved. */
  onChanged: () => Promise<void>;
}

const TOP_LEVEL = "__TOP__";

export const MoveCategorySection: React.FC<MoveCategorySectionProps> = ({ category, categories, onChanged }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const currentParent = category.parent_id ? String(category.parent_id) : TOP_LEVEL;
  const [choice, setChoice] = useState(currentParent);
  const [preview, setPreview] = useState<CategoryMovePreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);

  // A different category each time the panel changes: start from where it actually sits.
  useEffect(() => {
    setChoice(currentParent);
    setPreview(null);
  }, [currentParent, category.id]);

  const parentIdOf = (value: string) => (value === TOP_LEVEL ? null : value);

  const check = useCallback(
    async (value: string) => {
      setChecking(true);
      try {
        const result = await api.previewCategoryMove(String(category.id), parentIdOf(value));
        setPreview(result.accepted ? (result.preview ?? null) : { blockers: [result.reason ?? copy.common.unknownError], from: "", to: "", renames: 0 });
      } finally {
        setChecking(false);
      }
    },
    [api, category.id],
  );

  const choose = (value: string) => {
    setChoice(value);
    setPreview(null);
    if (value !== currentParent) void check(value);
  };

  const move = async () => {
    setBusy(true);
    try {
      const result = await api.moveInventoryCategory(String(category.id), parentIdOf(choice));
      if (!result.accepted) {
        push("error", copy.toast.failed, result.reason ?? copy.common.unknownError);
        return;
      }
      push("success", copy.removal.moveDone(String(category.name), preview?.to ?? ""));
      setPreview(null);
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  // Anything can take sub-categories, at any depth — except this category itself and
  // anything already inside it, which would cut that branch out of the tree.
  const inside = new Set(descendantsOf(categories, String(category.id)).map((row) => String(row.id)));
  const destinations = categories
    .filter((row) => String(row.id) !== String(category.id) && !inside.has(String(row.id)))
    .sort((a, b) => categoryPath(a).localeCompare(categoryPath(b)));
  const moved = choice !== currentParent;
  const blocked = (preview?.blockers.length ?? 0) > 0;

  return (
    <section className="rm-drawer-section" data-testid="category-move">
      <h3 className="rm-drawer-heading">{copy.removal.moveCategory}</h3>
      <p className="field-help">{copy.removal.moveCategoryExplain}</p>

      <select
        className="form-input"
        aria-label={copy.removal.moveCategory}
        value={choice}
        data-testid="category-move-target"
        onChange={(event) => choose(event.target.value)}
      >
        <option value={TOP_LEVEL}>{copy.removal.moveCategoryTop}</option>
        {destinations.map((row) => (
          <option key={String(row.id)} value={String(row.id)}>
            {categoryPath(row)}
          </option>
        ))}
      </select>

      {checking ? <p className="field-help">{copy.removal.checking}</p> : null}

      {preview && moved ? (
        blocked ? (
          <p className="rm-danger-reason" role="status">
            ⚠ {preview.blockers.join(" ")}
          </p>
        ) : (
          <>
            <p className="field-help" role="status">
              {preview.from} → <strong>{preview.to}</strong>. {copy.removal.moveRenames(preview.renames)}
            </p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              data-testid="category-move-do"
              onClick={() => void move()}
            >
              {busy ? copy.removal.moving : copy.removal.moveDo}
            </button>
          </>
        )
      ) : null}
    </section>
  );
};
