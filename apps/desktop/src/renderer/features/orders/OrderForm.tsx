import type { ColourAccess } from "../../hooks/useCanAddColour";
import React, { useMemo, useRef, useState } from "react";
import { SearchableCombobox } from "../../components/shared/SearchableCombobox";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { ArticleBlockCard } from "./ArticleBlockCard";
import { OrderStepsStrip } from "./OrderStepsStrip";
import { PendingArticleBlock } from "./PendingArticleBlock";
import { draftProblemCount, draftReady, draftSteps, draftTotal } from "./orderDraft";
import { orderDozens } from "./orderUnits";
import { orderPartyOptions, type OrderChoices } from "./useOrderChoices";
import type { OrderDraftState } from "./useOrderDraft";
import { withViewTransition } from "../../utils/withViewTransition";
import { OrderPlusIcon } from "./OrderIcons";

// THE ORDER BEING WRITTEN, new or edited, in DOZENS (stored as cartons, orderDraft.ts):
//
//   Party [ BEHRAAM SHOES ▾ ]   [+ Add a note]
//   ┌ Articles                                  [ + Add article ] ┐   ← a button; pressed, the list; picked, its block
//   │ ┌ SK6 ─────────────────────────────────── 31 dzn  ✕ ┐     │   ← this part scrolls
//   │ │ every colour across, sizes down   [+ New colour]    │     │
//   │ │ size × colour boxes, each colour's total under it  │     │
//   └──────────────────────────────────────────────────────────┘
//   (✓)Party ─ (✓)Articles ─ (3)Dozens   Next: type the dozens     ORDER TOTAL 31 dozen  [ Save order ]
//
// The total bar sits under the scrolling part, never over it (owner, 24 Nov 2026: it hid what was behind it). The
// picker offers only articles not yet on the order; the one picked becomes its band at once (PendingArticleBlock), and
// its first box takes the focus when its block arrives. The note waits behind "+ Add a note" until wanted.
//
// "+ Add article" (owner, 24 Nov 2026: the picker blended into the page): a filled button that says what it does
// (affordance). Pressed, it becomes the searchable list, already open; picked or dismissed, it is the button again.

const words = copy.orders;
const SHARED_ELEMENT = "ord-article";

interface OrderFormProps {
  entry: OrderDraftState;
  choices: OrderChoices;
  busy: boolean;
  editing: boolean;
  onSave: () => void;
  onDiscard?: () => void;
  /** An administrator where Product Master is written: + New colour on each article. */
  /** Whether "+ New colour" adds, asks the Product Master computer, or cannot be used here (useCanAddColour.ts). */
  colourAccess: ColourAccess;
}

export const OrderForm: React.FC<OrderFormProps> = ({ entry, choices, busy, editing, onSave, onDiscard, colourAccess }) => {
  const { draft } = entry;
  /** The article being read: shown at once as its band (optimistic), until its block replaces it. */
  const [article, setArticle] = useState("");
  /** The article whose block should take the focus when it appears. */
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  /** The article list is showing, in place of the "+ Add article" button. */
  const [picking, setPicking] = useState(false);
  const pickerRef = useRef<HTMLLabelElement>(null);
  const onOrder = useMemo(() => new Set(draft.blocks.map((block) => block.article)), [draft.blocks]);
  // Customers only; an order being edited keeps its own party in the list (24 Nov 2026).
  const partyOptions = useMemo(() => orderPartyOptions(choices.parties.value, draft.partyId), [choices.parties.value, draft.partyId]);
  const articleOptions = useMemo(() => choices.articles.value.filter((option) => !onOrder.has(option.value)), [choices.articles.value, onOrder]);
  const disabled = busy || entry.addingArticle;
  const pending = article !== "" && !onOrder.has(article);
  const showNote = noteOpen || draft.note !== "";

  if (choices.parties.error) return <StateView kind="error" compact message={choices.parties.error} onRetry={() => void choices.parties.reload()} />;
  if (choices.articles.error) return <StateView kind="error" compact message={choices.articles.error} onRetry={() => void choices.articles.reload()} />;

  const add = (value: string) => {
    if (!value) return;
    // Marked now, before the read, so its block takes the focus whenever it mounts. The picker's field becomes the
    // article's band (a shared-element transition), then its colours are read.
    setJustAdded(value);
    withViewTransition(() => setArticle(value), { element: pickerRef.current, name: SHARED_ELEMENT });
    void entry.addArticle(value).finally(() => setArticle(""));
  };

  return (
    <div className="ord-form ord-form--compose">
      <div className="ord-scroll">
        <div className="card ord-head">
          <label className="mpr-field ord-party-field">
            <span className="input-label">{words.party}</span>
            <SearchableCombobox ariaLabel={words.party} placeholder={words.partyPlaceholder} searchPlaceholder={words.partySearch}
              value={draft.partyId} options={partyOptions} onChange={entry.setParty} />
          </label>
          {showNote ? (
            <label className="mpr-field ord-note">
              <span className="input-label">{words.note}</span>
              <input className="input" value={draft.note} maxLength={200} placeholder={words.notePlaceholder} disabled={disabled} autoFocus={noteOpen && draft.note === ""}
                onChange={(event) => entry.setNote(event.target.value)} />
            </label>
          ) : (
            <button type="button" className="ord-note-add" disabled={disabled} onClick={() => setNoteOpen(true)}>+ {words.addNote}</button>
          )}
        </div>
        {/* Articles: the picker heads the card its blocks are written in, so party → articles → save reads top down. */}
        <section className="card ord-articles" aria-labelledby="ord-articles-title">
          <div className="ord-articles-head">
            <h2 className="gp-section-title" id="ord-articles-title">{words.articlesTitle}</h2>
            {picking ? (
              <label className="mpr-field ord-article-pick" ref={pickerRef}>
                <span className="sr-only">{words.article}</span>
                <SearchableCombobox ariaLabel={words.article} placeholder={words.articlePlaceholder} value="" options={articleOptions} onChange={add} autoFocus
                  onOpenChange={(open) => { if (!open) setPicking(false); }} />
              </label>
            ) : (
              <button type="button" className="btn btn-primary ord-article-add" disabled={disabled || articleOptions.length === 0}
                title={articleOptions.length === 0 ? words.noMoreArticles : undefined} onClick={() => setPicking(true)}>
                <OrderPlusIcon /> {words.addArticle}
              </button>
            )}
          </div>
          {pending ? <PendingArticleBlock article={article} /> : null}
          {draft.blocks.length === 0 && !pending ? <StateView kind="empty" compact title={words.emptyTitle} hint={words.emptyHint} /> : null}
          {draft.blocks.map((block) => (
            <ArticleBlockCard key={block.article} block={block} disabled={disabled} focusOnMount={block.article === justAdded}
              onType={(productId, value) => entry.type(block.article, productId, value)}
              onRemove={() => entry.removeArticle(block.article)}
              colourAccess={colourAccess} asked={entry.asked[block.article] ?? []} onColourAsked={(colour) => entry.colourAsked(block.article, colour)}
              onColourAdded={() => void entry.colourAdded(block.article)}
              onColourRemoved={() => void entry.colourRemoved(block.article)} />
          ))}
        </section>
      </div>
      <OrderFootBar entry={entry} busy={busy} editing={editing} onSave={onSave} onDiscard={onDiscard} />
    </div>
  );
};

// THE TOTAL BAR: where the order stands (its steps), its total, and the one main action. The last thing on the
// screen, so it is the last thing read (serial position), and Save is the only filled button on it (von Restorff).
const OrderFootBar: React.FC<Pick<OrderFormProps, "entry" | "busy" | "editing" | "onSave" | "onDiscard">> = ({ entry, busy, editing, onSave, onDiscard }) => {
  const { draft } = entry;
  const problems = draftProblemCount(draft);
  return (
    <footer className="card ord-foot-bar">
      <OrderStepsStrip steps={draftSteps(draft)} showNext={problems === 0} />
      {problems > 0 ? <span className="ord-problem" role="alert">⚠ {words.problemsBlock}</span> : null}
      <span className="ord-foot-total">
        <span className="ord-total-label">{words.totalLabel}</span>
        <strong className="ord-total" aria-live="polite">{words.dozens(orderDozens(draftTotal(draft)))}</strong>
      </span>
      <span className="ord-actions">
        {editing && onDiscard ? <button type="button" className="btn btn-secondary" disabled={busy} onClick={onDiscard}>{words.cancelEdit}</button> : null}
        <button type="button" className="btn btn-primary" disabled={busy || !draftReady(draft)} onClick={onSave}>
          {busy ? words.saving : editing ? words.saveEdit : words.save}
        </button>
      </span>
    </footer>
  );
};
