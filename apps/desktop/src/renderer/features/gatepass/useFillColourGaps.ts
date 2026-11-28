import { useEffect, useRef, useState } from "react";
import { addArticleColor } from "../../components/shared/articleColor";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";

// EVERY BOX OPEN ON THE GATEPASS (owner, 28 Nov 2026: "dont do the + thing keep everything open"). When an article is
// opened where colours may be added (useCanAddColour: an administrator where Product Master is written), each colour
// the article has but not in every size is added to the sizes it is missing from, by itself, through the same call
// "+ New colour" uses (addArticleColor → addColorToArticle). The store is then read again and every cell has its box.
// Each article and colour is tried once while the page is open, so a refusal is told once and never retried in a loop.

const words = copy.missingSize;

interface FillColourGapsInput {
  article: string;
  /** Colours of the article that are missing from at least one of its sizes. */
  gapColours: readonly string[];
  /** Open, and allowed to add colours here. */
  enabled: boolean;
  /** After at least one colour was added: read the store again. */
  onFilled: () => void;
}

/** Fills the article's colour gaps once it is open; true while it is doing so. */
export const useFillColourGaps = ({ article, gapColours, enabled, onFilled }: FillColourGapsInput): boolean => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const tried = useRef(new Set<string>());
  const [filling, setFilling] = useState(false);
  const gapKey = gapColours.join("|");

  useEffect(() => {
    if (!enabled) return;
    const todo = gapColours.filter((colour) => !tried.current.has(`${article}|${colour}`));
    if (todo.length === 0) return;
    for (const colour of todo) tried.current.add(`${article}|${colour}`);
    setFilling(true);
    void (async () => {
      let added = false;
      for (const colour of todo) {
        const reply = await addArticleColor(api, article, colour, words.addMissingFailed);
        if (reply.ok) added = true;
        else push("error", words.notInMaster, reply.reason);
      }
      setFilling(false);
      if (added) onFilled();
    })();
    // gapKey stands for gapColours: the effect runs again only when the gaps themselves change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, article, gapKey]);

  return filling;
};
