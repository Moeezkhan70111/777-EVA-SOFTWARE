import React, { useRef } from "react";
import { CARTON_ADJUSTMENT_KIND, type CartonAdjustmentDirection, type CartonAdjustmentKind } from "@erp/domain";
import { ColorSwatch } from "../../components/shared/ColorSwatch";
import { SidewaysScrollArea } from "../../components/shared/SidewaysScrollArea";
import { copy } from "../../config/copy";
import { dozensText, lineKey, resultOf, typedCartons, type EntryGrid } from "./stockAdjustmentDraft";
import type { AdjustmentChoice } from "./stockAdjustmentReply";

// ONE ARTICLE, EVERY COLOUR AND SIZE AT ONCE (owner, 13 Nov 2026), IN DOZENS: sizes down the side, colours across,
// a box in every cell. Under a box: what the store holds now and what the typed dozens would leave, in amber when
// that is below zero. A cell that already has opening stock, or whose colour cannot be put on that size here, says so
// in words and takes no quantity. Arrow Up and Down move along a colour; Enter adds every typed cell.

const text = copy.stockAdjustment;
/** The pinned Size column's width, for the sideways-scroll fades. */
const SIZE_COLUMN_WIDTH = 96;

interface QuantityGridProps {
  article: string;
  kind: CartonAdjustmentKind;
  direction: CartonAdjustmentDirection;
  grid: EntryGrid;
  typed: Readonly<Record<string, string>>;
  problems: ReadonlyMap<string, string>;
  canAddColor: boolean;
  onType: (key: string, value: string) => void;
  onEnter: () => void;
}

/** Why a cell takes no quantity, in words, or null when it does. */
const lockedNote = (choice: AdjustmentChoice, opening: boolean, canAddColor: boolean): string | null => {
  if (choice.colorMissing && !canAddColor) return text.colorNotOnSize;
  if (opening && choice.hasOpening) return text.hasOpening;
  return null;
};

/** "Now 5 → 8" under a box: the figure in store, and the one the typed dozens would leave. */
const CellFigures: React.FC<{ choice: AdjustmentChoice; direction: CartonAdjustmentDirection; typed: string }> = ({ choice, direction, typed }) => {
  const cartons = typedCartons(typed);
  const result = cartons === null ? null : resultOf({ inStore: choice.inStore, direction, cartons });
  if (result === null && choice.inStore === 0) return null;
  const below = result !== null && result < 0;
  return (
    <span className={below ? "sa-cell-figures is-below-zero" : "sa-cell-figures"}>
      {text.cellNow(dozensText(choice.inStore))}
      {result === null ? null : ` → ${dozensText(result)}`}
      {below ? " ⚠" : null}
    </span>
  );
};

interface CellProps {
  choice: AdjustmentChoice | undefined;
  row: number;
  column: number;
  locked: string | null;
  direction: CartonAdjustmentDirection;
  typed: string;
  problem: string | undefined;
  canAddColor: boolean;
  onType: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}

const Cell: React.FC<CellProps> = ({ choice, row, column, locked, direction, typed, problem, canAddColor, onType, onKeyDown }) => {
  if (!choice) return <td className="sa-cell"><span className="sa-note">{copy.common.none}</span></td>;
  if (locked) {
    return <td className="sa-cell is-locked"><span className="sa-note">{locked}</span><CellFigures choice={choice} direction={direction} typed="" /></td>;
  }
  const inputId = `sa-qty-${lineKey(choice.articleSizeId, choice.color)}`;
  return (
    <td className={problem ? "sa-cell is-invalid" : "sa-cell"}>
      <input id={inputId} className="form-input sa-qty" inputMode="decimal" autoComplete="off" value={typed} data-row={row} data-column={column}
        aria-label={text.quantityFor(choice.color, choice.size)} aria-invalid={problem !== undefined} aria-describedby={problem ? `${inputId}-problem` : undefined}
        onChange={(event) => onType(event.target.value)} onKeyDown={onKeyDown} />
      {choice.colorMissing && canAddColor ? <span className="sa-note sa-new-on-size">{text.newOnSize}</span> : null}
      <CellFigures choice={choice} direction={direction} typed={typed} />
      {problem ? <span id={`${inputId}-problem`} className="sa-problem" role="alert">⚠ {problem}</span> : null}
    </td>
  );
};

export const QuantityGrid: React.FC<QuantityGridProps> = ({ article, kind, direction, grid, typed, problems, canAddColor, onType, onEnter }) => {
  const tableRef = useRef<HTMLTableElement>(null);
  const opening = kind === CARTON_ADJUSTMENT_KIND.OPENING;

  /** Enter adds; Up and Down move to the same colour on the size above or below. */
  const keyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); onEnter(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const { row, column } = event.currentTarget.dataset;
    const next = Number(row) + (event.key === "ArrowDown" ? 1 : -1);
    const target = tableRef.current?.querySelector<HTMLInputElement>(`input[data-row="${String(next)}"][data-column="${String(column)}"]`);
    if (target) { event.preventDefault(); target.focus(); target.select(); }
  };

  return (
    <SidewaysScrollArea label={text.gridLabel(article)} colourCount={grid.colours.length} pinnedStart={SIZE_COLUMN_WIDTH}>
      <table ref={tableRef} className="data-table sa-grid">
        <thead>
          <tr>
            <th scope="col" className="sa-grid-size">{text.sizeColumn}</th>
            {grid.colours.map((colour) => (
              <th scope="col" key={colour} className="sa-grid-colour">
                <span className="sa-grid-colour-name"><ColorSwatch color={colour} />{colour}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.sizes.map((size, row) => (
            <tr key={size.articleSizeId}>
              <th scope="row" className="sa-grid-size">{size.size}</th>
              {grid.colours.map((colour, column) => {
                const key = lineKey(size.articleSizeId, colour);
                const choice = grid.cells.get(key);
                return (
                  <Cell key={colour} choice={choice} row={row} column={column} direction={direction} typed={typed[key] ?? ""} problem={problems.get(key)}
                    locked={choice ? lockedNote(choice, opening, canAddColor) : null} canAddColor={canAddColor}
                    onType={(value) => onType(key, value)} onKeyDown={keyDown} />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </SidewaysScrollArea>
  );
};
