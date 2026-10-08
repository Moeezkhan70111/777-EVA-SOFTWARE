import React from "react";
import { ColorSwatch } from "../../components/shared/ColorSwatch";
import { copy } from "../../config/copy";
import { partyLine, type PartyFacts } from "../parties/PartyCard";
import { ProductThumb } from "./ProductThumb";
import type { ArticleImageMap } from "./useArticleImages";
import { articleLabel, articleSlug, type GatepassDraft } from "./gatepassDraft";

// The right-hand panel: the Gatepass as it will be created — party, every article with a
// quantity, the colours on it, article totals and the grand total. Reads the same draft as
// the cards, so it can never show a different number.

interface GatepassSummaryPanelProps {
  party: PartyFacts | null;
  draft: GatepassDraft;
  images: ArticleImageMap;
  /** Why Create is disabled, shown under the totals; null when the document is ready. */
  blocker: string | null;
}

export const GatepassSummaryPanel: React.FC<GatepassSummaryPanelProps> = ({ party, draft, images, blocker }) => {
  const articles = draft.articles.filter((article) => article.total > 0);

  return (
    <aside className="card gp-card gp-summary" aria-labelledby="gp-summary-title" data-testid="gatepass-summary">
      <div className="gp-summary-head">
        <h2 className="gp-section-title" id="gp-summary-title">
          {copy.gatepass.summaryTitle}
        </h2>
        <span className="gp-summary-party" data-testid="gatepass-summary-party">
          {party ? partyLine(party) : copy.gatepass.noPartySelected}
        </span>
      </div>

      {/* Only this part scrolls; the heading and the totals stay in view. */}
      <div className="gp-summary-body">
        {articles.length === 0 ? (
          <p className="gp-summary-empty">{copy.gatepass.summaryEmpty}</p>
        ) : (
          <ul className="gp-summary-list">
            {articles.map((article) => (
              <li key={article.key} className="gp-summary-article" data-testid={`gatepass-summary-${articleSlug(article)}`}>
                <div className="gp-summary-article-head">
                  <ProductThumb article={article.article} src={images[article.article]} small />
                  <span className="gp-summary-article-name">{articleLabel(article)}</span>
                  <span className="gp-summary-article-total">
                    <span className="gp-party-meta">{copy.columns.total}</span> <strong>{article.total}</strong>
                  </span>
                </div>
                <ul className="gp-summary-colours">
                  {article.colours
                    .filter((colour) => (colour.check.value ?? 0) > 0)
                    .map((colour) => (
                      <li key={colour.productVariantId}>
                        <span className="gp-colour-name">
                          <ColorSwatch color={colour.colour} />
                          {colour.colour}
                        </span>
                        <span className="num">{colour.check.value}</span>
                      </li>
                    ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="gp-summary-foot">
        <div>
          <span className="gp-summary-foot-label">{copy.gatepass.totalItems}</span>
          <span className="gp-summary-foot-meta" data-testid="gatepass-summary-counts">
            {copy.gatepass.articlesAndColors(draft.articleCount, draft.colourCount)}
          </span>
        </div>
        <div className="gp-summary-grand">
          <span className="gp-summary-foot-label">{copy.gatepass.grandTotalLabel}</span>
          <strong data-testid="gatepass-summary-total">{draft.total}</strong>
        </div>
      </div>
      {blocker && (
        <p className="gp-summary-hint" data-testid="gatepass-blocker">
          {blocker}
        </p>
      )}
    </aside>
  );
};
