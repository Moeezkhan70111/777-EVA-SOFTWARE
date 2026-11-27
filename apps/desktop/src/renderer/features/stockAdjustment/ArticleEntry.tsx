import React from "react";
import { CARTON_ADJUSTMENT_DIRECTION, CARTON_ADJUSTMENT_KIND, type CartonAdjustmentKind } from "@erp/domain";
import { SearchableCombobox } from "../../components/shared/SearchableCombobox";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { dozensText, totalsOf, type DraftLine } from "./stockAdjustmentDraft";
import { QuantityGrid } from "./QuantityGrid";
import { AddColorControl } from "../../components/shared/AddColorControl";
import { ENTRY_MODE, useArticleGrid } from "./useArticleGrid";
import { StepperMatrix } from "./StepperMatrix";
import { StepTitle } from "../manualProduction/StepTitle";

// ARTICLE → EVERY COLOUR AND SIZE AT ONCE, IN DOZENS (owner, 13 Nov 2026). Choosing the article shows its sizes down
// and its colours across, a box in every cell; type any of them, then "Add to document" puts every typed cell on the
// document in one go. A colour not yet on a size is added to it first (useArticleGrid).
//
// Or the + / − view (owner, 27 Nov 2026): the article as Carton Stock shows it, − and + in every cell, one carton a
// press. Its sign decides Increase or Decrease, so it needs no Movement choice (StepperMatrix).

const text = copy.stockAdjustment;

interface ArticleEntryProps {
  kind: CartonAdjustmentKind;
  articles: readonly string[];
  onAdd: (lines: DraftLine[]) => void;
  /** Lines on the document so far: the step is done once there is one. */
  lineCount: number;
}

export const ArticleEntry: React.FC<ArticleEntryProps> = ({ kind, articles, onAdd, lineCount }) => {
  const entry = useArticleGrid(kind, onAdd);
  const { article, choices, grid } = entry;
  const showGrid = article !== "" && grid.sizes.length > 0 && grid.colours.length > 0;
  const stepping = entry.mode === ENTRY_MODE.STEP;
  const typedTotals = totalsOf(entry.entries);

  return (
    <section className="card sa-card" aria-labelledby="sa-entry-title">
      <StepTitle id="sa-entry-title" index={2} done={lineCount > 0} title={text.entryTitle} />
      <div className="sa-entry-grid">
        <div className="mpr-field sa-article">
          <span className="input-label" aria-hidden="true">{text.articleLabel}</span>
          <SearchableCombobox ariaLabel={text.articleLabel} placeholder={text.articlePlaceholder} value={article}
            options={articles.map((name) => ({ value: name, label: name }))} onChange={entry.chooseArticle} />
        </div>
        <div className="mpr-field">
          <span className="input-label" id="sa-mode-label">{text.entryModeLabel}</span>
          <div className="sa-toggle" role="group" aria-labelledby="sa-mode-label">
            {[ENTRY_MODE.TYPE, ENTRY_MODE.STEP].map((value) => (
              <button key={value} type="button" className={value === entry.mode ? "sa-toggle-btn is-on" : "sa-toggle-btn"} aria-pressed={value === entry.mode}
                onClick={() => entry.setMode(value)}>
                {text.entryModes[value]}
              </button>
            ))}
          </div>
        </div>
        {kind === CARTON_ADJUSTMENT_KIND.ADJUSTMENT && !stepping ? (
          <div className="mpr-field">
            <span className="input-label" id="sa-direction-label">{text.directionLabel}</span>
            <div className="sa-toggle" role="group" aria-labelledby="sa-direction-label">
              {[CARTON_ADJUSTMENT_DIRECTION.IN, CARTON_ADJUSTMENT_DIRECTION.OUT].map((value) => (
                <button key={value} type="button" className={value === entry.direction ? "sa-toggle-btn is-on" : "sa-toggle-btn"} aria-pressed={value === entry.direction}
                  onClick={() => entry.setDirection(value)}>
                  {text.directions[value]}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {article && choices.loading && choices.value.length === 0 ? <StateView kind="loading" compact message={text.loadingArticle} /> : null}
      {choices.error ? <StateView kind="error" compact message={choices.error} onRetry={() => void choices.reload()} /> : null}
      {article && !choices.loading && !choices.error && choices.value.length === 0 ? <StateView kind="empty" compact title={text.noSizesTitle} hint={entry.canAddColor ? text.noColorsHintAdd : text.noSizesHint} /> : null}
      {article ? (
        <div className="sa-grid-head">
          {showGrid ? <p className="sa-hint">{stepping ? text.stepHint : text.gridHint}</p> : null}
          {entry.canAddColor ? <AddColorControl article={article} onAdded={() => void choices.reload()} /> : null}
        </div>
      ) : null}
      {showGrid && stepping ? (
        <StepperMatrix article={article} kind={kind} grid={grid} steps={entry.steps} canAddColor={entry.canAddColor}
          onUp={entry.up} onDown={entry.down} onColourAdded={() => void choices.reload()} />
      ) : null}
      {showGrid && !stepping ? (
        <QuantityGrid article={article} kind={kind} direction={entry.effective} grid={grid} typed={entry.typed} problems={entry.problems}
          canAddColor={entry.canAddColor} onType={entry.type} onEnter={entry.add} onColourAdded={() => void choices.reload()} />
      ) : null}
      {showGrid ? (
        <div className="sa-actions">
          {entry.entries.length > 0 ? (
            <span className="sa-note" role="status">{stepping
                ? text.changedSummary(entry.entries.length, dozensText(typedTotals.cartonsIn), dozensText(typedTotals.cartonsOut))
                : text.typedSummary(entry.entries.length, dozensText(typedTotals.cartonsIn + typedTotals.cartonsOut))}</span>
          ) : null}
          <button type="button" className="btn btn-primary" disabled={!entry.canAdd} onClick={entry.add}>{text.addToDocument}</button>
        </div>
      ) : null}
    </section>
  );
};
