import React from "react";
import { AddColorControl } from "../../components/shared/AddColorControl";
import { MissingSizeCell } from "../../components/shared/MissingSizeCell";
import { SizeColourGrid } from "../../components/shared/SizeColourGrid";
import { copy } from "../../config/copy";
import { articleWithGroup, type StockGrid } from "../../utils/gatepassGrid";
import { ProductThumb } from "./ProductThumb";
import { GatepassQtyCell } from "./GatepassQtyCell";
import { sizesMissingColour } from "./colourGaps";
import { dozensText, type DraftArticleGroup } from "./gatepassDraft";

// ONE ARTICLE ON THE GATEPASS BEING WRITTEN, every size at once (owner, 25 Nov 2026: "the format used in opening stock
// and stock adjustment"). Open: sizes down, colours across, a box in every cell (SizeColourGrid, shared: Arrow Up and
// Down move along a colour, Tab across), each colour's total under it. A colour the article is made in, but not in
// this size, has no box: the cell says so, and an administrator where Product Master is written adds it from there
// (MissingSizeCell); a new colour is added from "+ New colour" (AddColorControl). Who may do either is the one rule of
// every quantity-by-colour page (useCanAddColour). Closed: one line saying what has been entered. One card is open at a time.

const words = copy.gatepass;

interface ArticleGridCardProps {
  group: DraftArticleGroup;
  grid: StockGrid;
  expanded: boolean;
  image: string | null | undefined;
  canAddColour: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onQuantityChange: (productVariantId: string, text: string) => void;
  /** After a colour was added to Product Master: the store is read again, so its boxes appear. */
  onColourAdded: () => void;
}

const ChevronIcon = () => (
  <svg className="gp-chevron" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const TrashIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10M9 9v4M11 9v4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const collapsedMeta = (group: DraftArticleGroup): string => {
  if (group.errorCount > 0) return `⚠ ${words.needsAttention(group.errorCount)}`;
  if (group.selectedCount === 0) return words.noQuantityYet;
  return `${words.colorsSelected(group.selectedCount)} · ${words.totalQty(dozensText(group.total))}`;
};

const colourTotal = (group: DraftArticleGroup, colour: string): number =>
  group.sizes.reduce((sum, entry) => sum + (entry.colours.find((c) => c.colour === colour)?.check.value ?? 0), 0);

export const ArticleGridCard: React.FC<ArticleGridCardProps> = ({ group, grid, expanded, image, canAddColour, onToggle, onRemove, onQuantityChange, onColourAdded }) => {
  const name = articleWithGroup(group.article, group.groupName);
  const slug = group.article.replace(/[^\w.-]+/g, "-");
  const bodyId = `gp-article-body-${slug}`;
  const bySize = new Map(group.sizes.map((entry) => [entry.key, entry]));
  const className = ["gp-article", "gp-article--grid", expanded ? "is-expanded" : "", group.errorCount > 0 ? "has-error" : ""].filter(Boolean).join(" ");

  return (
    <section className={className} data-testid={`gatepass-article-${slug}`}>
      <div className="gp-article-head">
        <button type="button" className="gp-article-toggle" aria-expanded={expanded} aria-controls={bodyId} onClick={onToggle}>
          <ProductThumb article={group.article} src={image} />
          <span className="gp-article-title">
            <span className="gp-article-name">
              <strong>{group.article}</strong>
              {group.groupName && <span className="gp-article-group">{group.groupName}</span>}
            </span>
            <span>{words.sizesOnCard(group.sizes.length)}</span>
          </span>
          <span className="gp-article-meta" data-testid={`gatepass-article-meta-${slug}`}>{collapsedMeta(group)}</span>
          <ChevronIcon />
        </button>
        <button type="button" className="gp-icon-btn gp-icon-btn--danger" aria-label={words.removeArticle(name)} onClick={onRemove}>
          <TrashIcon />
        </button>
      </div>

      {expanded && (
        <div className="gp-article-body" id={bodyId}>
          {canAddColour ? <div className="gp-grid-tools"><AddColorControl article={group.article} onAdded={() => onColourAdded()} /></div> : null}
          <SizeColourGrid
            label={words.gridLabel(name)}
            sizeHeader={words.sizeHeader}
            sizes={group.sizes.map((entry) => ({ id: entry.key, size: entry.size }))}
            colours={group.colours}
            onEnter={() => undefined}
            renderCell={(size, colour, box) => {
              const entry = bySize.get(size.id);
              const cell = entry?.colours.find((c) => c.colour === colour);
              if (!entry || !cell) {
                return <MissingSizeCell article={group.article} colour={colour} size={size.size} missingSizes={sizesMissingColour(grid, group.article, colour)}
                  canAdd={canAddColour} disabled={false} onAdded={onColourAdded} />;
              }
              return <GatepassQtyCell entry={entry} colour={cell} box={box} onChange={onQuantityChange} />;
            }}
            footer={{ label: words.colourTotal, renderCell: (colour) => <td className="gp-grid-total">{dozensText(colourTotal(group, colour))}</td> }}
          />
        </div>
      )}
    </section>
  );
};
