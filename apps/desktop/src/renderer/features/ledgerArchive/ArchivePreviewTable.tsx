import React from "react";
import type { LedgerArchiveSide } from "@erp/domain";
import { SearchableCombobox } from "../../components/shared/SearchableCombobox";
import { copy } from "../../config/copy";
import type { Party } from "../../types/desktopApi";
import { partyOption } from "../parties/partyOption";
import { formatDate } from "../../utils/dates";
import type { ImportPreview, PreviewStatement } from "./archiveReplies";
import { archiveAmount } from "./ArchivedLedgerRow";
import { statementReady } from "./importSession";
import type { ChosenStatement } from "./legacyImport";

// Each party in the chosen files, before anything is imported (docs/50, 53): whose ledger it is, who they are in the
// ERP (matched, or chosen here, from that side's parties only), what their rows add up to, and whether they can be
// imported. A statement with any problem is listed with its problems and left out; the rest go in together.

const text = copy.ledgerArchive;

function statusOf(statement: PreviewStatement): { label: string; tone: "ok" | "warn" | "err" } {
  const words = text.side[statement.side];
  if (statement.problems.length > 0) return { label: text.hasProblems(statement.problems.length), tone: "err" };
  if (statement.fileAlreadyImported) return { label: text.statementFileImported(statement.fileAlreadyImported.fileName, statement.fileAlreadyImported.importedBy), tone: "err" };
  if (statement.alreadyStored) return { label: text.alreadyStored(statement.alreadyStored.fileName), tone: "err" };
  if (statement.repeatedRows > 0) return { label: words.repeatedRows(statement.repeatedRows), tone: "err" };
  if (!statement.match) return { label: words.notMatched, tone: "warn" };
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

interface RowProps {
  statement: PreviewStatement;
  source: ChosenStatement | undefined;
  options: ReturnType<typeof partyOption>[];
  showFile: boolean;
  chosen: string | undefined;
  onChoose: (partyId: string) => void;
}

const StatementRow: React.FC<RowProps> = ({ statement, source, options, showFile, chosen, onChoose }) => {
  const status = statusOf(statement);
  const words = text.side[statement.side];
  const name = statement.customerName || statement.partyCode;
  const totals = statement.totals;
  const totalsAgree = source?.report !== null && source?.report !== undefined && statement.problems.length === 0;
  return (
    <tr>
      <td>
        <strong>{statement.customerName || "-"}</strong>
        <small className="ledger-import-code">{text.sideName[statement.side]}{statement.partyCode ? ` · ${statement.partyCode}` : ""}</small>
        {showFile && source && <small className="ledger-import-code">{source.fileName}</small>}
      </td>
      <td className="ledger-import-customer">
        <SearchableCombobox
          value={chosen ?? statement.match?.partyId ?? ""}
          options={options}
          placeholder={words.chooseParty}
          ariaLabel={words.chooseLabel(name)}
          dropdown
          onChange={(partyId) => { if (partyId) onChoose(partyId); }}
        />
        {statement.match && <small>{text.matchedBy[statement.match.how]}</small>}
        {statement.side === "SUPPLIER" && <small>{text.balanceRule[statement.balanceRule]}</small>}
      </td>
      <td className="amount">{totals.rowCount.toLocaleString("en-US")}</td>
      <td>{totals.periodFrom ? `${formatDate(totals.periodFrom, totals.periodFrom)} – ${formatDate(totals.periodTo, totals.periodTo)}` : "-"}</td>
      <td className="amount">{archiveAmount(totals.openingBalancePaisa)}</td>
      <td className="amount debit">{archiveAmount(totals.totalDebitPaisa)}</td>
      <td className="amount credit">{archiveAmount(totals.totalCreditPaisa)}</td>
      <td className="amount balance">{archiveAmount(totals.closingBalancePaisa)}</td>
      <td>
        <span className={`ledger-import-status ledger-import-status--${status.tone}`} data-ready={statementReady(statement)}>{status.label}</span>
        {totalsAgree && <small className="ledger-import-code">{text.totalsMatch}</small>}
        <Notes statement={statement} />
      </td>
    </tr>
  );
};

interface Props {
  preview: ImportPreview;
  /** Every party a statement may be matched to; each statement is offered its own side's only. */
  customers: readonly Party[];
  /** The ledger the import was opened from: its words head the table. */
  side?: LedgerArchiveSide;
  /** The statements as read from the files, in the preview's order. */
  sources?: readonly ChosenStatement[];
  showFile?: boolean;
  choices: Readonly<Record<number, string>>;
  onChoose: (index: number, partyId: string) => void;
}

export const ArchivePreviewTable: React.FC<Props> = ({ preview, customers, side = "CUSTOMER", sources = [], showFile = false, choices, onChoose }) => {
  const optionsOf = (statementSide: LedgerArchiveSide) => customers.filter((party) => party.partyType === statementSide).map(partyOption);
  const sideOptions = { CUSTOMER: optionsOf("CUSTOMER"), SUPPLIER: optionsOf("SUPPLIER") };
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
          {preview.statements.map((statement, index) => (
            <StatementRow
              key={`${statement.side}-${statement.partyCode}-${statement.customerName}-${String(index)}`}
              statement={statement}
              source={sources[index]}
              options={sideOptions[statement.side]}
              showFile={showFile}
              chosen={choices[index]}
              onChoose={(partyId) => onChoose(index, partyId)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
};
