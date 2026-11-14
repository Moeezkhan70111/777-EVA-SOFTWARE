import { useCallback, useEffect, useState } from "react";
import { cartonsToDozens } from "@erp/domain";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { leaseRefusalText } from "../../../shared/leaseRefusal";
import { toIsoDate } from "../../utils/dates";
import { parseSaveReply } from "../productionDay/productionDayReply";
import { mergeLines, readStoredLines, type DraftLine } from "./manualProductionDraft";

// THE LIST WAITING TO BE SAVED (docs/48), and its one write.
//
// KEPT ON THIS COMPUTER until it is saved or cleared (R17): leaving the page, or closing the app, does not lose what
// was typed. It is kept for the day it was made only: a list from yesterday is not offered today, because saving it
// would record yesterday's work as today's production. Nothing in it is secret, and nothing in it is stock until
// Save: storage only spares the typing.
//
// SAVE sends every line with its own request id. A definite answer (saved, or refused: nothing written) settles the
// list: saved clears it, refused keeps it to be corrected. NO ANSWER keeps the list and its ids, so pressing Save
// again asks about the same lines and nothing is added twice.

const STORAGE_KEY = "erp.manual-production.list";
const text = copy.manualProductionPage;

export type SaveOutcome = { kind: "saved"; lines: number; cartons: number; duplicates: number } | { kind: "refused"; message: string };

const loadStored = (): DraftLine[] => {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as { day?: unknown; lines?: unknown } | null;
    return stored && stored.day === toIsoDate() ? readStoredLines(stored.lines) : [];
  } catch {
    return [];
  }
};

const store = (lines: readonly DraftLine[]): void => {
  try {
    if (lines.length === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ day: toIsoDate(), lines }));
  } catch {
    // Storage is a convenience: the list still works without it.
  }
};

export const useProductionList = (onSaved: () => void) => {
  const api = useDesktopApi();
  const [lines, setLines] = useState<DraftLine[]>(loadStored);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);

  useEffect(() => store(lines), [lines]);

  const add = useCallback((added: readonly DraftLine[]) => {
    setOutcome(null);
    setLines((current) => mergeLines(current, added));
  }, []);
  const remove = useCallback((key: string) => setLines((current) => current.filter((line) => line.key !== key)), []);
  const clear = useCallback(() => { setLines([]); setOutcome(null); }, []);

  /** Resolves with null once saved, or the reason it was not (the confirmation shows it). */
  const save = useCallback(async (): Promise<string | null> => {
    if (lines.length === 0 || saving) return null;
    setSaving(true);
    setOutcome(null);
    try {
      const reply = await api.saveManualProduction({
        lines: lines.map((line) => ({ requestId: line.requestId, machineId: line.machineId, articleSizeId: line.articleSizeId, color: line.color, dozens: String(cartonsToDozens(line.cartons)) })),
      });
      const parsed = parseSaveReply(reply, text.unreachable);
      if (!parsed.ok) {
        setOutcome({ kind: "refused", message: parsed.reason });
        return parsed.reason;
      }
      setOutcome({ kind: "saved", lines: parsed.value.entries, cartons: parsed.value.cartons, duplicates: parsed.value.duplicates });
      setLines([]);
      onSaved();
      return null;
    } catch (error) {
      const message = leaseRefusalText(error) ?? text.unreachable;
      setOutcome({ kind: "refused", message });
      return message;
    } finally {
      setSaving(false);
    }
  }, [api, lines, onSaved, saving]);

  return { lines, saving, outcome, add, remove, clear, save };
};
