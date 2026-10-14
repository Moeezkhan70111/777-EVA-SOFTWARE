import React from "react";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import type { MachineRecord } from "../../types/desktopApi";
import { machineIsReady, type LoadState } from "./useCartonProgram";

// WHICH MACHINE — asked first on both QR Generator tabs (Phase 1.1):
//
//   MACHINE   The cartons are added to this machine's program for today.
//   [● MACHINE 1      ] [  MACHINE 2      ] [  MACHINE 3              ]
//     ASLAM · BABAR       ASLAM · KHAN        ⚠ Contractors not set
//
// A radio group: one machine at a time, each one a button reachable by Tab, and the choice is said
// in words (aria-checked), not only by the highlight (R18). A machine missing a contractor cannot be
// chosen — the main process would refuse its run anyway.

const text = copy.machinePicker;

interface MachinePickerProps {
  machines: LoadState<MachineRecord>;
  selectedId: string | null;
  onSelect: (machine: MachineRecord) => void;
  /** Opens the Machine Program to set machines up; absent when this user cannot. */
  onSetUpMachines?: () => void;
}

const MachineOption: React.FC<{ machine: MachineRecord; selected: boolean; onSelect: () => void }> = ({ machine, selected, onSelect }) => {
  const ready = machineIsReady(machine);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={!ready}
      className={`mpk-option${selected ? " is-selected" : ""}`}
      onClick={onSelect}
    >
      <span className="mpk-radio" aria-hidden="true" />
      <span className="mpk-text">
        <strong>{machine.name}</strong>
        <small>
          {ready ? text.contractors(machine.contractorName ?? "", machine.packingContractorName ?? "") : `⚠ ${text.missingContractors}`}
        </small>
      </span>
    </button>
  );
};

export const MachinePicker: React.FC<MachinePickerProps> = ({ machines, selectedId, onSelect, onSetUpMachines }) => {
  const body = () => {
    if (machines.loading && machines.rows.length === 0) return <StateView kind="loading" compact message={text.loading} />;
    if (machines.error) return <StateView kind="error" compact message={machines.error} onRetry={() => void machines.reload()} />;
    if (machines.rows.length === 0) {
      return (
        <StateView
          kind="empty"
          compact
          title={text.noMachinesTitle}
          hint={text.noMachinesHint}
          action={onSetUpMachines ? { label: text.setUpMachines, onClick: onSetUpMachines } : undefined}
        />
      );
    }
    return (
      <div className="mpk-options" role="radiogroup" aria-labelledby="mpk-label">
        {machines.rows.map((machine) => (
          <MachineOption key={machine.id} machine={machine} selected={machine.id === selectedId} onSelect={() => onSelect(machine)} />
        ))}
      </div>
    );
  };

  return (
    <section className="card mpk-card">
      <div className="mpk-head">
        <h2 id="mpk-label" className="mpk-label">{text.label}</h2>
        <span className={selectedId ? "mpk-hint" : "mpk-hint mpk-hint--required"}>
          {selectedId ? text.hint : `${text.chooseFirst} ${text.hint}`}
        </span>
      </div>
      {body()}
    </section>
  );
};
