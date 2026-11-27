import React, { useCallback, useEffect, useState } from "react";
import { EMPLOYEE_STATUS, SALARY_CHANGE_KIND } from "@erp/domain";
import { Modal } from "../../components/shared/Modal";
import { ReadOnlyNotice } from "../../components/shared/ReadOnlyNotice";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { formatDate } from "../../utils/dates";
import type { WriteLease } from "../sync/useWriteLease";
import { parseEmployeeDetailReply, percentText, salaryText, type EmployeeDetail, type SalaryChange } from "./employees";
import { INCREMENT_FORM_ID, IncrementForm } from "./IncrementForm";

// AN EMPLOYEE'S CARD, opened from their row (owner, 27 Nov 2026), in the card pages' look (Modal themed, docs/56):
//
//   ALI RAZA                                                                ×
//   ┌ MONTHLY SALARY ─────────┐   WORK  CUTTING    PHONE  0300…
//   │ Rs 27,500                │   JOINED 1 Nov 2026  STATUS ✓ Working
//   └ +10% from 1 Dec 2026 ────┘
//   Salary history: From | Change | Monthly salary               the pages' table (doc-table), newest first
//                                                       [Close] [Increment]
//
// The salary is the one figure in the Store blue (Von Restorff), the same hero as the Customer Ledger's balance (R1).
// Increment is the second step of the same card (progressive disclosure): its form takes the card's place, with the
// salary now as the first term of its equation (one figure, one blue answer, no repeat), and the footer becomes
// [Back] [Save increment]. Read fresh each time it opens. Off the accounts
// computer the card says why it cannot change a salary (ReadOnlyNotice) instead of a bare disabled button.

const text = copy.salaries;

interface EmployeeCardProps {
  employeeId: string;
  /** This computer's ACCOUNTS lease: whether a salary may be changed here, and why not. */
  lease: WriteLease;
  onClose: () => void;
  onRaised: (employee: EmployeeDetail) => void;
}

const stepText = (line: SalaryChange): string => {
  if (line.kind === SALARY_CHANGE_KIND.PERCENT && line.amount !== null) return text.historyPercent(percentText(line.amount));
  if (line.kind === SALARY_CHANGE_KIND.FIXED && line.amount !== null) return text.historyFixed(salaryText(line.amount));
  return text.historyStart;
};

const Hero: React.FC<{ employee: EmployeeDetail }> = ({ employee }) => {
  const last = employee.history[employee.history.length - 1];
  const note = last && last.kind !== SALARY_CHANGE_KIND.START ? text.heroSinceChange(stepText(last), formatDate(last.effectiveOn)) : last ? text.heroSinceStart(formatDate(last.effectiveOn)) : null;
  return (
    <section className="cl-hero sal-hero" aria-label={text.heroLabel}>
      <span className="cl-hero-label">{text.heroLabel}</span>
      <strong className="cl-hero-figure">Rs {salaryText(employee.monthlySalaryPaisa)}</strong>
      {note ? <p className="cl-hero-note">{note}</p> : null}
    </section>
  );
};

const Details: React.FC<{ employee: EmployeeDetail }> = ({ employee }) => (
  <dl className="sal-card-details">
    <div><dt>{text.workLabelCard}</dt><dd>{employee.work ?? text.notGiven}</dd></div>
    <div><dt>{text.phoneLabelCard}</dt><dd>{employee.phone ?? text.notGiven}</dd></div>
    <div><dt>{text.joinedLabelCard}</dt><dd>{employee.joinedOn ? formatDate(employee.joinedOn) : text.notGiven}</dd></div>
    <div>
      <dt>{text.statusLabel}</dt>
      <dd>
        <span className={employee.status === EMPLOYEE_STATUS.ACTIVE ? "badge badge-ok" : "badge badge-muted"}>
          {employee.status === EMPLOYEE_STATUS.ACTIVE ? "✓ " : ""}{text.status[employee.status]}
        </span>
      </dd>
    </div>
  </dl>
);

const History: React.FC<{ employee: EmployeeDetail }> = ({ employee }) => (
  <section className="sal-history" aria-label={text.historyLabel(employee.name)}>
    <h3 className="sal-section-title">{text.historyTitle}</h3>
    <div className="doc-table-wrap card">
      <table className="data-table doc-table">
        <thead>
          <tr>
            <th scope="col">{text.historyColumns.from}</th>
            <th scope="col">{text.historyColumns.change}</th>
            <th scope="col" className="doc-num">{text.historyColumns.salary}</th>
          </tr>
        </thead>
        <tbody>
          {[...employee.history].reverse().map((line) => (
            <tr key={line.id}>
              <td className="sal-history-date">{formatDate(line.effectiveOn)}</td>
              <td>
                <span className="sal-history-step">{stepText(line)}</span>
                {line.note || line.createdBy ? (
                  <span className="cb-city">{[line.note, line.createdBy ? text.historyBy(line.createdBy) : null].filter(Boolean).join(" · ")}</span>
                ) : null}
              </td>
              <td className="doc-num"><strong>Rs {salaryText(line.toPaisa)}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
);

/** The card's footer action: Increment while looking, Save while incrementing. */
const footerOf = (employee: EmployeeDetail | null, incrementing: boolean, saving: boolean, canWrite: boolean, start: () => void): React.ReactNode => {
  if (employee === null) return undefined;
  if (incrementing) {
    return <button type="submit" form={INCREMENT_FORM_ID} className="btn btn-primary" disabled={saving}>{saving ? text.savingIncrement : text.saveIncrement}</button>;
  }
  const allowed = canWrite && employee.status === EMPLOYEE_STATUS.ACTIVE;
  return <button type="button" className="btn btn-primary" aria-label={text.incrementLabel(employee.name)} disabled={!allowed} onClick={start}>{text.increment}</button>;
};

export const EmployeeCard: React.FC<EmployeeCardProps> = ({ employeeId, lease, onClose, onRaised }) => {
  const api = useDesktopApi();
  const [employee, setEmployee] = useState<EmployeeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [incrementing, setIncrementing] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setError(null);
    void api.getEmployee(employeeId)
      .then((reply) => {
        const parsed = parseEmployeeDetailReply(reply, text.cardFailed);
        if (parsed.ok) setEmployee(parsed.value); else setError(parsed.reason);
      })
      .catch(() => setError(text.cardFailed));
  }, [api, employeeId]);

  useEffect(load, [load]);

  const body = () => {
    if (error && employee === null) return <StateView kind="error" compact title={error} onRetry={load} />;
    if (employee === null) return <StateView kind="loading" compact message={text.cardLoading} />;
    if (incrementing) {
      return (
        <IncrementForm employee={employee} onBusy={setSaving}
          onRaised={(raised) => { setEmployee(raised); setIncrementing(false); onRaised(raised); }} />
      );
    }
    return (
      <div className="sal-card">
        <div className="sal-card-top">
          <Hero employee={employee} />
          <Details employee={employee} />
        </div>
        {lease.canWrite ? null : <ReadOnlyNotice status={lease.status} />}
        <History employee={employee} />
      </div>
    );
  };

  return (
    <Modal themed wide title={employee?.name ?? text.cardSubtitle} subtitle={incrementing ? text.incrementTitle : text.cardSubtitle} onClose={onClose}
      footer={footerOf(employee, incrementing, saving, lease.canWrite, () => setIncrementing(true))}
      dismissLabel={incrementing ? text.back : text.close} onDismiss={incrementing ? () => setIncrementing(false) : undefined}>
      {body()}
    </Modal>
  );
};
