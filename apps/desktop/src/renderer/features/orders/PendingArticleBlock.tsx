import React from "react";
import { copy } from "../../config/copy";

// AN ARTICLE BEING READ (24 Nov 2026): the band appears the moment the article is picked, its name already in it,
// while its colours are read from Product Master — an optimistic update of the screen only; nothing is saved. It
// stands where the article's block will stand, at the block's height, so the page does not jump when the block
// replaces it. It carries the shared-element name the picker had (theme.css, .ord-vt-article), so the picker's field
// is seen to become this band (withViewTransition). If the article cannot be read it simply goes, and the reason is
// the notice the read already gives.

const words = copy.orders;
const SKELETON_CHIPS = [0, 1, 2, 3];

export const PendingArticleBlock: React.FC<{ article: string }> = ({ article }) => (
  <section className="card ord-block ord-block--pending" aria-label={article} aria-busy="true">
    <header className="ord-block-head ord-vt-article">
      <h3 className="ord-block-title">{article}</h3>
      <span className="ord-block-total ord-skeleton" aria-hidden="true" />
    </header>
    <div className="ord-chips" aria-hidden="true">
      {SKELETON_CHIPS.map((index) => <span key={index} className="ord-chip ord-chip--skeleton" />)}
    </div>
    <p className="ord-hint" role="status">{words.loadingArticle}</p>
  </section>
);
