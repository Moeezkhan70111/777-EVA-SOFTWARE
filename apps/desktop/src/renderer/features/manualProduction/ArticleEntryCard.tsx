import React from "react";
import { SearchableCombobox, type SearchableComboboxOption } from "../../components/shared/SearchableCombobox";
import { SizeColourGrid, type GridBoxProps, type GridSize } from "../../components/shared/SizeColourGrid";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import type { MachineRecord } from "../../types/desktopApi";
import { cellKey, dozensText, typedCartons, type ProductionGrid } from "./manualProductionDraft";
import { articlesOf, sizesOf, type ProductChoice } from "./productChoices";
import { StepTitle } from "./StepTitle";
import type { useArticleEntry } from "./useArticleEntry";

// STEP 2, THE ARTICLE: choose it, and every size (down) and colour (across) shows at once (SizeColourGrid, shared
// with Stock Adjustment). Type dozens in any box. Under a box: what is already saved today for that size and colour
// (every machine), and what this machine already has in the list. A size not made in a colour says so and takes no
// quantity. "Add to list" puts every typed box on the list for the machine chosen above.

const text = copy.manualProductionPage;

type Entry = ReturnType<typeof useArticleEntry>;

interface ArticleEntryCardProps {
  machine: MachineRecord | null;
  products: readonly ProductChoice[];
  entry: Entry;
  /** Cartons saved today per article|size|colour, every machine. */
  savedToday: ReadonlyMap<string, number>;
  /** Cartons in the list for this machine, by cellKey. */
  listed: ReadonlyMap<string, number>;
}

const articleOptions = (products: readonly ProductChoice[]): SearchableComboboxOption[] =>
  articlesOf(products).map((article) => {
    const sizes = sizesOf(products, article);
    const colours = new Set(sizes.flatMap((size) => size.colors));
    return { value: article, label: article, detail: text.articleDetail(sizes.length, colours.size) };
  });

export const savedKey = (article: string, size: string, color: string): string => `${article}|${size}|${color}`;

/** A box with a problem is marked invalid; one holding a quantity is marked typed (and says so in its value). */
const cellClass = (problem: string | undefined, typed: string): string => {
  if (problem) return "sa-cell is-invalid";
  return typedCartons(typed) === null ? "sa-cell" : "sa-cell is-typed";
};

interface CellProps {
  size: GridSize;
  colour: string;
  box: GridBoxProps;
  entry: Entry;
  saved: number;
  listed: number;
}

const Cell: React.FC<CellProps> = ({ size, colour, box, entry, saved, listed }) => {
  if (!entry.grid.made.get(size.id)?.has(colour)) {
    return <td className="sa-cell is-locked"><span className="sa-note">{text.colourNotOnSize}</span></td>;
  }
  const key = cellKey(size.id, colour);
  const typed = entry.typed[key] ?? "";
  const problem = entry.problems.get(key);
  const inputId = `mnp-qty-${key}`;
  return (
    <td className={cellClass(problem, typed)}>
      <input id={inputId} className="form-input sa-qty" inputMode="decimal" autoComplete="off" value={typed} {...box}
        aria-label={text.quantityFor(colour, size.size)} aria-invalid={problem !== undefined} aria-describedby={problem ? `${inputId}-problem` : undefined}
        onChange={(event) => entry.type(key, event.target.value)} />
      {saved > 0 ? <span className="sa-cell-figures">{text.savedToday(dozensText(saved))}</span> : null}
      {listed > 0 ? <span className="sa-cell-figures mnp-in-list">{text.inList(dozensText(listed))}</span> : null}
      {problem ? <span id={`${inputId}-problem`} className="sa-problem" role="alert">⚠ {problem}</span> : null}
    </td>
  );
};

const Grid: React.FC<{ entry: Entry; grid: ProductionGrid; savedToday: ReadonlyMap<string, number>; listed: ReadonlyMap<string, number> }> = ({ entry, grid, savedToday, listed }) => (
  <SizeColourGrid
    label={text.gridLabel(entry.article)}
    sizeHeader={text.sizeColumn}
    sizes={grid.sizes}
    colours={grid.colours}
    onEnter={entry.add}
    renderCell={(size, colour, box) => (
      <Cell size={size} colour={colour} box={box} entry={entry}
        saved={savedToday.get(savedKey(entry.article, size.size, colour)) ?? 0} listed={listed.get(cellKey(size.id, colour)) ?? 0} />
    )}
  />
);

export const ArticleEntryCard: React.FC<ArticleEntryCardProps> = ({ machine, products, entry, savedToday, listed }) => {
  const { article, grid } = entry;
  const showGrid = article !== "" && grid.sizes.length > 0 && grid.colours.length > 0;
  const noColours = article !== "" && grid.sizes.length > 0 && grid.colours.length === 0;
  const typedCartonsTotal = entry.lines.reduce((sum, line) => sum + line.cartons, 0);
  return (
    <section className="card mnp-card" aria-labelledby="mnp-article-title">
      <div className="mnp-card-head">
        <StepTitle id="mnp-article-title" index={2} done={showGrid} title={text.articleStep} />
        <div className="mnp-article-pick">
          <SearchableCombobox ariaLabel={text.articleLabel} placeholder={text.articlePlaceholder} searchPlaceholder={text.articleSearch}
            emptyLabel={text.articleNone} value={article} options={articleOptions(products)} onChange={entry.chooseArticle} />
        </div>
      </div>
      {!machine ? <p className="mnp-hint mnp-hint--warn" role="note">⚠ {text.chooseMachineFirst}</p> : null}
      {article === "" ? <StateView kind="empty" compact title={text.chooseArticle} /> : null}
      {noColours ? <StateView kind="empty" compact title={text.noColoursTitle} hint={text.noColoursHint} /> : null}
      {showGrid ? <p className="mnp-hint">{text.gridHint}</p> : null}
      {showGrid ? <Grid entry={entry} grid={grid} savedToday={savedToday} listed={listed} /> : null}
      {showGrid ? (
        <div className="mnp-actions">
          <span className="mnp-note">{text.addHint}</span>
          {entry.lines.length > 0 ? <span className="mnp-typed" role="status">{text.typedSummary(entry.lines.length, dozensText(typedCartonsTotal))}</span> : null}
          <button type="button" className="btn btn-secondary" onClick={entry.clearTyping} disabled={Object.keys(entry.typed).length === 0}>{text.clearTyping}</button>
          <button type="button" className="btn btn-primary" disabled={!entry.canAdd} onClick={entry.add}>{text.addToList}</button>
        </div>
      ) : null}
    </section>
  );
};
