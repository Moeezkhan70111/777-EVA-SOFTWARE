import { leaseRefusalText } from "../../../shared/leaseRefusal";
import type { useDesktopApi } from "../../hooks/useDesktopApi";

// Adding a colour to an article (main process addColorToArticle): the colour on every active size of the article
// where it is not yet made, the sizes it is already made in left as they are. Product master data, written where
// MASTER_DATA is held and by an administrator; the main process refuses it anywhere else. One call and one reading of
// its answer for every control that adds a colour — "+ New colour" (AddColorControl) and, on Enter Orders, "+ Add" on
// a size a colour is not made in (24 Nov 2026).

type DesktopApi = ReturnType<typeof useDesktopApi>;

export type ArticleColorReply = { ok: true; color: string } | { ok: false; reason: string };

const readReply = (reply: unknown, failed: string): ArticleColorReply => {
  const record = typeof reply === "object" && reply !== null ? (reply as Record<string, unknown>) : {};
  if (record.accepted === true && typeof record.color === "string") return { ok: true, color: record.color };
  return { ok: false, reason: typeof record.reason === "string" ? record.reason : failed };
};

/** Adds `color` to `article`; `failed` is what the operator is told when no reason comes back. */
export const addArticleColor = async (api: DesktopApi, article: string, color: string, failed: string): Promise<ArticleColorReply> => {
  try {
    return readReply(await api.addArticleColor({ article, color }), failed);
  } catch (error) {
    return { ok: false, reason: leaseRefusalText(error) ?? failed };
  }
};

export type ColorAskReply = { ok: true; color: string; asked: boolean } | { ok: false; reason: string };

/** Asks the Product Master computer for `color` on `article` (main process requestArticleColor, from Enter Orders on the
 *  orders computer). `asked` is false when the article already had it: nothing to wait for. */
export const requestArticleColor = async (api: DesktopApi, article: string, color: string, failed: string): Promise<ColorAskReply> => {
  try {
    const reply = await api.requestArticleColor({ article, color });
    const record = typeof reply === "object" && reply !== null ? (reply as Record<string, unknown>) : {};
    if (record.accepted === true && typeof record.color === "string") return { ok: true, color: record.color, asked: record.status === "REQUESTED" };
    return { ok: false, reason: typeof record.reason === "string" ? record.reason : failed };
  } catch (error) {
    return { ok: false, reason: leaseRefusalText(error) ?? failed };
  }
};

export type ColorRemovalReply = { ok: true; color: string; removed: number } | { ok: false; reason: string };

/** Takes `color` off every size of `article` (main process removeColorFromArticle). Refused, in words, while carton
 *  stock or an open order still needs it; `failed` is what the operator is told when no reason comes back. */
export const removeArticleColor = async (api: DesktopApi, article: string, color: string, failed: string): Promise<ColorRemovalReply> => {
  try {
    const reply = await api.removeArticleColor({ article, color });
    const record = typeof reply === "object" && reply !== null ? (reply as Record<string, unknown>) : {};
    if (record.accepted === true && typeof record.color === "string" && typeof record.removed === "number") {
      return { ok: true, color: record.color, removed: record.removed };
    }
    return { ok: false, reason: typeof record.reason === "string" ? record.reason : failed };
  } catch (error) {
    return { ok: false, reason: leaseRefusalText(error) ?? failed };
  }
};
