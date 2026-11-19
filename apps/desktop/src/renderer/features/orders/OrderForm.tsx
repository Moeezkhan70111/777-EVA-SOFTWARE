import React, { useState } from "react";
import { SearchableCombobox } from "../../components/shared/SearchableCombobox";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { ArticleBlockCard } from "./ArticleBlockCard";
import { draftLines, draftProblemCount, draftReady, draftTotal } from "./orderDraft";
import type { OrderChoices } from "./useOrderChoices";
import type { OrderDraftState } from "./useOrderDraft";

// THE ORDER BEING WRITTEN, new or edited:
//
//   Party [ BEHRAAM SHOES ▾ ]   Note [ ……………… ]
//   Article [ SK6 ▾ ]                                    ← adding it opens its block
//   ┌ SK6 ─ colours [RED ✓] [BLUE ✓] [BLACK] ─ 62 ctn ✕ ┐
//   │ size × colour boxes, each colour's total under it │
//   Order total 62 cartons · 6 lines          [ Save order ]

const words = copy.orders;

interface OrderFormProps {
  entry: OrderDraftState;
  choices: OrderChoices;
  busy: boolean;
  editing: boolean;
  onSave: () => void;
  onDiscard?: () => void;
  /** An administrator where Product Master is written: + New colour on each article. */
  canAddColor: boolean;
}

export const OrderForm: React.FC<OrderFormProps> = ({ entry, choices, busy, editing, onSave, onDiscard, canAddColor }) => {
  const { draft } = entry;
  const [article, setArticle] = useState("");
  const total = draftTotal(draft);
  const problems = draftProblemCount(draft);
  const disabled = busy || entry.addingArticle;

  if (choices.parties.error) return <StateView kind="error" compact message={choices.parties.error} onRetry={() => void choices.parties.reload()} />;
  if (choices.articles.error) return <StateView kind="error" compact message={choices.articles.error} onRetry={() => void choices.articles.reload()} />;

  const add = (value: string) => {
    setArticle(value);
    if (!value) return;
    void entry.addArticle(value).then(() => setArticle(""));
  };

  return (
    <div className="ord-form">
      <div className="card ord-head">
        <label className="mpr-field ord-party-field">
          <span className="input-label">{words.party}</span>
          <SearchableCombobox ariaLabel={words.party} placeholder={words.partyPlaceholder} searchPlaceholder={words.partySearch}
            value={draft.partyId} options={choices.parties.value} onChange={entry.setParty} />
        </label>
        <label className="mpr-field ord-note">
          <span className="input-label">{words.note}</span>
          <input className="input" value={draft.note} maxLength={200} placeholder={words.notePlaceholder} disabled={disabled} onChange={(event) => entry.setNote(event.target.value)} />
        </label>
        <label className="mpr-field ord-article-pick">
          <span className="input-label">{words.article}</span>
          <SearchableCombobox ariaLabel={words.article} placeholder={words.articlePlaceholder} value={article} options={choices.articles.value} onChange={add} />
        </label>
      </div>
      {entry.addingArticle ? <StateView kind="loading" compact message={words.loadingArticle} /> : null}
      {draft.blocks.length === 0 ? <StateView kind="empty" compact title={words.emptyTitle} hint={words.emptyHint} /> : null}
      {draft.blocks.map((block) => (
        <ArticleBlockCard key={block.article} block={block} disabled={disabled}
          onToggleColour={(colour) => entry.toggleColour(block.article, colour)}
          onType={(productId, value) => entry.type(block.article, productId, value)}
          onRemove={() => entry.removeArticle(block.article)}
          canAddColor={canAddColor} onColourAdded={(colour) => void entry.colourAdded(block.article, colour)} />
      ))}
      <footer className="card ord-foot-bar">
        <span className="ord-total-label">{words.totalLabel}</span>
        <strong className="ord-total" aria-live="polite">{words.cartons(total)}</strong>
        <span className="ord-muted">{words.lineCount(draftLines(draft).length)}</span>
        {problems > 0 ? <span className="ord-problem" role="alert">⚠ {words.problemsBlock}</span> : null}
        <span className="ord-actions">
          {editing && onDiscard ? <button type="button" className="btn btn-secondary" disabled={busy} onClick={onDiscard}>{words.cancelEdit}</button> : null}
          <button type="button" className="btn btn-primary" disabled={busy || !draftReady(draft)} onClick={onSave}>
            {busy ? words.saving : editing ? words.saveEdit : words.save}
          </button>
        </span>
      </footer>
    </div>
  );
};
