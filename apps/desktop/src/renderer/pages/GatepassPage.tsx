import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AppRoute } from "../app/routes";
import { useDesktopApi } from "../hooks/useDesktopApi";
import { REQUEST_STORAGE_KEY, useLeftoverRequest, useRequestId } from "../hooks/useRequestId";
import { useNotifications } from "../state/NotificationsContext";
import { StateView } from "../components/shared/StateView";
import type { Gatepass, GatepassShortage } from "../types/desktopApi";
import { buildStockGrid } from "../utils/gatepassGrid";
import { openGatepassPrintWindow } from "../utils/gatepassPrint";
import { copy } from "../config/copy";
import { ArticleGridCard } from "../features/gatepass/ArticleGridCard";
import { ArticlePicker } from "../features/gatepass/ArticlePicker";
import { GatepassDocumentView } from "../features/gatepass/GatepassDocumentView";
import { GatepassNavigator } from "../features/gatepass/GatepassNavigator";
import { GatepassStatusBadge } from "../features/gatepass/GatepassStatusBadge";
import { GatepassSteps } from "../features/gatepass/GatepassSteps";
import { GatepassSummaryPanel } from "../features/gatepass/GatepassSummaryPanel";
import { PartySection, type TransportFields } from "../features/gatepass/PartySection";
import { buildDraftFromDocument, createBlocker, dozensText, groupArticles, listArticleOptions } from "../features/gatepass/gatepassDraft";
import { useArticleImages } from "../features/gatepass/useArticleImages";
import { gatepassPartyOptions, useGatepassData } from "../features/gatepass/useGatepassData";
import { useGatepassDraft } from "../features/gatepass/useGatepassDraft";
import { useGatepassNavigation } from "../features/gatepass/useGatepassNavigation";
import { usePartyBalance } from "../features/parties/usePartyBalance";
import { CartonCloudOffNotice } from "../features/sync/CartonCloudOffNotice";
import { EditingActions, ViewingActions } from "../features/gatepass/GatepassActions";
import { GatepassEditBar } from "../features/gatepass/GatepassEditBar";
import { canEditGatepass, draftFromDocument, partyIsLocked, stockForEdit } from "../features/gatepass/gatepassEdit";
import { useGatepassEdit } from "../features/gatepass/useGatepassEdit";
import { useCanAddColour } from "../hooks/useCanAddColour";

// Gatepass — one screen, two columns.
//
//   Left:   Party, then the articles being cut. Each ARTICLE is a card with every size the store holds
//           (owner, 25 Nov 2026, as Opening Stock and Stock Adjustment): open, sizes down and colours
//           across, a box in every cell with In / Reserved / Free under it; closed, it is one line. One
//           card is open at a time, so ten articles still fit on a screen.
//   Right:  the Gatepass as it will be created — every article, colour and quantity, with
//           article totals and the grand total. Stays in view while the left side scrolls.
//   Then:   Create → GP-000123, shown in the same two columns, read-only, with Print.
//   ‹ › Load in the header walks through stored Gatepasses by number the same way; the
//   draft being written is kept underneath and › past the latest document returns to it.
//   Edit (local migration 118): a stored gatepass's lines, party and transport go onto the draft, the store shown
//   with the gatepass's own cartons given back, and Save changes replaces it under the same number.
//
// Nothing here moves stock: the document reserves cartons for the party; the cartons that
// actually leave are recorded later by the Store Move Out scanner (against this Gatepass)
// and the gate scanner. Each colour shows Current Stock (physically In Store), Reserved
// (owed to other open Gatepasses) and Reflected Stock (Current − Reserved, the most this
// document may take). The figures are a snapshot — the main process re-reads them inside
// the write transaction and refuses the document if Reflected Stock no longer covers it.

interface GatepassPageProps {
  token: string;
  username: string;
  onNavigate: (route: AppRoute, id?: string) => void;
  /** Open the gatepass in Sale Voucher to bill it. Absent for someone who may not open Sale Voucher here. */
  onMakeBill?: (gatepassId: string) => void;
  /** Whether this user may edit a gatepass (admin or the gatepass-edit permission). */
  canEdit?: boolean;
  /** Open this gatepass straight into an edit (from Gatepass List). */
  editGatepassId?: string;
}

interface SubmitError {
  message: string;
  shortages?: GatepassShortage[];
}

const EMPTY_TRANSPORT: TransportFields = { biltyNumber: "", transportVia: "", remarks: "" };

export const GatepassPage: React.FC<GatepassPageProps> = ({ token, onNavigate, onMakeBill, canEdit = false, editGatepassId }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const { parties, partiesLoading, stock, grid, reloadStock, applyShortages } = useGatepassData(token);
  const edit = useGatepassEdit(token);
  // While editing, the store is shown with the gatepass's own cartons given back, as the edit counts them.
  const draftGrid = useMemo(() => (edit.editing ? buildStockGrid(stockForEdit(stock.rows, edit.editing)) : grid), [edit.editing, stock.rows, grid]);
  const { draft, expandedArticle, isDirty, addArticle, removeArticle, toggleExpanded, expand, setQuantity, clear, load } = useGatepassDraft(draftGrid);
  const articleGroups = useMemo(() => groupArticles(draft.articles), [draft.articles]);
  const nav = useGatepassNavigation(token);
  // Adding a colour to an article: the one rule every quantity-by-colour page asks (useCanAddColour).
  const canAddColour = useCanAddColour();

  const [partyId, setPartyId] = useState("");
  const [transport, setTransport] = useState<TransportFields>(EMPTY_TRANSPORT);
  const [submitting, setSubmitting] = useState(false);
  // One press of Create, one request id (hooks/useRequestId.ts): held at once, not on the next render, so a second
  // press in the same instant sends nothing; kept after a lost answer, so a retry is answered with the same gatepass.
  const request = useRequestId(REQUEST_STORAGE_KEY.GATEPASS);
  useLeftoverRequest(REQUEST_STORAGE_KEY.GATEPASS, (id) => api.findGatepassByRequest(id, { token }), (label) =>
    push("warning", copy.requests.lastSaveTitle, copy.requests.lastSaveBody(label))
  );
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);

  const party = useMemo(() => parties.find((p) => p.id === partyId) ?? null, [parties, partyId]);
  // Customers only; an edited gatepass keeps its own party in the list.
  const partyOptions = useMemo(() => gatepassPartyOptions(parties, edit.editing?.partyId), [parties, edit.editing]);
  const draftBalance = usePartyBalance(partyId);
  const documentBalance = usePartyBalance(nav.viewing?.partyId ?? "");
  const documentDraft = useMemo(() => (nav.viewing ? buildDraftFromDocument(nav.viewing) : null), [nav.viewing]);
  const shownDraft = documentDraft ?? draft;
  const images = useArticleImages(shownDraft.articles.map((a) => a.article));
  const articleOptions = useMemo(() => listArticleOptions(draftGrid), [draftGrid]);
  const blocker = createBlocker(draft, partyId);
  const articlesReady = draft.lines.length > 0 && draft.errorCount === 0;

  // ── Handlers ──────────────────────────────────────────────────────────────
  const resetDraft = () => {
    request.renew();
    clear();
    setPartyId("");
    setTransport(EMPTY_TRANSPORT);
    setSubmitError(null);
    void reloadStock();
  };

  const draftHasContent = () => isDirty || Boolean(partyId) || Object.values(transport).some((text) => text.trim() !== "");

  const startNew = () => {
    if (draftHasContent() && !window.confirm(copy.gatepass.discardDraft)) return;
    resetDraft();
    nav.close();
  };

  // ── Edit (local migration 118) ────────────────────────────────────────────
  const startEdit = (document: Gatepass) => {
    if (!edit.editing && draftHasContent() && !window.confirm(copy.gatepass.finishDraftFirst)) return;
    resetDraft();
    const { articles, inputs } = draftFromDocument(document);
    load(articles, inputs);
    setPartyId(document.partyId);
    setTransport({ biltyNumber: document.biltyNumber ?? "", transportVia: document.transportVia ?? "", remarks: document.remarks ?? "" });
    edit.start(document);
    nav.close();
  };

  const cancelEdit = () => {
    const document = edit.editing;
    if (!window.confirm(copy.gatepass.discardEdit)) return;
    resetDraft();
    edit.stop();
    if (document) nav.show(document);
  };

  const saveEdit = async () => {
    const document = edit.editing;
    if (!document || blocker || edit.saving) return;
    if (!edit.reason.trim()) {
      setSubmitError({ message: copy.gatepass.reasonNeeded });
      return;
    }
    setSubmitError(null);
    const result = await edit.save({ partyId, lines: draft.lines, ...transport });
    if (!result.accepted) {
      const message = result.reason ?? copy.gatepass.editFailed;
      setSubmitError({ message, shortages: result.shortages?.length ? result.shortages : undefined });
      push("error", copy.toast.failed, message);
      return;
    }
    push("success", copy.gatepass.editedToast(document.code), copy.gatepass.editedToastBody(dozensText(result.totalQuantity ?? 0), result.billNumber));
    const saved = await api.getGatepass(document.id, { token });
    resetDraft();
    edit.stop();
    if (saved) nav.show(saved);
  };

  // Opened from Gatepass List to edit: once the store is read, the gatepass goes onto the draft.
  const openedForEdit = useRef<string | null>(null);
  useEffect(() => {
    if (!editGatepassId || !canEdit || stock.loading || openedForEdit.current === editGatepassId) return;
    openedForEdit.current = editGatepassId;
    void api.getGatepass(editGatepassId, { token }).then((document) => {
      if (document && canEditGatepass(document)) startEdit(document);
      else if (document) nav.show(document);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per gatepass asked for, after the store is read
  }, [editGatepassId, canEdit, stock.loading]);

  const pickArticle = (article: string) => {
    addArticle(article);
    setSubmitError(null);
  };

  const create = async () => {
    if (blocker || submitting) return;
    const requestId = request.start();
    if (requestId === null) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.createGatepass(
        {
          requestId,
          partyId,
          lines: draft.lines,
          biltyNumber: transport.biltyNumber.trim() || null,
          transportVia: transport.transportVia.trim() || null,
          remarks: transport.remarks.trim() || null,
        },
        { token }
      );

      // A definite answer. A conflict keeps the id: pressing Create again must not make a second, different
      // gatepass from an edited draft -- "New" starts one. Any other answer gives the next press a new id.
      request.settle({ renew: result.outcome !== "REQUEST_CONFLICT" });
      if (result.accepted) {
        const code = result.code ?? "";
        if (result.outcome === "ALREADY_SAVED") push("success", copy.requests.alreadySavedTitle, copy.requests.gatepassAlreadySaved(code));
        else push("success", copy.gatepass.createdToast(code), copy.gatepass.createdToastBody(dozensText(result.totalQuantity ?? 0), party?.partyName ?? ""));
        // The stored document replaces the draft on screen; the print-out is built from it.
        const document = result.gatepassId ? await api.getGatepass(result.gatepassId, { token }) : null;
        resetDraft();
        if (document) nav.show(document);
        else push("warning", copy.gatepass.createdToast(code), copy.gatepass.createdNotReloaded);
        return;
      }

      // Rejected: stay on the document with the exact reason. Any colour that fell short
      // gets the live figure at once (so its box validates against it) and its card opens.
      const shortages = result.shortages ?? [];
      applyShortages(shortages);
      if (shortages[0]) expand(shortages[0].article);
      const message = result.reason ?? copy.gatepass.createFailed;
      setSubmitError({ message, shortages: shortages.length ? shortages : undefined });
      push("error", copy.toast.failed, message);
    } catch {
      // No answer: the same id goes again, so the gatepass cannot be made twice.
      request.unanswered();
      setSubmitError({ message: copy.gatepass.saveFailed });
      push("error", copy.toast.failed, copy.gatepass.saveFailed);
    } finally {
      setSubmitting(false);
    }
  };

  const printViewing = () => {
    if (nav.viewing && !openGatepassPrintWindow(nav.viewing)) push("error", copy.toast.popupBlocked, copy.common.popupBlocked);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const renderArticles = () => {
    if (stock.loading && grid.rows.length === 0) return <StateView kind="loading" compact />;
    if (stock.error) return <StateView kind="error" compact message={stock.error} onRetry={() => void reloadStock()} />;
    if (grid.rows.length === 0) return <StateView kind="empty" compact title={copy.gatepass.noStockTitle} hint={copy.gatepass.noStockHint} />;
    if (draft.articles.length === 0) return <StateView kind="empty" compact title={copy.gatepass.noArticlesTitle} hint={copy.gatepass.noArticlesHint} />;
    return (
      <div className="gp-article-list" data-testid="gatepass-articles">
        {articleGroups.map((group) => (
          <ArticleGridCard
            key={group.article}
            group={group}
            grid={draftGrid}
            expanded={expandedArticle === group.article}
            image={images[group.article]}
            canAddColour={canAddColour}
            onToggle={() => toggleExpanded(group.article)}
            onRemove={() => removeArticle(group.article)}
            onQuantityChange={(variantId, text) => {
              setQuantity(variantId, text);
              setSubmitError(null);
            }}
            onColourAdded={() => void reloadStock()}
          />
        ))}
      </div>
    );
  };

  const renderDraft = () => (
    <div className="gp-work">
      {edit.editing ? <GatepassEditBar document={edit.editing} reason={edit.reason} onReason={edit.setReason} /> : null}
      {submitError && (
        <div className="gp-alert gp-alert--error" role="alert" data-testid="gatepass-submit-error">
          <strong>{submitError.message}</strong>
          {submitError.shortages && (
            <ul className="gp-alert-list">
              {submitError.shortages.map((s) => (
                <li key={s.productVariantId}>
                  {s.article} / {s.color} / {s.size} — {copy.gatepass.shortageLine({ currentStock: dozensText(s.currentStock), reserved: dozensText(s.reserved), reflected: dozensText(s.reflected), requested: dozensText(s.requested) })}
                  {s.seen !== null && s.seen !== s.reflected ? ` ${copy.gatepass.youSaw(dozensText(s.seen))}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <PartySection
        parties={partyOptions}
        loading={partiesLoading}
        partyId={partyId}
        party={party}
        balance={draftBalance}
        transport={transport}
        onPartyChange={(id) => {
          setPartyId(id);
          setSubmitError(null);
        }}
        onTransportChange={(patch) => setTransport((prev) => ({ ...prev, ...patch }))}
        partyLocked={edit.editing ? partyIsLocked(edit.editing) : false}
      />

      <section className="card gp-card gp-section gp-articles" data-testid="gatepass-articles-section">
        <div className="gp-section-head-row">
          <h2 className="gp-section-title">{copy.gatepass.articlesSection}</h2>
          <ArticlePicker options={articleOptions} disabled={Boolean(stock.error) || grid.rows.length === 0} onPick={pickArticle} />
        </div>
        
        {renderArticles()}
      </section>
    </div>
  );

  const viewing = nav.viewing;
  const editing = edit.editing;
  const summaryParty = viewing ? { partyName: viewing.partyName, partyCode: viewing.partyCode, city: viewing.partyCity } : party;
  const pageTitle = viewing ? `${copy.gatepass.title} ${viewing.code}` : editing ? copy.gatepass.editTitle(editing.code) : copy.gatepass.title;

  return (
    // doc-themed: the card pages' look (theme.css, "Create Gatepass in the card pages' look"), shared with Sale Voucher.
    <div className="page gatepass-page gp-compose doc-themed">
      <CartonCloudOffNotice />
      <header className="gp-topbar">
        <div className="gp-topbar-main">
          <h1 className={`page-title${viewing ? " page-detail-title" : ""}`} data-testid="gatepass-title">
            {pageTitle}
          </h1>
          {viewing ? <GatepassStatusBadge status={viewing.status} /> : null}
          {editing ? <span className="badge badge-warn" data-testid="gatepass-editing-badge">{copy.gatepass.editingBadge}</span> : null}
          {!viewing && !editing ? <GatepassSteps partyDone={Boolean(partyId)} articlesDone={articlesReady} /> : null}
        </div>
        <div className="gp-topbar-actions">
          {editing ? (
            <EditingActions saving={edit.saving} blocked={Boolean(blocker) || !edit.reason.trim()} onCancel={cancelEdit} onSave={() => void saveEdit()} />
          ) : (
            <>
              {/* Hick's law (owner, 24 Nov 2026): finding a gatepass is one group, acting on this one another. */}
              <div className="gp-topbar-group">
                <GatepassNavigator current={viewing?.gatepassNumber ?? null} latest={nav.latest} busy={nav.busy} onGo={(n) => void nav.goTo(n)} onNew={nav.close} />
                <button type="button" className="btn btn-secondary" onClick={startNew} data-testid="gatepass-new">
                  + {copy.gatepass.newGatepass}
                </button>
              </div>
              <span className="gp-topbar-divider" aria-hidden="true" />
              {viewing ? (
                <ViewingActions
                  document={viewing}
                  onOpenInList={() => onNavigate("gatepass-list", viewing.id)}
                  onPrint={printViewing}
                  onEdit={canEdit ? () => startEdit(viewing) : undefined}
                  onMakeBill={onMakeBill ? () => onMakeBill(viewing.id) : undefined}
                />
              ) : (
                <button type="button" className="btn btn-primary" onClick={() => void create()} disabled={Boolean(blocker) || submitting} data-testid="gatepass-create">
                  {submitting ? copy.gatepass.creating : copy.gatepass.createGatepass}
                </button>
              )}
            </>
          )}
        </div>
      </header>

      <div className="gp-workspace">
        {viewing && documentDraft ? <GatepassDocumentView document={viewing} draft={documentDraft} balance={documentBalance} images={images} /> : renderDraft()}
        <GatepassSummaryPanel party={summaryParty} draft={shownDraft} images={images} blocker={viewing ? null : blocker} />
      </div>
    </div>
  );
};
