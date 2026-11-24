import React, { useEffect, useMemo, useRef, useState } from "react";
import { AddColorControl } from "../../components/shared/AddColorControl";
import { ColorSwatch } from "../../components/shared/ColorSwatch";
import { ColourName } from "../colorTranslation/ColourName";
import { SizeColourGrid, type GridBoxProps, type GridSize } from "../../components/shared/SizeColourGrid";
import { copy } from "../../config/copy";
import { MissingSizeCell } from "./MissingSizeCell";
import { OrderCheckIcon, OrderCloseIcon } from "./OrderIcons";
import { articleGrid, blockProblems, blockTotals, cellKey, colourLocked, type ArticleBlock } from "./orderDraft";
import { orderDozens } from "./orderUnits";

// ONE ARTICLE ON THE ORDER: its colours as chips (pick as many as the party wants, at once), then a box for every live
// colour and size, sizes down and chosen colours across (SizeColourGrid: arrow keys move up and down, Tab across).
// Each colour's total sits under its column and the article's total in the heading. A combination not in Product
// Master has no box: an administrator adds it from the cell, anyone else is told who can (MissingSizeCell). A colour already dispatched against (while editing) stays on. An administrator on the computer that writes
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
  /** Just added from the picker: its first colour takes the focus, so the keyboard carries straight on (24 Nov 2026). */
  focusOnMount?: boolean;
}

export const ArticleBlockCard: React.FC<ArticleBlockCardProps> = ({ block, disabled, onToggleColour, onType, onRemove, canAddColor, onColourAdded, focusOnMount = false }) => {
  const grid = useMemo(() => articleGrid(block.products), [block.products]);
  const problems = blockProblems(block);
  const totals = blockTotals(block);
  const canRemove = !disabled && !Object.values(block.dispatched).some((cartons) => cartons > 0);
  const chipsRef = useRef<HTMLDivElement>(null);
  const blockRef = useRef<HTMLElement>(null);
  const colourCount = useRef(block.colours.length);
  /** The box to focus once a size added to Product Master appears in the grid. */
  const [focusLabel, setFocusLabel] = useState<string | null>(null);

  useEffect(() => {
    // An article that came with its one colour already chosen goes straight to its first box; otherwise to its colours.
    if (!focusOnMount) return;
    const firstBox = blockRef.current?.querySelector<HTMLInputElement>(".ord-input:not(:disabled)");
    if (block.colours.length > 0 && firstBox) firstBox.focus();
    else chipsRef.current?.querySelector<HTMLButtonElement>(".ord-chip:not(:disabled)")?.focus();
    // Once, when the block first appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // The first colour chosen: the dozens are the next thing to type, so the first box takes the focus (default effect).
    if (colourCount.current === 0 && block.colours.length === 1) blockRef.current?.querySelector<HTMLInputElement>(".ord-input:not(:disabled)")?.focus();
    colourCount.current = block.colours.length;
  }, [block.colours.length]);

  useEffect(() => {
    // A size just added to Product Master: once its box is there, it takes the focus for the dozens.
    if (!focusLabel) return;
    const box = blockRef.current?.querySelector<HTMLInputElement>(`input[aria-label="${CSS.escape(focusLabel)}"]`);
    if (box) { box.focus(); setFocusLabel(null); }
  }, [grid, focusLabel]);

  const missingSizes = (colour: string) => grid.sizes.filter((size) => !grid.cells.has(cellKey(size.size, colour))).map((size) => size.size);

  const cell = (size: GridSize, colour: string, box: GridBoxProps) => {
    const productId = grid.cells.get(cellKey(size.size, colour));
    if (!productId) {
      return (
        <MissingSizeCell article={block.article} colour={colour} size={size.size} missingSizes={missingSizes(colour)} canAdd={canAddColor} disabled={disabled}
          onAdded={(added) => { setFocusLabel(words.cellLabel(block.article, colour, size.size)); onColourAdded(added); }} />
      );
    }
    const problem = problems.get(productId);
    return (
      <td className={problem ? "ord-cell has-problem" : "ord-cell"}>
        <input
          {...box}
          className="input ord-input"
          inputMode="decimal"
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
    <section className="card ord-block" aria-label={block.article} ref={blockRef}>
      <header className="ord-block-head">
        <h3 className="ord-block-title">{block.article}</h3>
        <span className="ord-block-total">{words.articleTotal(orderDozens(totals.total))}</span>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!canRemove} aria-label={words.removeArticle(block.article)} title={words.removeArticle(block.article)} onClick={onRemove}>
          <OrderCloseIcon />
        </button>
      </header>
      <div className="ord-chips" role="group" aria-label={words.colours} ref={chipsRef}>
        {grid.colours.map((colour) => {
          const on = block.colours.includes(colour);
          return (
            <button key={colour} type="button" className={on ? "ord-chip is-on" : "ord-chip"} aria-pressed={on} aria-label={words.toggleColour(colour)}
              disabled={disabled || (on && colourLocked(block, colour))} onClick={() => onToggleColour(colour)}>
              {/* The tick's slot is always there, empty until chosen: the chip reads as a toggle, and nothing moves. */}
              <span className="ord-chip-mark" aria-hidden="true"><OrderCheckIcon /></span>
              <ColorSwatch color={colour} /><ColourName colour={colour} />
            </button>
          );
        })}
        {canAddColor && !disabled ? <AddColorControl article={block.article} onAdded={onColourAdded} /> : null}
      </div>
      {block.colours.length === 0 ? <p className="ord-hint">{words.coloursHint}</p> : (
        <SizeColourGrid
          renderColourName={(colour) => <ColourName colour={colour} />}
          label={words.gridLabel(block.article)}
          sizeHeader={words.size}
          sizes={grid.sizes}
          colours={block.colours}
          onEnter={() => undefined}
          renderCell={cell}
          renderColourAction={(colour) => colourLocked(block, colour) ? null : (
            <button type="button" className="ord-colour-off" disabled={disabled} aria-label={words.removeColour(block.article, colour)} title={words.removeColour(block.article, colour)} onClick={() => onToggleColour(colour)}>
              <OrderCloseIcon />
            </button>
          )}
          footer={{ label: words.colourTotal, renderCell: (colour) => <td className="ord-num ord-foot">{orderDozens(totals.byColour.get(colour) ?? 0)}</td> }}
        />
      )}
    </section>
  );
};
