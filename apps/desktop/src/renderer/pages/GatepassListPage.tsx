import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppRoute } from "../app/routes";
import { useDesktopApi } from "../hooks/useDesktopApi";
import { useNotifications } from "../state/NotificationsContext";
import type { Gatepass, GatepassJourneyStep, GatepassListRow, GatepassStatus, Party } from "../types/desktopApi";
import { GATEPASS_STAGES, gatepassStage, PERMISSION } from "@erp/domain";
import { GatepassJourney } from "../features/gatepass/GatepassJourney";
import { GatepassDeliveryProof } from "../features/gatepass/GatepassDeliveryProof";
import { buildDocumentGrid } from "../utils/gatepassGrid";
import { formatGatepassDate, formatGatepassDateTime, openGatepassPrintWindow } from "../utils/gatepassPrint";
import { copy } from "../config/copy";
import { GatepassStatusBadge as StatusBadge } from "../features/gatepass/GatepassStatusBadge";
import { describeMoveOutProgress } from "../features/gatepass/GatepassDocumentHead";
import { StateView } from "../components/shared/StateView";

// Gatepass List — every gatepass, newest first, with the document opened in place.
//
// The tabs across the top are the operational queues: there is one Gatepass and one status,
// and a stage is simply a filter on it — never a separate record. The counts come from one
// grouped query, and a user lands on the queue their permissions say they work.
//
// Search by number or party; filter by party, article, date and status. A cancelled
// gatepass stays in the list with its badge: the history is never deleted. The detail shows
// exactly what was cut, who prepared it and — if so — who cancelled it and why. There is no
// scan count here on purpose: nothing in the scanning flow references a gatepass yet, and a
// number that is not derived from real scan events would be a guess.

const PAGE_SIZE = 25;

/**
 * The queues, in journey order, then everything. Built from the domain's stage model rather
 * than listed again here, so adding a stage changes one file.
 */
type StageFilter = GatepassStatus | "ALL";
const STAGE_TABS: ReadonlyArray<{ key: string; label: string; status: StageFilter }> = [
  ...GATEPASS_STAGES.filter((stage) => stage.pending).map((stage) => ({
    key: stage.status,
    label: stage.label,
    status: stage.status as StageFilter,
  })),
  { key: "ALL", label: "All", status: "ALL" as StageFilter },
];

/**
 * The queue this user works, so Gatepass opens on their own pile rather than on everything.
 * It only chooses where to land — every tab stays reachable, because seeing the rest of the
 * journey is how an operator answers a question about a document that is no longer theirs.
 */
export const defaultStageFor = (permissions: readonly string[], isAdmin: boolean): StageFilter => {
  // Someone who works every desk has no one desk to open on, so they get the whole list.
  // An administrator holds every permission, which would otherwise land them on the first
  // queue in the journey — usually empty, and never the one they went looking for.
  if (isAdmin) return "ALL";
  // The Munshi issues the documents and follows all of them, so the whole list is their pile.
  // Their only gatepass permission is the plain one, which also gates the Pending Builties
  // queue — without this they would open on a desk they do not work, usually empty.
  if (permissions.includes(PERMISSION.MUNSHI)) return "ALL";
  const mine = GATEPASS_STAGES.filter((stage) => stage.pending && stage.permission && permissions.includes(stage.permission));
  return mine.length === 1 ? (mine[0]!.status as StageFilter) : "ALL";
};
const PARTY_PAGE_SIZE = 1000;

interface GatepassListPageProps {
  /** The signed-in user's effective permissions, used only to pick which queue opens first. */
  permissions?: readonly string[];
  /** Administrators work every desk, so they open on the whole list rather than one queue. */
  isAdmin?: boolean;
  token: string;
  username: string;
  /** Whether the signed-in user may cancel (admin or the gatepass-cancel permission). */
  canCancel: boolean;
  /** Open this document straight away (e.g. right after creating it). */
  initialGatepassId?: string;
  onNavigate: (route: AppRoute, id?: string) => void;
}

export const GatepassListPage: React.FC<GatepassListPageProps> = ({ token, username, canCancel, permissions = [], isAdmin = false, initialGatepassId, onNavigate }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [search, setSearch] = useState("");
  const [partyId, setPartyId] = useState("");
  const [article, setArticle] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [status, setStatus] = useState<StageFilter>(() => (initialGatepassId ? "ALL" : defaultStageFor(permissions, isAdmin)));
  const [page, setPage] = useState(1);

  const [rows, setRows] = useState<GatepassListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** Bumped when the open document changes underneath the screen, to re-read it and its journey. */
  const [detailVersion, setDetailVersion] = useState(0);
  const [stageCounts, setStageCounts] = useState<Record<string, number>>({});
  const [journey, setJourney] = useState<GatepassJourneyStep[] | null>(null);
  const [journeyLoading, setJourneyLoading] = useState(false);
  const [journeyError, setJourneyError] = useState<string | null>(null);

  const [parties, setParties] = useState<Party[]>([]);
  const [articles, setArticles] = useState<string[]>([]);

  const [selectedId, setSelectedId] = useState<string | undefined>(initialGatepassId);
  const [detail, setDetail] = useState<Gatepass | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // Debounced search text so typing does not fire a query per keystroke.
  const [searchTerm, setSearchTerm] = useState("");
  useEffect(() => {
    const handle = window.setTimeout(() => setSearchTerm(search.trim()), 250);
    return () => window.clearTimeout(handle);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [searchTerm, partyId, article, fromDate, toDate, status]);

  // ── Filter options ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.listParties({ page: 1, pageSize: PARTY_PAGE_SIZE, sortBy: "party_name", sortOrder: "ASC" });
        if (!cancelled) setParties(result.rows ?? []);
      } catch {
        /* the party filter simply stays empty */
      }
      try {
        const result = await api.listUniqueArticles();
        if (!cancelled) setArticles(result ?? []);
      } catch {
        /* the article filter simply stays empty */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  // ── List ───────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await api.listGatepasses(
        {
          search: searchTerm,
          partyId: partyId || undefined,
          article: article || undefined,
          fromDate: fromDate || undefined,
          toDate: toDate || undefined,
          status,
          page,
          pageSize: PAGE_SIZE,
        },
        { token }
      );
      setRows(result.rows ?? []);
      setTotal(result.total ?? 0);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : copy.states.loadFailedBody);
      push("error", "Gatepasses could not be loaded", "Try again.");
    } finally {
      setLoading(false);
    }
  }, [api, token, searchTerm, partyId, article, fromDate, toDate, status, page, push]);

  useEffect(() => {
    void load();
  }, [load]);

  // Counts follow the list: after billing a document or scanning one out, the queue it left
  // and the queue it joined are both refreshed by the same reload the list already does.
  const loadCounts = useCallback(async () => {
    try {
      setStageCounts(await api.countGatepassesByStage({ token }));
    } catch {
      /* the tabs simply show no number */
    }
  }, [api, token]);

  useEffect(() => {
    void loadCounts();
  }, [loadCounts, rows]);

  // ── Detail ─────────────────────────────────────────────────────────────────
  // The initial id comes from whichever page sent us here; if it is not a gatepass (stale
  // selection from another module) we simply show the list rather than an error.
  const initialIdRef = useRef(initialGatepassId);
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    void (async () => {
      try {
        const doc = await api.getGatepass(selectedId, { token });
        if (cancelled) return;
        setDetail(doc);
        if (!doc) {
          if (selectedId === initialIdRef.current) {
            setSelectedId(undefined);
          } else {
            push("error", "Gatepass not found", "It may have been removed or you may not have access.");
          }
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, token, selectedId, detailVersion, push]);

  useEffect(() => {
    if (!selectedId) {
      setJourney(null);
      setJourneyError(null);
      return;
    }
    let cancelled = false;
    setJourneyLoading(true);
    setJourneyError(null);
    void (async () => {
      try {
        const steps = await api.getGatepassJourney(selectedId, { token });
        if (!cancelled) setJourney(steps);
      } catch (error) {
        if (!cancelled) setJourneyError(error instanceof Error ? error.message : copy.states.loadFailedBody);
      } finally {
        if (!cancelled) setJourneyLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, token, selectedId, detailVersion, detail]);

  const openDetail = (id: string) => {
    setSelectedId(id);
    setCancelOpen(false);
    setCancelReason("");
    setCancelError(null);
  };

  const closeDetail = () => {
    setSelectedId(undefined);
    setDetail(null);
    setCancelOpen(false);
  };

  const print = () => {
    if (!detail) return;
    if (!openGatepassPrintWindow(detail)) push("error", copy.toast.popupBlocked, "Allow popups to print the Gatepass.");
  };

  const confirmCancel = async () => {
    if (!detail || cancelling) return;
    const reason = cancelReason.trim();
    if (!reason) {
      setCancelError("Give a reason for cancelling this Gatepass.");
      return;
    }
    setCancelling(true);
    setCancelError(null);
    try {
      const result = await api.cancelGatepass({ gatepassId: detail.id, reason }, { token });
      if (!result.accepted) {
        setCancelError(result.reason ?? "The Gatepass could not be cancelled.");
        return;
      }
      // Say what the cancellation freed and what it could not: cartons already moved out stay out.
      push(
        "success",
        `Gatepass ${result.code ?? detail.code} cancelled`,
        `by ${username} · ${result.releasedQuantity ?? 0} reserved cartons released` +
          (result.dispatchedFromStoreQuantity ? ` · ${result.dispatchedFromStoreQuantity} already moved out stay moved out` : "")
      );
      setCancelOpen(false);
      setCancelReason("");
      const refreshed = await api.getGatepass(detail.id, { token });
      setDetail(refreshed);
      void load();
    } catch {
      setCancelError("The Gatepass could not be cancelled. Nothing was changed — try again.");
    } finally {
      setCancelling(false);
    }
  };

  const clearFilters = () => {
    setSearch("");
    setPartyId("");
    setArticle("");
    setFromDate("");
    setToDate("");
    setStatus("ALL");
  };

  const activeFilterCount = [partyId, article, fromDate, toDate, status !== "ALL" ? status : ""].filter(Boolean).length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const startIndex = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const endIndex = Math.min(page * PAGE_SIZE, total);
  const partyName = useMemo(() => (id: string) => parties.find((p) => p.id === id)?.partyName ?? "", [parties]);
  /** The document in the book's shape: article + size rows, colour columns. */
  const detailGrid = useMemo(() => (detail ? buildDocumentGrid(detail.lines) : null), [detail]);

  // ── Render ─────────────────────────────────────────────────────────────────
  if (selectedId) {
    return (
      <div className="page gatepass-page">
        <header className="gp-header">
          <div>
            <button type="button" className="gp-back" onClick={closeDetail}>
              ← Gatepass List
            </button>
            <h1 className="page-title gp-detail-title">
              Gatepass {detail?.code ?? ""}
              {detail && <StatusBadge status={detail.status} />}
            </h1>
          </div>
          {detail && (
            <div className="gp-header-side">
              <button type="button" className="btn btn-secondary" onClick={print} data-testid="gatepass-print">
                🖨 Print
              </button>
              {detail.status === "BILLED" ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => onNavigate("gatepass-store-scan", detail.id)}
                  data-testid="gatepass-open-store-scan"
                >
                  Scan out of Store →
                </button>
              ) : null}
              {detail.status === "AT_GATE" ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => onNavigate("gatepass-dispatch-scan", detail.id)}
                  data-testid="gatepass-open-dispatch-scan"
                >
                  Scan for Dispatch →
                </button>
              ) : null}
              {canCancel && detail.status === "CREATED" && (
                <button type="button" className="btn btn-danger" onClick={() => setCancelOpen(true)} data-testid="gatepass-cancel-open">
                  Cancel Gatepass
                </button>
              )}
              <button type="button" className="btn btn-primary" onClick={() => onNavigate("gatepass")}>
                + New Gatepass
              </button>
            </div>
          )}
        </header>

        {detailLoading && !detail ? (
          <div className="loading">Loading gatepass…</div>
        ) : !detail ? (
          <div className="empty-state">This Gatepass could not be found.</div>
        ) : (
          <>
            {detail.status === "CANCELLED" && (
              <div className="gp-alert gp-alert--warn" role="status" data-testid="gatepass-cancelled-banner">
                <strong>Cancelled</strong> {formatGatepassDateTime(detail.cancelledAt)} by {detail.cancelledBy ?? "—"}
                {detail.cancelReason ? ` — ${detail.cancelReason}` : ""}. The lines below are kept for history.
              </div>
            )}

            <section className="card gp-card gp-journey-card" aria-label="Gatepass journey">
              <span className="card-eyebrow">Journey</span>
              <GatepassJourney
                steps={journey}
                loading={journeyLoading}
                error={journeyError}
                onRetry={() => setSelectedId(detail.id)}
                cancelled={detail.status === "CANCELLED"}
              />
            </section>

            <GatepassDeliveryProof
              gatepassId={detail.id}
              status={detail.status}
              token={token}
              onDelivered={async () => {
                // The document, its journey and the stage counts all follow the backend.
                setDetailVersion((version) => version + 1);
                await load();
                await loadCounts();
              }}
            />

            <section className="card gp-card" data-testid="gatepass-detail">
              <div className="gp-review-grid gp-review-grid--wide">
                <div>
                  <span className="card-eyebrow">{copy.columns.party}</span>
                  <strong className="gp-party-name">{detail.partyName}</strong>
                  <span className="gp-party-meta">{[detail.partyCode, detail.partyCity].filter(Boolean).join(" · ")}</span>
                </div>
                <div>
                  <span className="card-eyebrow">{copy.columns.date}</span>
                  <strong>{formatGatepassDate(detail.gatepassDate)}</strong>
                </div>
                <div>
                  <span className="card-eyebrow">Created by</span>
                  <strong>{detail.createdBy ?? "—"}</strong>
                  <span className="gp-party-meta">{formatGatepassDateTime(detail.createdAt)}</span>
                </div>
                <div>
                  <span className="card-eyebrow">Total quantity</span>
                  <strong data-testid="gatepass-detail-total">{detail.totalQuantity} cartons</strong>
                  <span className="gp-party-meta">
                    {detail.lineCount} {detail.lineCount === 1 ? "line" : "lines"}
                  </span>
                </div>
                <div>
                  <span className="card-eyebrow">{copy.gatepass.movedOut}</span>
                  <strong data-testid="gatepass-detail-moved-out">{describeMoveOutProgress(detail)}</strong>
                  <span className="gp-party-meta">
                    {copy.gatepass.outstanding}: {detail.outstandingQuantity}
                  </span>
                </div>
                <div>
                  <span className="card-eyebrow">Bilty No.</span>
                  <strong data-testid="gatepass-detail-bilty">{detail.biltyNumber ?? "—"}</strong>
                </div>
                <div>
                  <span className="card-eyebrow">Via</span>
                  <strong data-testid="gatepass-detail-via">{detail.transportVia ?? "—"}</strong>
                </div>
                {detail.remarks && (
                  <div className="gp-review-span">
                    <span className="card-eyebrow">{copy.columns.remarks}</span>
                    <strong>{detail.remarks}</strong>
                  </div>
                )}
              </div>

              {detailGrid && (
                <div className="gp-grid-scroll">
                  <table className="gp-table gp-grid gp-grid--readonly" data-testid="gatepass-detail-grid">
                    <thead>
                      <tr>
                        <th className="gp-grid-article">{copy.columns.article}</th>
                        <th className="gp-grid-size">{copy.columns.size}</th>
                        {detailGrid.colours.map((colour) => (
                          <th key={colour} className="gp-grid-colour" scope="col">
                            {colour}
                          </th>
                        ))}
                        <th className="num gp-grid-total">{copy.columns.total}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailGrid.rows.map((row) => (
                        <tr key={row.key} className="has-qty">
                          <th scope="row" className="gp-grid-article">
                            {row.article}
                            {row.groupName && <span className="gp-grid-group">{row.groupName}</span>}
                          </th>
                          <td className="gp-grid-size">{row.size}</td>
                          {detailGrid.colours.map((colour) => (
                            <td key={colour} className={`gp-cell num${row.quantities[colour] ? " is-selected" : " gp-cell--none"}`}>
                              {row.quantities[colour] ?? ""}
                            </td>
                          ))}
                          <td className="num gp-grid-total gp-cell-strong">{row.total}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={2}>{copy.columns.total}</td>
                        {detailGrid.colours.map((colour) => (
                          <td key={colour} className="gp-cell num">
                            {detailGrid.columnTotals[colour] ?? ""}
                          </td>
                        ))}
                        <td className="num gp-grid-total">{detailGrid.total}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}

              <details className="gp-line-detail">
                <summary>Line detail — what the store has moved out for each line, and In Store quantity when it was cut</summary>
                <table className="gp-table gp-lines-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>{copy.columns.article}</th>
                      <th>Colour</th>
                      <th>{copy.columns.size}</th>
                      <th className="num">Qty (cartons)</th>
                      <th className="num">{copy.gatepass.movedOut}</th>
                      <th className="num">{copy.gatepass.outstanding}</th>
                      <th className="num text-muted">In Store when cut</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((line) => (
                      <tr key={line.id}>
                        <td className="text-muted">{line.lineNo}</td>
                        <td className="gp-cell-strong">{line.article}{line.groupName && <span className="gp-grid-group">{line.groupName}</span>}</td>
                        <td>{line.color}</td>
                        <td>{line.size}</td>
                        <td className="num">{line.quantity}</td>
                        <td className="num">{line.dispatchedFromStoreQuantity}</td>
                        <td className="num">{line.outstandingQuantity}</td>
                        <td className="num text-muted">{line.storeQuantityAtCreation}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>

              <p className="gp-review-note">
                Reservation document only. Which cartons actually left is recorded by the Store Move Out scanner against this Gatepass and by the gate scanner (see QR Journey for any carton).
              </p>
            </section>

            {cancelOpen && (
              <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !cancelling && setCancelOpen(false)}>
                <div className="modal gp-cancel-modal" role="dialog" aria-modal="true" aria-labelledby="gp-cancel-title">
                  <h2 className="modal-title" id="gp-cancel-title">
                    Cancel {detail.code}?
                  </h2>
                  <p className="modal-sub">
                    The document is marked cancelled and kept for history. Nothing physical changes — the gatepass never moved a carton.
                  </p>
                  <div className="gp-field">
                    <label className="input-label" htmlFor="gp-cancel-reason">
                      Reason
                    </label>
                    <input
                      id="gp-cancel-reason"
                      className={`form-input${cancelError ? " error" : ""}`}
                      type="text"
                      autoFocus
                      value={cancelReason}
                      onChange={(e) => {
                        setCancelReason(e.target.value);
                        setCancelError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void confirmCancel();
                      }}
                      placeholder="e.g. Wrong party, quantity re-issued as GP-000130"
                      maxLength={240}
                    />
                    {cancelError && (
                      <div className="gp-qty-error" role="alert">
                        {cancelError}
                      </div>
                    )}
                  </div>
                  <div className="modal-footer">
                    <button type="button" className="btn btn-secondary" onClick={() => setCancelOpen(false)} disabled={cancelling}>
                      Keep Gatepass
                    </button>
                    <button type="button" className="btn btn-danger" onClick={() => void confirmCancel()} disabled={cancelling} data-testid="gatepass-cancel-confirm">
                      {cancelling ? "Cancelling…" : "Cancel Gatepass"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="page gatepass-page">
      <header className="gp-header">
        <div>
          <span className="card-eyebrow">Gatepass</span>
          <h1 className="page-title">Gatepass List</h1>
          <p className="page-sub">Quantities cut from store stock for parties. Open a gatepass to view, print or cancel it.</p>
        </div>
        <div className="gp-header-side">
          <button type="button" className="btn btn-primary" onClick={() => onNavigate("gatepass")}>
            + New Gatepass
          </button>
        </div>
      </header>

      <nav className="gp-stages" aria-label="Gatepass stages">
        {STAGE_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`gp-stage${status === tab.status ? " is-active" : ""}`}
            aria-pressed={status === tab.status}
            onClick={() => setStatus(tab.status)}
          >
            {tab.label}
            {tab.status !== "ALL" ? <span className="gp-stage-count">{stageCounts[tab.status] ?? 0}</span> : null}
          </button>
        ))}
      </nav>

      <section className="card gp-card gp-filters">
        <div className="gp-field gp-filter-search">
          <label className="input-label" htmlFor="gp-search">{copy.actions.search}</label>
          <input id="gp-search" className="form-input" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Gatepass number or party" />
        </div>
        <div className="gp-field">
          <label className="input-label" htmlFor="gp-filter-party">{copy.columns.party}</label>
          <select id="gp-filter-party" className="form-input" value={partyId} onChange={(e) => setPartyId(e.target.value)}>
            <option value="">All parties</option>
            {parties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.partyName}
              </option>
            ))}
          </select>
        </div>
        <div className="gp-field">
          <label className="input-label" htmlFor="gp-filter-article">{copy.columns.article}</label>
          <select id="gp-filter-article" className="form-input" value={article} onChange={(e) => setArticle(e.target.value)}>
            <option value="">{copy.filters.allArticles}</option>
            {articles.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        <div className="gp-field">
          <label className="input-label" htmlFor="gp-filter-from">
            From
          </label>
          <input id="gp-filter-from" className="form-input" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </div>
        <div className="gp-field">
          <label className="input-label" htmlFor="gp-filter-to">
            To
          </label>
          <input id="gp-filter-to" className="form-input" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
        {/* Status is chosen by the stage tabs above, so there is one control for it, not two. */}
        {(activeFilterCount > 0 || search) && (
          <button type="button" className="btn btn-ghost btn-sm gp-filter-clear" onClick={clearFilters}>{copy.actions.clear}</button>
        )}
      </section>

      <section className="card gp-card gp-list-card">
        <table className="gp-table gp-list-table" data-testid="gatepass-list-table">
          <thead>
            <tr>
              <th>GP No.</th>
              <th>{copy.columns.date}</th>
              <th>{copy.columns.party}</th>
              <th>Articles</th>
              <th className="num">{copy.columns.items}</th>
              <th className="num">{copy.columns.qty}</th>
              <th className="num">{copy.gatepass.movedOut}</th>
              <th>{copy.columns.status}</th>
              <th>Created by</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <tr>
                <td colSpan={9}><StateView kind="loading" compact /></td>
              </tr>
            ) : loadError ? (
              <tr>
                <td colSpan={9}><StateView kind="error" compact message={loadError} onRetry={() => void load()} /></td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={9}>
                  {activeFilterCount > 0 || searchTerm
                    ? <StateView kind="empty" compact title={copy.gatepass.noMatch} />
                    : <StateView kind="empty" compact title={copy.gatepass.emptyTitle} hint={copy.gatepass.emptyHint} />}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  className="gp-list-row"
                  tabIndex={0}
                  onClick={() => openDetail(row.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openDetail(row.id);
                    }
                  }}
                  data-testid={`gatepass-row-${row.code}`}
                >
                  <td className="gp-cell-code">{row.code}</td>
                  <td>{formatGatepassDate(row.gatepassDate)}</td>
                  <td className="gp-cell-strong">{row.partyName}</td>
                  <td>{row.articles.join(", ")}</td>
                  <td className="num">{row.lineCount}</td>
                  <td className="num gp-cell-strong">{row.totalQuantity}</td>
                  <td className="num" data-testid={`gatepass-row-moved-out-${row.code}`}>{row.dispatchedFromStoreQuantity}</td>
                  <td>
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="text-muted">{row.createdBy ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        <div className="gp-pager">
          <span className="pager-info">
            {total === 0 ? "No gatepasses" : `Showing ${startIndex}–${endIndex} of ${total}`}
            {partyId && partyName(partyId) ? ` · ${partyName(partyId)}` : ""}
          </span>
          <div className="gp-pager-controls">
            <button type="button" className="btn btn-secondary btn-sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              ‹ Prev
            </button>
            <span className="gp-pager-page">
              Page {page} of {totalPages}
            </span>
            <button type="button" className="btn btn-secondary btn-sm" disabled={page >= totalPages || loading} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
              Next ›
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};
