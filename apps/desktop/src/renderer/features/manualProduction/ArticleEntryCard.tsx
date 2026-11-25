import React, { useEffect, useRef } from "react";
import { AddColorControl } from "../../components/shared/AddColorControl";
import { MissingSizeCell } from "../../components/shared/MissingSizeCell";
import { SearchableCombobox, type SearchableComboboxOption } from "../../components/shared/SearchableCombobox";
import { SizeColourGrid, type GridBoxProps, type GridSize } from "../../components/shared/SizeColourGrid";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import type { MachineRecord } from "../../types/desktopApi";
import { cellKey, dozensText, sizesNotMadeIn, typedCartons, type ProductionGrid } from "./manualProductionDraft";
import { articlesOf, sizesOf, type ProductChoice } from "./productChoices";
import { StepTitle } from "./StepTitle";
import { revealBlockSoon } from "../../utils/revealBlock";
import type { useArticleEntry } from "./useArticleEntry";

// STEP 2, THE ARTICLE: choose it, and every size (down) and colour (across) shows at once (SizeColourGrid, shared
// with Stock Adjustment). Type dozens in any box. Under a box: what is already saved today for that size and colour
// (every machine), and what this machine already has in the list. A size not made in a colour says so and takes no
// quantity. "Add to list" puts every typed box on the list for the machine chosen above.
//
// The UI/UX pass (owner, 25 Nov 2026): the article picker sits beside its title, next to the grid it fills
// (proximity); choosing an article puts the cursor in its first box and brings the whole grid into view (Tesler,
// Doherty); each colour's typed dozens add up under its column (Prägnanz); a size not made in a colour has the same
// hatched cell as Enter Orders and Gatepass (similarity).
//
// Adding a colour (25 Nov 2026): the same "+ New colour" and "+ Add" in a size not made in a colour as every
// quantity-by-colour page, under the one rule (useCanAddColour); after either, the products are read again.

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
  canAddColour: boolean;
  /** A colour was added to Product Master: the products are read again. */
  onColourAdded: () => void;
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
  canAddColour: boolean;
  onColourAdded: () => void;
}

const Cell: React.FC<CellProps> = ({ size, colour, box, entry, saved, listed, canAddColour, onColourAdded }) => {
  if (!entry.grid.made.get(size.id)?.has(colour)) {
    return <MissingSizeCell className="sa-cell" article={entry.article} colour={colour} size={size.size} missingSizes={sizesNotMadeIn(entry.grid, colour)}
      canAdd={canAddColour} disabled={false} onAdded={onColourAdded} />;
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

/** The cartons typed for one colour, every size: the grid's last row. */
const typedFor = (entry: Entry, grid: ProductionGrid, colour: string): number =>
  grid.sizes.reduce((sum, size) => sum + (typedCartons(entry.typed[cellKey(size.id, colour)] ?? "") ?? 0), 0);

interface GridProps { entry: Entry; grid: ProductionGrid; savedToday: ReadonlyMap<string, number>; listed: ReadonlyMap<string, number>; canAddColour: boolean; onColourAdded: () => void }

const Grid: React.FC<GridProps> = ({ entry, grid, savedToday, listed, canAddColour, onColourAdded }) => (
  <SizeColourGrid
    label={text.gridLabel(entry.article)}
    sizeHeader={text.sizeColumn}
    sizes={grid.sizes}
    colours={grid.colours}
    onEnter={entry.add}
    renderCell={(size, colour, box) => (
      <Cell size={size} colour={colour} box={box} entry={entry}
        saved={savedToday.get(savedKey(entry.article, size.size, colour)) ?? 0} listed={listed.get(cellKey(size.id, colour)) ?? 0}
        canAddColour={canAddColour} onColourAdded={onColourAdded} />
    )}
    footer={{ label: text.colourTotal, renderCell: (colour) => <td className="mnp-grid-total">{dozensText(typedFor(entry, grid, colour))}</td> }}
  />
);

export const ArticleEntryCard: React.FC<ArticleEntryCardProps> = ({ machine, products, entry, savedToday, listed, canAddColour, onColourAdded }) => {
  const { article, grid } = entry;
  const showGrid = article !== "" && grid.sizes.length > 0 && grid.colours.length > 0;
  const noColours = article !== "" && grid.sizes.length > 0 && grid.colours.length === 0;
  const cardRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!article) return;
    // The article was just chosen: the first box takes the cursor, and the whole grid comes into view.
    cardRef.current?.querySelector<HTMLInputElement>("input.sa-qty")?.focus({ preventScroll: true });
    revealBlockSoon(cardRef.current);
  }, [article]);
  return (
    <section className="card mnp-card" aria-labelledby="mnp-article-title" ref={cardRef}>
      <div className="mnp-card-head">
        <StepTitle id="mnp-article-title" index={2} done={showGrid} title={text.articleStep} />
        <div className="mnp-article-pick">
          <SearchableCombobox ariaLabel={text.articleLabel} placeholder={text.articlePlaceholder} searchPlaceholder={text.articleSearch}
            emptyLabel={text.articleNone} value={article} options={articleOptions(products)} onChange={entry.chooseArticle} />
        </div>
        {article && canAddColour ? <AddColorControl article={article} onAdded={() => onColourAdded()} /> : null}
      </div>
      {!machine ? <p className="mnp-hint mnp-hint--warn" role="note">⚠ {text.chooseMachineFirst}</p> : null}
      {article === "" ? <StateView kind="empty" compact title={text.chooseArticle} /> : null}
      {noColours ? <StateView kind="empty" compact title={text.noColoursTitle} hint={text.noColoursHint} /> : null}
      {showGrid ? <Grid entry={entry} grid={grid} savedToday={savedToday} listed={listed} canAddColour={canAddColour} onColourAdded={onColourAdded} /> : null}
      {showGrid ? (
        <div className="mnp-actions">
          <button type="button" className="btn btn-secondary" onClick={entry.clearTyping} disabled={Object.keys(entry.typed).length === 0}>{text.clearTyping}</button>
          <button type="button" className="btn btn-primary" disabled={!entry.canAdd} onClick={entry.add}>{text.addToList}</button>
        </div>
      ) : null}
    </section>
  );
};
