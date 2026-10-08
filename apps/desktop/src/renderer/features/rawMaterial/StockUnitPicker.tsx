import React, { useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import { AddUnitModal } from "./AddUnitModal";

// Sets the unit a material's stock is counted in, for a material saved without one. Used in the
// material drawer and, where the gap is usually discovered, in the label generator.
//
// The data layer only allows it while the material has no stock, movement or label yet, and says
// so in words if it is refused — this picker never decides that itself.

interface StockUnitPickerProps {
  itemId: string;
  displayName: string;
  units: Array<Record<string, unknown>>;
  /** The unit it has now, if any — preselected so a wrong one can be corrected. */
  currentUnitId?: string | null;
  /** Re-reads units and materials after a save or a new unit. */
  onSaved: () => Promise<void> | void;
}

export const StockUnitPicker: React.FC<StockUnitPickerProps> = ({ itemId, displayName, units, currentUnitId, onSaved }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [unitId, setUnitId] = useState(currentUnitId ?? "");
  const [saving, setSaving] = useState(false);
  const [addingUnit, setAddingUnit] = useState(false);

  const save = async () => {
    if (!unitId) return;
    setSaving(true);
    try {
      const result = await api.setInventoryItemUnit(itemId, unitId);
      if (!result.accepted) {
        push("error", "Unit not set", result.reason ?? "The unit could not be set.");
        return;
      }
      const code = units.find((unit) => String(unit.id) === unitId)?.code;
      push("success", "Stock unit set", `${displayName} is counted in ${String(code ?? "")}`.trim());
      await onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rm-unit-picker">
      <label className="input-label" htmlFor={`rm-unit-${itemId}`}>
        Stock unit
      </label>
      <div className="rm-unit-picker-row">
        <select
          id={`rm-unit-${itemId}`}
          className="form-input"
          value={unitId}
          onChange={(event) => setUnitId(event.target.value)}
        >
          <option value="">Select a unit…</option>
          {units.map((unit) => (
            <option key={String(unit.id)} value={String(unit.id)}>
              {String(unit.code)} — {String(unit.name ?? "")}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-secondary" title="Add a new unit" aria-label="Add a new unit" onClick={() => setAddingUnit(true)}>
          +
        </button>
        <button type="button" className="btn btn-primary" disabled={!unitId || unitId === currentUnitId || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save unit"}
        </button>
      </div>
      {addingUnit ? (
        <AddUnitModal
          onClose={() => setAddingUnit(false)}
          onCreated={async (newUnitId) => {
            await onSaved();
            if (newUnitId) setUnitId(newUnitId);
          }}
        />
      ) : null}
    </div>
  );
};
