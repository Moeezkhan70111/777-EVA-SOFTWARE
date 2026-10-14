import React, { useState } from "react";
import { formatQuantityInDozens } from "@erp/domain";
import { copy } from "../../config/copy";
import type { CartonProgramLine, MachineDayProgram } from "../../types/desktopApi";
import { formatTime } from "../../utils/dates";
import { CartonProgramRuns } from "./CartonProgramRuns";

// One program's lines — one row per article, size and colour (a B carton line is its own row):
//
//   Article   Size   Colour         Carton QRs   Equivalent Dozens   Runs   Last generated
//   ▸ SK6     7/10   BLACKGREY             10              5 DZN       1    10:42
//   ▸ EVR9    7/10   MIX  [B]               3            1.5 DZN       1    11:05
//
// Every figure arrives already counted by the main process; this only lays them out. Opening a
// row lists the generation runs it is made of.

const text = copy.cartonProgram;
const COLUMN_COUNT = 7;

const lineKey = (line: CartonProgramLine) => `${line.articleSizeId}|${line.color}|${line.grade ?? ""}`;

const LineRow: React.FC<{ programId: string; line: CartonProgramLine }> = ({ programId, line }) => {
  const [open, setOpen] = useState(false);
  const runsId = `cp-runs-${programId}-${lineKey(line)}`;
  const toggleLabel = (open ? text.hideRuns : text.showRuns)(line.article, line.size, line.color);

  return (
    <>
      <tr className={open ? "cp-row is-open" : "cp-row"}>
        <td>
          <button
            type="button"
            className="btn btn-ghost btn-sm cp-toggle"
            aria-expanded={open}
            aria-controls={open ? runsId : undefined}
            aria-label={toggleLabel}
            title={toggleLabel}
            onClick={() => setOpen((value) => !value)}
          >
            <span aria-hidden="true">{open ? "▾" : "▸"}</span>
          </button>
          <strong>{line.article}</strong>
        </td>
        <td>{line.size}</td>
        <td>
          {line.color}
          {line.grade ? (
            <span className="badge badge-warn cp-grade" title={text.bBadgeLabel} aria-label={text.bBadgeLabel}>
              {text.bBadge}
            </span>
          ) : null}
        </td>
        <td className="cp-num cp-cartons">
          <strong>{line.cartons.toLocaleString()}</strong>
          {line.voidedCartons > 0 ? <small className="cp-voided">{text.voided(line.voidedCartons)}</small> : null}
        </td>
        <td className="cp-num">{formatQuantityInDozens(line.cartons)}</td>
        <td className="cp-num">{line.batchCount.toLocaleString()}</td>
        <td className="cp-when">{formatTime(line.lastGeneratedAt)}</td>
      </tr>
      {open ? (
        <tr className="cp-runs-row">
          <td colSpan={COLUMN_COUNT}>
            <CartonProgramRuns programId={programId} line={line} id={runsId} />
          </td>
        </tr>
      ) : null}
    </>
  );
};

export const CartonProgramTable: React.FC<{ program: MachineDayProgram }> = ({ program }) => (
  <div className="cp-table-wrap">
    <table className="data-table cp-table">
      <caption className="sr-only">{text.tableCaption(program.code)}</caption>
      <thead>
        <tr>
          <th scope="col">{text.colArticle}</th>
          <th scope="col">{text.colSize}</th>
          <th scope="col">{text.colColor}</th>
          <th scope="col" className="cp-num">{text.colCartons}</th>
          <th scope="col" className="cp-num">{text.colDozens}</th>
          <th scope="col" className="cp-num">{text.colRuns}</th>
          <th scope="col">{text.colLast}</th>
        </tr>
      </thead>
      <tbody>
        {program.lines.map((line) => (
          <LineRow key={lineKey(line)} programId={program.programId} line={line} />
        ))}
      </tbody>
    </table>
  </div>
);
