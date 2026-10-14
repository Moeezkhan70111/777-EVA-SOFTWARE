import { useEffect, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { copy } from "../../config/copy";
import type { MachineRecord, WorkSection } from "../../types/desktopApi";

// Adding a machine, as one piece of behaviour. Raw Material → Setup → Machines uses this, so a
// machine is saved one way wherever it is added (R1).
//
// A machine needs only its name. The data layer owns the rules: the name is required and stored
// upper-case, a name already taken returns the machine that has it rather than making a second
// one, and a machine added without a section is filed under the floor's section for it. The
// only thing decided here is what to tell the operator when that existing machine is retired —
// it would otherwise look as if nothing happened.

export interface AddMachineState {
  name: string;
  setName: (name: string) => void;
  /** The section chosen in Setup. Empty = let the data layer file the machine. */
  sectionId: string;
  setSectionId: (sectionId: string) => void;
  saving: boolean;
  /** Why the last attempt did not add a machine, in words. Null when there is nothing to say. */
  problem: string | null;
  clearProblem: () => void;
  /** Saves the machine. Resolves to the machine (new or already existing), or null if refused. */
  add: () => Promise<MachineRecord | null>;
}

export const useAddMachine = (sections: readonly WorkSection[] = []): AddMachineState => {
  const api = useDesktopApi();
  const [name, setName] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // Where a section list is offered (Setup), the first one is chosen for the operator.
  useEffect(() => {
    if (!sectionId && sections.length > 0) setSectionId(sections[0].id);
  }, [sections, sectionId]);

  const add = async (): Promise<MachineRecord | null> => {
    const trimmed = name.trim();
    if (!trimmed) {
      setProblem(copy.machineProgram.machineNameRequired);
      return null;
    }
    setSaving(true);
    setProblem(null);
    try {
      const result = await api.createMachine(sectionId ? { name: trimmed, sectionId } : { name: trimmed });
      if (!result.accepted || !result.machine) {
        setProblem(result.reason ?? copy.machineProgram.machineNotSaved);
        return null;
      }
      if (result.machine.status !== "ACTIVE") {
        setProblem(copy.machineProgram.machineAlreadyRetired(result.machine.name));
        return null;
      }
      setName("");
      return result.machine;
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : copy.machineProgram.machineNotSaved);
      return null;
    } finally {
      setSaving(false);
    }
  };

  return { name, setName, sectionId, setSectionId, saving, problem, clearProblem: () => setProblem(null), add };
};
