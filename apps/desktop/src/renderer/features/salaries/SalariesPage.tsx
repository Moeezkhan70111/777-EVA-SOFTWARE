import React, { useMemo, useState } from "react";
import { EMPLOYEE_STATUS, LEASE_DOMAIN, monthlySalaryTotal } from "@erp/domain";
import { ReadOnlyNotice } from "../../components/shared/ReadOnlyNotice";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { useNotifications } from "../../state/NotificationsContext";
import { useWriteLease } from "../sync/useWriteLease";
import { AddEmployeeDialog } from "./AddEmployeeDialog";
import { EmployeeTable, EmployeeTableSkeleton } from "./EmployeeTable";
import { salaryText } from "./employees";
import { useEmployees } from "./useEmployees";

// SALARIES (owner, 27 Nov 2026: "add a new card on dashboard named as Salaries. in this page put an add Employee
// Button"):
//
//   Salaries                                                [ + Add Employee ]
//   ┌ Employees  12 ┐  ┌ Salaries a month  Rs 3,40,000 ┐
//   Employee (work) | Phone | Joined | Monthly salary
//
// Employees are written where the accounts are (ACCOUNTS, PC1): anywhere else the page reads and says why it cannot
// add (ReadOnlyNotice). The month's total is the domain's (monthlySalaryTotal), in paisa, working employees only.

const text = copy.salaries;

export const SalariesPage: React.FC = () => {
  const employees = useEmployees();
  const lease = useWriteLease(LEASE_DOMAIN.ACCOUNTS);
  const { push } = useNotifications();
  const [adding, setAdding] = useState(false);
  const rows = employees.rows;
  const working = useMemo(() => (rows ?? []).filter((employee) => employee.status === EMPLOYEE_STATUS.ACTIVE).length, [rows]);
  const total = useMemo(() => monthlySalaryTotal(rows ?? []), [rows]);
  const refreshing = employees.loading && rows !== null;

  const body = () => {
    if (employees.error && rows === null) return <StateView kind="error" title={text.failed} onRetry={employees.reload} />;
    if (rows === null) return <EmployeeTableSkeleton />;
    if (rows.length === 0) return <StateView kind="empty" title={text.emptyTitle} hint={text.emptyHint} />;
    return <EmployeeTable rows={rows} refreshing={refreshing} />;
  };

  return (
    <div className="page doc-themed cl-page sal-page">
      <header className="cl-head">
        <div className="cl-head-title"><h1>{text.title}</h1></div>
        <div className="cl-head-actions">
          <button type="button" className="btn btn-primary" aria-label={text.addEmployeeLabel} disabled={!lease.canWrite} onClick={() => setAdding(true)}>
            {text.addEmployee}
          </button>
        </div>
      </header>
      <ReadOnlyNotice status={lease.status} />
      {rows !== null && rows.length > 0 ? (
        <dl className="sal-figures">
          <div className="card"><dt>{text.employeesLabel}</dt><dd>{text.employeeCount(working)}</dd></div>
          <div className="card sal-figure-main"><dt>{text.monthlyLabel}</dt><dd>Rs {salaryText(total)}</dd></div>
        </dl>
      ) : null}
      {employees.error && rows !== null ? <StateView kind="error" compact message={text.failed} onRetry={employees.reload} /> : null}
      {body()}
      {adding ? (
        <AddEmployeeDialog
          onClose={() => setAdding(false)}
          onAdded={(employee) => {
            setAdding(false);
            push("success", text.addedTitle(employee.name), text.addedBody(salaryText(employee.monthlySalaryPaisa)));
            employees.reload();
          }}
        />
      ) : null}
    </div>
  );
};
