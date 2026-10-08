import React, { useMemo, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import { copy } from "../../config/copy";
import { Modal } from "./Modal";
import {
  FIELD_TYPES,
  FIELD_TYPE_HINTS,
  FIELD_TYPE_LABELS,
  type CategoryRow,
  type FieldType,
  type LibraryAttribute,
} from "./rawMaterial";

// The shared attribute library: define COLOUR or SIZE once, then add it to whichever
// categories need it. An attribute exists by being attached to at least one category, so
// creating one here means creating it on the selected category.

const emptyDraft = { fieldKey: "", label: "", fieldType: "DROPDOWN" as FieldType, required: false, searchable: true };

interface AttributeLibraryProps {
  library: LibraryAttribute[];
  selectedCategory: CategoryRow | undefined;
  onChanged: () => Promise<void>;
}

export const AttributeLibrary: React.FC<AttributeLibraryProps> = ({ library, selectedCategory, onChanged }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const assignedKeys = useMemo(
    () => new Set((selectedCategory?.fields ?? []).map((field) => String(field.field_key ?? ""))),
    [selectedCategory]
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return library;
    return library.filter(
      (attribute) => attribute.label.toLowerCase().includes(needle) || attribute.fieldKey.toLowerCase().includes(needle)
    );
  }, [library, search]);

  const assign = async (attribute: LibraryAttribute) => {
    if (!selectedCategory) return;
    setBusyKey(attribute.fieldKey);
    try {
      const result = await api.addInventoryCategoryField({
        categoryId: String(selectedCategory.id),
        fieldKey: attribute.fieldKey,
        label: attribute.label,
        fieldType: attribute.fieldType,
        required: false,
        searchable: true,
      });
      if (!result.accepted) {
        push("error", copy.toast.addFailed, result.reason ?? "That attribute could not be added.");
        return;
      }
      push("success", "Attribute added", `${attribute.label} → ${String(selectedCategory.name)}`);
      await onChanged();
    } finally {
      setBusyKey(null);
    }
  };

  const create = async () => {
    if (!selectedCategory) {
      push("error", "Pick a category first", "A new attribute has to be attached to a category.");
      return;
    }
    if (!draft.fieldKey.trim() || !draft.label.trim()) return;
    setSaving(true);
    try {
      const result = await api.addInventoryCategoryField({
        categoryId: String(selectedCategory.id),
        fieldKey: draft.fieldKey.toUpperCase(),
        label: draft.label.toUpperCase(),
        fieldType: draft.fieldType,
        required: draft.required,
        searchable: draft.searchable,
      });
      if (!result.accepted) {
        push("error", "Attribute not created", result.reason ?? "The attribute could not be saved.");
        return;
      }
      push("success", "Attribute created", draft.label);
      setDraft(emptyDraft);
      setCreating(false);
      await onChanged();
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside className="inv-cat-library">
      <div className="inv-cat-library-header">
        <div className="inv-cat-library-title">
          <span className="inv-cat-eyebrow">Attribute library</span>
          <span className="inv-cat-count">{library.length}</span>
        </div>
        <button type="button" className="btn btn-primary inv-cat-create-btn" onClick={() => { setDraft(emptyDraft); setCreating(true); }}>
          + New
        </button>
      </div>

      <div className="inv-cat-lib-search-wrap">
        <svg className="inv-cat-lib-search-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path
            fillRule="evenodd"
            d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
            clipRule="evenodd"
          />
        </svg>
        <input
          className="form-input inv-cat-lib-search"
          aria-label="Search attributes"
          placeholder="Search attributes…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <div className="inv-cat-library-list">
        {filtered.length === 0 ? (
          <div className="rm-muted inv-cat-lib-empty">
            {library.length === 0 ? "No attributes yet. Create the first one." : "No matches for that search."}
          </div>
        ) : null}
        {filtered.map((attribute) => {
          const already = assignedKeys.has(attribute.fieldKey);
          const busy = busyKey === attribute.fieldKey;
          return (
            <div key={attribute.fieldKey} className={`inv-cat-lib-row${already ? " inv-cat-lib-row--assigned" : ""}`}>
              <div className="inv-cat-lib-row-info">
                <span className="inv-cat-lib-label">{attribute.label}</span>
                <span className={`inv-cat-type-pill inv-cat-type-pill--${attribute.fieldType.toLowerCase()}`}>
                  {FIELD_TYPE_LABELS[attribute.fieldType as FieldType] ?? attribute.fieldType}
                </span>
              </div>
              <div className="inv-cat-lib-row-meta">
                <span className="inv-cat-lib-used" title={attribute.usedIn.join(", ")}>
                  {attribute.usedIn.length} {attribute.usedIn.length === 1 ? "category" : "categories"}
                </span>
              </div>
              <button
                type="button"
                className={`inv-cat-lib-add-btn${already ? " inv-cat-lib-add-btn--done" : ""}`}
                disabled={already || busy || !selectedCategory}
                onClick={() => void assign(attribute)}
                title={
                  !selectedCategory
                    ? "Select a category first"
                    : already
                      ? "Already in this category"
                      : `Add to ${String(selectedCategory.name)}`
                }
              >
                {busy ? "…" : already ? "✓ Added" : "+ Add"}
              </button>
            </div>
          );
        })}
      </div>

      {creating ? (
        <Modal
          title="New attribute"
          subtitle={selectedCategory ? `Added to ${String(selectedCategory.name)}` : "Select a category first"}
          onClose={() => setCreating(false)}
          footer={
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || !draft.fieldKey.trim() || !draft.label.trim() || !selectedCategory}
              onClick={() => void create()}
            >
              {saving ? "Saving…" : "Create attribute"}
            </button>
          }
        >
          <div className="rm-form-grid">
            <div className="form-group">
              <label className="input-label" htmlFor="rm-lib-key">
                Key<span className="required-mark"> *</span>
              </label>
              <input
                id="rm-lib-key"
                className="form-input"
                autoFocus
                placeholder="e.g. COLOR"
                value={draft.fieldKey}
                onChange={(event) => setDraft({ ...draft, fieldKey: event.target.value.toUpperCase() })}
              />
              <span className="field-help">How the system refers to it. Shared across categories.</span>
            </div>
            <div className="form-group">
              <label className="input-label" htmlFor="rm-lib-label">
                Label<span className="required-mark"> *</span>
              </label>
              <input
                id="rm-lib-label"
                className="form-input"
                placeholder="e.g. COLOR"
                value={draft.label}
                onChange={(event) => setDraft({ ...draft, label: event.target.value.toUpperCase() })}
              />
            </div>
          </div>

          <div className="form-group">
            <label className="input-label" htmlFor="rm-lib-type">
              {copy.columns.type}
            </label>
            <select
              id="rm-lib-type"
              className="form-input"
              value={draft.fieldType}
              onChange={(event) => setDraft({ ...draft, fieldType: event.target.value as FieldType })}
            >
              {FIELD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {FIELD_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
            <span className="field-help">{FIELD_TYPE_HINTS[draft.fieldType]}</span>
          </div>

          <label className="inv-cat-check-label">
            <input type="checkbox" checked={draft.required} onChange={(event) => setDraft({ ...draft, required: event.target.checked })} />
            Required when creating a material
          </label>
          <label className="inv-cat-check-label">
            <input type="checkbox" checked={draft.searchable} onChange={(event) => setDraft({ ...draft, searchable: event.target.checked })} />
            Searchable
          </label>
        </Modal>
      ) : null}
    </aside>
  );
};
