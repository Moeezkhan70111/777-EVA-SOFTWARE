import React, { useState } from "react";
import { employeeProblems, type EmployeeDraft, type EmployeeField } from "@erp/domain";
import { Modal } from "../../components/shared/Modal";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { leaseRefusalText } from "../../../shared/leaseRefusal";
import { parseEmployeeReply, type Employee } from "./employees";
import { SalaryField, type SalaryFieldProps } from "./SalaryField";

// ADD EMPLOYEE (owner, 27 Nov 2026: "pop up appears to add Employee set its salary"), in the card pages' look (Modal
// themed, docs/56):
//
//   Add Employee                                                          ×
//   NAME *                          MONTHLY SALARY *
//   [ Ali Raza              ]       [ Rs        25000 ]
//   ── Other details · Optional ─────────────────────────────────────────
//   WORK              PHONE                 JOINED ON
//   [ Cutting ▾ ]     [ 0300-1234567 ]      [ 2026-11-01 ]
//                                                    [Cancel] [Add employee]
//
// The two things needed come first (Pareto, serial position); the rest is grouped under its own heading (common
// region). Work offers what is already in use (recognition over recall). Each problem is said under its field once
// Save was pressed, by the domain's rules (employees.ts); the main process checks everything again. Enter saves.

const text = copy.salaries;
const EMPTY: EmployeeDraft = { name: "", work: "", phone: "", monthlySalary: "", joinedOn: "" };
const FORM_ID = "sal-add-form";

interface AddEmployeeDialogProps {
  /** Work already given to someone, offered as suggestions. */
  works: readonly string[];
  onClose: () => void;
  onAdded: (employee: Employee) => void;
}

/** One field of the form, its id from the draft's own name. */
const Field: React.FC<Omit<SalaryFieldProps, "id"> & { field: EmployeeField }> = ({ field, ...rest }) => <SalaryField id={`sal-${field}`} {...rest} />;

export const AddEmployeeDialog: React.FC<AddEmployeeDialogProps> = ({ works, onClose, onAdded }) => {
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

  const footer = <button type="submit" form={FORM_ID} className="btn btn-primary" disabled={saving}>{saving ? text.saving : text.save}</button>;

  return (
    <Modal themed wide title={text.dialogTitle} subtitle={text.dialogSubtitle} onClose={onClose} footer={footer}>
      <form id={FORM_ID} className="sal-form" noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="sal-form-row">
          <Field field="name" label={text.nameLabel} value={draft.name} problem={problems.name} onChange={set("name")} required placeholder={text.namePlaceholder} maxLength={60} autoFocus />
          <Field field="monthlySalary" label={text.salaryLabel} value={draft.monthlySalary} problem={problems.monthlySalary} onChange={set("monthlySalary")} required
            inputMode="decimal" placeholder={text.salaryPlaceholder} maxLength={14} prefix="Rs" figure />
        </div>
        <fieldset className="sal-optional">
          <legend><span>{text.optionalTitle}</span> <span className="sal-optional-hint">{text.optionalHint}</span></legend>
          <div className="sal-form-row sal-form-row--three">
            <Field field="work" label={text.workLabel} value={draft.work} problem={problems.work} onChange={set("work")} placeholder={text.workPlaceholder} maxLength={60} suggestions={works} />
            <Field field="phone" label={text.phoneLabel} value={draft.phone} problem={problems.phone} onChange={set("phone")} type="tel" inputMode="tel" placeholder={text.phonePlaceholder} maxLength={20} />
            <Field field="joinedOn" label={text.joinedLabel} value={draft.joinedOn} problem={problems.joinedOn} onChange={set("joinedOn")} type="date" />
          </div>
        </fieldset>
        {refusal ? <p className="sal-problem sal-refusal" role="alert">⚠ {refusal}</p> : null}
      </form>
    </Modal>
  );
};
