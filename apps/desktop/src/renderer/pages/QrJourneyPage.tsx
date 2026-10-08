import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { QrDetail, QrJourney, QrJourneyStep, QrJourneyStepKind, QrPlace, QrSearchRow } from "../types/desktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { qrStageMeta } from "../utils/qrLifecycle";
import { formatDateTime as formatDateTimeCentral } from "../utils/dates";
import { QrDetailDrawer } from "./QrManagementPage";
import { copy } from "../config/copy";

// QR Journey — the whole path one code has taken, hop by hop.
//
//   scan or search a code → see every station it passed through, in order
//
// Where QR Management answers "what is this code now?", this page answers "how did it get
// here?": generated → produced → into the store → out to the gate → back in → out again →
// dispatched → returned → into the store… Every hop is derived by the database from the
// registry row and the append-only event log (erp:get-qr-journey); nothing here is
// editable and nothing is stored separately.

const SEARCH_LIMIT = 25;
const SEARCH_DEBOUNCE_MS = 250;
const RECENT_LIMIT = 8;

// ─── Vocabulary ─────────────────────────────────────────────────────────────

/** What each hop is called and which station produced it. */
const STEP_META: Record<QrJourneyStepKind, { label: string; station: string; tone: string }> = {
  REGISTERED: { label: "Generated", station: "QR Generator", tone: "generated" },
  VOID: { label: "Voided", station: "QR Management", tone: "off" },
  PRODUCED: { label: "Produced", station: "Live Production", tone: "produced" },
  STORE_ENTRY: { label: "Moved in to store", station: "Store — Move In", tone: "store" },
  STORE_EXIT: { label: "Moved out to gate", station: "Store — Move Out", tone: "gate" },
  DISPATCHED: { label: "Dispatched", station: "Dispatch Scanning", tone: "dispatched" },
  RETURNED: { label: "Returned", station: "Return Scanning", tone: "returned" },
  DAMAGED: { label: "Marked damaged", station: "QR Management", tone: "off" },
  SOLD: { label: "Sold", station: "Billing", tone: "dispatched" },
  MOVED: { label: "Moved", station: "Scanner", tone: "store" },
  PACKED: { label: "Packed", station: "Scanner", tone: "produced" },
  ADJUSTMENT: { label: "Adjustment", station: "Scanner", tone: "off" },
};

/**
 * A raw material packet passes through the same two hops, but they mean something else:
 * it is received from a supplier rather than moved in off the factory floor, and it is
 * issued to the section that consumes it rather than moved out to the gate. Saying "to
 * gate" on a packet would be plainly wrong, so the raw-material wording overrides it.
 */
const RAW_MATERIAL_STEP_META: Partial<Record<QrJourneyStepKind, { label: string; station: string; tone: string }>> = {
  STORE_ENTRY: { label: "Received into store", station: "Raw Material Input", tone: "store" },
  STORE_EXIT: { label: "Issued", station: "Raw Material Output", tone: "gate" },
  REGISTERED: { label: "Generated", station: "Raw Material QR Generator", tone: "generated" },
};

const stepMetaFor = (kind: QrJourneyStepKind, journeyKind: "CARTON" | "RAW_MATERIAL" | undefined) =>
  (journeyKind === "RAW_MATERIAL" ? RAW_MATERIAL_STEP_META[kind] : undefined) ?? STEP_META[kind];

const PLACE_LABELS: Record<QrPlace, string> = {
  FACTORY: "Factory floor",
  WAREHOUSE: "Store",
  GATE: "Gate",
  CUSTOMER: "With customer",
};
const placeLabel = (place: QrPlace | null | undefined): string => (place ? PLACE_LABELS[place] : "—");

/** The status vocabulary QR Management already uses, so both pages say the same thing. */
const statusLabel = (status: string | null | undefined): string => (status ? qrStageMeta(status).label : "—");
const statusShort = (status: string | null | undefined): string => (status ? qrStageMeta(status).short : "—");

/** Kinds that get a tally in the summary, in the order they are shown. */
const COUNTED_KINDS: QrJourneyStepKind[] = ["PRODUCED", "STORE_ENTRY", "STORE_EXIT", "DISPATCHED", "RETURNED", "DAMAGED", "SOLD", "VOID"];
const COUNT_LABELS: Record<QrJourneyStepKind, string> = {
  REGISTERED: "Generated",
  VOID: "Voided",
  PRODUCED: "Produced",
  STORE_ENTRY: "Moved in",
  STORE_EXIT: "Moved out",
  DISPATCHED: "Dispatched",
  RETURNED: "Returned",
  DAMAGED: "Damaged",
  SOLD: "Sold",
  MOVED: "Moved",
  PACKED: "Packed",
  ADJUSTMENT: "Adjusted",
};

/** Statuses whose dwell time is worth showing, in lifecycle order. */
const DWELL_ORDER = ["REGISTERED", "PRODUCED", "WAREHOUSE", "TO_GATE", "DISPATCHED", "ON_GATE", "RETURNED", "DAMAGED", "SCRAPPED", "VOID"];

// ─── Formatting ──────────────────────────────────────────────────────────────

const formatDateTime = (iso: string | null | undefined): string => formatDateTimeCentral(iso, iso ?? "—");

/** "3 min", "2 h 15 min", "4 d 6 h" — coarse on purpose; this is a story, not a stopwatch. */
export const formatDuration = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "< 1 min";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
  if (hours > 0) return mins > 0 ? `${hours} h ${mins} min` : `${hours} h`;
  return `${mins} min`;
};

const productLabel = (j: { article: string; color: string; size: string }) => [j.article, j.color, j.size].filter(Boolean).join(" · ") || "—";

// ─── Icons ───────────────────────────────────────────────────────────────────

const SearchIcon: React.FC = () => (
  <svg className="search-icon" width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <path
      fillRule="evenodd"
      d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
      clipRule="evenodd"
    />
  </svg>
);

const RouteIcon: React.FC = () => (
  <svg width="44" height="44" viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <circle cx="10" cy="12" r="4" stroke="currentColor" strokeWidth="2.4" />
    <circle cx="38" cy="36" r="4" stroke="currentColor" strokeWidth="2.4" />
    <path d="M14 12h12a6 6 0 0 1 6 6v0a6 6 0 0 1-6 6H20a6 6 0 0 0-6 6v0a6 6 0 0 0 6 6h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
);

// ─── Sub-components ──────────────────────────────────────────────────────────

const StageBadge: React.FC<{ stage: string; label?: string | null }> = ({ stage, label }) => {
  const meta = qrStageMeta(stage);
  return (
    <span className={`badge ${meta.badge}`} title={meta.hint}>
      {label ?? meta.label}
    </span>
  );
};

/** The whole path in one line: every status the code has been in, in order, last one current. */
const PathStrip: React.FC<{ steps: QrJourneyStep[]; journeyKind?: "CARTON" | "RAW_MATERIAL" }> = ({ steps, journeyKind }) => (
  <ol className="qrj-path" aria-label="Path">
    {steps.map((step, idx) => {
      const meta = stepMetaFor(step.kind, journeyKind);
      const isLast = idx === steps.length - 1;
      return (
        <li key={step.id} className={`qrj-path-hop qrj-tone--${meta.tone}${isLast ? " is-current" : ""}`} title={`${meta.label} · ${formatDateTime(step.occurredAt)}`}>
          <span className="qrj-path-index" aria-hidden="true">
            {step.index}
          </span>
          <span className="qrj-path-label">{step.toStatusLabel ?? statusShort(step.toStatus)}</span>
          {!isLast && (
            <span className="qrj-path-arrow" aria-hidden="true">
              →
            </span>
          )}
        </li>
      );
    })}
  </ol>
);

const StatTile: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode; testId?: string }> = ({ label, value, sub, testId }) => (
  <div className="qrj-stat">
    <span className="qrj-stat-label">{label}</span>
    <span className="qrj-stat-value" data-testid={testId}>
      {value}
    </span>
    {sub && <span className="qrj-stat-sub">{sub}</span>}
  </div>
);

const DwellCard: React.FC<{ dwellMs: Record<string, number>; currentStatus: string | null }> = ({ dwellMs, currentStatus }) => {
  const rows = DWELL_ORDER.filter((s) => (dwellMs[s] ?? 0) > 0).map((s) => ({ status: s, ms: dwellMs[s] }));
  const max = rows.reduce((m, r) => Math.max(m, r.ms), 0) || 1;
  return (
    <section className="card qrj-card" aria-label="Time spent">
      <div className="card-header">
        <h2 className="card-title">Time spent</h2>
        <span className="text-muted qrj-card-note">by status · current counts up to now</span>
      </div>
      {rows.length === 0 ? (
        <p className="qrj-empty-note">No time recorded yet.</p>
      ) : (
        <ul className="qrj-dwell">
          {rows.map((r) => (
            <li key={r.status} className={`qrj-dwell-row${r.status === currentStatus ? " is-current" : ""}`}>
              <span className="qrj-dwell-bar" aria-hidden="true" style={{ width: `${Math.max((r.ms / max) * 100, 6)}%` }} />
              <span className="qrj-dwell-label">{statusLabel(r.status)}</span>
              <strong className="qrj-dwell-value">{formatDuration(r.ms)}</strong>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const CountsCard: React.FC<{ counts: QrJourney["counts"] }> = ({ counts }) => {
  const rows = COUNTED_KINDS.filter((k) => (counts[k] ?? 0) > 0);
  return (
    <section className="card qrj-card" aria-label="Hops by kind">
      <div className="card-header">
        <h2 className="card-title">Hops by kind</h2>
        <span className="text-muted qrj-card-note">how many times each happened</span>
      </div>
      {rows.length === 0 ? (
        <p className="qrj-empty-note">Only generated so far — no scans yet.</p>
      ) : (
        <ul className="qrj-counts">
          {rows.map((k) => (
            <li key={k} className={`qrj-count qrj-tone--${STEP_META[k].tone}`}>
              <strong>{(counts[k] ?? 0).toLocaleString()}×</strong> {COUNT_LABELS[k]}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const JourneySteps: React.FC<{ steps: QrJourneyStep[]; journeyKind?: "CARTON" | "RAW_MATERIAL" }> = ({ steps, journeyKind }) => (
  <ol className="qrj-steps" aria-label="Journey">
    {steps.map((step, idx) => {
      const meta = stepMetaFor(step.kind, journeyKind);
      const heading = step.toStatusLabel ?? meta.label;
      const isLast = idx === steps.length - 1;
      const who = [step.actor, step.workstation, step.deviceId].filter(Boolean).join(" · ");
      const placeChanged = step.fromPlace !== step.toPlace;
      return (
        <li key={step.id} className={`qrj-step qrj-tone--${meta.tone}${isLast ? " is-current" : ""}`} data-testid="journey-step">
          <span className="qrj-step-index" aria-hidden="true">
            {step.index}
          </span>
          <div className="qrj-step-body">
            <div className="qrj-step-head">
              <div className="qrj-step-title">
                <strong>{heading}</strong>
                <span className="qrj-step-station">{meta.station}</span>
              </div>
              <div className="qrj-step-when">
                <span>{formatDateTime(step.occurredAt)}</span>
                {step.sinceMs !== null && <span className="qrj-step-since">+{formatDuration(step.sinceMs)}</span>}
              </div>
            </div>
            <div className="qrj-step-transition" aria-label={copy.scanning.statusChange}>
              {step.fromStatus ? (
                <>
                  <span>{statusLabel(step.fromStatus)}</span>
                  <span className="qrj-arrow" aria-hidden="true">
                    →
                  </span>
                </>
              ) : null}
              <strong>{step.toStatusLabel ?? statusLabel(step.toStatus)}</strong>
              {step.toPlace && (
                <span className="qrj-step-place">
                  {placeChanged && step.fromPlace ? `${placeLabel(step.fromPlace)} → ${placeLabel(step.toPlace)}` : `at ${placeLabel(step.toPlace)}`}
                </span>
              )}
            </div>
            {(who || step.factory) && (
              <div className="qrj-step-meta">
                {who ? `by ${who}` : ""}
                {who && step.factory ? " · " : ""}
                {step.factory ?? ""}
              </div>
            )}
            {step.note && <div className="qrj-step-note">“{step.note}”</div>}
          </div>
        </li>
      );
    })}
  </ol>
);

// ─── Page ────────────────────────────────────────────────────────────────────

interface QrJourneyPageProps {
  username?: string;
}

export const QrJourneyPage: React.FC<QrJourneyPageProps> = ({ username }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<QrSearchRow[]>([]);
  const [suggestionsFor, setSuggestionsFor] = useState("");
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [notFound, setNotFound] = useState<string | null>(null);

  const [journey, setJourney] = useState<QrJourney | null>(null);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);

  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<QrDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const latestSearch = useRef(0);

  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // ── Lookup ──
  /** Traces one code. Returns false (and reports nothing) when it is not registered. */
  const openJourney = useCallback(
    async (qrId: string): Promise<boolean> => {
      const id = qrId.trim().toUpperCase();
      if (!id) return false;
      ++latestSearch.current; // cancel any in-flight suggestion search
      setSuggestOpen(false);
      setLoading(true);
      try {
        const found = await api.getQrJourney(id);
        if (!found) return false;
        setNotFound(null);
        setJourney(found);
        setQuery("");
        setRecent((prev) => [found.qrId, ...prev.filter((x) => x !== found.qrId)].slice(0, RECENT_LIMIT));
        return true;
      } catch (error) {
        push("error", "Lookup failed", error instanceof Error && error.message ? error.message : "Could not trace this code");
        return false;
      } finally {
        setLoading(false);
        searchInputRef.current?.focus();
      }
    },
    [api, push]
  );

  const runSearch = useCallback(
    async (rawQuery: string) => {
      const q = rawQuery.trim();
      const ticket = ++latestSearch.current;
      if (!q) {
        setSuggestions([]);
        setSuggestionsFor("");
        setSuggestOpen(false);
        return;
      }
      setSearching(true);
      try {
        const rows = await api.searchQrCodes(q, SEARCH_LIMIT);
        if (ticket !== latestSearch.current) return;
        setSuggestions(rows);
        setSuggestionsFor(q);
        setSuggestOpen(true);
      } catch {
        if (ticket === latestSearch.current) {
          setSuggestions([]);
          setSuggestionsFor("");
          setSuggestOpen(false);
        }
      } finally {
        if (ticket === latestSearch.current) setSearching(false);
      }
    },
    [api]
  );

  useEffect(() => {
    setNotFound(null);
    const handle = window.setTimeout(() => void runSearch(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query, runSearch]);

  // Enter (or a handheld scanner, which types the code and presses Enter) traces the exact
  // code straight away. Failing that, a suggestion computed for this very input is used —
  // an exact match, or the only one. Anything else is reported, never created.
  const submitSearch = async () => {
    const raw = query.trim();
    const q = raw.toUpperCase();
    if (!q) return;
    if (await openJourney(q)) return;
    const fresh = suggestionsFor === raw ? suggestions : [];
    const exact = fresh.find((r) => r.qrId === q);
    if (exact && (await openJourney(exact.qrId))) return;
    if (fresh.length === 1 && (await openJourney(fresh[0].qrId))) return;
    setSuggestOpen(false);
    setNotFound(q);
  };

  // ── Details drawer (the QR Management one, read-only) ──
  const openDetail = useCallback(async () => {
    if (!journey) return;
    setDetailOpen(true);
    setDetail(null);
    setDetailLoading(true);
    try {
      setDetail(await api.getQrDetail(journey.qrId));
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, [api, journey]);

  const closeDetail = useCallback(() => {
    setDetailOpen(false);
    setDetail(null);
    searchInputRef.current?.focus();
  }, []);

  // While the drawer is open, Escape closes it instead of navigating to Dashboard.
  useEffect(() => {
    if (!detailOpen) return;
    const sentinel = document.createElement("div");
    sentinel.setAttribute("data-suppress-esc", "1");
    sentinel.style.display = "none";
    document.body.appendChild(sentinel);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".qrm-drawer-backdrop .member-modal")) closeDetail();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      sentinel.remove();
      window.removeEventListener("keydown", onKey);
    };
  }, [detailOpen, closeDetail]);

  // ── Derived ──
  const age = useMemo(() => {
    if (!journey?.registeredAt) return null;
    return new Date(journey.asOf).getTime() - new Date(journey.registeredAt).getTime();
  }, [journey]);
  const inStoreNow = journey?.currentStatus === "WAREHOUSE";
  const storeVisits = journey?.counts.STORE_ENTRY ?? 0;

  return (
    <div className="page qr-journey-page">
      <div className="page-header qrm-page-header">
        <h1>QR Journey</h1>
        <form
          className="qrm-lookup"
          onSubmit={(e) => {
            e.preventDefault();
            void submitSearch();
          }}
        >
          <div className="search-wrap qrm-search">
            <SearchIcon />
            <input
              ref={searchInputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => suggestions.length > 0 && setSuggestOpen(true)}
              onBlur={() => window.setTimeout(() => setSuggestOpen(false), 150)}
              placeholder="Trace a QR — scan a label, paste a code, or type SK6 RED 000037"
              aria-label="Trace QR"
              autoComplete="off"
              spellCheck={false}
            />
            {(searching || loading) && <span className="qrm-lookup-spinner text-muted">…</span>}
          </div>
          {suggestOpen && query.trim() && !notFound && (
            <div className="qrm-suggest" role="listbox" aria-label="Matching codes">
              {suggestions.length === 0 ? (
                <div className="qrm-suggest-empty">No registered code matches “{query.trim()}”</div>
              ) : (
                <>
                  {suggestions.map((row) => (
                    <button
                      key={row.qrId}
                      type="button"
                      role="option"
                      aria-selected={false}
                      className="qrm-suggest-row"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => void openJourney(row.qrId)}
                    >
                      <code className="qrm-code">{row.qrId}</code>
                      <StageBadge stage={row.stage} />
                    </button>
                  ))}
                  {suggestions.length >= SEARCH_LIMIT && <div className="qrm-suggest-empty">First {SEARCH_LIMIT} matches — keep typing to narrow down.</div>}
                </>
              )}
            </div>
          )}
          {notFound && (
            <div className="qrm-lookup-notfound" role="alert">
              <strong>QR NOT FOUND</strong>
              <span>
                <code className="qrm-code">{notFound}</code> is not registered, so it has no journey. Only codes generated in the QR Generator exist.
              </span>
            </div>
          )}
        </form>
      </div>

      {recent.length > 1 && (
        <div className="qrj-recent" aria-label="Recently traced">
          <span className="qrj-recent-label">Recently traced</span>
          {recent.map((id) => (
            <button
              key={id}
              type="button"
              className={`qrj-recent-chip${journey?.qrId === id ? " is-active" : ""}`}
              onClick={() => void openJourney(id)}
              title="Trace again"
            >
              <code>{id}</code>
            </button>
          ))}
        </div>
      )}

      {!journey ? (
        <div className="card qrj-welcome">
          <div className="qrj-welcome-icon">
            <RouteIcon />
          </div>
          <h2>Trace a code's whole path</h2>
          <p>
            Every station a carton passes through is recorded against its QR. Scan or search a code above to see that path in order — generated, produced, into the store, out to
            the gate, back in, dispatched, returned — with who did each step and how long the carton waited between them.
          </p>
          <ol className="qrj-path qrj-path--example" aria-hidden="true">
            {["Generated", "Production", "In Store", "To Gate", "In Store", "To Gate", "Dispatched", "Returned", "In Store"].map((label, idx, all) => (
              <li key={`${label}-${idx}`} className="qrj-path-hop qrj-tone--example">
                <span className="qrj-path-label">{label}</span>
                {idx < all.length - 1 && (
                  <span className="qrj-path-arrow" aria-hidden="true">
                    →
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <>
          {/* ── Identity + where it stands now ─────────────────────────────── */}
          <section className="card qrj-hero" aria-label={copy.columns.code}>
            <div className="qrj-hero-main">
              <div className="qrj-hero-id">
                <span className="qrj-hero-product" data-testid="journey-product">
                  {productLabel(journey)}
                </span>
                <code className="qrj-hero-code" data-testid="journey-code">
                  {journey.qrId}
                </code>
              </div>
              <div className="qrj-hero-now" aria-label={copy.scanning.currentStatus}>
                <StageBadge stage={journey.stage} label={journey.stageLabel} />
                <span className="qrj-hero-place" data-testid="journey-place">
                  {journey.currentPlace ? `at ${placeLabel(journey.currentPlace)}` : "no physical unit yet"}
                </span>
              </div>
            </div>
            <div className="qrj-hero-stats">
              <StatTile label="Hops" value={journey.steps.length.toLocaleString()} sub={`serial ${journey.serial}`} testId="journey-hops" />
              <StatTile label="Generated" value={formatDateTime(journey.registeredAt)} sub={age !== null ? `${formatDuration(age)} ago` : undefined} />
              <StatTile label="First scanned" value={formatDateTime(journey.firstScannedAt)} sub={journey.firstScannedAt ? "Live Production" : "not yet produced"} />
              <StatTile label="Last activity" value={formatDateTime(journey.lastActivityAt)} sub={stepMetaFor(journey.steps[journey.steps.length - 1]?.kind ?? "REGISTERED", journey.kind).label} />
              <StatTile
                label="Store visits"
                value={storeVisits.toLocaleString()}
                sub={inStoreNow ? "in the store now" : storeVisits > 0 ? `${(journey.counts.STORE_EXIT ?? 0).toLocaleString()} moved out` : "never entered the store"}
              />
            </div>
            <div className="qrj-hero-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void openDetail()}>
                Full details
              </button>
            </div>
          </section>

          {/* ── The path in one line ───────────────────────────────────────── */}
          <section className="card qrj-card qrj-path-card" aria-label="Path so far">
            <div className="card-header">
              <h2 className="card-title">Path so far</h2>
              <span className="text-muted qrj-card-note">every status in order · last is now</span>
            </div>
            <PathStrip steps={journey.steps} journeyKind={journey.kind} />
          </section>

          <div className="qrj-side-by-side">
            <DwellCard dwellMs={journey.dwellMs} currentStatus={journey.currentStatus} />
            <CountsCard counts={journey.counts} />
          </div>

          {/* ── Every hop, in full ─────────────────────────────────────────── */}
          <section className="card qrj-card" aria-label="Journey, step by step">
            <div className="card-header">
              <h2 className="card-title">Step by step</h2>
              <span className="text-muted qrj-card-note">oldest first · elapsed time is since the previous step</span>
            </div>
            <JourneySteps steps={journey.steps} journeyKind={journey.kind} />
          </section>
        </>
      )}

      {detailOpen && journey && (
        <QrDetailDrawer
          qrId={journey.qrId}
          detail={detail}
          loading={detailLoading}
          username={username}
          readOnly
          onClose={closeDetail}
          onChanged={async () => {
            await openDetail();
          }}
        />
      )}
    </div>
  );
};
