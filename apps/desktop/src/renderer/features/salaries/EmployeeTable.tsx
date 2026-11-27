import React from "react";
import { EMPLOYEE_STATUS } from "@erp/domain";
import { copy } from "../../config/copy";
import { formatDate } from "../../utils/dates";
import { salaryText, type Employee } from "./employees";

// One row per employee, the monthly salary last and strongest (serial position). What they do sits under the name, so
// the table has one column fewer. An employee who has left says so in words (R18), not by a faded row alone. The
// Customer Balance table's look (doc-table, R1).

const text = copy.salaries;
const SKELETON_ROWS = Array.from({ length: 6 }, (_, index) => index);

const Head: React.FC = () => (
  <thead>
    <tr>
      <th scope="col">{text.columns.name}</th>
      <th scope="col" className="doc-col-wide">{text.columns.phone}</th>
      <th scope="col" className="doc-col-wide doc-num">{text.columns.joined}</th>
      <th scope="col" className="doc-num">{text.columns.salary}</th>
    </tr>
  </thead>
);

const Row: React.FC<{ employee: Employee }> = ({ employee }) => (
  <tr className={employee.status === EMPLOYEE_STATUS.LEFT ? "doc-row sal-left" : "doc-row"}>
    <td>
      <span className="sal-name">{employee.name}</span>
      {employee.work ? <span className="cb-city">{employee.work}</span> : null}
      {employee.status === EMPLOYEE_STATUS.LEFT ? <span className="badge badge-muted sal-status">{text.left}</span> : null}
    </td>
    <td className="doc-col-wide">{employee.phone ?? <span className="doc-muted">{text.notGiven}</span>}</td>
    <td className="doc-col-wide doc-num doc-muted">{employee.joinedOn ? formatDate(employee.joinedOn) : text.notGiven}</td>
    <td className="doc-num"><strong>Rs {salaryText(employee.monthlySalaryPaisa)}</strong></td>
  </tr>
);

interface EmployeeTableProps {
  rows: readonly Employee[];
  refreshing: boolean;
}

export const EmployeeTable: React.FC<EmployeeTableProps> = ({ rows, refreshing }) => (
  <div className={refreshing ? "doc-table-wrap card is-refreshing" : "doc-table-wrap card"} aria-busy={refreshing || undefined}>
    <table className="data-table doc-table" aria-label={text.tableLabel}>
      <Head />
      <tbody>{rows.map((employee) => <Row key={employee.id} employee={employee} />)}</tbody>
    </table>
  </div>
);

/** The table's own shape while the first read is on its way (no layout shift). */
export const EmployeeTableSkeleton: React.FC = () => (
  <div className="doc-table-wrap card" aria-busy="true">
    <p className="sr-only" role="status">{text.loading}</p>
    <table className="data-table doc-table" aria-hidden="true">
      <Head />
      <tbody>
        {SKELETON_ROWS.map((index) => (
          <tr key={index} className="doc-skeleton-row">
            <td><span className="cl-skeleton doc-bone doc-bone--wide" /></td>
            <td className="doc-col-wide"><span className="cl-skeleton doc-bone" /></td>
            <td className="doc-col-wide"><span className="cl-skeleton doc-bone" /></td>
            <td><span className="cl-skeleton doc-bone" /></td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
