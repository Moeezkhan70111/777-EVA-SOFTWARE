import React, { useRef } from "react";
import { copy } from "../../config/copy";
import { ProductThumb } from "./ProductThumb";
import { ColourRow } from "./ColourRow";
import { articleLabel, articleSlug, type DraftArticle } from "./gatepassDraft";

// One article + size on the Gatepass. Open: a row per colour — Current Stock, Reserved and
// Reflected Stock beside a box for the cartons being cut (never more than Reflected Stock).
// Closed: a single line saying what has been entered, so a long document stays short on
// screen. A stored document shows the same rows read-only, with what Store Move Out has
// taken for each line so far.

interface ArticleCardProps {
  article: DraftArticle;
  expanded: boolean;
  image: string | null | undefined;
  onToggle: () => void;
  /** A stored document: quantities are shown, nothing can be changed or removed. */
  readOnly?: boolean;
  onRemove?: () => void;
  onQuantityChange?: (productVariantId: string, text: string) => void;
  onStep?: (productVariantId: string, delta: 1 | -1) => void;
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

const collapsedMeta = (article: DraftArticle): string => {
  if (article.errorCount > 0) return `⚠ ${copy.gatepass.needsAttention(article.errorCount)}`;
  if (article.selectedCount === 0) return copy.gatepass.noQuantityYet;
  return `${copy.gatepass.colorsSelected(article.selectedCount)} · ${copy.gatepass.totalQty(article.total)}`;
};

/** Column headings: the three live figures when writing; the creation snapshot and move-out progress when reading. */
const TableHead: React.FC<{ readOnly?: boolean }> = ({ readOnly }) => (
  <thead>
    <tr>
      <th scope="col">{copy.columns.color}</th>
      {readOnly ? (
        <>
          <th scope="col" className="num">{copy.gatepass.stockAtCreation}</th>
          <th scope="col" className="num">{copy.gatepass.gatepassQty}</th>
          <th scope="col" className="num">{copy.gatepass.movedOut}</th>
          <th scope="col" className="num">{copy.gatepass.outstanding}</th>
        </>
      ) : (
        <>
          <th scope="col" className="num">Store Stock</th>
          <th scope="col" className="num">{copy.gatepass.reserved}</th>
          <th scope="col" className="num gp-th-reflected">Available</th>
          <th scope="col">{copy.gatepass.gatepassQty}</th>
        </>
      )}
    </tr>
  </thead>
);

export const ArticleCard: React.FC<ArticleCardProps> = ({ article, expanded, image, onToggle, readOnly, onRemove, onQuantityChange, onStep }) => {
  const name = articleLabel(article);
  const slug = articleSlug(article);
  const bodyId = `gp-article-body-${slug}`;
  const inputs = useRef<Array<HTMLInputElement | null>>([]);

  const moveFocus = (from: number, step: 1 | -1) => {
    inputs.current[from + step]?.focus();
  };

  const className = ["gp-article", expanded ? "is-expanded" : "", article.errorCount > 0 ? "has-error" : ""].filter(Boolean).join(" ");

  return (
    <section className={className} data-testid={`gatepass-article-${slug}`}>
      <div className="gp-article-head">
        <button type="button" className="gp-article-toggle" aria-expanded={expanded} aria-controls={bodyId} onClick={onToggle}>
          <ProductThumb article={article.article} src={image} />
          <span className="gp-article-title">
            {/* Article and its group read as one name — "SK6 EVR GENTS" — with the size under it. */}
            <span className="gp-article-name">
              <strong>{article.article}</strong>
              {article.groupName && <span className="gp-article-group">{article.groupName}</span>}
            </span>
            <span>{article.size}</span>
          </span>
          {!expanded && (
            <span className="gp-article-meta" data-testid={`gatepass-article-meta-${slug}`}>
              {collapsedMeta(article)}
            </span>
          )}
          <ChevronIcon />
        </button>
        {!readOnly && (
          <button type="button" className="gp-icon-btn gp-icon-btn--danger" aria-label={copy.gatepass.removeArticle(name)} onClick={onRemove}>
            <TrashIcon />
          </button>
        )}
      </div>

      {expanded && (
        <div className="gp-article-body" id={bodyId}>
          <table className="gp-colour-table">
            <TableHead readOnly={readOnly} />
            <tbody>
              {article.colours.map((colour, index) => (
                <ColourRow
                  key={colour.productVariantId}
                  article={article}
                  colour={colour}
                  inputRef={(el) => {
                    inputs.current[index] = el;
                  }}
                  onMove={(step) => moveFocus(index, step)}
                  readOnly={readOnly}
                  onQuantityChange={onQuantityChange}
                  onStep={onStep}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
