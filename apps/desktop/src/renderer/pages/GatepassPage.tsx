import React, { useMemo, useState } from "react";
import type { AppRoute } from "../app/routes";
import { useDesktopApi } from "../hooks/useDesktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { StateView } from "../components/shared/StateView";
import type { GatepassShortage } from "../types/desktopApi";
import { rowKeyOf } from "../utils/gatepassGrid";
import { openGatepassPrintWindow } from "../utils/gatepassPrint";
import { copy } from "../config/copy";
import { ArticleCard } from "../features/gatepass/ArticleCard";
import { ArticlePicker } from "../features/gatepass/ArticlePicker";
import { GatepassDocumentView } from "../features/gatepass/GatepassDocumentView";
import { GatepassNavigator } from "../features/gatepass/GatepassNavigator";
import { GatepassStatusBadge } from "../features/gatepass/GatepassStatusBadge";
import { GatepassSteps } from "../features/gatepass/GatepassSteps";
import { GatepassSummaryPanel } from "../features/gatepass/GatepassSummaryPanel";
import { PartySection, type TransportFields } from "../features/gatepass/PartySection";
import { buildDraftFromDocument, createBlocker, listArticleOptions } from "../features/gatepass/gatepassDraft";
import { useArticleImages } from "../features/gatepass/useArticleImages";
import { useGatepassData } from "../features/gatepass/useGatepassData";
import { useGatepassDraft } from "../features/gatepass/useGatepassDraft";
import { useGatepassNavigation } from "../features/gatepass/useGatepassNavigation";
import { usePartyBalance } from "../features/parties/usePartyBalance";

// Gatepass — one screen, two columns.
//
//   Left:   Party, then the articles being cut. Each article + size is a card: open, it
//           lists every colour the store holds with its In Store cartons and a box for the
//           cartons going out; closed, it is one line. One card is open at a time, so ten
//           articles still fit on a screen.
//   Right:  the Gatepass as it will be created — every article, colour and quantity, with
//           article totals and the grand total. Stays in view while the left side scrolls.
//   Then:   Create → GP-000123, shown in the same two columns, read-only, with Print.
//   ‹ › Load in the header walks through stored Gatepasses by number the same way; the
//   draft being written is kept underneath and › past the latest document returns to it.
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
}

interface SubmitError {
  message: string;
  shortages?: GatepassShortage[];
}

const EMPTY_TRANSPORT: TransportFields = { biltyNumber: "", transportVia: "", remarks: "" };

export const GatepassPage: React.FC<GatepassPageProps> = ({ token, onNavigate }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const { parties, partiesLoading, stock, grid, reloadStock, applyShortages } = useGatepassData(token);
  const { draft, expandedKey, isDirty, addArticle, removeArticle, toggleExpanded, expand, setQuantity, stepQuantityBy, clear } = useGatepassDraft(grid);
  const nav = useGatepassNavigation(token);

  const [partyId, setPartyId] = useState("");
  const [transport, setTransport] = useState<TransportFields>(EMPTY_TRANSPORT);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);

  const party = useMemo(() => parties.find((p) => p.id === partyId) ?? null, [parties, partyId]);
  const draftBalance = usePartyBalance(partyId);
  const documentBalance = usePartyBalance(nav.viewing?.partyId ?? "");
  const documentDraft = useMemo(() => (nav.viewing ? buildDraftFromDocument(nav.viewing) : null), [nav.viewing]);
  const shownDraft = documentDraft ?? draft;
  const images = useArticleImages(shownDraft.articles.map((a) => a.article));
  const articleOptions = useMemo(() => listArticleOptions(grid), [grid]);
  const blocker = createBlocker(draft, partyId);
  const articlesReady = draft.lines.length > 0 && draft.errorCount === 0;

  // ── Handlers ──────────────────────────────────────────────────────────────
  const resetDraft = () => {
    clear();
    setPartyId("");
    setTransport(EMPTY_TRANSPORT);
    setSubmitError(null);
    void reloadStock();
  };

  const startNew = () => {
    const dirty = isDirty || Boolean(partyId) || Object.values(transport).some((text) => text.trim() !== "");
    if (dirty && !window.confirm(copy.gatepass.discardDraft)) return;
    resetDraft();
    nav.close();
  };

  const pickArticle = (key: string) => {
    addArticle(key);
    setSubmitError(null);
  };

  const create = async () => {
    if (blocker || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api.createGatepass(
        {
          partyId,
          lines: draft.lines,
          biltyNumber: transport.biltyNumber.trim() || null,
          transportVia: transport.transportVia.trim() || null,
          remarks: transport.remarks.trim() || null,
        },
        { token }
      );

      if (result.accepted) {
        const code = result.code ?? "";
        push("success", copy.gatepass.createdToast(code), copy.gatepass.createdToastBody(result.totalQuantity ?? 0, party?.partyName ?? ""));
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
      if (shortages[0]) expand(rowKeyOf(shortages[0].article, shortages[0].size));
      const message = result.reason ?? copy.gatepass.createFailed;
      setSubmitError({ message, shortages: shortages.length ? shortages : undefined });
      push("error", copy.toast.failed, message);
    } catch {
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
        {draft.articles.map((article) => (
          <ArticleCard
            key={article.key}
            article={article}
            expanded={expandedKey === article.key}
            image={images[article.article]}
            onToggle={() => toggleExpanded(article.key)}
            onRemove={() => removeArticle(article.key)}
            onQuantityChange={(variantId, text) => {
              setQuantity(variantId, text);
              setSubmitError(null);
            }}
            onStep={stepQuantityBy}
          />
        ))}
      </div>
    );
  };

  const renderDraft = () => (
    <div className="gp-work">
      {submitError && (
        <div className="gp-alert gp-alert--error" role="alert" data-testid="gatepass-submit-error">
          <strong>{submitError.message}</strong>
          {submitError.shortages && (
            <ul className="gp-alert-list">
              {submitError.shortages.map((s) => (
                <li key={s.productVariantId}>
                  {s.article} / {s.color} / {s.size} — {copy.gatepass.shortageLine(s)}
                  {s.seen !== null && s.seen !== s.reflected ? ` ${copy.gatepass.youSaw(s.seen)}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <PartySection
        parties={parties}
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
  const summaryParty = viewing ? { partyName: viewing.partyName, partyCode: viewing.partyCode, city: viewing.partyCity } : party;

  return (
    <div className="page gatepass-page gp-compose">
      <header className="gp-topbar">
        <div className="gp-topbar-main">
          <h1 className="page-title" data-testid="gatepass-title">
            {viewing ? `${copy.gatepass.title} ${viewing.code}` : copy.gatepass.title}
          </h1>
          {viewing ? <GatepassStatusBadge status={viewing.status} /> : <GatepassSteps partyDone={Boolean(partyId)} articlesDone={articlesReady} />}
        </div>
        <div className="gp-topbar-actions">
          <GatepassNavigator current={viewing?.gatepassNumber ?? null} latest={nav.latest} busy={nav.busy} onGo={(n) => void nav.goTo(n)} onNew={nav.close} />
          <button type="button" className="btn btn-secondary" onClick={startNew} data-testid="gatepass-new">
            + New Gatepass
          </button>
          {viewing ? (
            <>
              <button type="button" className="btn btn-secondary" onClick={() => onNavigate("gatepass-list", viewing.id)}>
                {copy.gatepass.openInList}
              </button>
              <button type="button" className="btn btn-primary" onClick={printViewing} data-testid="gatepass-print">
                🖨 {copy.gatepass.printGatepass}
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => void create()} disabled={Boolean(blocker) || submitting} data-testid="gatepass-create">
              {submitting ? copy.gatepass.creating : copy.gatepass.createGatepass}
            </button>
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
