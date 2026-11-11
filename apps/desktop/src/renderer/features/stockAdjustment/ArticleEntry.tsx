import React, { useMemo, useState } from "react";
import { CARTON_ADJUSTMENT_DIRECTION, CARTON_ADJUSTMENT_KIND, compareSizes, type CartonAdjustmentDirection, type CartonAdjustmentKind } from "@erp/domain";
import { SearchableCombobox } from "../../components/shared/SearchableCombobox";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { entriesFrom, entryProblem, type DraftLine } from "./stockAdjustmentDraft";
import { useArticleChoices } from "./useStockAdjustment";
import { SizeQuantityTable } from "./SizeQuantityTable";

// ARTICLE → COLOUR → A QUANTITY PER SIZE. The article's sizes are the rows; each shows the figure in store now, the
// quantity typed and the figure it would leave. "Add to document" puts the sizes with a quantity on the document.

const text = copy.stockAdjustment;

interface ArticleEntryProps {
  kind: CartonAdjustmentKind;
  articles: readonly string[];
  onAdd: (lines: DraftLine[]) => void;
}

export const ArticleEntry: React.FC<ArticleEntryProps> = ({ kind, articles, onAdd }) => {
  const [article, setArticle] = useState("");
  const [color, setColor] = useState("");
  const [direction, setDirection] = useState<CartonAdjustmentDirection>(CARTON_ADJUSTMENT_DIRECTION.IN);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const choices = useArticleChoices(article);
  const effective = kind === CARTON_ADJUSTMENT_KIND.OPENING ? CARTON_ADJUSTMENT_DIRECTION.IN : direction;

  const colours = useMemo(() => [...new Set(choices.value.map((choice) => choice.color))].sort(), [choices.value]);
  const rows = useMemo(() => choices.value.filter((choice) => choice.color === color).sort((a, b) => compareSizes(a.size, b.size)), [choices.value, color]);
  const problems = rows.map((row) => entryProblem(row, kind, effective, typed[row.articleSizeId] ?? ""));
  const entries = entriesFrom(article, color, rows, typed, effective);
  const canAdd = entries.length > 0 && problems.every((problem) => problem === null);

  const chooseArticle = (value: string) => { setArticle(value); setColor(""); setTyped({}); };
  const chooseColor = (value: string) => { setColor(value); setTyped({}); };
  const add = () => {
    if (!canAdd) return;
    onAdd(entries);
    setTyped({});
  };

  return (
    <section className="card sa-card" aria-labelledby="sa-entry-title">
      <h3 id="sa-entry-title" className="card-title">{text.entryTitle}</h3>
      <div className="sa-entry-grid">
        <div className="mpr-field sa-article">
          <span className="input-label" aria-hidden="true">{text.articleLabel}</span>
          <SearchableCombobox ariaLabel={text.articleLabel} placeholder={text.articlePlaceholder} value={article}
            options={articles.map((name) => ({ value: name, label: name }))} onChange={chooseArticle} />
        </div>
        <div className="mpr-field">
          <span className="input-label" aria-hidden="true">{text.colorLabel}</span>
          <SearchableCombobox dropdown ariaLabel={text.colorLabel} placeholder={text.colorPlaceholder} value={color} emptyLabel={text.noColors}
            options={colours.map((name) => ({ value: name, label: name }))} onChange={chooseColor} />
        </div>
        {kind === CARTON_ADJUSTMENT_KIND.ADJUSTMENT ? (
          <div className="mpr-field">
            <span className="input-label" id="sa-direction-label">{text.directionLabel}</span>
            <div className="sa-toggle" role="group" aria-labelledby="sa-direction-label">
              {[CARTON_ADJUSTMENT_DIRECTION.IN, CARTON_ADJUSTMENT_DIRECTION.OUT].map((value) => (
                <button key={value} type="button" className={value === direction ? "sa-toggle-btn is-on" : "sa-toggle-btn"} aria-pressed={value === direction}
                  onClick={() => setDirection(value)}>
                  {text.directions[value]}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {article && choices.loading && choices.value.length === 0 ? <StateView kind="loading" compact message={text.loadingArticle} /> : null}
      {choices.error ? <StateView kind="error" compact message={choices.error} onRetry={() => void choices.reload()} /> : null}
      {article && !choices.loading && !choices.error && choices.value.length === 0 ? <StateView kind="empty" compact title={text.noSizesTitle} hint={text.noSizesHint} /> : null}
      {color && rows.length > 0 ? (
        <SizeQuantityTable kind={kind} direction={effective} rows={rows} typed={typed} problems={problems}
          onType={(id, value) => setTyped((current) => ({ ...current, [id]: value }))} onEnter={add} />
      ) : null}
      {color && rows.length > 0 ? (
        <div className="sa-actions">
          <button type="button" className="btn btn-primary" disabled={!canAdd} onClick={add}>{text.addToDocument}</button>
        </div>
      ) : null}
    </section>
  );
};
