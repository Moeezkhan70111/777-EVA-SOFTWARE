import React from "react";
import type { LedgerArchiveSide } from "@erp/domain";
import { SearchableCombobox } from "../../components/shared/SearchableCombobox";
import { copy } from "../../config/copy";
import type { Party } from "../../types/desktopApi";
import { partyOption } from "../parties/partyOption";
import { formatDate } from "../../utils/dates";
import type { ImportPreview, PreviewStatement } from "./archiveReplies";
import { archiveAmount } from "./ArchivedLedgerRow";
import { statementReady } from "./useArchiveImport";

// Each customer in the chosen file, before anything is imported (docs/50): who they are in the ERP (matched, or
// chosen here), what their rows add up to, and whether they can be imported. A statement with any problem is listed
// with its problems and left out; the rest go in together.

const text = copy.ledgerArchive;

function statusOf(statement: PreviewStatement, side: LedgerArchiveSide): { label: string; tone: "ok" | "warn" | "err" } {
  if (statement.problems.length > 0) return { label: text.hasProblems(statement.problems.length), tone: "err" };
  if (statement.alreadyStored) return { label: text.alreadyStored(statement.alreadyStored.fileName), tone: "err" };
  if (statement.repeatedRows > 0) return { label: text.side[side].repeatedRows(statement.repeatedRows), tone: "err" };
  if (!statement.match) return { label: text.side[side].notMatched, tone: "warn" };
  return { label: text.ready, tone: "ok" };
}

const Notes: React.FC<{ statement: PreviewStatement }> = ({ statement }) => {
  const notes = [...statement.problems, ...statement.warnings];
  if (notes.length === 0) return null;
  return (
    <details className="ledger-import-details">
      <summary>{statement.problems.length > 0 ? text.showDetails : text.warnings(statement.warnings.length)}</summary>
      <ul>{notes.map((note) => <li key={note}>{note}</li>)}</ul>
    </details>
  );
};

interface Props {
  preview: ImportPreview;
  customers: readonly Party[];
  side?: LedgerArchiveSide;
  choices: Readonly<Record<number, string>>;
  onChoose: (index: number, partyId: string) => void;
}

export const ArchivePreviewTable: React.FC<Props> = ({ preview, customers, side = "CUSTOMER", choices, onChoose }) => {
  const options = customers.map(partyOption);
  const words = text.side[side];
  return (
    <div className="ledger-import-table-wrap">
      <table className="customer-ledger-table ledger-import-table">
        <thead>
          <tr>
            <th>{words.partyInFile}</th>
            <th>{words.erpParty}</th>
            <th className="amount">{text.rowsColumn}</th>
            <th>{text.periodColumn}</th>
            <th className="amount">{text.openingColumn}</th>
            <th className="amount">{text.debitColumn}</th>
            <th className="amount">{text.creditColumn}</th>
            <th className="amount">{text.closingColumn}</th>
            <th>{text.statusColumn}</th>
          </tr>
        </thead>
        <tbody>
          {preview.statements.map((statement, index) => {
            const status = statusOf(statement, side);
            const name = statement.customerName || statement.partyCode;
            const totals = statement.totals;
            return (
              <tr key={`${statement.partyCode}-${statement.customerName}-${String(index)}`}>
                <td>
                  <strong>{statement.customerName || "-"}</strong>
                  {statement.partyCode && <small className="ledger-import-code">{statement.partyCode}</small>}
                </td>
                <td className="ledger-import-customer">
                  <SearchableCombobox
                    value={choices[index] ?? statement.match?.partyId ?? ""}
                    options={options}
                    placeholder={words.chooseParty}
                    ariaLabel={words.chooseLabel(name)}
                    dropdown
                    onChange={(partyId) => { if (partyId) onChoose(index, partyId); }}
                  />
                  {statement.match && <small>{text.matchedBy[statement.match.how]}</small>}
                  {side === "SUPPLIER" && <small>{text.balanceRule[statement.balanceRule]}</small>}
                </td>
                <td className="amount">{totals.rowCount.toLocaleString("en-US")}</td>
                <td>{totals.periodFrom ? `${formatDate(totals.periodFrom, totals.periodFrom)} – ${formatDate(totals.periodTo, totals.periodTo)}` : "-"}</td>
                <td className="amount">{archiveAmount(totals.openingBalancePaisa)}</td>
                <td className="amount debit">{archiveAmount(totals.totalDebitPaisa)}</td>
                <td className="amount credit">{archiveAmount(totals.totalCreditPaisa)}</td>
                <td className="amount balance">{archiveAmount(totals.closingBalancePaisa)}</td>
                <td>
                  <span className={`ledger-import-status ledger-import-status--${status.tone}`} data-ready={statementReady(statement)}>{status.label}</span>
                  <Notes statement={statement} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
