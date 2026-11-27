import React, { useState } from "react";
import { SALARY_CHANGE_KIND, incrementOf, incrementProblems, type IncrementDraft, type IncrementKind } from "@erp/domain";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { toIsoDate } from "../../utils/dates";
import { leaseRefusalText } from "../../../shared/leaseRefusal";
import { parseEmployeeDetailReply, salaryText, type EmployeeDetail } from "./employees";
import { SalaryField } from "./SalaryField";

// INCREMENT, the employee card's second step (owner, 27 Nov 2026: "increment the salary by percentage or a fixed
// value"), in the card pages' look (docs/56):
//
//   INCREMENT BY  [ Percentage | Fixed amount ]          the shared two-way toggle (sa-toggle)
//   PERCENTAGE *  [ 10        % ]     NEW SALARY FROM *  [ 2026-12-01 ]     today, as most raises start now
//   NOTE          [ Yearly increment ]
//   ┌ Now Rs 25,000  +  Increment Rs 2,500  =  New salary Rs 27,500 ┐     an equation, the answer in blue
//   A percentage is rounded to the nearest rupee.
//
// The figure is worked out by the domain (incrementOf) as the person types, in a strip that keeps its size from the
// start (no layout shift). Back and Save are the dialog's own footer buttons (EmployeeCard); this form is FORM_ID. It is
// sent with the salary it was worked out on, so the main process refuses it if that salary changed meanwhile.

const text = copy.salaries;
const KINDS: readonly IncrementKind[] = [SALARY_CHANGE_KIND.PERCENT, SALARY_CHANGE_KIND.FIXED];
export const INCREMENT_FORM_ID = "sal-increment-form";

interface IncrementFormProps {
  employee: EmployeeDetail;
  /** Told while the increment is being saved, so the footer's Save can say so. */
  onBusy: (busy: boolean) => void;
  onRaised: (employee: EmployeeDetail) => void;
}

const Equation: React.FC<{ now: number; plus: number | null; next: number | null }> = ({ now, plus, next }) => {
  const money = (paisa: number | null) => (paisa === null ? text.equationEmpty : `Rs ${salaryText(paisa)}`);
  return (
    <div className="sal-equation" role="status" aria-label={text.equationLabel}>
      <div><span>{text.equationNow}</span><strong>{money(now)}</strong></div>
      <span className="sal-equation-sign" aria-hidden="true">+</span>
      <div><span>{text.equationPlus}</span><strong>{money(plus)}</strong></div>
      <span className="sal-equation-sign" aria-hidden="true">=</span>
      <div className="sal-equation-answer"><span>{text.equationNew}</span><strong>{money(next)}</strong></div>
    </div>
  );
};

export const IncrementForm: React.FC<IncrementFormProps> = ({ employee, onBusy, onRaised }) => {
  const api = useDesktopApi();
  const [draft, setDraft] = useState<IncrementDraft>({ kind: SALARY_CHANGE_KIND.PERCENT, value: "", effectiveOn: toIsoDate(), note: "" });
  const [tried, setTried] = useState(false);
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
    onBusy(true);
    try {
      const reply = parseEmployeeDetailReply(await api.incrementEmployeeSalary({ employeeId: employee.id, ...draft, expectedSalaryPaisa: current }), text.notRaised);
      if (reply.ok) onRaised(reply.value);
      else setRefusal(reply.reason);
    } catch (error) {
      setRefusal(leaseRefusalText(error) ?? text.notRaised);
    } finally {
      onBusy(false);
    }
  };

  return (
    <form id={INCREMENT_FORM_ID} className="sal-form" aria-label={text.incrementTitle} noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="form-group sal-field">
        <span className="input-label" id="sal-increment-kind">{text.incrementBy}</span>
        <div className="sa-toggle" role="group" aria-labelledby="sal-increment-kind">
          {KINDS.map((kind) => (
            <button key={kind} type="button" className={draft.kind === kind ? "sa-toggle-btn is-on" : "sa-toggle-btn"} aria-pressed={draft.kind === kind}
              onClick={() => setDraft((previous) => ({ ...previous, kind, value: "" }))}>
              {text.incrementKinds[kind]}
            </button>
          ))}
        </div>
      </div>
      <div className="sal-form-row">
        <SalaryField id="sal-increment-value" label={percent ? text.percentLabel : text.fixedLabel} value={draft.value} problem={problems.value} onChange={set("value")}
          required inputMode="decimal" placeholder={percent ? text.percentPlaceholder : text.fixedPlaceholder} maxLength={12} autoFocus figure
          prefix={percent ? undefined : "Rs"} suffix={percent ? "%" : undefined} />
        <SalaryField id="sal-increment-from" label={text.effectiveLabel} value={draft.effectiveOn} problem={problems.effectiveOn} onChange={set("effectiveOn")} required type="date" />
      </div>
      <SalaryField id="sal-increment-note" label={text.noteLabel} value={draft.note} problem={problems.note} onChange={set("note")} placeholder={text.notePlaceholder} maxLength={120} />
      <Equation now={current} plus={increment?.increasePaisa ?? null} next={increment?.newSalaryPaisa ?? null} />
      <p className="sal-hint">{percent ? text.hintPercent : text.hintFixed}</p>
      {refusal ? <p className="sal-problem sal-refusal" role="alert">⚠ {refusal}</p> : null}
    </form>
  );
};
