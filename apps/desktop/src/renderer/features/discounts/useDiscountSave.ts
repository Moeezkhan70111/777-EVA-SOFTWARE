import { useState } from "react";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import { leaseRefusalText } from "../../../shared/leaseRefusal";
import { DISCOUNT_KIND, SIZE_SCOPE, type DiscountChange, type SizeScope } from "./discountPolicy";

// Saving discounts: the same calls the page always made, one rule per customer (and per size), each saved where
// customers are written (the PARTIES lease, main process). Only the boxes changed from the current discount are sent.
// A refusal is said against its customer; whatever saved is announced once, and the page reads the rules again.

const text = copy.discountPolicy;

/** What the discounts are on: a group or series id, or an article with how its sizes are taken. */
export type DiscountTarget =
  | { readonly kind: typeof DISCOUNT_KIND.PRODUCT_GROUP | typeof DISCOUNT_KIND.ARTICLE_SERIES; readonly id: string; readonly name: string }
  | { readonly kind: typeof DISCOUNT_KIND.ARTICLE; readonly article: string; readonly scope: SizeScope; readonly name: string };

type Reply = { accepted: boolean; reason?: string };

export const useDiscountSave = (partyName: (partyId: string) => string, onSaved: () => void) => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [saving, setSaving] = useState(false);

  const call = (target: DiscountTarget, change: DiscountChange): Promise<Reply> => {
    if (target.kind === DISCOUNT_KIND.ARTICLE) {
      const separate = target.scope === SIZE_SCOPE.SEPARATE_SIZES;
      return api.createPartyArticleDiscount({ partyId: change.partyId, article: target.article, sizeScope: target.scope, size: separate ? change.size : null, discountPerPair: change.rupees });
    }
    if (target.kind === DISCOUNT_KIND.PRODUCT_GROUP) return api.createPartyProductGroupDiscount({ partyId: change.partyId, productGroupId: target.id, discountPerPair: change.rupees });
    return api.createPartyArticleSeriesDiscount({ partyId: change.partyId, articleSeriesId: target.id, discountPerPair: change.rupees });
  };

  /** Saves each change; returns the keys that saved, so their boxes can be let go. */
  const save = async (target: DiscountTarget, changes: readonly DiscountChange[]): Promise<Set<string>> => {
    setSaving(true);
    const saved = new Set<string>();
    for (const change of changes) {
      const reply = await call(target, change).catch((error: unknown): Reply => ({ accepted: false, reason: leaseRefusalText(error) ?? text.couldNotSave }));
      if (reply.accepted) saved.add(change.key);
      else push("error", text.notSavedTitle, text.notSaved(partyName(change.partyId), reply.reason ?? text.couldNotSave));
    }
    setSaving(false);
    if (saved.size > 0) {
      push("success", text.savedTitle, text.savedBody(saved.size, target.name));
      onSaved();
    }
    return saved;
  };

  return { saving, save };
};

