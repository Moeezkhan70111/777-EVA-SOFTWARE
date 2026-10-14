import React from "react";
import { copy } from "../../config/copy";
import type { MachineRecord } from "../../types/desktopApi";
import type { LoadState } from "../machineProgram/useCartonProgram";

// Select Machine: [ MACHINE 1 ▾ ] — every machine in service, from the machine records. Choosing one
// never moves anything already issued: each issue keeps the machine it was made to.

const text = copy.upperMoveOut;

interface MachineSelectProps {
  machines: LoadState<MachineRecord>;
  selectedId: string | null;
  onSelect: (machine: MachineRecord | null) => void;
  /** A scan is being recorded: the machine it is for must not change under it. */
  locked: boolean;
}

export const MachineSelect: React.FC<MachineSelectProps> = ({ machines, selectedId, onSelect, locked }) => {
  const status = machines.loading && machines.rows.length === 0 ? text.machinesLoading : machines.error ? text.machinesFailed : machines.rows.length === 0 ? text.noMachines : null;
  return (
    <div className="um-machine">
      <label className="um-machine-label" htmlFor="um-machine">{text.machineLabel}</label>
      <select
        id="um-machine"
        className="form-input um-machine-select"
        value={selectedId ?? ""}
        disabled={locked || machines.rows.length === 0}
        title={locked ? text.machineLocked : undefined}
        onChange={(event) => onSelect(machines.rows.find((machine) => machine.id === event.target.value) ?? null)}
      >
        <option value="">{text.chooseMachine}</option>
        {machines.rows.map((machine) => (
          <option key={machine.id} value={machine.id}>{machine.name}</option>
        ))}
      </select>
      {status ? <span className="um-machine-status" role="status">{status}</span> : null}
      {machines.error ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void machines.reload()}>{copy.common.retry}</button>
      ) : null}
    </div>
  );
};
