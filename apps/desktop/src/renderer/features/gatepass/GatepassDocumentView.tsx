import React, { useEffect, useState } from "react";
import { copy } from "../../config/copy";
import type { Gatepass } from "../../types/desktopApi";
import { ArticleCard } from "./ArticleCard";
import { GatepassDocumentHead } from "./GatepassDocumentHead";
import type { GatepassDraft } from "./gatepassDraft";
import type { ArticleImageMap } from "./useArticleImages";
import type { PartyBalanceState } from "../parties/usePartyBalance";

// A stored Gatepass in the left column, read-only: the document head, then the same
// article cards the clerk writes with — quantities shown, nothing editable. The first
// article opens when a document is loaded; the rest stay one line each.

interface GatepassDocumentViewProps {
  document: Gatepass;
  /** The document's lines in the draft's shape (buildDraftFromDocument). */
  draft: GatepassDraft;
  balance: PartyBalanceState;
  images: ArticleImageMap;
}

export const GatepassDocumentView: React.FC<GatepassDocumentViewProps> = ({ document, draft, balance, images }) => {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  useEffect(() => {
    setExpandedKey(draft.articles[0]?.key ?? null);
  }, [draft]);

  return (
    <div className="gp-work" data-testid="gatepass-document">
      <GatepassDocumentHead document={document} balance={balance} />
      <section className="card gp-card gp-section gp-articles">
        <div className="gp-section-head-row">
          <h2 className="gp-section-title">{copy.gatepass.articlesSection}</h2>
          {/* <span className="gp-party-meta">{copy.gatepass.createdNote}</span> */}
        </div>
        <div className="gp-article-list">
          {draft.articles.map((article) => (
            <ArticleCard
              key={article.key}
              article={article}
              expanded={expandedKey === article.key}
              image={images[article.article]}
              readOnly
              onToggle={() => setExpandedKey((prev) => (prev === article.key ? null : article.key))}
            />
          ))}
        </div>
      </section>
    </div>
  );
};
