import { useCallback, useMemo, useState } from "react";
import type { StockGrid } from "../../utils/gatepassGrid";
import { articleRowKeys, buildDraft, type GatepassDraft } from "./gatepassDraft";

// State of the Gatepass being written: which ARTICLES are on it (each with every size the store holds, owner, 25 Nov
// 2026: as Opening Stock and Stock Adjustment), which one is open, and the text typed in every box. Everything derived
// (checks, totals, lines) comes from buildDraft so the cards and the summary panel never disagree. The sizes follow the
// store: a size Product Master gains while the gatepass is written appears on its article at once.

export interface GatepassDraftApi {
  draft: GatepassDraft;
  /** The article whose grid is open. */
  expandedArticle: string | null;
  /** True once anything has been added or typed — "New Gatepass" asks before discarding. */
  isDirty: boolean;
  /** Adds the article with all its sizes and opens it; an article already on the Gatepass is opened instead. */
  addArticle: (article: string) => "added" | "existing";
  removeArticle: (article: string) => void;
  toggleExpanded: (article: string) => void;
  expand: (article: string) => void;
  setQuantity: (productVariantId: string, text: string) => void;
  clear: () => void;
  /** Puts a stored gatepass's articles and quantities on the draft, to edit it. Replaces whatever was there. */
  load: (articles: string[], inputs: Record<string, string>) => void;
}

export const useGatepassDraft = (grid: StockGrid): GatepassDraftApi => {
  const [articles, setArticles] = useState<string[]>([]);
  const [expandedArticle, setExpandedArticle] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});

  const keys = useMemo(() => articleRowKeys(grid, articles), [grid, articles]);
  const draft = useMemo(() => buildDraft(grid, keys, inputs), [grid, keys, inputs]);

  const addArticle = useCallback(
    (article: string): "added" | "existing" => {
      const existing = articles.includes(article);
      if (!existing) setArticles((prev) => [...prev, article]);
      setExpandedArticle(article);
      return existing ? "existing" : "added";
    },
    [articles]
  );

  const removeArticle = useCallback(
    (article: string) => {
      setArticles((prev) => prev.filter((name) => name !== article));
      setExpandedArticle((prev) => (prev === article ? null : prev));
      const variants = grid.rows.filter((row) => row.article === article).flatMap((row) => Object.values(row.cells).map((cell) => cell.productVariantId));
      setInputs((prev) => {
        const next = { ...prev };
        for (const id of variants) delete next[id];
        return next;
      });
    },
    [grid]
  );

  const toggleExpanded = useCallback((article: string) => setExpandedArticle((prev) => (prev === article ? null : article)), []);
  const expand = useCallback((article: string) => setExpandedArticle(article), []);

  const setQuantity = useCallback((productVariantId: string, text: string) => {
    setInputs((prev) => ({ ...prev, [productVariantId]: text }));
  }, []);

  const clear = useCallback(() => {
    setArticles([]);
    setExpandedArticle(null);
    setInputs({});
  }, []);

  const load = useCallback((loaded: string[], typed: Record<string, string>) => {
    setArticles(loaded);
    setInputs(typed);
    setExpandedArticle(loaded[0] ?? null);
  }, []);

  const isDirty = articles.length > 0 || Object.values(inputs).some((text) => text.trim() !== "");

  return { draft, expandedArticle, isDirty, addArticle, removeArticle, toggleExpanded, expand, setQuantity, clear, load };
};
