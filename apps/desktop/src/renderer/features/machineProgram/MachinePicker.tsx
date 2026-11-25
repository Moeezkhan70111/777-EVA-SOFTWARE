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
//
// CHANGING CONTRACTORS FROM THE CARD (owner, 25 Nov 2026): given `onEditContractors`, each card carries a pencil
// beside it that opens the machine's contractors (MachineDialog). It is its own button, so choosing a machine and
// changing its contractors are never the same click; a machine missing a contractor is put right from here too.

const text = copy.machinePicker;

interface MachinePickerProps {
  machines: LoadState<MachineRecord>;
  selectedId: string | null;
  onSelect: (machine: MachineRecord) => void;
  /** Opens the Machine Program to set machines up; absent when this user cannot. */
  onSetUpMachines?: () => void;
  /** Numbers the picker as a step of a page (Manual Production's step 1): a tick once a machine is chosen. */
  step?: number;
  /**
   * A short line under a machine, by machine id (Manual Production, 25 Nov 2026: "✓ 12 dozen saved today"), so the
   * operator sees which machines are in without looking it up (recognition over recall). Said in words, not colour.
   */
  notes?: ReadonlyMap<string, string>;
  /** The line under the heading ("The cartons are added to ..."). Manual Production leaves it out (25 Nov 2026: clutter). */
  showHint?: boolean;
  /** Offered only to someone who may change contractors here (useCanChangeContractors): the pencil on each card. */
  onEditContractors?: (machine: MachineRecord) => void;
}

const PencilIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" />
  </svg>
);

const MachineOption: React.FC<{ machine: MachineRecord; selected: boolean; note?: string; onSelect: () => void; onEdit?: () => void }> = ({ machine, selected, note, onSelect, onEdit }) => {
  const ready = machineIsReady(machine);
  return (
    <div className={onEdit ? "mpk-option-wrap has-edit" : "mpk-option-wrap"}>
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={!ready}
      className={`mpk-option${selected ? " is-selected" : ""}${note ? " has-note" : ""}`}
      onClick={onSelect}
    >
      <span className="mpk-radio" aria-hidden="true" />
      <span className="mpk-text">
        <strong>{machine.name}</strong>
        <small>
          {ready ? text.contractors(machine.contractorName ?? "", machine.packingContractorName ?? "") : `⚠ ${text.missingContractors}`}
        </small>
        {note ? <span className="mpk-note">{note}</span> : null}
      </span>
    </button>
    {onEdit ? (
      <button type="button" className="mpk-edit" aria-label={copy.cartonProgram.changeContractorsFor(machine.name)} title={copy.cartonProgram.changeContractorsFor(machine.name)} onClick={onEdit}>
        <PencilIcon />
      </button>
    ) : null}
    </div>
  );
};

export const MachinePicker: React.FC<MachinePickerProps> = ({ machines, selectedId, onSelect, onSetUpMachines, step, notes, showHint = true, onEditContractors }) => {
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
          <MachineOption key={machine.id} machine={machine} selected={machine.id === selectedId} note={notes?.get(machine.id)} onSelect={() => onSelect(machine)}
            onEdit={onEditContractors ? () => onEditContractors(machine) : undefined} />
        ))}
      </div>
    );
  };

  return (
    <section className="card mpk-card">
      <div className="mpk-head">
        <h2 id="mpk-label" className="mpk-label">
          {step ? <span className={selectedId ? "qr-step-num is-done" : "qr-step-num"} aria-hidden="true">{selectedId ? "✓" : step}</span> : null}
          {text.label}
        </h2>
        {showHint ? (
          <span className={selectedId ? "mpk-hint" : "mpk-hint mpk-hint--required"}>
            {selectedId ? text.hint : `${text.chooseFirst} ${text.hint}`}
          </span>
        ) : null}
      </div>
      {body()}
    </section>
  );
};
