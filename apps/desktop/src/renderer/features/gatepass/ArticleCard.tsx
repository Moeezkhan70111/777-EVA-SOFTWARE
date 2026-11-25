import React from "react";
import { copy } from "../../config/copy";
import { ProductThumb } from "./ProductThumb";
import { ColourRow } from "./ColourRow";
import { articleSlug, dozensText, type DraftArticle } from "./gatepassDraft";

// One article + size on a STORED Gatepass, read-only: open, a row per colour with the store at creation, the
// quantity, what Store Move Out has taken and what is left; closed, a single line saying what is on it. A gatepass
// being written is typed one article at a time, every size at once (ArticleGridCard, 25 Nov 2026).

interface ArticleCardProps {
  article: DraftArticle;
  expanded: boolean;
  image: string | null | undefined;
  onToggle: () => void;
}

const ChevronIcon = () => (
  <svg className="gp-chevron" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const collapsedMeta = (article: DraftArticle): string => {
  if (article.selectedCount === 0) return copy.gatepass.noQuantityYet;
  return `${copy.gatepass.colorsSelected(article.selectedCount)} · ${copy.gatepass.totalQty(dozensText(article.total))}`;
};

/** The creation snapshot and the move-out progress, every figure in dozens. */
const TableHead: React.FC = () => (
  <thead>
    <tr>
      <th scope="col">{copy.columns.color}</th>
      <th scope="col" className="num">{copy.gatepass.inDozens(copy.gatepass.stockAtCreation)}</th>
      <th scope="col" className="num">{copy.gatepass.inDozens(copy.gatepass.gatepassQty)}</th>
      <th scope="col" className="num">{copy.gatepass.inDozens(copy.gatepass.movedOut)}</th>
      <th scope="col" className="num">{copy.gatepass.inDozens(copy.gatepass.outstanding)}</th>
    </tr>
  </thead>
);

export const ArticleCard: React.FC<ArticleCardProps> = ({ article, expanded, image, onToggle }) => {
  const slug = articleSlug(article);
  const bodyId = `gp-article-body-${slug}`;
  const className = ["gp-article", expanded ? "is-expanded" : ""].filter(Boolean).join(" ");

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
      </div>

      {expanded && (
        <div className="gp-article-body" id={bodyId}>
          <table className="gp-colour-table">
            <TableHead />
            <tbody>
              {article.colours.map((colour) => <ColourRow key={colour.productVariantId} article={article} colour={colour} />)}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
