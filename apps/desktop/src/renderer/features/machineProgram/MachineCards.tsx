import React from "react";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import type { MachineRecord } from "../../types/desktopApi";
import type { LoadState } from "./useCartonProgram";

// MACHINES — one card each, saying who works it:
//
//   ┌ MACHINE 1                 M-001 ┐
//   │ MACHINE CONTRACTOR   ASLAM      │
//   │ PACKING CONTRACTOR   BABAR      │
//   │            [Change contractors] │
//   └─────────────────────────────────┘
//
// A contractor not set says so in words, not only in colour (R18).

const text = copy.cartonProgram;

const Contractor: React.FC<{ label: string; name: string | null }> = ({ label, name }) => (
  <div className="mp-machine-role">
    <dt>{label}</dt>
    <dd className={name ? undefined : "mp-machine-unset"}>{name ?? `⚠ ${text.notSet}`}</dd>
  </div>
);

const MachineCard: React.FC<{ machine: MachineRecord; onEdit: () => void }> = ({ machine, onEdit }) => (
  <li className="mp-machine-card">
    <div className="mp-machine-head">
      <h3 className="mp-machine-name">{machine.name}</h3>
      <span className="mp-machine-code">{machine.machineCode}</span>
    </div>
    <dl className="mp-machine-roles">
      <Contractor label={text.machineContractor} name={machine.contractorName} />
      <Contractor label={text.packingContractor} name={machine.packingContractorName} />
    </dl>
    <button type="button" className="btn btn-ghost btn-sm mp-machine-edit" aria-label={text.changeContractorsFor(machine.name)} onClick={onEdit}>
      {text.changeContractors}
    </button>
  </li>
);

interface MachineCardsProps {
  machines: LoadState<MachineRecord>;
  onAdd: () => void;
  onEdit: (machine: MachineRecord) => void;
}

export const MachineCards: React.FC<MachineCardsProps> = ({ machines, onAdd, onEdit }) => {
  if (machines.loading && machines.rows.length === 0) return <StateView kind="loading" compact message={text.machinesLoading} />;
  if (machines.error) return <StateView kind="error" compact message={machines.error} onRetry={() => void machines.reload()} />;
  if (machines.rows.length === 0) {
    return <StateView kind="empty" title={text.noMachinesTitle} hint={text.noMachinesHint} action={{ label: text.addMachine, onClick: onAdd }} />;
  }
  return (
    <ul className="mp-machine-grid" aria-label={text.machinesTitle}>
      {machines.rows.map((machine) => (
        <MachineCard key={machine.id} machine={machine} onEdit={() => onEdit(machine)} />
      ))}
    </ul>
  );
};
