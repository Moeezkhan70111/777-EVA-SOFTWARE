import React, { useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import { copy } from "../../config/copy";
import { Modal } from "./Modal";

// Creating a unit of measure. Previously written twice, identically — once on the Add Raw
// Material page and once on the Item Categories page — so a change to one never reached the
// other.

interface AddUnitModalProps {
  onClose: () => void;
  /** Called with the new unit's id, so the caller can select what was just created. */
  onCreated: (unitId: string) => void;
}

export const AddUnitModal: React.FC<AddUnitModalProps> = ({ onClose, onCreated }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [draft, setDraft] = useState({ code: "", name: "", symbol: "" });
  const [saving, setSaving] = useState(false);

  const canSave = draft.code.trim() !== "" && draft.name.trim() !== "";

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const result = await api.createInventoryUnit(draft);
      if (!result.accepted) {
        push("error", "Unit not created", result.reason ?? "The unit could not be saved.");
        return;
      }
      push("success", "Unit created", draft.name);
      onCreated(result.id ? String(result.id) : "");
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const submitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void save();
    }
  };

  return (
    <Modal
      title="Add a unit"
      subtitle="A unit of measure materials can be counted in."
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" disabled={saving || !canSave} onClick={() => void save()}>
          {saving ? "Creating…" : "Create unit"}
        </button>
      }
    >
      <div className="form-group">
        <label className="input-label" htmlFor="rm-unit-code">
          {copy.columns.code}
          <span className="required-mark"> *</span>
        </label>
        <input
          id="rm-unit-code"
          className="form-input"
          autoFocus
          value={draft.code}
          placeholder="e.g. DZN"
          onChange={(event) => setDraft({ ...draft, code: event.target.value.toUpperCase() })}
          onKeyDown={submitOnEnter}
        />
      </div>

      <div className="form-group">
        <label className="input-label" htmlFor="rm-unit-name">
          {copy.columns.name}
          <span className="required-mark"> *</span>
        </label>
        <input
          id="rm-unit-name"
          className="form-input"
          value={draft.name}
          placeholder="e.g. Dozen"
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          onKeyDown={submitOnEnter}
        />
      </div>

      <div className="form-group">
        <label className="input-label" htmlFor="rm-unit-symbol">
          Symbol
        </label>
        <input
          id="rm-unit-symbol"
          className="form-input"
          value={draft.symbol}
          placeholder="Optional"
          onChange={(event) => setDraft({ ...draft, symbol: event.target.value })}
          onKeyDown={submitOnEnter}
        />
      </div>
    </Modal>
  );
};
