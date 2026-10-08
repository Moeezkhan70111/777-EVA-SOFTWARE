import { useCallback, useMemo, useState } from "react";
import type { StockGrid } from "../../utils/gatepassGrid";
import { buildDraft, stepQuantity, type GatepassDraft } from "./gatepassDraft";

// State of the Gatepass being written: which article + size cards are on screen, which
// one is open, and the text typed in every colour box. Everything derived (checks, totals,
// lines) comes from buildDraft so the cards and the summary panel never disagree.

export interface GatepassDraftApi {
  draft: GatepassDraft;
  expandedKey: string | null;
  /** True once anything has been added or typed — "New Gatepass" asks before discarding. */
  isDirty: boolean;
  /** Adds the article + size and opens it; an article already on the Gatepass is opened instead. */
  addArticle: (key: string) => "added" | "existing";
  removeArticle: (key: string) => void;
  toggleExpanded: (key: string) => void;
  expand: (key: string) => void;
  setQuantity: (productVariantId: string, text: string) => void;
  stepQuantityBy: (productVariantId: string, delta: 1 | -1) => void;
  clear: () => void;
}

export const useGatepassDraft = (grid: StockGrid): GatepassDraftApi => {
  const [addedKeys, setAddedKeys] = useState<string[]>([]);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});

  const draft = useMemo(() => buildDraft(grid, addedKeys, inputs), [grid, addedKeys, inputs]);

  const availableOf = useMemo(() => {
    const out: Record<string, number> = {};
    for (const row of grid.rows) for (const cell of Object.values(row.cells)) out[cell.productVariantId] = cell.available;
    return out;
  }, [grid]);

  const addArticle = useCallback(
    (key: string): "added" | "existing" => {
      const existing = addedKeys.includes(key);
      if (!existing) setAddedKeys((prev) => [...prev, key]);
      setExpandedKey(key);
      return existing ? "existing" : "added";
    },
    [addedKeys]
  );

  const removeArticle = useCallback(
    (key: string) => {
      const row = grid.rows.find((r) => r.key === key);
      setAddedKeys((prev) => prev.filter((k) => k !== key));
      setExpandedKey((prev) => (prev === key ? null : prev));
      if (!row) return;
      setInputs((prev) => {
        const next = { ...prev };
        for (const cell of Object.values(row.cells)) delete next[cell.productVariantId];
        return next;
      });
    },
    [grid]
  );

  const toggleExpanded = useCallback((key: string) => setExpandedKey((prev) => (prev === key ? null : key)), []);
  const expand = useCallback((key: string) => setExpandedKey(key), []);

  const setQuantity = useCallback((productVariantId: string, text: string) => {
    setInputs((prev) => ({ ...prev, [productVariantId]: text }));
  }, []);

  const stepQuantityBy = useCallback(
    (productVariantId: string, delta: 1 | -1) => {
      const available = availableOf[productVariantId] ?? 0;
      setInputs((prev) => ({ ...prev, [productVariantId]: String(stepQuantity(prev[productVariantId] ?? "", delta, available)) }));
    },
    [availableOf]
  );

  const clear = useCallback(() => {
    setAddedKeys([]);
    setExpandedKey(null);
    setInputs({});
  }, []);

  const isDirty = addedKeys.length > 0 || Object.values(inputs).some((text) => text.trim() !== "");

  return { draft, expandedKey, isDirty, addArticle, removeArticle, toggleExpanded, expand, setQuantity, stepQuantityBy, clear };
};
