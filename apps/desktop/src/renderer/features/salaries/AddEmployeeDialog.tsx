import React, { useState } from "react";
import { employeeProblems, type EmployeeDraft, type EmployeeField } from "@erp/domain";
import { Modal } from "../../components/shared/Modal";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { leaseRefusalText } from "../../../shared/leaseRefusal";
import { parseEmployeeReply, type Employee } from "./employees";

// ADD EMPLOYEE (owner, 27 Nov 2026: "pop up appears to add Employee set its salary"):
//
//   Name *                [ Ali Raza          ]
//   Work                  [ Cutting           ]     Phone  [ 0300-1234567 ]
//   Monthly salary (Rs) * [ 25000             ]     Joined on [ 2026-11-01 ]
//                                                  [Cancel] [Add employee]
//
// The rules are the domain's (employees.ts): each problem is said under its own field once Save was pressed, and the
// main process checks everything again. Enter saves.

const text = copy.salaries;
const EMPTY: EmployeeDraft = { name: "", work: "", phone: "", monthlySalary: "", joinedOn: "" };

interface AddEmployeeDialogProps {
  onClose: () => void;
  onAdded: (employee: Employee) => void;
}

interface FieldProps {
  field: EmployeeField;
  label: string;
  value: string;
  problem: string | undefined;
  onChange: (value: string) => void;
  required?: boolean;
  type?: "text" | "date" | "tel";
  inputMode?: "decimal" | "tel";
  placeholder?: string;
  maxLength?: number;
  autoFocus?: boolean;
}

const Field: React.FC<FieldProps> = ({ field, label, value, problem, onChange, required = false, type = "text", inputMode, placeholder, maxLength, autoFocus }) => {
  const id = `sal-${field}`;
  return (
    <div className="form-group">
      <label className="input-label" htmlFor={id}>{label}{required ? <span className="sal-required"> * <span className="sr-only">{text.required}</span></span> : null}</label>
      <input id={id} className="form-input" type={type} inputMode={inputMode} value={value} placeholder={placeholder} maxLength={maxLength} autoFocus={autoFocus}
        autoComplete="off" required={required} aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${id}-problem` : undefined}
        onChange={(event) => onChange(event.target.value)} />
      {problem ? <p id={`${id}-problem`} className="sal-problem" role="alert">⚠ {problem}</p> : null}
    </div>
  );
};

export const AddEmployeeDialog: React.FC<AddEmployeeDialogProps> = ({ onClose, onAdded }) => {
  const api = useDesktopApi();
  const [draft, setDraft] = useState<EmployeeDraft>(EMPTY);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const problems = tried ? employeeProblems(draft) : {};
  const set = (field: EmployeeField) => (value: string) => setDraft((current) => ({ ...current, [field]: value }));

  const save = async () => {
    setTried(true);
    setRefusal(null);
    if (Object.keys(employeeProblems(draft)).length > 0) return;
    setSaving(true);
    try {
      const reply = parseEmployeeReply(await api.createEmployee(draft), text.notSaved);
      if (reply.ok) onAdded(reply.value);
      else setRefusal(reply.reason);
    } catch (error) {
      setRefusal(leaseRefusalText(error) ?? text.notSaved);
    } finally {
      setSaving(false);
    }
  };

  const footer = (
    <button type="submit" form="sal-add-form" className="btn btn-primary" disabled={saving}>{saving ? text.saving : text.save}</button>
  );

  return (
    <Modal title={text.dialogTitle} subtitle={text.dialogSubtitle} onClose={onClose} footer={footer}>
      <form id="sal-add-form" className="sal-form" noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <Field field="name" label={text.nameLabel} value={draft.name} problem={problems.name} onChange={set("name")} required placeholder={text.namePlaceholder} maxLength={60} autoFocus />
        <div className="sal-form-row">
          <Field field="work" label={text.workLabel} value={draft.work} problem={problems.work} onChange={set("work")} placeholder={text.workPlaceholder} maxLength={60} />
          <Field field="phone" label={text.phoneLabel} value={draft.phone} problem={problems.phone} onChange={set("phone")} type="tel" inputMode="tel" placeholder={text.phonePlaceholder} maxLength={20} />
        </div>
        <div className="sal-form-row">
          <Field field="monthlySalary" label={text.salaryLabel} value={draft.monthlySalary} problem={problems.monthlySalary} onChange={set("monthlySalary")} required inputMode="decimal" placeholder={text.salaryPlaceholder} maxLength={14} />
          <Field field="joinedOn" label={text.joinedLabel} value={draft.joinedOn} problem={problems.joinedOn} onChange={set("joinedOn")} type="date" />
        </div>
        {refusal ? <p className="sal-problem sal-refusal" role="alert">⚠ {refusal}</p> : null}
      </form>
    </Modal>
  );
};
