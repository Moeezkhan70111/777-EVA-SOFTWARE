import React, { useEffect, useMemo, useRef, useState } from "react";
import { AddColorControl } from "../../components/shared/AddColorControl";
import { ColourName } from "../colorTranslation/ColourName";
import { SizeColourGrid, type GridBoxProps, type GridSize } from "../../components/shared/SizeColourGrid";
import { copy } from "../../config/copy";
import { MissingSizeCell } from "../../components/shared/MissingSizeCell";
import { OrderCloseIcon } from "./OrderIcons";
import { articleGrid, blockProblems, blockTotals, cellKey, type ArticleBlock } from "./orderDraft";
import { orderDozens } from "./orderUnits";
import { revealBlockSoon } from "../../utils/revealBlock";

// ONE ARTICLE ON THE ORDER: a box for every live colour and size at once, sizes down and every colour across
// (SizeColourGrid: arrow keys move up and down, Tab across). Nothing to choose first (owner, 27 Nov 2026: "DONT MAKE IT
// SELECT THE COLOR FIRST. OPEN ALL THE COLORS IN THE TABLE"): a box left empty is no line. Each colour's total sits
// under its column and the article's total in the heading. A combination not in Product Master has no box: an
// administrator adds it from the cell, anyone else is told who can (MissingSizeCell). "+ New colour" is always shown
// (owner, 27 Nov 2026: "GIVE ADD COLOR OPTION IN ENTER ORDERS PAGE"): it works for an administrator on the computer that
// writes Product Master, and anywhere else it says who can (useCanAddColour); the new colour opens as a column.

const words = copy.orders;

interface ArticleBlockCardProps {
  block: ArticleBlock;
  disabled: boolean;
  onType: (productId: string, value: string) => void;
  onRemove: () => void;
  /** Offered only to an administrator where MASTER_DATA is written (the main process refuses it anywhere else). */
  canAddColor: boolean;
  onColourAdded: (colour: string) => void;
  /** Just added from the picker: its first box takes the focus, so the keyboard carries straight on (24 Nov 2026). */
  focusOnMount?: boolean;
}

export const ArticleBlockCard: React.FC<ArticleBlockCardProps> = ({ block, disabled, onType, onRemove, canAddColor, onColourAdded, focusOnMount = false }) => {
  const grid = useMemo(() => articleGrid(block.products), [block.products]);
  const problems = blockProblems(block);
  const totals = blockTotals(block);
  const canRemove = !disabled && !Object.values(block.dispatched).some((cartons) => cartons > 0);
  const blockRef = useRef<HTMLElement>(null);
  const colourCount = useRef(block.colours.length);
  /** The box to focus once a size added to Product Master appears in the grid. */
  const [focusLabel, setFocusLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!focusOnMount) return;
    blockRef.current?.querySelector<HTMLInputElement>(".ord-input:not(:disabled)")?.focus({ preventScroll: true });
    // The new article is shown whole, its sizes and boxes too: no scrolling down to find them (owner, 24 Nov 2026).
    revealBlockSoon(blockRef.current);
    // Once, when the block first appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // A colour added: its column, and the sizes under it, scroll into view (owner, 24 Nov 2026).
    if (block.colours.length > colourCount.current) revealBlockSoon(blockRef.current);
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
        <MissingSizeCell className="ord-cell" article={block.article} colour={colour} size={size.size} missingSizes={missingSizes(colour)} canAdd={canAddColor} disabled={disabled}
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
      <div className="ord-block-tools">
        <AddColorControl article={block.article} onAdded={onColourAdded} blockedReason={canAddColor ? undefined : words.newColourWhere} disabled={disabled} />
      </div>
      <SizeColourGrid
        renderColourName={(colour) => <ColourName colour={colour} />}
        label={words.gridLabel(block.article)}
        sizeHeader={words.size}
        sizes={grid.sizes}
        colours={block.colours}
        onEnter={() => undefined}
        renderCell={cell}
        footer={{ label: words.colourTotal, renderCell: (colour) => <td className="ord-num ord-foot">{orderDozens(totals.byColour.get(colour) ?? 0)}</td> }}
      />
    </section>
  );
};
