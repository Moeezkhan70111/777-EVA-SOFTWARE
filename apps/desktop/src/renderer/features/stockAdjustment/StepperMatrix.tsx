import React, { useId } from "react";
import type { CartonAdjustmentKind } from "@erp/domain";
import { MissingSizeCell } from "../../components/shared/MissingSizeCell";
import { SidewaysScrollArea } from "../../components/shared/SidewaysScrollArea";
import { copy } from "../../config/copy";
import { useElementWidth } from "../../hooks/useElementWidth";
import { ColourHead, dozenFigure } from "../cartonStock/CartonMatrix";
import { CARTON_LAYOUT, cartonLayout } from "../cartonStock/cartonMatrixLayout";
import { dozensText, lineKey, type EntryGrid } from "./stockAdjustmentDraft";
import { canStepDown, isSteppable, stepTotals, type Steps } from "./stepperDraft";
import type { AdjustmentChoice } from "./stockAdjustmentReply";

// THE + / − VIEW (owner, 27 Nov 2026): "just like Carton Stock, but click + and − to adjust the stock". The article's
// card as Carton Stock draws it (name block, Size down, colours across with their Urdu names, Totals), and in every
// cell − and + around what the store will hold. The change shows under it, signed, so it never rests on colour alone.

const text = copy.stockAdjustment;

/** Carton Stock's columns, with colour columns wide enough for − figure +. */
const CARD_STYLE = {
  "--cs-name-width": `${CARTON_LAYOUT.nameWidth}px`,
  "--cs-colour-min": "10.5rem",
} as React.CSSProperties;

const signedDozens = (cartons: number): string => `${cartons > 0 ? "+" : "−"}${dozensText(Math.abs(cartons))}`;

interface StepCellProps {
  choice: AdjustmentChoice | undefined;
  kind: CartonAdjustmentKind;
  change: number;
  onUp: () => void;
  onDown: () => void;
}

const StepCell: React.FC<StepCellProps> = ({ choice, kind, change, onUp, onDown }) => {
  if (!choice) return <td className="sa-step-cell"><span className="sa-note">{copy.common.none}</span></td>;
  const after = choice.inStore + change;
  if (!isSteppable(choice, kind)) {
    return <td className="sa-step-cell is-locked"><span className="sa-step-held">{dozenFigure(after)}</span><span className="sa-note">{text.hasOpening}</span></td>;
  }
  const below = after < 0;
  const cellClass = ["sa-step-cell", change !== 0 ? "is-changed" : "", below ? "is-below-zero" : ""].filter(Boolean).join(" ");
  return (
    <td className={cellClass}>
      <div className="sa-stepper">
        <button type="button" className="sa-step-btn" aria-label={text.stepDown(choice.color, choice.size)} disabled={!canStepDown(kind, change)} onClick={onDown}>−</button>
        <span className="sa-step-figure">
          <span className="sa-step-held">{dozenFigure(after)}{below ? " ⚠" : null}</span>
          {change !== 0 ? <span className={change > 0 ? "sa-step-change is-up" : "sa-step-change is-down"}>{signedDozens(change)}</span> : null}
        </span>
        <button type="button" className="sa-step-btn" aria-label={text.stepUp(choice.color, choice.size)} onClick={onUp}>+</button>
      </div>
    </td>
  );
};

interface StepperMatrixProps {
  article: string;
  kind: CartonAdjustmentKind;
  grid: EntryGrid;
  steps: Steps;
  canAddColor: boolean;
  onUp: (key: string) => void;
  onDown: (key: string) => void;
  /** A colour was added to Product Master from a cell: the article is read again, so its cell appears. */
  onColourAdded: () => void;
}

export const StepperMatrix: React.FC<StepperMatrixProps> = ({ article, kind, grid, steps, canAddColor, onUp, onDown, onColourAdded }) => {
  const headingId = useId();
  const [listRef, listWidth] = useElementWidth<HTMLDivElement>();
  const layout = cartonLayout(listWidth);
  const totals = stepTotals(grid, steps);
  const sizesMissing = (colour: string): string[] =>
    grid.sizes.filter((size) => grid.cells.get(lineKey(size.articleSizeId, colour))?.colorMissing).map((size) => size.size);

  const cell = (articleSizeId: string, size: string, colour: string) => {
    const key = lineKey(articleSizeId, colour);
    const choice = grid.cells.get(key);
    if (choice?.colorMissing) {
      return <MissingSizeCell key={colour} className="sa-step-cell" article={article} colour={colour} size={size} missingSizes={sizesMissing(colour)}
        canAdd={canAddColor} disabled={false} onAdded={onColourAdded} />;
    }
    return <StepCell key={colour} choice={choice} kind={kind} change={steps[key] ?? 0} onUp={() => onUp(key)} onDown={() => onDown(key)} />;
  };

  return (
    <div ref={listRef} className={layout.stacked ? "cs-articles cs-articles--stacked sa-step-card" : "cs-articles sa-step-card"} style={CARD_STYLE}>
      <section className="cs-article" aria-labelledby={headingId}>
        <h3 className="cs-article-name" id={headingId}>{article}</h3>
        <SidewaysScrollArea label={text.stepLabel(article)} colourCount={grid.colours.length} pinnedStart={layout.sizeWidth} pinnedEnd={layout.totalWidth}>
          <table className="cs-table sa-step-table">
            <colgroup>
              <col style={{ width: layout.sizeWidth }} />
              {grid.colours.map((colour) => <col key={colour} />)}
              <col style={{ width: layout.totalWidth }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col" className="cs-size">{copy.cartonStock.sizeInDozens}</th>
                {grid.colours.map((colour) => <ColourHead key={colour} colour={colour} />)}
                <th scope="col" className="cs-total">{copy.cartonStock.total}</th>
              </tr>
            </thead>
            <tbody>
              {grid.sizes.map((size, row) => (
                <tr key={size.articleSizeId}>
                  <th scope="row" className="cs-size"><span className="cs-size-pill">{size.size}</span></th>
                  {grid.colours.map((colour) => cell(size.articleSizeId, size.size, colour))}
                  <td className="cs-total"><span className="cs-total-pill">{dozenFigure(totals.bySize[row] ?? 0)}</span></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="cs-grand">
                <th scope="row" className="cs-size">{copy.cartonStock.total}</th>
                {grid.colours.map((colour, column) => <td key={colour}>{dozenFigure(totals.byColour[column] ?? 0)}</td>)}
                <td className="cs-total"><span className="cs-total-pill cs-grand-pill">{dozenFigure(totals.grand)}</span></td>
              </tr>
            </tfoot>
          </table>
        </SidewaysScrollArea>
      </section>
    </div>
  );
};
