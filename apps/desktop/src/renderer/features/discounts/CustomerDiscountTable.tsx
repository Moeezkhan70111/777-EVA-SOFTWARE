import React from "react";
import { copy } from "../../config/copy";
import type { Party } from "../../types/desktopApi";
import { boxText, cellKey, discountText } from "./discountPolicy";

// The customers and their discount on one thing, a box each (or a box per size): the pages' table (doc-table), names
// down, discounts across, right-aligned and tabular. A box starts with the discount now; a changed box says what it was
// under it (recognition over recall), and a problem is said under the box in words (R18).

const text = copy.discountPolicy;

export interface DiscountColumn {
  /** "" for one discount on the whole thing, else the size. */
  readonly size: string;
  readonly label: string;
}

interface CustomerDiscountTableProps {
  customers: readonly Party[];
  columns: readonly DiscountColumn[];
  current: ReadonlyMap<string, number>;
  drafts: Readonly<Record<string, string>>;
  problems: ReadonlyMap<string, string>;
  /** What the discount is on, for each box's name: "EVR GENTS", "SK6 size 7/10". */
  what: string;
  disabled: boolean;
  onType: (key: string, value: string) => void;
}

const Box: React.FC<{ id: string; label: string; value: string; was: number | undefined; changed: boolean; problem: string | undefined; disabled: boolean; onType: (value: string) => void }> = ({
  id, label, value, was, changed, problem, disabled, onType,
}) => (
  <td className={changed ? "doc-num dp-cell is-changed" : "doc-num dp-cell"}>
    <input id={id} className="form-input dp-input" inputMode="decimal" value={value} disabled={disabled} aria-label={label}
      aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${id}-problem` : undefined} onChange={(event) => onType(event.target.value)} />
    {problem ? <span id={`${id}-problem`} className="dp-problem" role="alert">⚠ {problem}</span>
      : changed && was !== undefined ? <span className="dp-was">{text.was(discountText(was))}</span> : null}
  </td>
);

export const CustomerDiscountTable: React.FC<CustomerDiscountTableProps> = ({ customers, columns, current, drafts, problems, what, disabled, onType }) => (
  <div className="doc-table-wrap card dp-table-wrap">
    <table className="data-table doc-table dp-table">
      <thead>
        <tr>
          <th scope="col">{text.customer}</th>
          {columns.map((column) => <th key={column.size} scope="col" className="doc-num">{column.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {customers.map((customer) => (
          <tr key={customer.id}>
            <th scope="row" className="dp-customer">{customer.partyName}</th>
            {columns.map((column) => {
              const key = cellKey(customer.id, column.size);
              const value = boxText(key, drafts, current);
              const was = current.get(key);
              const changed = key in drafts && value.trim() !== (was === undefined ? "" : discountText(was));
              return (
                <Box key={column.size} id={`dp-${customer.id}-${column.size || "all"}`} value={value} was={was} changed={changed} problem={problems.get(key)} disabled={disabled}
                  label={text.boxLabel(customer.partyName, column.size ? `${what} ${column.label}` : what)} onType={(next) => onType(key, next)} />
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
