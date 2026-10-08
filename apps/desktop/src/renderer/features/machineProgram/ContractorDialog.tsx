import React, { useState } from "react";
import type { MachineRecord } from "../../types/desktopApi";
import { Modal } from "../../components/shared/Modal";
import { StateView } from "../../components/shared/StateView";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { copy } from "../../config/copy";
import { ContractorPicker } from "./ContractorPicker";
import { useContractors, type ContractorOption } from "./useMachineProgramData";

// Who works on a machine. Asked once, kept until somebody changes it.
//
// The first time it is a plain question with contractor cards and a Confirm. Changing it later is
// a deliberate act on the machine's permanent setup, so it shows the current and the new
// contractor side by side and says what will happen before anything is saved: future programs
// change, programs already made keep the contractor they were made with.

interface ContractorDialogProps {
  machine: MachineRecord;
  onClose: () => void;
  /** Called once the contractor has been saved. */
  onSaved: () => void;
}

export const ContractorDialog: React.FC<ContractorDialogProps> = ({ machine, onClose, onSaved }) => {
  const api = useDesktopApi();
  const contractors = useContractors();
  const [chosen, setChosen] = useState<ContractorOption | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const changing = machine.contractorPartyId != null;
  const sameAsNow = chosen?.id === machine.contractorPartyId;

  const save = async () => {
    if (!chosen) return;
    setSaving(true);
    setProblem(null);
    try {
      const result = await api.assignMachineContractor({ machineId: machine.id, contractorPartyId: chosen.id });
      if (!result.accepted) {
        setProblem(result.reason ?? copy.common.unknownError);
        return;
      }
      onSaved();
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : copy.common.unknownError);
    } finally {
      setSaving(false);
    }
  };

  const action = changing ? copy.machineProgram.changeContractor : copy.machineProgram.confirmContractor;
  const confirmStep = chosen !== null && !sameAsNow;

  return (
    <Modal
      title={confirmStep && changing ? copy.machineProgram.changeContractorTitle : copy.machineProgram.whoWorksHere(machine.name)}
      subtitle={machine.name}
      onClose={onClose}
      wide={!confirmStep}
      footer={
        confirmStep ? (
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
            {saving ? copy.machineProgram.saving : action}
          </button>
        ) : null
      }
    >
      {confirmStep && chosen ? (
        <ContractorConfirm machine={machine} chosen={chosen} changing={changing} onBack={() => setChosen(null)} />
      ) : contractors.loading ? (
        <StateView kind="loading" compact />
      ) : contractors.error ? (
        <StateView kind="error" compact message={contractors.error} onRetry={() => void contractors.reload()} />
      ) : (
        <ContractorPicker contractors={contractors.value} selectedId={chosen?.id ?? machine.contractorPartyId} onSelect={setChosen} />
      )}

      {problem ? (
        <p className="mp-problem" role="alert">
          ⚠ {problem}
        </p>
      ) : null}
    </Modal>
  );
};

/** What will change, said before it is saved. */
const ContractorConfirm: React.FC<{ machine: MachineRecord; chosen: ContractorOption; changing: boolean; onBack: () => void }> = ({
  machine,
  chosen,
  changing,
  onBack,
}) => (
  <div className="mp-confirm">
    <dl className="mp-facts">
      <div>
        <dt>Machine</dt>
        <dd>{machine.name}</dd>
      </div>
      {changing ? (
        <div>
          <dt>{copy.machineProgram.currentContractor}</dt>
          <dd>{machine.contractorName}</dd>
        </div>
      ) : null}
      <div>
        <dt>{changing ? copy.machineProgram.newContractor : copy.machineProgram.contractor}</dt>
        <dd className="mp-facts-strong">{chosen.name}</dd>
      </div>
    </dl>
    {changing ? <p className="mp-note">{copy.machineProgram.changeContractorExplain(machine.name)}</p> : null}
    <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
      {copy.machineProgram.back}
    </button>
  </div>
);
