import React from "react";
import type { MachineProgramRunRecord, MachineProgramUpperLineRecord } from "../../types/desktopApi";
import { ColorSwatch } from "../../components/shared/ColorSwatch";
import { copy } from "../../config/copy";
import { FixQuantityCell } from "./FixQuantityCell";
import { QuantityCell } from "./QuantityCell";
import { TrashIcon } from "./MachineProgramIcons";
import { formatNumber } from "./machineProgram";
import { isFixRun, type MachineShift } from "@erp/domain";
import { useUppers } from "./useMachineProgramData";
import type { ProgramWrites } from "./useProgramWrites";

// One saved sole run as rows of the colour's table — one row per upper on it:
//
//   SK6   7/10   ● Black    30 DOZEN   [ 10 ]   🗑
//   SK6   7/10   ● Green    60 DOZEN   [ 10 ]   🗑
//
// "Available Stock (Upper)" is what the STORE holds for this row to draw on, read live rather
// than remembered. The row's OWN quantity is not taken off it — typing 5 against a 15 DOZEN
// upper must leave the column reading 15, not 10, because the 5 is already shown in the next
// column and the operator is being told what there is, not what is left after themselves.
//
// Other programs' reservations ARE taken off, so the figure is still what this row may be set to
// and never over-promises the store. It is exactly the ceiling the quantity box enforces, so the
// two columns can never disagree. The store's own count comes from the data layer
// (listMachineProgramUppers); nothing is worked out here.
//
// The article and the size describe the RUN, not the row. Clicking either opens the run's own
// change, which is why they are buttons and say so to a screen reader.

interface SoleRunRowsProps {
  run: MachineProgramRunRecord;
  machineId: string;
  programDate: string;
  shift: MachineShift;
  /** True when every run under this sole is a FIX run, so the table has no upper columns. */
  fixOnly: boolean;
  writes: ProgramWrites;
  onChangeRun: () => void;
  onRemoveLine: (line: MachineProgramUpperLineRecord) => void;
  onRemoveRun: () => void;
}

/** A sole colour as the table names it: the colour, and the word for it. */
const SoleName: React.FC<{ colour: string }> = ({ colour }) => (
  <>
    <ColorSwatch color={colour} />
    <span className="mpx-upper-colour">{colour}</span>
  </>
);

export const SoleRunRows: React.FC<SoleRunRowsProps> = ({
  run,
  machineId,
  programDate,
  shift,
  fixOnly,
  writes,
  onChangeRun,
  onRemoveLine,
  onRemoveRun,
}) => {
  const uppers = useUppers(machineId, run.articleSizeId, writes.stockVersion);
  const described = `${run.article} ${run.size}`;

  /**
   * The store's stock for this row: what is free of the upper, with this row's own reservation
   * added back. One figure, used both for the column and as the quantity box's ceiling.
   */
  const inStore = (line: MachineProgramUpperLineRecord): number | null => {
    const material = uppers.value.find((candidate) => candidate.itemId === line.itemId);
    return material ? material.available + line.quantity : null;
  };

  /** A bare number: the unit is said once, in the Qty to Run heading, and the whole table is in it. */
  const free = (line: MachineProgramUpperLineRecord): string => {
    const stock = inStore(line);
    if (stock != null) return formatNumber(stock);
    return uppers.loading ? copy.common.loading : "—";
  };

  // A FIX article has no upper: it is moulded from TWO soles, and the row names both of them —
  // the outer one the card is grouped by, and the inner one that goes inside it. Both are on the
  // row rather than only the card's heading, because what the floor is handed is a line of work
  // and a line of work has to say what it is made of.
  //
  // There is nothing to fetch from the store for it, so on a card where every article is fix the
  // upper columns are not there at all (SoleGroup writes the headings to match). On a card that
  // mixes the two, the pair shares the Upper Color cell and says plainly that it has no upper.
  //
  // The quantity is the run's own and reserves nothing, so it is typed against no ceiling.
  if (isFixRun(run)) {
    return (
      <tbody className="mpx-run">
        <tr>
          <td className="mpx-cell-article" data-label={copy.machineProgram.colArticle}>
            <button
              type="button"
              className="mpx-run-link"
              aria-label={`${copy.machineProgram.editSole} ${described}`}
              onClick={onChangeRun}
            >
              {run.article}
            </button>
          </td>
          <td className="mpx-cell-size" data-label={copy.machineProgram.colSize}>
            <button
              type="button"
              className="mpx-run-link mpx-run-link--plain"
              aria-label={`${copy.machineProgram.editSole} ${described}`}
              onClick={onChangeRun}
            >
              {run.size}
            </button>
          </td>

          {fixOnly ? (
            <>
              <td className="mpx-cell-upper" data-label={copy.machineProgram.colOuterSole}>
                <SoleName colour={run.soleColour} />
              </td>
              <td className="mpx-cell-upper" data-label={copy.machineProgram.colInnerSole}>
                <SoleName colour={run.innerSoleColour ?? ""} />
              </td>
            </>
          ) : (
            <>
              {/* No column of its own to put the outer sole in, so the pair shares the cell. */}
              <td className="mpx-cell-upper" data-label={copy.machineProgram.colUpper}>
                <SoleName colour={run.soleColour} />
                <span className="mpx-upper-sep" aria-hidden="true">
                  /
                </span>
                <SoleName colour={run.innerSoleColour ?? ""} />
                <span className="mpx-upper-kind">{copy.machineProgram.fixNoUpperShort}</span>
              </td>
              <td className="mpx-num" data-label={copy.machineProgram.colAvailable}>
                —
              </td>
            </>
          )}

          <td className="mpx-cell-qty" data-label={copy.machineProgram.colQuantityShort}>
            <FixQuantityCell machineId={machineId} programDate={programDate} shift={shift} run={run} writes={writes} />
          </td>

          <td className="mpx-cell-remove">
            <button
              type="button"
              className="mpx-icon-btn mpx-icon-btn--danger"
              aria-label={`${copy.machineProgram.removeArticle} ${described}`}
              onClick={onRemoveRun}
            >
              <TrashIcon />
            </button>
          </td>
        </tr>
      </tbody>
    );
  }

  return (
    <tbody className="mpx-run">
      {run.lines.map((line) => (
        <tr key={line.id}>
          <td className="mpx-cell-article" data-label={copy.machineProgram.colArticle}>
            <button
              type="button"
              className="mpx-run-link"
              aria-label={`${copy.machineProgram.editSole} ${described}`}
              onClick={onChangeRun}
            >
              {run.article}
            </button>
          </td>

          <td className="mpx-cell-size" data-label={copy.machineProgram.colSize}>
            <button
              type="button"
              className="mpx-run-link mpx-run-link--plain"
              aria-label={`${copy.machineProgram.editSole} ${described}`}
              onClick={onChangeRun}
            >
              {run.size}
            </button>
          </td>

          <td className="mpx-cell-upper" data-label={copy.machineProgram.colUpper}>
            <ColorSwatch color={line.upperColour} />
            <span className="mpx-upper-colour">{line.upperColour}</span>
            <span className="mpx-upper-kind">{line.subCategoryName}</span>
          </td>

          <td className="mpx-num" data-label={copy.machineProgram.colAvailable}>
            {free(line)}
          </td>

          <td className="mpx-cell-qty" data-label={copy.machineProgram.colQuantityShort}>
            <QuantityCell
              machineId={machineId}
              programDate={programDate}
              run={run}
              line={line}
              limit={inStore(line) ?? line.quantity}
              loadingLimit={uppers.loading && uppers.value.length === 0}
              writes={writes}
            />
          </td>

          <td className="mpx-cell-remove">
            <button
              type="button"
              className="mpx-icon-btn mpx-icon-btn--danger"
              aria-label={`${copy.machineProgram.removeUpper} ${line.upperColour} — ${described}`}
              onClick={() => onRemoveLine(line)}
            >
              <TrashIcon />
            </button>
          </td>
        </tr>
      ))}
    </tbody>
  );
};
