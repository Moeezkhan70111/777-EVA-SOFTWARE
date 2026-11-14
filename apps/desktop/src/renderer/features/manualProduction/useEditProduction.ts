import { useCallback, useEffect, useRef, useState } from "react";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { editCells, parseArticleTodayReply, parseEditReply, startingTyped, type ArticleToday, type EditChange, type Reply } from "./productionEdit";

// The edit dialog's reads and its one write. Today's figures are read once, when the dialog opens, and the boxes start
// at them. One request id for the dialog: a Save retried after a lost answer changes nothing twice (the main process
// also skips a figure that already equals what is asked for).

const text = copy.productionEdit;

export const useEditProduction = (machineName: string, article: string) => {
  const api = useDesktopApi();
  const [today, setToday] = useState<Reply<ArticleToday> | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const requestId = useRef(crypto.randomUUID());

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const reply = parseArticleTodayReply(await api.getManualProductionArticle({ machineName, article }), text.failed);
        if (!live) return;
        setToday(reply);
        if (reply.ok) setTyped(startingTyped(reply.value));
      } catch (error) {
        if (live) setToday({ ok: false, reason: error instanceof Error && error.message ? error.message : text.failed });
      }
    })();
    return () => { live = false; };
  }, [api, machineName, article]);

  const type = useCallback((key: string, value: string) => setTyped((current) => ({ ...current, [key]: value })), []);

  /** Saves the changes. Resolves with how many figures changed, or the reason it was refused. */
  const save = useCallback(
    async (changes: readonly EditChange[]): Promise<Reply<number>> => {
      if (!today?.ok || !today.value.machineId) return { ok: false, reason: text.failed };
      try {
        const reply = await api.editManualProduction({ requestId: requestId.current, machineId: today.value.machineId, article, cells: editCells(changes) });
        return parseEditReply(reply, text.failed);
      } catch (error) {
        return { ok: false, reason: error instanceof Error && error.message ? error.message : text.failed };
      }
    },
    [api, article, today]
  );

  return { today, typed, type, save };
};
