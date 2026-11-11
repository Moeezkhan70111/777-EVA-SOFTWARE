import React, { useMemo, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { leaseRefusalText } from "../../../shared/leaseRefusal";
import { CARTON_ADJUSTMENT_DIRECTION, CARTON_ADJUSTMENT_KIND, LEASE_DOMAIN, compareSizes, type CartonAdjustmentDirection, type CartonAdjustmentKind } from "@erp/domain";
import { SearchableCombobox } from "../../components/shared/SearchableCombobox";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { entriesFrom, entryProblem, needsColorAdded, type DraftLine } from "./stockAdjustmentDraft";
import { useArticleChoices } from "./useStockAdjustment";
import { SizeQuantityTable } from "./SizeQuantityTable";
import { AddColorControl } from "./AddColorControl";
import { useWriteLease } from "../sync/useWriteLease";

// ARTICLE → COLOUR → A QUANTITY PER SIZE, IN DOZENS. Every active size of the article is a row, whether or not the
// colour is on it yet; each shows the figure in store now, the dozens typed and the figure it would leave. "Add to
// document" puts the sizes with a quantity on the document -- first adding the colour to any size it is not on yet
// (master data, where MASTER_DATA is written), so the line can be posted.

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
  const [adding, setAdding] = useState(false);
  const [addProblem, setAddProblem] = useState<string | null>(null);
  const api = useDesktopApi();
  const choices = useArticleChoices(article);
  // A new colour is product master data: offered only where MASTER_DATA is written.
  const masterData = useWriteLease(LEASE_DOMAIN.MASTER_DATA);
  const effective = kind === CARTON_ADJUSTMENT_KIND.OPENING ? CARTON_ADJUSTMENT_DIRECTION.IN : direction;

  const colours = useMemo(() => [...new Set(choices.value.map((choice) => choice.color))].sort(), [choices.value]);
  const rows = useMemo(() => choices.value.filter((choice) => choice.color === color).sort((a, b) => compareSizes(a.size, b.size)), [choices.value, color]);
  const problems = rows.map((row) => entryProblem(row, kind, effective, typed[row.articleSizeId] ?? "", masterData.canWrite));
  const entries = entriesFrom(article, color, rows, typed, effective);
  const canAdd = entries.length > 0 && problems.every((problem) => problem === null) && !adding;

  const chooseArticle = (value: string) => { setArticle(value); setColor(""); setTyped({}); };
  const chooseColor = (value: string) => { setColor(value); setTyped({}); };
  const colorAdded = async (value: string) => { await choices.reload(); chooseColor(value); };
  /** Adds the colour to the sizes it is not on yet, then the lines. Nothing is added to the document if that fails. */
  const add = async () => {
    if (!canAdd) return;
    setAddProblem(null);
    if (needsColorAdded(rows, color, typed)) {
      setAdding(true);
      try {
        const reply = (await api.addArticleColor({ article, color })) as { accepted?: unknown; reason?: unknown };
        if (reply?.accepted !== true) {
          setAddProblem(typeof reply?.reason === "string" ? reply.reason : text.colorNotAdded);
          return;
        }
        await choices.reload();
      } catch (error) {
        setAddProblem(leaseRefusalText(error) ?? text.colorNotAdded);
        return;
      } finally {
        setAdding(false);
      }
    }
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
          <div className="sa-color-row">
            <SearchableCombobox dropdown ariaLabel={text.colorLabel} placeholder={text.colorPlaceholder} value={color} emptyLabel={text.noColors}
              options={colours.map((name) => ({ value: name, label: name }))} onChange={chooseColor} />
            {masterData.canWrite && article ? <AddColorControl article={article} onAdded={(value) => void colorAdded(value)} /> : null}
          </div>
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
      {article && !choices.loading && !choices.error && choices.value.length === 0 ? <StateView kind="empty" compact title={text.noSizesTitle} hint={masterData.canWrite ? text.noColorsHintAdd : text.noSizesHint} /> : null}
      {color && rows.length > 0 ? (
        <SizeQuantityTable kind={kind} direction={effective} rows={rows} typed={typed} problems={problems} canAddColor={masterData.canWrite}
          onType={(id, value) => setTyped((current) => ({ ...current, [id]: value }))} onEnter={() => void add()} />
      ) : null}
      {color && rows.length > 0 ? (
        <div className="sa-actions">
          {addProblem ? <span className="sa-problem" role="alert">⚠ {addProblem}</span> : null}
          <button type="button" className="btn btn-primary" disabled={!canAdd} onClick={() => void add()}>{adding ? text.addingColor : text.addToDocument}</button>
        </div>
      ) : null}
    </section>
  );
};
