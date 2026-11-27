import React, { useCallback, useEffect, useState } from "react";
import { EMPLOYEE_STATUS, SALARY_CHANGE_KIND } from "@erp/domain";
import { Modal } from "../../components/shared/Modal";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { formatDate } from "../../utils/dates";
import { parseEmployeeDetailReply, percentText, salaryText, type EmployeeDetail, type SalaryChange } from "./employees";
import { IncrementForm } from "./IncrementForm";

// AN EMPLOYEE'S CARD, opened from their row (owner, 27 Nov 2026: "clicking it opens the card of employee. with its
// details. also put a button in that card as increment"):
//
//   ALI RAZA                                                     Employee card
//   Monthly salary  Rs 27,500     Work CUTTING   Phone …   Joined 1 Nov 2026   Status Working
//   Salary history
//     1 Nov 2026   Started at            Rs 25,000
//     1 Dec 2026   +10%                  Rs 27,500    Yearly · by owner
//                                                              [Close] [Increment]
//
// Read fresh from the main process each time it opens, so the history is the database's. Increment is offered where
// the accounts are written (the page passes canWrite) and only for someone still working here.

const text = copy.salaries;

interface EmployeeCardProps {
  employeeId: string;
  /** Whether this computer may change a salary (the ACCOUNTS lease). */
  canWrite: boolean;
  onClose: () => void;
  onRaised: (employee: EmployeeDetail) => void;
}

const stepText = (line: SalaryChange): string => {
  if (line.kind === SALARY_CHANGE_KIND.PERCENT && line.amount !== null) return text.historyPercent(percentText(line.amount));
  if (line.kind === SALARY_CHANGE_KIND.FIXED && line.amount !== null) return text.historyFixed(salaryText(line.amount));
  return text.historyStart;
};

const History: React.FC<{ employee: EmployeeDetail }> = ({ employee }) => (
  <section className="sal-history" aria-label={text.historyLabel(employee.name)}>
    <h3 className="sal-increment-title">{text.historyTitle}</h3>
    <ol className="sal-history-list">
      {[...employee.history].reverse().map((line) => (
        <li key={line.id} className="sal-history-line">
          <span className="sal-history-date">{formatDate(line.effectiveOn)}</span>
          <span className="sal-history-step">{stepText(line)}</span>
          <strong className="sal-history-salary">Rs {salaryText(line.toPaisa)}</strong>
          {line.note || line.createdBy ? (
            <span className="sal-history-note">{[line.note, line.createdBy ? text.historyBy(line.createdBy) : null].filter(Boolean).join(" · ")}</span>
          ) : null}
        </li>
      ))}
    </ol>
  </section>
);

const Details: React.FC<{ employee: EmployeeDetail }> = ({ employee }) => (
  <dl className="sal-card-details">
    <div className="sal-card-salary"><dt>{text.salaryNow}</dt><dd>Rs {salaryText(employee.monthlySalaryPaisa)}</dd></div>
    <div><dt>{text.workLabelCard}</dt><dd>{employee.work ?? text.notGiven}</dd></div>
    <div><dt>{text.phoneLabelCard}</dt><dd>{employee.phone ?? text.notGiven}</dd></div>
    <div><dt>{text.joinedLabelCard}</dt><dd>{employee.joinedOn ? formatDate(employee.joinedOn) : text.notGiven}</dd></div>
    <div><dt>{text.statusLabel}</dt><dd>{text.status[employee.status]}</dd></div>
  </dl>
);

export const EmployeeCard: React.FC<EmployeeCardProps> = ({ employeeId, canWrite, onClose, onRaised }) => {
  const api = useDesktopApi();
  const [employee, setEmployee] = useState<EmployeeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [incrementing, setIncrementing] = useState(false);

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

  const working = employee?.status === EMPLOYEE_STATUS.ACTIVE;
  const footer = employee && !incrementing ? (
    <button type="button" className="btn btn-primary" aria-label={text.incrementLabel(employee.name)} disabled={!canWrite || !working} onClick={() => setIncrementing(true)}>
      {text.increment}
    </button>
  ) : undefined;

  const body = () => {
    if (error && employee === null) return <StateView kind="error" compact title={error} onRetry={load} />;
    if (employee === null) return <StateView kind="loading" compact message={text.cardLoading} />;
    return (
      <div className="sal-card">
        <Details employee={employee} />
        {incrementing ? (
          <IncrementForm employee={employee} onCancel={() => setIncrementing(false)}
            onRaised={(raised) => { setEmployee(raised); setIncrementing(false); onRaised(raised); }} />
        ) : null}
        <History employee={employee} />
      </div>
    );
  };

  return (
    <Modal title={employee?.name ?? text.cardSubtitle} subtitle={text.cardSubtitle} onClose={onClose} footer={footer} wide>
      {body()}
    </Modal>
  );
};
