import React, { useCallback, useEffect, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import type { MachineRecord, WorkSection } from "../../types/desktopApi";
import { copy } from "../../config/copy";

// The machines on the floor, and the destination each one stands in.
//
// A machine is not a destination: DestinationsPanel above lists the places a packet is SENT
// (MACHINE, PACKING), while this lists the individual machines standing in one of them. The link
// is what decides what a machine can be programmed with — a material whose route sends it to this
// machine's section can go on its program, and one the store sends elsewhere cannot.
//
// It lives here because machines are master data, gated on the same stock permission as the rest
// of raw material setup rather than on who may write a program.

interface MachinesPanelProps {
  sections: WorkSection[];
}

export const MachinesPanel: React.FC<MachinesPanelProps> = ({ sections }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [machines, setMachines] = useState<MachineRecord[]>([]);
  const [name, setName] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      setMachines(await api.listMachines(true));
    } catch {
      setMachines([]);
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Most floors have one section their machines stand in, so it is chosen for them.
  useEffect(() => {
    if (!sectionId && sections.length > 0) setSectionId(sections[0].id);
  }, [sections, sectionId]);

  const add = async () => {
    const trimmed = name.trim();
    if (!trimmed || !sectionId) return;
    setSaving(true);
    try {
      const result = await api.createMachine({ name: trimmed, sectionId });
      if (!result.accepted) {
        push("error", "Machine not added", result.reason ?? "The machine could not be saved.");
        return;
      }
      push("success", "Machine added", trimmed);
      setName("");
      await reload();
    } finally {
      setSaving(false);
    }
  };

  const setStatus = async (machine: MachineRecord, status: "ACTIVE" | "INACTIVE") => {
    const result = await api.setMachineStatus(machine.id, status);
    if (!result.accepted) {
      push("error", "Machine not updated", result.reason ?? "The machine could not be updated.");
      return;
    }
    await reload();
  };

  return (
    <div className="rm-setup-card">
      <div className="rm-setup-card-head">
        <h3 className="rm-setup-card-title">{copy.machineProgram.machines}</h3>
        <span className="rm-section-note">{copy.machineProgram.machinesHint}</span>
      </div>

      {machines.length === 0 ? (
        <span className="rm-muted">{copy.machineProgram.machinesEmpty}</span>
      ) : (
        <ul className="rm-machine-list">
          {machines.map((machine) => (
            <li key={machine.id} className={`rm-machine-row${machine.status === "ACTIVE" ? "" : " is-retired"}`}>
              <span className="rm-machine-name">{machine.name}</span>
              <span className="rm-machine-section">{machine.sectionName}</span>
              <span className="rm-machine-status">{machine.status === "ACTIVE" ? "In use" : "Retired"}</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void setStatus(machine, machine.status === "ACTIVE" ? "INACTIVE" : "ACTIVE")}
              >
                {machine.status === "ACTIVE" ? copy.machineProgram.retireMachine : copy.machineProgram.restoreMachine}
              </button>
            </li>
          ))}
        </ul>
      )}

      {sections.length === 0 ? (
        <span className="rm-muted">Add a destination above before adding machines — a machine has to stand somewhere.</span>
      ) : (
        <div className="rm-inline-add">
          <label htmlFor="rm-new-machine" className="input-label">
            {copy.machineProgram.machineName}
          </label>
          <input
            id="rm-new-machine"
            className="form-input"
            value={name}
            placeholder="e.g. Machine 1"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void add();
              }
            }}
          />
          <label htmlFor="rm-new-machine-section" className="input-label">
            {copy.machineProgram.machineSection}
          </label>
          <select
            id="rm-new-machine-section"
            className="form-input"
            value={sectionId}
            onChange={(event) => setSectionId(event.target.value)}
          >
            {sections.map((section) => (
              <option key={section.id} value={section.id}>
                {section.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-primary btn-sm" disabled={saving || !name.trim()} onClick={() => void add()}>
            {saving ? "Adding…" : copy.machineProgram.addMachine}
          </button>
        </div>
      )}
    </div>
  );
};
