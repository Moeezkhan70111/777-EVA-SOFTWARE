import React from "react";
import { copy } from "../../config/copy";
import type { Gatepass } from "../../types/desktopApi";
import { partyIsLocked } from "./gatepassEdit";

// Above the draft while a stored gatepass is being edited: what is being edited, what happens to its bill, and the
// reason the edit is kept under (required).

interface GatepassEditBarProps {
  document: Gatepass;
  reason: string;
  onReason: (reason: string) => void;
}

export const GatepassEditBar: React.FC<GatepassEditBarProps> = ({ document, reason, onReason }) => (
  <section className="card gp-card gp-section gp-edit-bar" data-testid="gatepass-edit-bar" aria-label={copy.gatepass.editTitle(document.code)}>
    <p className="gp-edit-note">{copy.gatepass.editingNote(document.code)}</p>
    {partyIsLocked(document) ? <p className="gp-edit-note">{copy.gatepass.editingBilledNote}</p> : null}
    <label className="gp-edit-reason">
      <span>{copy.gatepass.reasonLabel}</span>
      <input
        className="form-input"
        type="text"
        maxLength={200}
        required
        value={reason}
        placeholder={copy.gatepass.reasonPlaceholder}
        onChange={(event) => onReason(event.target.value)}
      />
    </label>
  </section>
);
