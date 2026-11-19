import { useCallback, useState } from "react";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import type { CustomerOrderArticleProduct } from "../../types/desktopApi";
import { emptyOrderDraft, newBlock, toggleColour, withProducts, type ArticleBlock, type OrderDraft } from "./orderDraft";
import { parseArticleReply } from "./orderReply";

// The order being typed: party, note and its article blocks (orderDraft.ts). Adding an article reads its live colours
// and sizes from Product Master once, so every colour can be chosen without opening the article picker again.

const words = copy.orders;

export const useOrderDraft = (token: string) => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [draft, setDraft] = useState<OrderDraft>(emptyOrderDraft);
  const [addingArticle, setAddingArticle] = useState(false);

  /** One article's live products, or null (and a notice) when they could not be read. */
  const productsOf = useCallback(
    async (article: string): Promise<CustomerOrderArticleProduct[] | null> => {
      const reply = parseArticleReply(await api.getCustomerOrderArticle(article, { token }).catch(() => null));
      if (!reply.accepted) {
        push("error", copy.toast.loadFailed, reply.reason);
        return null;
      }
      return reply.value;
    },
    [api, push, token]
  );

  const updateBlock = (article: string, change: (block: ArticleBlock) => ArticleBlock) =>
    setDraft((current) => ({ ...current, blocks: current.blocks.map((block) => (block.article === article ? change(block) : block)) }));

  const addArticle = async (article: string) => {
    if (!article) return;
    if (draft.blocks.some((block) => block.article === article)) {
      push("info", words.article, words.alreadyAdded(article));
      return;
    }
    setAddingArticle(true);
    const products = await productsOf(article);
    setAddingArticle(false);
    if (products === null) return;
    if (products.length === 0) {
      push("warning", words.article, words.noColours);
      return;
    }
    setDraft((current) => (current.blocks.some((block) => block.article === article) ? current : { ...current, blocks: [newBlock(article, products), ...current.blocks] }));
  };

  /** A colour was just added to the article in Product Master: read its products again and choose that colour. */
  const colourAdded = async (article: string, colour: string) => {
    const products = await productsOf(article);
    if (products === null) return;
    updateBlock(article, (block) => withProducts(block, products, colour));
  };

  // Stable: the page's own callbacks list it in their dependencies, and a new function each render would loop them.
  const reset = useCallback(() => setDraft(emptyOrderDraft), []);

  return {
    draft,
    setDraft,
    addingArticle,
    productsOf,
    setParty: (partyId: string) => setDraft((current) => ({ ...current, partyId })),
    setNote: (note: string) => setDraft((current) => ({ ...current, note })),
    addArticle,
    colourAdded,
    removeArticle: (article: string) => setDraft((current) => ({ ...current, blocks: current.blocks.filter((block) => block.article !== article) })),
    toggleColour: (article: string, colour: string) => updateBlock(article, (block) => toggleColour(block, colour)),
    type: (article: string, productId: string, value: string) => updateBlock(article, (block) => ({ ...block, typed: { ...block.typed, [productId]: value } })),
    reset,
  };
};

export type OrderDraftState = ReturnType<typeof useOrderDraft>;
