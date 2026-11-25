import React, { useMemo } from "react";
import { useElementWidth } from "../../hooks/useElementWidth";
import { BENTO_GAP_PX, bentoLayout } from "../../utils/bentoLayout";
import { PendingArticleMatrix } from "./PendingArticleMatrix";
import type { PendingArticle } from "./pendingMatrix";

// Articles as cards in a bento grid: twelve columns, each card as wide as its table needs, every row filled edge to
// edge, A to Z (bentoLayout.ts). One party's pending orders (PendingPartyRow) and one stored order (OrderDetails) (R1).

interface PendingArticleGridsProps {
  label: string;
  articles: readonly PendingArticle[];
}

export const PendingArticleGrids: React.FC<PendingArticleGridsProps> = ({ label, articles }) => {
  const [gridRef, gridWidth] = useElementWidth<HTMLDivElement>();
  const spans = useMemo(() => bentoLayout(articles.map((group) => group.colours.length), gridWidth, BENTO_GAP_PX), [articles, gridWidth]);
  return (
    <div className="ord-matrices" aria-label={label} ref={gridRef}>
      {articles.map((group, position) => <PendingArticleMatrix key={group.article} group={group} span={spans[position] ?? 12} />)}
    </div>
  );
};
