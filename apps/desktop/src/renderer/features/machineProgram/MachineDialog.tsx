import React, { useState } from "react";
import { Modal } from "../../components/shared/Modal";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import type { MachineContractorRole, MachineRecord } from "../../types/desktopApi";
import { useCanCreateParty } from "../parties/useCanCreateParty";
import { ContractorField } from "./ContractorField";
import { useContractors } from "./useCartonProgram";
import { leaseRefusalText } from "../../../shared/leaseRefusal";

// ADD MACHINE / CHANGE CONTRACTORS — one dialog, two uses (Machine Program, and the machine cards on Manual
// Production):
//
//   Machine name          [ MACHINE 4              ]      (adding only)
//   Contractors of MACHINE 1                                   [ + Add Party ] [×]
//   Machine contractor    [ KAMRAN              ▾ ]   ↺ was ALAMGIR
//   Packing contractor    [ BABAR               ▾ ]
//                                         [Cancel] [Save 1 change]
//
// The contractors are Contractor parties from the Party Master. They stay with the machine until they are changed
// here; a program already opened keeps the pair it was opened with. Every rule (a name used once, a real active
// contractor) is checked again by the main process.
//
// The UI/UX pass (owner, 25 Nov 2026): the pickers are the shared searchable panel; a changed field says what it was;
// Save names how many changes it saves and is off while nothing changed. A contractor not on the list yet is added in
// Party Master: "+ Add Party" at the top right closes the dialog and opens the Add Party page (owner, 25 Nov 2026),
// offered to whoever may add parties on this computer (useCanCreateParty) where the page gives the way there.

const text = copy.cartonProgram;
const ROLES = ["MACHINE", "PACKING"] as const;

interface MachineDialogProps {
  /** The machine whose contractors are being changed; absent when adding a new machine. */
  machine?: MachineRecord;
  onClose: () => void;
  /** Called once saved, with a line for the confirmation. */
  onSaved: (title: string, body: string) => void;
  /** Opens the Add Party page; absent where this user may not open it. */
  onAddParty?: () => void;
}

/** The contractor saved on the machine for a role; null when adding a machine (nothing saved yet). */
const savedOf = (machine: MachineRecord | undefined, role: MachineContractorRole): string | null =>
  machine ? (role === "PACKING" ? machine.packingContractorPartyId : machine.contractorPartyId) ?? "" : null;

export const MachineDialog: React.FC<MachineDialogProps> = ({ machine, onClose, onSaved, onAddParty }) => {
  const api = useDesktopApi();
  const contractors = useContractors(text.contractorsFailed);
  const canCreateParty = useCanCreateParty();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Record<MachineContractorRole, string>>({ MACHINE: savedOf(machine, "MACHINE") ?? "", PACKING: savedOf(machine, "PACKING") ?? "" });
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const changes = machine ? ROLES.filter((role) => picked[role] !== savedOf(machine, role)) : [];

  const missing = (): string | null => {
    if (!machine && !name.trim()) return text.nameRequired;
    if (!picked.MACHINE) return text.contractorRequired;
    if (!picked.PACKING) return text.packingRequired;
    return null;
  };

  const save = async () => {
    const reason = missing();
    if (reason) return setProblem(reason);
    setSaving(true);
    setProblem(null);
    try {
      if (!machine) {
        const added = await api.addMachine({ name, contractorPartyId: picked.MACHINE, packingContractorPartyId: picked.PACKING });
        if (!added.accepted) return setProblem(added.reason ?? text.notSaved);
        onSaved(text.machineAdded, text.machineAddedBody(name.trim().toUpperCase()));
        return;
      }
      for (const role of changes) {
        const result = await api.assignMachineContractor({ machineId: machine.id, role, contractorPartyId: picked[role] });
        if (!result.accepted) return setProblem(result.reason ?? text.notSaved);
      }
      onSaved(text.contractorsSaved, text.contractorsSavedBody(machine.name));
    } catch (error) {
      setProblem(leaseRefusalText(error) ?? copy.common.unknownError);
    } finally {
      setSaving(false);
    }
  };

  const field = (role: MachineContractorRole) => (
    <ContractorField key={role} label={role === "PACKING" ? text.packingContractor : text.machineContractor} contractors={contractors.rows}
      value={picked[role]} current={savedOf(machine, role)} onChange={(value) => setPicked((previous) => ({ ...previous, [role]: value }))} />
  );

  const nothingChanged = machine !== undefined && changes.length === 0;
  const footer = (
    <>
      <button type="button" className="btn btn-primary" disabled={saving || nothingChanged || contractors.rows.length === 0} onClick={() => void save()}>
        {saving ? text.saving : machine ? text.saveContractors(changes.length) : text.saveAdd}
      </button>
    </>
  );

  const addParty = onAddParty && canCreateParty ? (
    <button type="button" className="btn btn-secondary btn-sm mp-add-party" aria-label={text.addPartyLabel} title={text.addPartyLabel}
      onClick={() => { onClose(); onAddParty(); }}>
      {text.addParty}
    </button>
  ) : null;

  return (
    <Modal headerAction={addParty} title={machine ? text.editMachineTitle(machine.name) : text.addMachineTitle} subtitle={machine ? text.editMachineSubtitle : text.addMachineSubtitle} onClose={onClose} footer={footer}>
      <div className="mp-dialog doc-themed">
        {machine ? null : (
          <div className="form-group">
            <label className="input-label" htmlFor="mp-machine-name">{text.machineName}</label>
            <input id="mp-machine-name" className="form-input mp-name-input" value={name} maxLength={60} autoComplete="off" autoFocus
              placeholder={text.machineNamePlaceholder} onChange={(event) => setName(event.target.value)} />
          </div>
        )}
        {contractors.loading && contractors.rows.length === 0 ? (
          <StateView kind="loading" compact message={text.contractorsLoading} />
        ) : contractors.error ? (
          <StateView kind="error" compact message={contractors.error} onRetry={() => void contractors.reload()} />
        ) : contractors.rows.length === 0 ? (
          <StateView kind="empty" compact title={text.noContractorsTitle} hint={text.noContractorsHint} />
        ) : (
          ROLES.map(field)
        )}
        {nothingChanged ? <p className="mp-dialog-note">{text.nothingChanged}</p> : null}
        {problem ? <p className="mp-dialog-problem" role="alert">⚠ {problem}</p> : null}
      </div>
    </Modal>
  );
};
