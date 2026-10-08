import React, { useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import { copy } from "../../config/copy";
import { Modal } from "./Modal";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog";
import { FIELD_TYPES, FIELD_TYPE_HINTS, FIELD_TYPE_LABELS, type CategoryRow, type FieldType } from "./rawMaterial";
import { DeleteCategorySection } from "./DeleteCategorySection";
import { MoveCategorySection } from "./MoveCategorySection";

// The attributes assigned to one category, with their dropdown options. Editing an attribute
// or removing it from a category changes the category, not the materials already created from
// it — an existing material keeps the values it was saved with, because its identity is a
// signature over them.

interface CategoryAttributesProps {
  category: CategoryRow;
  onChanged: () => Promise<void>;
  onRename: () => void;
  /** What its materials come in — its own, else its parent's, else PACKET. */
  packName: string;
  /** An administrator decides a removal; everyone else asks for one. */
  isAdmin: boolean;
  /** The whole tree, so this category can be offered a new parent. */
  categories: CategoryRow[];
}

export const CategoryAttributes: React.FC<CategoryAttributesProps> = ({ category, packName, isAdmin, categories, onChanged, onRename }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const fields = (category.fields ?? []) as Array<Record<string, unknown>>;

  const [optionDrafts, setOptionDrafts] = useState<Record<string, string>>({});
  const [addingOptionFor, setAddingOptionFor] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [editDraft, setEditDraft] = useState({ label: "", fieldType: "TEXT" as FieldType, required: false, searchable: true });
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<Record<string, unknown> | null>(null);
  /** The dropdown choice waiting for a go-ahead to be removed. */
  const [removingOption, setRemovingOption] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);

  const addOption = async (fieldId: string) => {
    const value = (optionDrafts[fieldId] ?? "").trim();
    if (!value) return;
    const result = await api.addInventoryFieldOption({ fieldId, value: value.toUpperCase() });
    if (!result.accepted) {
      push("error", "Option not added", result.reason ?? "The option could not be saved.");
      return;
    }
    setOptionDrafts({ ...optionDrafts, [fieldId]: "" });
    setAddingOptionFor(null);
    await onChanged();
  };

  /**
   * Removing a choice is refused by the data layer while any material still carries it, and the
   * refusal names those materials — so the confirmation asks first and shows that answer rather
   * than this component deciding for itself.
   */
  const removeOption = async (): Promise<string | null> => {
    if (!removingOption) return null;
    const result = await api.deleteInventoryFieldOption(String(removingOption.id));
    if (!result.accepted) return result.reason ?? copy.common.unknownError;
    push("success", copy.removal.deleteOptionDone(String(removingOption.option_value ?? "")));
    await onChanged();
    return null;
  };

  const saveAttribute = async () => {
    if (!editing || !editDraft.label.trim()) return;
    setSaving(true);
    try {
      const result = await api.updateInventoryCategoryField(String(editing.id), editDraft);
      if (!result.accepted) {
        push("error", "Attribute not updated", result.reason ?? "The attribute could not be saved.");
        return;
      }
      push("success", "Attribute updated", editDraft.label);
      setEditing(null);
      await onChanged();
    } finally {
      setSaving(false);
    }
  };

  const removeAttribute = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      const result = await api.removeInventoryCategoryField(String(removing.id));
      if (!result.accepted) {
        push("error", "Attribute not removed", result.reason ?? "The attribute could not be removed.");
        return;
      }
      push("success", "Attribute removed", String(removing.label));
      setRemoving(null);
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="inv-cat-assigned-panel">
      <div className="inv-cat-assigned-header">
        <div className="inv-cat-assigned-title">
          <span className="inv-cat-eyebrow">Attributes in</span>
          <h2 className="inv-cat-cat-name">{String(category.path_name ?? category.name)}</h2>
          <span className="inv-cat-pack">Comes in: <strong>{packName}</strong></span>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRename}>
          ✎ Edit
        </button>
      </div>

      {fields.length === 0 ? (
        <div className="inv-cat-empty-state inv-cat-empty-state--sm">
          <span>No attributes assigned yet.</span>
          <span className="rm-muted">Every material in this category would be the same material. Add one from the library.</span>
        </div>
      ) : (
        <div className="inv-cat-field-table">
          <div className="inv-cat-field-thead">
            <span>Attribute</span>
            <span>{copy.columns.type}</span>
            <span>Flags</span>
            <span />
          </div>

          {fields.map((field) => {
            const fieldId = String(field.id);
            const fieldType = String(field.field_type ?? "");
            const isDropdown = fieldType === "DROPDOWN";
            const options = Array.isArray(field.options) ? (field.options as Array<Record<string, unknown>>) : [];

            return (
              <div key={fieldId} className="inv-cat-field-row-group">
                <div className="inv-cat-field-row">
                  <span className="inv-cat-field-name">
                    {String(field.label)}
                    {field.inherited_from ? (
                      <span className="inv-cat-inherited" title="Defined on the parent category — change it there and every sub-category follows">
                        from {String(field.inherited_from)}
                      </span>
                    ) : null}
                  </span>
                  <span className={`inv-cat-type-pill inv-cat-type-pill--${fieldType.toLowerCase()}`}>
                    {FIELD_TYPE_LABELS[fieldType as FieldType] ?? fieldType}
                  </span>
                  <span className="inv-cat-field-flags">
                    {field.is_required ? <span className="inv-cat-flag inv-cat-flag--req">required</span> : null}
                    {field.is_searchable ? <span className="inv-cat-flag inv-cat-flag--search">searchable</span> : null}
                  </span>
                  <span className="inv-cat-field-actions">
                    {/* An inherited attribute is edited where it is defined, on the parent. */}
                    {field.inherited_from ? null : isDropdown ? (
                      <button
                        type="button"
                        className="inv-cat-add-badge inv-cat-add-badge--add"
                        onClick={() => setAddingOptionFor((current) => (current === fieldId ? null : fieldId))}
                      >
                        + Option
                      </button>
                    ) : null}
                    {field.inherited_from ? null : <button
                      type="button"
                      className="inv-cat-add-badge"
                      onClick={() => {
                        setEditing(field);
                        setEditDraft({
                          label: String(field.label ?? ""),
                          fieldType: String(field.field_type ?? "TEXT") as FieldType,
                          required: Boolean(field.is_required),
                          searchable: Boolean(field.is_searchable ?? true),
                        });
                      }}
                    >
                      {copy.actions.edit}
                    </button>}
                    {field.inherited_from ? null : <button
                      type="button"
                      className="inv-cat-remove-btn"
                      onClick={() => setRemoving(field)}
                      aria-label={`Remove ${String(field.label)}`}
                      title="Remove from this category"
                    >
                      ×
                    </button>}
                  </span>
                </div>

                {isDropdown && options.length > 0 ? (
                  <div className="inv-cat-options-row">
                    {options.map((option) => (
                      <span key={String(option.id)} className="inv-cat-option-chip">
                        {String(option.display_label ?? option.option_value)}
                        <button
                          type="button"
                          className="inv-cat-option-remove"
                          aria-label={`Remove ${String(option.display_label ?? option.option_value)} from ${String(field.label)}`}
                          title={copy.removal.deleteOption}
                          onClick={() => setRemovingOption(option)}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}

                {isDropdown && addingOptionFor === fieldId ? (
                  <div className="inv-cat-option-add-row">
                    <input
                      className="form-input inv-cat-option-input"
                      aria-label={`New ${String(field.label)} option`}
                      value={optionDrafts[fieldId] ?? ""}
                      placeholder="New option…"
                      autoFocus
                      onChange={(event) => setOptionDrafts({ ...optionDrafts, [fieldId]: event.target.value.toUpperCase() })}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void addOption(fieldId);
                        }
                        if (event.key === "Escape") {
                          event.stopPropagation();
                          setAddingOptionFor(null);
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={!(optionDrafts[fieldId] ?? "").trim()}
                      onClick={() => void addOption(fieldId)}
                    >
                      {copy.actions.add}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAddingOptionFor(null)}>
                      {copy.common.cancel}
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {/* Where it is filed, then removing it — both come under everything it is made of. */}
      <MoveCategorySection category={category} categories={categories} onChanged={onChanged} />

      <DeleteCategorySection
        categoryId={String(category.id)}
        name={String(category.name)}
        isAdmin={isAdmin}
        onChanged={onChanged}
      />

      {editing ? (
        <Modal
          title="Edit attribute"
          subtitle={String(editing.field_key ?? "")}
          onClose={() => setEditing(null)}
          footer={
            <button type="button" className="btn btn-primary" disabled={saving || !editDraft.label.trim()} onClick={() => void saveAttribute()}>
              {saving ? "Saving…" : copy.common.save}
            </button>
          }
        >
          <div className="form-group">
            <label className="input-label" htmlFor="rm-attr-label">
              Label<span className="required-mark"> *</span>
            </label>
            <input
              id="rm-attr-label"
              className="form-input"
              autoFocus
              value={editDraft.label}
              onChange={(event) => setEditDraft({ ...editDraft, label: event.target.value.toUpperCase() })}
            />
          </div>
          <div className="form-group">
            <label className="input-label" htmlFor="rm-attr-type">
              {copy.columns.type}
            </label>
            <select
              id="rm-attr-type"
              className="form-input"
              value={editDraft.fieldType}
              onChange={(event) => setEditDraft({ ...editDraft, fieldType: event.target.value as FieldType })}
            >
              {FIELD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {FIELD_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
            <span className="field-help">{FIELD_TYPE_HINTS[editDraft.fieldType]}</span>
          </div>
          <label className="inv-cat-check-label">
            <input
              type="checkbox"
              checked={editDraft.required}
              onChange={(event) => setEditDraft({ ...editDraft, required: event.target.checked })}
            />
            Required when creating a material
          </label>
          <label className="inv-cat-check-label">
            <input
              type="checkbox"
              checked={editDraft.searchable}
              onChange={(event) => setEditDraft({ ...editDraft, searchable: event.target.checked })}
            />
            Searchable
          </label>
        </Modal>
      ) : null}

      {removing ? (
        <Modal
          title={`Remove ${String(removing.label)}?`}
          subtitle={`From ${String(category.name)}`}
          onClose={() => setRemoving(null)}
          footer={
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void removeAttribute()}>
              {busy ? "Removing…" : "Remove"}
            </button>
          }
        >
          <p className="rm-modal-text">
            New materials in this category will no longer ask for it. Materials already created keep the values they were
            saved with.
          </p>
        </Modal>
      ) : null}
      {removingOption ? (
        <ConfirmDialog
          title={copy.removal.deleteOptionTitle(String(removingOption.option_value ?? ""))}
          facts={[{ label: "Choice", value: String(removingOption.display_label ?? removingOption.option_value ?? "") }]}
          explain={copy.removal.deleteOptionExplain}
          confirmLabel={copy.actions.remove}
          busyLabel={copy.removal.deleting}
          onConfirm={removeOption}
          onClose={() => setRemovingOption(null)}
        />
      ) : null}
    </div>
  );
};
