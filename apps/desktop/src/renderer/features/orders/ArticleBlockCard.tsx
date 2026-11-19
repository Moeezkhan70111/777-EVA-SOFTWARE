import React, { useMemo } from "react";
import { AddColorControl } from "../../components/shared/AddColorControl";
import { ColorSwatch } from "../../components/shared/ColorSwatch";
import { SizeColourGrid, type GridBoxProps, type GridSize } from "../../components/shared/SizeColourGrid";
import { copy } from "../../config/copy";
import { articleGrid, blockProblems, blockTotals, cellKey, colourLocked, type ArticleBlock } from "./orderDraft";

// ONE ARTICLE ON THE ORDER: its colours as chips (pick as many as the party wants, at once), then a box for every live
// colour and size, sizes down and chosen colours across (SizeColourGrid: arrow keys move up and down, Tab across).
// Each colour's total sits under its column and the article's total in the heading. A combination that is not made
// has no box. A colour already dispatched against (while editing) stays on. An administrator on the computer that writes
// Product Master may add a NEW colour to the article from here (+ New colour); it is chosen at once.

const words = copy.orders;

interface ArticleBlockCardProps {
  block: ArticleBlock;
  disabled: boolean;
  onToggleColour: (colour: string) => void;
  onType: (productId: string, value: string) => void;
  onRemove: () => void;
  /** Offered only to an administrator where MASTER_DATA is written (the main process refuses it anywhere else). */
  canAddColor: boolean;
  onColourAdded: (colour: string) => void;
}

export const ArticleBlockCard: React.FC<ArticleBlockCardProps> = ({ block, disabled, onToggleColour, onType, onRemove, canAddColor, onColourAdded }) => {
  const grid = useMemo(() => articleGrid(block.products), [block.products]);
  const problems = blockProblems(block);
  const totals = blockTotals(block);
  const canRemove = !disabled && !Object.values(block.dispatched).some((cartons) => cartons > 0);

  const cell = (size: GridSize, colour: string, box: GridBoxProps) => {
    const productId = grid.cells.get(cellKey(size.size, colour));
    if (!productId) return <td className="ord-cell ord-cell--none"><span title={words.notMade(colour, size.size)} aria-label={words.notMade(colour, size.size)}>—</span></td>;
    const problem = problems.get(productId);
    return (
      <td className={problem ? "ord-cell has-problem" : "ord-cell"}>
        <input
          {...box}
          className="input ord-input"
          inputMode="numeric"
          aria-label={words.cellLabel(block.article, colour, size.size)}
          aria-invalid={problem ? true : undefined}
          title={problem}
          value={block.typed[productId] ?? ""}
          disabled={disabled}
          onChange={(event) => onType(productId, event.target.value)}
        />
      </td>
    );
  };

  return (
    <section className="card ord-block" aria-label={block.article}>
      <header className="ord-block-head">
        <h3 className="ord-block-title">{block.article}</h3>
        <span className="ord-block-total">{words.articleTotal(totals.total)}</span>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!canRemove} aria-label={words.removeArticle(block.article)} onClick={onRemove}>
          <span aria-hidden="true">✕</span>
        </button>
      </header>
      <div className="ord-chips" role="group" aria-label={words.colours}>
        {grid.colours.map((colour) => {
          const on = block.colours.includes(colour);
          return (
            <button key={colour} type="button" className={on ? "ord-chip is-on" : "ord-chip"} aria-pressed={on} aria-label={words.toggleColour(colour)}
              disabled={disabled || (on && colourLocked(block, colour))} onClick={() => onToggleColour(colour)}>
              <ColorSwatch color={colour} />{colour}{on ? <span aria-hidden="true"> ✓</span> : null}
            </button>
          );
        })}
        {canAddColor && !disabled ? <AddColorControl article={block.article} onAdded={onColourAdded} /> : null}
      </div>
      {block.colours.length === 0 ? <p className="ord-hint">{words.coloursHint}</p> : (
        <SizeColourGrid
          label={words.gridLabel(block.article)}
          sizeHeader={words.size}
          sizes={grid.sizes}
          colours={block.colours}
          onEnter={() => undefined}
          renderCell={cell}
          renderColourAction={(colour) => colourLocked(block, colour) ? null : (
            <button type="button" className="ord-colour-off" disabled={disabled} aria-label={words.removeColour(block.article, colour)} onClick={() => onToggleColour(colour)}>
              <span aria-hidden="true">✕</span>
            </button>
          )}
          footer={{ label: words.colourTotal, renderCell: (colour) => <td className="ord-num ord-foot">{(totals.byColour.get(colour) ?? 0).toLocaleString("en-US")}</td> }}
        />
      )}
    </section>
  );
};
