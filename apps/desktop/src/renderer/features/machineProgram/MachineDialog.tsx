import React, { useMemo, useState } from "react";
import { Modal } from "../../components/shared/Modal";
import { SearchableCombobox } from "../../components/shared/SearchableCombobox";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import type { MachineContractorRole, MachineRecord } from "../../types/desktopApi";
import { useContractors } from "./useCartonProgram";
import { leaseRefusalText } from "../../../shared/leaseRefusal";

// ADD MACHINE / CHANGE CONTRACTORS — one dialog, two uses:
//
//   Machine name          [ MACHINE 4              ]      (adding only)
//   Machine contractor    [ ASLAM               ▾ ]
//   Packing contractor    [ BABAR               ▾ ]
//                                        [Cancel] [Add Machine]
//
// The contractors are Contractor parties from the Party Master. They stay with the machine until
// they are changed here; a program already opened keeps the pair it was opened with. Every rule
// (a name used once, a real active contractor) is checked again by the main process.

const text = copy.cartonProgram;

interface MachineDialogProps {
  /** The machine whose contractors are being changed; absent when adding a new machine. */
  machine?: MachineRecord;
  onClose: () => void;
  /** Called once saved, with a line for the confirmation. */
  onSaved: (title: string, body: string) => void;
}

const roleChanges = (machine: MachineRecord, picked: Record<MachineContractorRole, string>) =>
  (["MACHINE", "PACKING"] as const).filter((role) =>
    picked[role] !== (role === "PACKING" ? machine.packingContractorPartyId : machine.contractorPartyId)
  );

export const MachineDialog: React.FC<MachineDialogProps> = ({ machine, onClose, onSaved }) => {
  const api = useDesktopApi();
  const contractors = useContractors(text.contractorsFailed);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Record<MachineContractorRole, string>>({
    MACHINE: machine?.contractorPartyId ?? "",
    PACKING: machine?.packingContractorPartyId ?? "",
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const options = useMemo(
    () => contractors.rows.map((contractor) => ({ value: contractor.id, label: contractor.name, detail: contractor.city || undefined })),
    [contractors.rows]
  );

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
      for (const role of roleChanges(machine, picked)) {
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

  const contractorField = (role: MachineContractorRole, label: string) => (
    <div className="form-group">
      <span className="input-label">{label}</span>
      <SearchableCombobox
        dropdown
        value={picked[role]}
        options={options}
        placeholder={text.chooseContractor}
        emptyLabel={text.noContractorMatch}
        ariaLabel={label}
        onChange={(value) => setPicked((previous) => ({ ...previous, [role]: value }))}
      />
    </div>
  );

  return (
    <Modal
      title={machine ? text.editMachineTitle(machine.name) : text.addMachineTitle}
      subtitle={machine ? text.editMachineSubtitle : text.addMachineSubtitle}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" disabled={saving || contractors.rows.length === 0} onClick={() => void save()}>
          {saving ? text.saving : machine ? text.save : text.saveAdd}
        </button>
      }
    >
      {machine ? null : (
        <div className="form-group">
          <label className="input-label" htmlFor="mp-machine-name">{text.machineName}</label>
          <input
            id="mp-machine-name"
            className="form-input mp-name-input"
            value={name}
            maxLength={60}
            autoComplete="off"
            autoFocus
            placeholder={text.machineNamePlaceholder}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
      )}
      {contractors.loading && contractors.rows.length === 0 ? (
        <StateView kind="loading" compact message={text.contractorsLoading} />
      ) : contractors.error ? (
        <StateView kind="error" compact message={contractors.error} onRetry={() => void contractors.reload()} />
      ) : contractors.rows.length === 0 ? (
        <StateView kind="empty" compact title={text.noContractorsTitle} hint={text.noContractorsHint} />
      ) : (
        <>
          {contractorField("MACHINE", text.machineContractor)}
          {contractorField("PACKING", text.packingContractor)}
        </>
      )}
      {problem ? <p className="mp-dialog-problem" role="alert">⚠ {problem}</p> : null}
    </Modal>
  );
};
