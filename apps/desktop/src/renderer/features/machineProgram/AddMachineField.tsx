import React, { useState } from "react";
import type { MachineRecord } from "../../types/desktopApi";
import { copy } from "../../config/copy";
import { useAddMachine } from "./useAddMachine";

// + Add Machine, at the end of the machines row. Pressed, it becomes a text field right there:
// type "Machine 4", press Add (or Enter). Nothing else is asked.
//
// While the field is open it carries data-suppress-esc, so Escape closes the field instead of
// the app's "Escape goes Home".

interface AddMachineFieldProps {
  /** Called with the saved machine, so the page can open it straight away. */
  onAdded: (machine: MachineRecord) => void;
}

export const AddMachineField: React.FC<AddMachineFieldProps> = ({ onAdded }) => {
  const [open, setOpen] = useState(false);
  const form = useAddMachine();

  const close = () => {
    setOpen(false);
    form.setName("");
    form.clearProblem();
  };

  const save = async () => {
    const machine = await form.add();
    if (!machine) return;
    setOpen(false);
    onAdded(machine);
  };

  if (!open) {
    return (
      <button type="button" className="btn btn-secondary mpx-add-machine" onClick={() => setOpen(true)}>
        {copy.machineProgram.addMachineButton}
      </button>
    );
  }

  return (
    <form
      className="mpx-add-machine-form"
      data-suppress-esc
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label htmlFor="mpx-new-machine" className="sr-only">
        {copy.machineProgram.machineName}
      </label>
      <input
        id="mpx-new-machine"
        className="form-input"
        value={form.name}
        placeholder={copy.machineProgram.machineNamePlaceholder}
        autoFocus
        onChange={(event) => form.setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") close();
        }}
      />
      <button type="submit" className="btn btn-primary" disabled={form.saving}>
        {form.saving ? copy.machineProgram.addingMachine : copy.machineProgram.addMachineSave}
      </button>
      <button type="button" className="btn btn-secondary" onClick={close}>
        {copy.common.cancel}
      </button>
      {form.problem ? (
        <p className="mp-problem mpx-add-machine-problem" role="alert">
          ⚠ {form.problem}
        </p>
      ) : null}
    </form>
  );
};
