import React, { useState } from "react";
import type { MachineContractorRole, MachineRecord } from "../../types/desktopApi";
import { Modal } from "../../components/shared/Modal";
import { StateView } from "../../components/shared/StateView";
import { StepHeading } from "../../components/shared/StepHeading";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { copy } from "../../config/copy";
import { ContractorPicker } from "./ContractorPicker";
import { useContractors, type ContractorOption } from "./useMachineProgramData";

// Who works on a machine — BOTH of them, on one screen:
//
//   ① Machine contractor        ② Packing contractor
//   Runs the machine.           Packs what it makes.
//   [ ALAMGIR ] [ RASHID ] …    [ ALAMGIR ] [ RASHID ] …
//
// A machine is run under one contractor and its output packed under another, and the day's
// program is paid against both, so neither is optional: a program cannot be made until the
// machine has the pair. They come from the same CONTRACTOR parties, and one person may be the
// machine contractor here and the packing contractor on the next machine.
//
// Asked once and kept until somebody changes it. Each role is its own saved assignment, so
// changing one never rewrites the other — and a program already made keeps the pair it was made
// with, which the note says before anything is saved.

interface ContractorDialogProps {
  machine: MachineRecord;
  onClose: () => void;
  /** Called once the contractors have been saved. */
  onSaved: () => void;
}

/** What the machine has saved right now, per role. */
const savedId = (machine: MachineRecord, role: MachineContractorRole): string | null =>
  role === "PACKING" ? machine.packingContractorPartyId : machine.contractorPartyId;

const savedName = (machine: MachineRecord, role: MachineContractorRole): string | null =>
  role === "PACKING" ? machine.packingContractorName : machine.contractorName;

const ROLE_TITLE: Record<MachineContractorRole, string> = {
  MACHINE: copy.machineProgram.machineContractor,
  PACKING: copy.machineProgram.packingContractor,
};

const ROLE_HINT: Record<MachineContractorRole, string> = {
  MACHINE: copy.machineProgram.machineContractorHint,
  PACKING: copy.machineProgram.packingContractorHint,
};

export const ContractorDialog: React.FC<ContractorDialogProps> = ({ machine, onClose, onSaved }) => {
  const api = useDesktopApi();
  const contractors = useContractors();
  const [picked, setPicked] = useState<Record<MachineContractorRole, string | null>>({
    MACHINE: machine.contractorPartyId,
    PACKING: machine.packingContractorPartyId,
  });
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // A machine missing either role is being SET UP, even if it already has the other one —
  // calling that "change" would be telling the operator they are undoing something.
  const completing = machine.contractorPartyId === null || machine.packingContractorPartyId === null;
  const replacingSomebody = machine.contractorPartyId !== null || machine.packingContractorPartyId !== null;
  const changed = (["MACHINE", "PACKING"] as const).filter((role) => picked[role] !== savedId(machine, role));
  const ready = picked.MACHINE !== null && picked.PACKING !== null && changed.length > 0;

  /**
   * Each role is its own transaction — the backend has no "set both", because a machine's two
   * contractors are two independent facts about it. The first refusal stops the rest and names
   * the role, and whatever went through before it stays assigned.
   */
  const save = async () => {
    setSaving(true);
    setProblem(null);
    try {
      for (const role of changed) {
        const contractorPartyId = picked[role];
        if (!contractorPartyId) continue;
        const result = await api.assignMachineContractor({ machineId: machine.id, role, contractorPartyId });
        if (!result.accepted) {
          setProblem(copy.machineProgram.contractorSaveFailed(ROLE_TITLE[role], result.reason ?? copy.common.unknownError));
          return;
        }
      }
      onSaved();
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : copy.common.unknownError);
    } finally {
      setSaving(false);
    }
  };

  const pick = (role: MachineContractorRole) => (contractor: ContractorOption) =>
    setPicked((previous) => ({ ...previous, [role]: contractor.id }));

  return (
    <Modal
      title={completing ? copy.machineProgram.whoWorksHere(machine.name) : copy.machineProgram.changeContractorTitle}
      subtitle={`${machine.name} — ${copy.machineProgram.bothContractorsNeeded}`}
      wide="xl"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary btn-lg" disabled={!ready || saving} onClick={() => void save()}>
          {saving ? copy.machineProgram.saving : completing ? copy.machineProgram.saveContractors : copy.machineProgram.changeContractor}
        </button>
      }
    >
      {contractors.loading && contractors.value.length === 0 ? (
        <StateView kind="loading" compact />
      ) : contractors.error ? (
        <StateView kind="error" compact message={contractors.error} onRetry={() => void contractors.reload()} />
      ) : (
        <div className="mpa-panels mpa-panels--two">
          {(["MACHINE", "PACKING"] as const).map((role, index) => (
            <RoleSection
              key={role}
              index={index + 1}
              role={role}
              machine={machine}
              contractors={contractors.value}
              pickedId={picked[role]}
              onSelect={pick(role)}
            />
          ))}
        </div>
      )}

      {/* Only worth saying when somebody is already on the machine: programs made under them
          keep the pair they were made with. */}
      {replacingSomebody ? <p className="mp-note">{copy.machineProgram.changeContractorExplain(machine.name)}</p> : null}

      {problem ? (
        <p className="mp-problem" role="alert">
          ⚠ {problem} {copy.machineProgram.contractorSavedSoFar}
        </p>
      ) : null}
    </Modal>
  );
};

/** One role: what the machine has now, and the contractors it can be changed to. */
const RoleSection: React.FC<{
  index: number;
  role: MachineContractorRole;
  machine: MachineRecord;
  contractors: ContractorOption[];
  pickedId: string | null;
  onSelect: (contractor: ContractorOption) => void;
}> = ({ index, role, machine, contractors, pickedId, onSelect }) => {
  const now = savedName(machine, role);
  const unchanged = pickedId === savedId(machine, role);
  return (
    <section className="mpa-panel" aria-label={ROLE_TITLE[role]}>
      <StepHeading index={index} done={pickedId !== null} title={ROLE_TITLE[role]} />
      <p className="mpa-role-hint">{ROLE_HINT[role]}</p>
      {now ? (
        <p className="mpa-role-now">
          <span className="mpa-role-now-label">{copy.machineProgram.currentContractor}</span>
          {now}
          {unchanged ? null : <span className="mpa-role-changed">{copy.machineProgram.newContractor}</span>}
        </p>
      ) : null}
      <div className="mpa-panel-body">
        <ContractorPicker contractors={contractors} selectedId={pickedId} onSelect={onSelect} />
      </div>
    </section>
  );
};
