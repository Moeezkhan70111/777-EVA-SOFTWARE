import React, { useCallback, useEffect, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import type { MachineRecord, WorkSection } from "../../types/desktopApi";
import { copy } from "../../config/copy";
import { useAddMachine } from "./useAddMachine";

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
  // The same save the Machine Program's + Add Machine uses (one implementation, R1).
  const { name, setName, sectionId, setSectionId, saving, problem, add: addMachine } = useAddMachine(sections);

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

  const add = async () => {
    const machine = await addMachine();
    if (!machine) return;
    push("success", copy.machineProgram.machineAddedTitle, machine.name);
    await reload();
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

      {/* A name is all a machine needs; the section is offered only when there is one to pick. */}
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
        {sections.length > 0 ? (
          <>
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
          </>
        ) : null}
        <button type="button" className="btn btn-primary btn-sm" disabled={saving || !name.trim()} onClick={() => void add()}>
          {saving ? copy.machineProgram.addingMachine : copy.machineProgram.addMachine}
        </button>
      </div>
      {problem ? (
        <span className="rm-muted" role="alert">
          ⚠ {problem}
        </span>
      ) : null}
    </div>
  );
};
