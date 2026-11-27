import React, { useState } from "react";
import { SALARY_CHANGE_KIND, incrementOf, incrementProblems, type IncrementDraft, type IncrementKind } from "@erp/domain";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { toIsoDate } from "../../utils/dates";
import { leaseRefusalText } from "../../../shared/leaseRefusal";
import { parseEmployeeDetailReply, salaryText, type EmployeeDetail } from "./employees";
import { SalaryField } from "./SalaryField";

// INCREMENT, inside the employee's card (owner, 27 Nov 2026: "increment the salary by percentage or a fixed value"):
//
//   Increment by   (•) Percentage (%)   ( ) Fixed amount (Rs)
//   Percentage [ 10 ]        New salary from [ 2026-12-01 ]
//   Note [ Yearly increment ]
//   Rs 25,000 → Rs 27,500 (+Rs 2,500)        A percentage is rounded to the nearest rupee.
//                                                     [Cancel] [Save increment]
//
// The figure is worked out by the domain (incrementOf), shown before it is saved, and sent with the salary it was
// worked out on, so the main process refuses it if that salary changed meanwhile.

const text = copy.salaries;
const KINDS: readonly IncrementKind[] = [SALARY_CHANGE_KIND.PERCENT, SALARY_CHANGE_KIND.FIXED];

interface IncrementFormProps {
  employee: EmployeeDetail;
  onCancel: () => void;
  onRaised: (employee: EmployeeDetail) => void;
}

export const IncrementForm: React.FC<IncrementFormProps> = ({ employee, onCancel, onRaised }) => {
  const api = useDesktopApi();
  const [draft, setDraft] = useState<IncrementDraft>({ kind: SALARY_CHANGE_KIND.PERCENT, value: "", effectiveOn: toIsoDate(), note: "" });
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const current = employee.monthlySalaryPaisa;
  const problems = tried ? incrementProblems(current, draft) : {};
  const increment = incrementOf(current, draft);
  const set = (field: keyof IncrementDraft) => (value: string) => setDraft((previous) => ({ ...previous, [field]: value }));
  const percent = draft.kind === SALARY_CHANGE_KIND.PERCENT;

  const save = async () => {
    setTried(true);
    setRefusal(null);
    if (increment === null) return;
    setSaving(true);
    try {
      const reply = parseEmployeeDetailReply(await api.incrementEmployeeSalary({ employeeId: employee.id, ...draft, expectedSalaryPaisa: current }), text.notRaised);
      if (reply.ok) onRaised(reply.value);
      else setRefusal(reply.reason);
    } catch (error) {
      setRefusal(leaseRefusalText(error) ?? text.notRaised);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="sal-form sal-increment card" aria-label={text.incrementTitle} noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <h3 className="sal-increment-title">{text.incrementTitle}</h3>
      <fieldset className="sal-kinds">
        <legend className="input-label">{text.incrementBy}</legend>
        {KINDS.map((kind) => (
          <label key={kind} className={draft.kind === kind ? "sal-kind is-on" : "sal-kind"}>
            <input type="radio" name="sal-increment-kind" value={kind} checked={draft.kind === kind} onChange={() => setDraft((previous) => ({ ...previous, kind, value: "" }))} />
            {text.incrementKinds[kind]}
          </label>
        ))}
      </fieldset>
      <div className="sal-form-row">
        <SalaryField id="sal-increment-value" label={percent ? text.percentLabel : text.fixedLabel} value={draft.value} problem={problems.value} onChange={set("value")}
          required inputMode="decimal" placeholder={percent ? text.percentPlaceholder : text.fixedPlaceholder} maxLength={12} autoFocus />
        <SalaryField id="sal-increment-from" label={text.effectiveLabel} value={draft.effectiveOn} problem={problems.effectiveOn} onChange={set("effectiveOn")} required type="date" />
      </div>
      <SalaryField id="sal-increment-note" label={text.noteLabel} value={draft.note} problem={problems.note} onChange={set("note")} placeholder={text.notePlaceholder} maxLength={120} />
      <p className="sal-preview" role="status">
        {increment ? <strong>{text.preview(salaryText(current), salaryText(increment.newSalaryPaisa), salaryText(increment.increasePaisa))}</strong> : null}
        {percent ? <span className="sal-preview-hint">{text.roundedNote}</span> : null}
      </p>
      {refusal ? <p className="sal-problem sal-refusal" role="alert">⚠ {refusal}</p> : null}
      <div className="sal-increment-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={saving}>{text.cancelIncrement}</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? text.savingIncrement : text.saveIncrement}</button>
      </div>
    </form>
  );
};
