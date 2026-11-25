import React from "react";
import { CARTON_ADJUSTMENT_KIND, type CartonAdjustmentDirection, type CartonAdjustmentKind } from "@erp/domain";
import { MissingSizeCell } from "../../components/shared/MissingSizeCell";
import { SizeColourGrid, type GridBoxProps } from "../../components/shared/SizeColourGrid";
import { copy } from "../../config/copy";
import { dozensText, lineKey, resultOf, typedCartons, type EntryGrid } from "./stockAdjustmentDraft";
import type { AdjustmentChoice } from "./stockAdjustmentReply";

// ONE ARTICLE, EVERY COLOUR AND SIZE AT ONCE (owner, 13 Nov 2026), IN DOZENS: sizes down the side, colours across,
// a box in every cell (SizeColourGrid, shared). Under a box: what the store holds now and what the typed dozens would
// leave, in amber when that is below zero. A cell that already has opening stock says so in words and takes no
// quantity; a size the colour is not made in is the shared "Not in Product Master / + Add" cell (MissingSizeCell), as
// on every quantity-by-colour page. Arrow Up and Down move along a colour; Enter adds every typed cell.

const text = copy.stockAdjustment;

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
  /** A colour was added to Product Master from a cell: the article is read again, so its box appears. */
  onColourAdded: () => void;
}

/** Why a cell takes no quantity, in words, or null when it does. */
const lockedNote = (choice: AdjustmentChoice, opening: boolean): string | null => (opening && choice.hasOpening ? text.hasOpening : null);

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
  box: GridBoxProps;
  locked: string | null;
  direction: CartonAdjustmentDirection;
  typed: string;
  problem: string | undefined;
  onType: (value: string) => void;
}

const Cell: React.FC<CellProps> = ({ choice, box, locked, direction, typed, problem, onType }) => {
  if (!choice) return <td className="sa-cell"><span className="sa-note">{copy.common.none}</span></td>;
  if (locked) {
    return <td className="sa-cell is-locked"><span className="sa-note">{locked}</span><CellFigures choice={choice} direction={direction} typed="" /></td>;
  }
  const inputId = `sa-qty-${lineKey(choice.articleSizeId, choice.color)}`;
  return (
    <td className={problem ? "sa-cell is-invalid" : "sa-cell"}>
      <input id={inputId} className="form-input sa-qty" inputMode="decimal" autoComplete="off" value={typed} {...box}
        aria-label={text.quantityFor(choice.color, choice.size)} aria-invalid={problem !== undefined} aria-describedby={problem ? `${inputId}-problem` : undefined}
        onChange={(event) => onType(event.target.value)} />
      <CellFigures choice={choice} direction={direction} typed={typed} />
      {problem ? <span id={`${inputId}-problem`} className="sa-problem" role="alert">⚠ {problem}</span> : null}
    </td>
  );
};

export const QuantityGrid: React.FC<QuantityGridProps> = ({ article, kind, direction, grid, typed, problems, canAddColor, onType, onEnter, onColourAdded }) => {
  const opening = kind === CARTON_ADJUSTMENT_KIND.OPENING;
  /** Every size of the article not made in a colour: what "+ Add" adds the colour to. */
  const sizesMissing = (colour: string): string[] =>
    grid.sizes.filter((size) => grid.cells.get(lineKey(size.articleSizeId, colour))?.colorMissing).map((size) => size.size);
  return (
    <SizeColourGrid
      label={text.gridLabel(article)}
      sizeHeader={text.sizeColumn}
      sizes={grid.sizes.map((size) => ({ id: size.articleSizeId, size: size.size }))}
      colours={grid.colours}
      onEnter={onEnter}
      renderCell={(size, colour, box) => {
        const key = lineKey(size.id, colour);
        const choice = grid.cells.get(key);
        if (choice?.colorMissing) {
          return <MissingSizeCell className="sa-cell" article={article} colour={colour} size={size.size} missingSizes={sizesMissing(colour)}
            canAdd={canAddColor} disabled={false} onAdded={onColourAdded} />;
        }
        return (
          <Cell choice={choice} box={box} direction={direction} typed={typed[key] ?? ""} problem={problems.get(key)}
            locked={choice ? lockedNote(choice, opening) : null} onType={(value) => onType(key, value)} />
        );
      }}
    />
  );
};
