import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type {
  QrBatchMemberRow,
  QrDetail,
  QrGenerationFilterOptions,
  QrGenerationGroup,
  QrGenerationOverview,
  QrSearchRow,
  QrStage,
  QrStageCounts,
} from "../types/desktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { QrPreview, openCartonLabelPrintWindow, openRawMaterialLabelPrintWindow } from "../utils/qrLabels";
import { materialLabelAttributes, formatQuantity, type InventoryItemRow } from "../features/rawMaterial/rawMaterial";
import {
  lifecycleRailFor,
  QR_OFF_RAIL_STAGES,
  orderedStageCounts,
  qrStageMeta,
  railIndexOf,
} from "../utils/qrLifecycle";
import {
  formatDate as formatDateCentral,
  formatDateTime as formatDateTimeCentral,
  formatTime as formatTimeCentral,
} from "../utils/dates";
import { copy } from "../config/copy";

// QR Management is a read/audit surface over the registry (qr_codes), the live unit
// (qr_master) and the event log (production_events). Every filter, grouping and count is
// computed by the database; this page only asks for one screen of results at a time.

const SEARCH_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 250;
const GROUP_PAGE_SIZE = 25;
const MEMBER_PAGE_SIZE = 100;

const EVENT_LABELS: Record<string, string> = {
  PRODUCED: "Production scan (+IN)",
  MOVED: "Moved",
  STORE_ENTRY: "Store entry (In Store)",
  STORE_EXIT: "Store move out (To Gate)",
  PACKED: "Packed",
  DISPATCHED: "Dispatched",
  RETURNED: "Returned",
  DAMAGED: "Marked damaged",
  SOLD: "Sold",
  ADJUSTMENT: "Adjustment",
};

// ─── Date helpers ───────────────────────────────────────────────────────────────
// Filter days are local calendar days on this machine (never UTC days), matching how the
// database interprets them and how the dashboard bounds "today".

const toLocalYmd = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const daysAgoYmd = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return toLocalYmd(d);
};

// Display goes through the central formatters (business timezone); an unparseable value is
// shown as-is so a bad timestamp is visible rather than hidden behind a dash.
const formatDate = (iso: string): string => formatDateCentral(iso, iso);

const formatTime = (iso: string): string => formatTimeCentral(iso, "");

const formatDateTime = (iso: string): string => formatDateTimeCentral(iso, iso);

/** A plain `YYYY-MM-DD` filter day is a calendar day, not an instant. */
const formatYmd = (ymd: string): string =>
  /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? formatDateCentral(`${ymd}T00:00:00`, ymd) : ymd;

const pad6 = (n: number) => String(n).padStart(6, "0");

// ─── Small presentational pieces ────────────────────────────────────────────────

const SearchIcon: React.FC = () => (
  <svg className="search-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <path
      fillRule="evenodd"
      d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
      clipRule="evenodd"
    />
  </svg>
);

const StageBadge: React.FC<{ stage: QrStage | string; title?: string }> = ({ stage, title }) => {
  const meta = qrStageMeta(stage);
  return (
    <span className={`badge ${meta.badge}`} title={title ?? meta.hint}>
      {meta.label}
    </span>
  );
};

/** "30 Production · 15 In Store · 5 Generated" — compact tallies for a range row. */
const StageSummaryInline: React.FC<{ counts: QrStageCounts }> = ({ counts }) => {
  const entries = orderedStageCounts(counts);
  if (entries.length === 0) return <span className="text-muted">—</span>;
  return (
    <span className="qrm-stage-inline">
      {entries.map(({ stage, count }) => {
        const meta = qrStageMeta(stage);
        return (
          <span key={stage} className={`qrm-stage-chip qrm-stage-chip--${meta.badge}`} title={meta.label}>
            <strong>{count.toLocaleString()}</strong> {meta.short}
          </span>
        );
      })}
    </span>
  );
};

/**
 * Dropdown-select-only combobox — the same control as the Add/Edit Product page's
 * Article/Size fields and the Product List filter panel: typing filters the list, the
 * value is set only by picking an option, arrows move the highlight, Enter picks,
 * Escape closes the menu without reaching the app's global Escape handler.
 */
const FilterCombobox: React.FC<{
  label: string;
  value: string;
  options: string[];
  placeholder: string;
  onChange: (value: string) => void;
}> = ({ label, value, options, placeholder, onChange }) => {
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const needle = query.trim().toLowerCase();
  const filtered = needle ? options.filter((o) => o.toLowerCase().includes(needle)) : options;

  const select = (next: string) => {
    onChange(next);
    setQuery("");
    setMenuOpen(false);
    setHighlight(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!menuOpen) setMenuOpen(true);
      setHighlight((n) => Math.min(n + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((n) => Math.max(n - 1, 0));
    } else if (e.key === "Enter" && menuOpen && filtered.length > 0) {
      e.preventDefault();
      select(filtered[highlight] ?? filtered[0]);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      setMenuOpen(false);
    }
  };

  return (
    <div className="city-combobox party-filter-combobox">
      <span className="city-search-icon" aria-hidden="true">
        ⌕
      </span>
      <input
        type="text"
        className="form-input"
        value={value || query}
        onChange={(e) => {
          if (value) onChange("");
          setQuery(e.target.value);
          setMenuOpen(true);
          setHighlight(0);
        }}
        onFocus={(e) => {
          e.currentTarget.select();
          setMenuOpen(true);
        }}
        onBlur={() => window.setTimeout(() => setMenuOpen(false), 120)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        role="combobox"
        aria-label={label}
        aria-expanded={menuOpen}
        aria-autocomplete="list"
        autoComplete="off"
      />
      {value && (
        <button
          type="button"
          className="party-combobox-clear"
          aria-label={`Clear ${label.toLowerCase()}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onChange("");
            setQuery("");
          }}
        >
          ×
        </button>
      )}
      {menuOpen && (
        <div className="city-options" role="listbox">
          {filtered.length === 0 ? (
            <div className="city-options-empty">No results found</div>
          ) : (
            filtered.map((option, idx) => (
              <button
                key={option}
                type="button"
                className={`city-option${idx === highlight || option === value ? " highlighted" : ""}`}
                role="option"
                aria-selected={option === value}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => select(option)}
              >
                {option}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};

interface Filters {
  /** Local calendar days, inclusive; the same day in both is a single date, both empty is all time. */
  fromDate: string;
  toDate: string;
  article: string;
  color: string;
  size: string;
}

const todayFilters = (): Filters => {
  const today = toLocalYmd(new Date());
  return { fromDate: today, toDate: today, article: "", color: "", size: "" };
};

/** What the database is actually asked for. */
const effectiveDates = (f: Filters): { fromDate?: string; toDate?: string } => ({
  fromDate: f.fromDate || undefined,
  toDate: f.toDate || undefined,
});

/** Identity of what the database is asked for, ignoring the page. */
const filterKeyOf = (f: Filters): string => {
  const { fromDate = "", toDate = "" } = effectiveDates(f);
  return [fromDate, toDate, f.article, f.color, f.size].join("|");
};

const describeDates = (f: Filters): string => {
  const { fromDate, toDate } = effectiveDates(f);
  if (!fromDate && !toDate) return "All time";
  if (fromDate && toDate && fromDate === toDate) return formatYmd(fromDate);
  if (fromDate && toDate) return `${formatYmd(fromDate)} → ${formatYmd(toDate)}`;
  if (fromDate) return `From ${formatYmd(fromDate)}`;
  return `Up to ${formatYmd(toDate as string)}`;
};

// ─── Expanded code list for one generation run ──────────────────────────────────

interface MembersState {
  rows: QrBatchMemberRow[];
  total: number;
  page: number;
  loading: boolean;
  error: string | null;
}

const BatchMembers: React.FC<{
  group: QrGenerationGroup;
  state: MembersState;
  onPage: (page: number) => void;
  onView: (qrId: string) => void;
}> = ({ group, state, onPage, onView }) => {
  const totalPages = Math.max(1, Math.ceil(state.total / MEMBER_PAGE_SIZE));
  return (
    <div className="qrm-members" data-testid={`members-${group.batchId}`}>
      <div className="qrm-members-head">
        <span>
          <strong>{group.article}</strong> · {group.color} · {group.size}{" "}
          <span className="qrm-mono">
            {pad6(group.startSequence)} → {pad6(group.endSequence)}
          </span>
        </span>
        <span className="text-muted">
          {state.total > 0
            ? `${state.total.toLocaleString()} codes · showing ${(
                (state.page - 1) * MEMBER_PAGE_SIZE +
                1
              ).toLocaleString()}–${Math.min(state.page * MEMBER_PAGE_SIZE, state.total).toLocaleString()}`
            : state.loading
              ? "Loading…"
              : "No codes"}
        </span>
      </div>
      {state.error ? (
        <div className="empty-state qrm-search-error" role="alert">
          <strong>Could not load these codes</strong>
          <span>{state.error}</span>
        </div>
      ) : (
        <table className="data-table qrm-members-table">
          <thead>
            <tr>
              <th>QR Code</th>
              <th>{copy.columns.status}</th>
              <th>Last change</th>
              <th aria-label={copy.columns.actions} />
            </tr>
          </thead>
          <tbody>
            {state.loading && state.rows.length === 0 && (
              <tr>
                <td colSpan={4} className="loading" style={{ textAlign: "center" }}>{copy.common.loading}</td>
              </tr>
            )}
            {state.rows.map((row) => (
              <tr key={row.qrId} className="qrm-member-row" onClick={() => onView(row.qrId)}>
                <td>
                  <code className="qrm-code">{row.qrId}</code>
                </td>
                <td>
                  <StageBadge stage={row.stage} />
                </td>
                <td className="text-muted">{formatDateTime(row.lastActivityAt)}</td>
                <td className="qrm-row-action">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onView(row.qrId);
                    }}
                  >
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {totalPages > 1 && (
        <div className="qrm-members-pager">
          <button type="button" className="btn btn-secondary btn-sm" disabled={state.page <= 1 || state.loading} onClick={() => onPage(state.page - 1)}>
            Previous
          </button>
          <span className="page-info">
            Page {state.page} of {totalPages}
          </span>
          <button type="button" className="btn btn-secondary btn-sm" disabled={state.page >= totalPages || state.loading} onClick={() => onPage(state.page + 1)}>
            Next
          </button>
        </div>
      )}
    </div>
  );
};

// ─── Detail drawer ──────────────────────────────────────────────────────────────

type ActionKind = "void" | "damage";

const ACTION_COPY: Record<
  ActionKind,
  { title: string; body: string; reasonLabel: string; placeholder: string; confirm: string }
> = {
  void: {
    title: "Void this code",
    body: "Use this for a label that was lost, torn or misprinted before the unit was produced. The production scanner will refuse the code from now on. You can restore it later if this was a mistake.",
    reasonLabel: "Reason",
    placeholder: "e.g. Label torn during printing",
    confirm: "Void code",
  },
  damage: {
    title: "Mark unit as damaged",
    body: "Use this for a produced unit that can no longer be sold. It is removed from stock on hand and recorded as damaged. This is written to the unit's history and cannot be undone here.",
    reasonLabel: "What happened",
    placeholder: "e.g. Crushed in warehouse rack B",
    confirm: "Mark damaged",
  },
};

interface TimelineEntry {
  key: string;
  label: string;
  at: string;
  meta: string;
  note: string | null;
  tone: string;
}

/**
 * The full history of one code, oldest first. Registration and voiding come from the
 * registry row's own timestamps; everything else is the append-only event log. Nothing
 * here is inferred — a step with no record simply does not appear.
 */
const buildTimeline = (detail: QrDetail): TimelineEntry[] => {
  const entries: TimelineEntry[] = [];
  if (detail.registry) {
    entries.push({
      key: "generated",
      label: "Generated",
      at: detail.registry.registeredAt,
      meta: detail.batch?.createdBy ? `QR Generator · ${detail.batch.createdBy}` : "QR Generator",
      note: null,
      tone: "generated",
    });
    if (detail.registry.status === "VOID" && detail.registry.voidedAt) {
      entries.push({
        key: "voided",
        label: "Voided",
        at: detail.registry.voidedAt,
        meta: detail.registry.voidedBy ? `QR Management · ${detail.registry.voidedBy}` : "QR Management",
        note: detail.registry.voidReason,
        tone: "damaged",
      });
    }
  }
  for (const ev of detail.events) {
    // A MOVED event written by Store Scanning is labelled by its business sub-kind.
    const kind = ev.subType ?? ev.eventType;
    entries.push({
      key: ev.id,
      label: EVENT_LABELS[kind] ?? kind,
      at: ev.occurredAt,
      meta:
        [ev.factory, ev.workstation, ev.operator].filter(Boolean).join(" · ") +
        (ev.deviceId ? ` · ${ev.deviceId}` : "") +
        (ev.syncStatus !== "SYNCED" ? ` · ${ev.syncStatus.toLowerCase()}` : ""),
      note: ev.note,
      tone: kind.toLowerCase(),
    });
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at));
};

const LifecycleRail: React.FC<{ stage: QrStage; kind?: "CARTON" | "RAW_MATERIAL" }> = ({ stage, kind }) => {
  const rail = lifecycleRailFor(kind);
  const current = railIndexOf(stage, rail);
  const offRail = QR_OFF_RAIL_STAGES.includes(stage);
  return (
    <div className="qrm-rail-wrap">
      <ol className="qrm-rail" aria-label="Lifecycle">
        {rail.map((step, index) => {
          const state = !step.tracked
            ? "untracked"
            : offRail
              ? "off"
              : index < current
                ? "done"
                : index === current
                  ? "current"
                  : "todo";
          return (
            <li
              key={step.key}
              className={`qrm-rail-step qrm-rail-step--${state}`}
              aria-current={state === "current" ? "step" : undefined}
              title={step.note}
            >
              <span className="qrm-rail-dot" aria-hidden="true" />
              <span className="qrm-rail-label">{step.label}</span>
              {!step.tracked && <span className="qrm-rail-note">not tracked</span>}
            </li>
          );
        })}
      </ol>
      {offRail && (
        <p className="qrm-note qrm-rail-exit">
          This code has left the lifecycle: <strong>{qrStageMeta(stage).label}</strong>. {qrStageMeta(stage).hint}
        </p>
      )}
    </div>
  );
};

/**
 * The one QR detail view. Also opened from Store Scanning's recent list, where it is
 * read-only: an operator can see the unit's status and history but not void or write it off.
 */
export const QrDetailDrawer: React.FC<{
  qrId: string;
  detail: QrDetail | null;
  loading: boolean;
  /** The logged-in operator, recorded as the actor of any correction made here. */
  username?: string;
  /** Hide the management actions (void / restore / damage). */
  readOnly?: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}> = ({ qrId, detail, loading, username, readOnly = false, onClose, onChanged }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [action, setAction] = useState<ActionKind | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
    setAction(null);
    setReason("");
  }, [qrId]);

  const closeAction = () => {
    setAction(null);
    setReason("");
  };

  const submitAction = async () => {
    if (!detail || !action) return;
    const trimmed = reason.trim();
    if (!trimmed) {
      push("error", "Reason required", "Enter a short reason so the history explains itself later");
      return;
    }
    setSubmitting(true);
    try {
      const actor = username?.trim() || null;
      const result =
        action === "void"
          ? await api.voidQrCode({ qrId: detail.qrId, reason: trimmed, actor })
          : await api.markQrCodeDamaged({ qrId: detail.qrId, reason: trimmed, actor });
      if (!result.accepted) {
        push("error", action === "void" ? "Could not void" : "Could not mark damaged", result.reason ?? "");
        return;
      }
      push("success", action === "void" ? "Code voided" : "Unit marked damaged", detail.qrId);
      closeAction();
      await onChanged();
    } catch {
      push("error", copy.toast.actionFailed, "Something went wrong — nothing was changed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleRestore = async () => {
    if (!detail) return;
    setSubmitting(true);
    try {
      const result = await api.restoreQrCode({ qrId: detail.qrId });
      if (!result.accepted) {
        push("error", "Could not restore", result.reason ?? "");
        return;
      }
      push("success", "Code restored", detail.qrId);
      await onChanged();
    } catch {
      push("error", copy.toast.actionFailed, "Something went wrong — nothing was changed");
    } finally {
      setSubmitting(false);
    }
  };

  const handlePrint = () => {
    if (!detail) return;
    // A reprint must reproduce the sticker that was printed, so each registry prints through
    // its own generator's path: a packet says category, attributes, supplier and what it holds
    // (its own stamped figure, not the material's today), a carton says article, size, colour.
    //
    // A packet's label needs the material behind it, which this screen does not hold, so it is
    // read first — and nothing is printed if that read fails, rather than printing a sticker
    // that says less than the one on the box.
    if (detail.kind === "RAW_MATERIAL") {
      void (async () => {
        const label = await api.getRawMaterialQrLabel(detail.qrId);
        if (!label) {
          push("error", copy.toast.failed, "This label could not be rebuilt for printing.");
          return;
        }
        const printed = openRawMaterialLabelPrintWindow({
          title: label.qrId,
          heading: label.displayName,
          subheading: label.qrId,
          header: {
            categoryLine: label.categoryLine,
            subCategoryLine: label.subCategoryLine,
            // The one function the generator uses, so the colour is the same Urdu word.
            attributes: materialLabelAttributes({ values: label.values } as unknown as InventoryItemRow),
            partyName: label.partyName,
            packQuantity: label.packingQuantity == null ? "" : formatQuantity(label.packingQuantity),
          },
          ids: [label.qrId],
        });
        if (!printed) push("error", copy.toast.popupBlocked, "Allow popups to print labels");
      })();
      return;
    }

    const ok = openCartonLabelPrintWindow({
      title: detail.qrId,
      heading: [detail.article, detail.size, detail.color].filter(Boolean).join(" / "),
      subheading: detail.qrId,
      identity: { article: detail.article, color: detail.color, size: detail.size },
      ids: [detail.qrId],
    });
    if (!ok) push("error", copy.toast.popupBlocked, "Allow popups to print labels");
  };

  const handleCopy = async () => {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(detail.qrId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      push("error", copy.toast.copyFailed, "Could not copy to the clipboard");
    }
  };

  const timeline = useMemo(() => (detail ? buildTimeline(detail) : []), [detail]);
  const stage = detail ? qrStageMeta(detail.stage) : null;
  // Void / restore / write-off act on the carton registry and the carton stock
  // projections. A raw material packet has neither, so those actions are not offered for
  // one — its detail and journey are still shown in full.
  const isRawMaterial = detail?.kind === "RAW_MATERIAL";
  const canVoid = !isRawMaterial && detail?.stage === "REGISTERED";
  const canRestore = !isRawMaterial && detail?.stage === "VOID";
  const canDamage =
    !isRawMaterial &&
    (detail?.stage === "PRODUCED" || detail?.stage === "WAREHOUSE" || detail?.stage === "TO_GATE" || detail?.stage === "RETURNED");
  const actionNote = (() => {
    if (isRawMaterial) {
      return "This is a raw material packet. Its movements are recorded here; corrections are made in Raw Material Master.";
    }
    switch (detail?.stage) {
      case "DISPATCHED":
      case "SOLD":
        return "This unit is with a customer. Use Return Scanning to bring it back before any write-off.";
      case "ON_GATE":
        // Deliberately not write-off-able: the carton is not counted in stock yet, so a
        // write-off here would take away a unit the projections never put back.
        return "This carton has been returned and is standing at the gate. Receive it through Store Scanning before any write-off.";
      case "DAMAGED":
        return "This unit has been written off as damaged. No further actions are available.";
      case "SCRAPPED":
        return "This unit has been scrapped. No further actions are available.";
      default:
        return null;
    }
  })();

  return (
    <div
      className="member-modal-backdrop qrm-drawer-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting && !action) onClose();
      }}
    >
      <aside className="qrm-drawer" role="dialog" aria-modal="true" aria-labelledby="qrm-drawer-title" aria-busy={loading}>
        <div className="qrm-drawer-head">
          <div className="qrm-drawer-title-wrap">
            <span className="section-label">QR Code</span>
            <code id="qrm-drawer-title" className="qrm-drawer-code">
              {qrId}
            </code>
            {detail && (
              <table className="data-table qrm-identity-table" aria-label="Identity">
                <thead>
                  <tr>
                    <th>{copy.columns.article}</th>
                    <th>Colour</th>
                    <th>{copy.columns.size}</th>
                    <th>{copy.columns.code}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <strong>{detail.article}</strong>
                    </td>
                    <td>
                      <strong>{detail.color}</strong>
                    </td>
                    <td>
                      <strong>{detail.size}</strong>
                    </td>
                    <td>
                      <strong className="qrm-mono qrm-identity-serial">{detail.serial}</strong>
                    </td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>
          <button type="button" className="member-modal-close" aria-label={copy.common.close} onClick={onClose} disabled={submitting}>
            ×
          </button>
        </div>

        {loading && !detail ? (
          <div className="loading" style={{ textAlign: "center" }}>{copy.common.loading}</div>
        ) : !detail || !stage ? (
          <div className="empty-state qrm-not-found" role="alert">
            <strong>QR NOT FOUND</strong>
            <span>No registered code matches this value. Nothing was created.</span>
          </div>
        ) : (
          <div className="qrm-drawer-body">
            <div className="qrm-identity-meta">
              <StageBadge stage={detail.stage} />
              <span className="qrm-stage-hint">{stage.hint}</span>
            </div>

            <div className="qrm-drawer-side">
              <div className="qr-preview-cell qrm-preview">
                <QrPreview value={detail.qrId} />
              </div>
              <div className="qrm-identity-actions">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void handleCopy()}>
                  {copied ? "Copied" : "Copy code"}
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={handlePrint}>
                  Print label
                </button>
              </div>
            </div>

            <section className="qrm-section">
              <p className="section-label">Lifecycle</p>
              <LifecycleRail stage={detail.stage} kind={detail.kind} />
            </section>

            <div className="qrm-sections">
              <section className="qrm-section">
                <p className="section-label">Generation</p>
                {detail.registry ? (
                  <dl className="qrm-kv">
                    <dt>Generated at</dt>
                    <dd>{formatDateTime(detail.registry.registeredAt)}</dd>
                    <dt>Generated by</dt>
                    <dd>{detail.batch?.createdBy ?? <span className="text-muted">Not recorded</span>}</dd>
                    <dt>Requested by</dt>
                    <dd>{detail.batch?.requestedBy ?? <span className="text-muted">Not recorded</span>}</dd>
                    {detail.batch && (
                      <>
                        <dt>Batch / range</dt>
                        <dd>
                          <span className="qrm-mono">
                            {pad6(detail.batch.startSequence)} → {pad6(detail.batch.endSequence)}
                          </span>
                          <span className="text-muted"> · {detail.batch.quantity.toLocaleString()} codes</span>
                        </dd>
                        <dt>Batch progress</dt>
                        <dd>
                          {detail.batch.producedCount.toLocaleString()} of {detail.batch.quantity.toLocaleString()} produced
                          {detail.batch.voidCount > 0 && <span className="text-muted"> · {detail.batch.voidCount} void</span>}
                        </dd>
                      </>
                    )}
                    {detail.registry.status === "VOID" && (
                      <>
                        <dt>Voided</dt>
                        <dd>
                          {detail.registry.voidedAt ? formatDateTime(detail.registry.voidedAt) : "—"}
                          {detail.registry.voidedBy && <span className="text-muted"> by {detail.registry.voidedBy}</span>}
                        </dd>
                        <dt>Reason</dt>
                        <dd>{detail.registry.voidReason ?? "—"}</dd>
                      </>
                    )}
                  </dl>
                ) : (
                  <p className="qrm-note">No registry entry — this unit predates the QR Generator and was scanned in directly.</p>
                )}
              </section>

              <section className="qrm-section">
                <p className="section-label">{copy.scanning.currentStatus}</p>
                <dl className="qrm-kv">
                  <dt>{copy.columns.status}</dt>
                  <dd>{detail.stageLabel ?? stage.label}</dd>
                  {detail.lifecycle ? (
                    <>
                      <dt>Location</dt>
                      <dd>
                        {detail.lifecycle.locationType}
                        {detail.lifecycle.locationId && <span className="text-muted"> · {detail.lifecycle.locationId}</span>}
                      </dd>
                      <dt>First scanned</dt>
                      <dd>{formatDateTime(detail.lifecycle.firstScannedAt)}</dd>
                      <dt>Last change</dt>
                      <dd>{formatDateTime(detail.lifecycle.updatedAt)}</dd>
                    </>
                  ) : (
                    <>
                      <dt>Scanned</dt>
                      <dd className="text-muted">
                        {detail.stage === "VOID" ? "Never — this code was voided before production." : "Not yet. It becomes a stock unit when it is scanned in Live Production."}
                      </dd>
                    </>
                  )}
                </dl>
              </section>
            </div>

            <section className="qrm-section">
              <p className="section-label">Timeline</p>
              {timeline.length === 0 ? (
                <p className="qrm-note">No events recorded.</p>
              ) : (
                <ol className="qrm-timeline">
                  {timeline.map((entry) => (
                    <li key={entry.key} className={`qrm-event qrm-event--${entry.tone}`}>
                      <div className="qrm-event-head">
                        <strong>{entry.label}</strong>
                        <span className="qrm-event-time">{formatDateTime(entry.at)}</span>
                      </div>
                      <div className="qrm-event-meta">{entry.meta || "—"}</div>
                      {entry.note && <div className="qrm-event-note">“{entry.note}”</div>}
                    </li>
                  ))}
                </ol>
              )}
            </section>

            {!readOnly && (
            <section className="qrm-section qrm-actions">
              <p className="section-label">{copy.columns.actions}</p>
              {canVoid && (
                <div className="qrm-action-row">
                  <div>
                    <strong>Void this code</strong>
                    <p className="qrm-note">Label lost or spoiled before production. The scanner will refuse it.</p>
                  </div>
                  <button type="button" className="btn btn-danger btn-sm" disabled={submitting} onClick={() => setAction("void")}>
                    Void…
                  </button>
                </div>
              )}
              {canRestore && (
                <div className="qrm-action-row">
                  <div>
                    <strong>Restore this code</strong>
                    <p className="qrm-note">Undo the void so it can be produced again.</p>
                  </div>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={submitting} onClick={() => void handleRestore()}>
                    {submitting ? "Restoring…" : "Restore"}
                  </button>
                </div>
              )}
              {canDamage && (
                <div className="qrm-action-row">
                  <div>
                    <strong>Mark unit as damaged</strong>
                    <p className="qrm-note">Removes it from stock on hand and records why.</p>
                  </div>
                  <button type="button" className="btn btn-danger btn-sm" disabled={submitting} onClick={() => setAction("damage")}>
                    Mark damaged…
                  </button>
                </div>
              )}
              {actionNote && <p className="qrm-note">{actionNote}</p>}
              {!canVoid && !canRestore && !canDamage && !actionNote && (
                <p className="qrm-note">No management actions apply to this code right now.</p>
              )}
            </section>
            )}
          </div>
        )}
      </aside>

      {action && detail && (
        <div
          className="member-modal-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !submitting) closeAction();
          }}
        >
          <section className="member-modal product-add-modal" role="dialog" aria-modal="true" aria-labelledby="qrm-action-title">
            <div className="member-modal-header">
              <div className="member-modal-identity">
                <div>
                  <h2 id="qrm-action-title">{ACTION_COPY[action].title}</h2>
                </div>
              </div>
              <button type="button" className="member-modal-close" aria-label={copy.common.close} onClick={closeAction} disabled={submitting}>
                ×
              </button>
            </div>
            <p className="qrm-modal-body">{ACTION_COPY[action].body}</p>
            <code className="qrm-modal-code">{detail.qrId}</code>
            <div className="form-group" style={{ margin: "14px 0 6px" }}>
              <label htmlFor="qrm-reason" className="input-label">
                {ACTION_COPY[action].reasonLabel} <span className="required-mark">*</span>
              </label>
              <input
                id="qrm-reason"
                type="text"
                className="form-input"
                style={{ width: "100%" }}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submitAction();
                  }
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    if (!submitting) closeAction();
                  }
                }}
                placeholder={ACTION_COPY[action].placeholder}
                maxLength={200}
                autoFocus
              />
            </div>
            <div className="member-modal-actions">
              <span />
              <button type="button" className="btn btn-secondary" onClick={closeAction} disabled={submitting}>{copy.common.cancel}</button>
              <button type="button" className="btn btn-danger" onClick={() => void submitAction()} disabled={submitting || !reason.trim()}>
                {submitting ? "Working…" : ACTION_COPY[action].confirm}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
};

// ─── Page ───────────────────────────────────────────────────────────────────────

interface QrManagementPageProps {
  /** The logged-in operator; recorded as the actor of void / damage corrections. */
  username?: string;
}

export const QrManagementPage: React.FC<QrManagementPageProps> = ({ username }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  // Direct lookup
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<QrSearchRow[]>([]);
  // The query the suggestions were computed for, so a stale list is never acted on.
  const [suggestionsFor, setSuggestionsFor] = useState("");
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [notFound, setNotFound] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const latestSearch = useRef(0);

  // Management filters + overview
  const [filters, setFilters] = useState<Filters>(todayFilters);
  const [options, setOptions] = useState<QrGenerationFilterOptions>({ articles: [], colors: [], sizes: [] });
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement | null>(null);
  const [overview, setOverview] = useState<QrGenerationOverview | null>(null);
  const [groupPage, setGroupPage] = useState(1);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const latestOverview = useRef(0);

  // Expanded runs
  const [expanded, setExpanded] = useState<Record<string, MembersState>>({});

  // Detail drawer
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<QrDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const bridgeMissing = typeof api.getQrGenerationOverview !== "function";

  // ── Overview ──
  // The headline tallies cover every code in the filter, so they are keyed by the filter:
  // fetched when it changes, kept while the operator pages through the runs.
  const [summary, setSummary] = useState<{ key: string; totalQrCount: number; stageCounts: QrStageCounts } | null>(null);
  const summaryKeyRef = useRef<string | null>(null);

  const loadOverview = useCallback(
    async (f: Filters, page: number, opts: { withSummary: boolean }) => {
      const ticket = ++latestOverview.current;
      setLoadingOverview(true);
      try {
        // The renderer hot-reloads in development but the preload bridge does not.
        if (typeof api.getQrGenerationOverview !== "function") {
          throw new Error("This feature is not available in the running app yet — restart the app to load it.");
        }
        const next = await api.getQrGenerationOverview({
          ...effectiveDates(f),
          article: f.article || undefined,
          color: f.color || undefined,
          size: f.size || undefined,
          page,
          pageSize: GROUP_PAGE_SIZE,
          includeSummary: opts.withSummary,
        });
        if (ticket !== latestOverview.current) return;
        setOverview(next);
        if (next.stageCounts && next.totalQrCount !== null) {
          const key = filterKeyOf(f);
          summaryKeyRef.current = key;
          setSummary({ key, totalQrCount: next.totalQrCount, stageCounts: next.stageCounts });
        }
        setOverviewError(null);
      } catch (error) {
        if (ticket !== latestOverview.current) return;
        const message = error instanceof Error && error.message ? error.message : "Could not load generation records";
        setOverview(null);
        setSummary(null);
        summaryKeyRef.current = null;
        setOverviewError(message);
      } finally {
        if (ticket === latestOverview.current) setLoadingOverview(false);
      }
    },
    [api],
  );

  // Any filter change starts again from page 1 with nothing expanded; React batches the
  // updates so the overview is fetched once.
  const updateFilters = useCallback((update: (prev: Filters) => Filters) => {
    setFilters(update);
    setGroupPage(1);
    setExpanded({});
  }, []);

  useEffect(() => {
    // Tallies are re-requested only when the filter they were computed for has changed.
    void loadOverview(filters, groupPage, { withSummary: summaryKeyRef.current !== filterKeyOf(filters) });
  }, [filters, groupPage, loadOverview]);

  useEffect(() => {
    if (typeof api.listQrGenerationFilterOptions !== "function") return;
    void (async () => {
      try {
        setOptions(await api.listQrGenerationFilterOptions());
      } catch {
        // The pickers just stay empty; typing a filter is still possible via search.
      }
    })();
  }, [api]);

  // ── Expansion ──
  const loadMembers = useCallback(
    async (batchId: string, page: number) => {
      setExpanded((prev) => ({
        ...prev,
        [batchId]: { rows: prev[batchId]?.rows ?? [], total: prev[batchId]?.total ?? 0, page, loading: true, error: null },
      }));
      try {
        const result = await api.listQrBatchMembers(batchId, { page, pageSize: MEMBER_PAGE_SIZE });
        setExpanded((prev) =>
          prev[batchId] ? { ...prev, [batchId]: { rows: result.rows, total: result.total, page: result.page, loading: false, error: null } } : prev,
        );
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : "Could not load codes";
        setExpanded((prev) => (prev[batchId] ? { ...prev, [batchId]: { ...prev[batchId], loading: false, error: message } } : prev));
      }
    },
    [api],
  );

  const toggleExpanded = (batchId: string) => {
    if (expanded[batchId]) {
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[batchId];
        return next;
      });
      return;
    }
    void loadMembers(batchId, 1);
  };

  // ── Detail ──
  const loadDetail = useCallback(
    async (qrId: string) => {
      setLoadingDetail(true);
      try {
        setDetail(await api.getQrDetail(qrId));
      } catch {
        setDetail(null);
        push("error", copy.toast.loadFailed, "Could not load this code");
      } finally {
        setLoadingDetail(false);
      }
    },
    [api, push],
  );

  // A direct lookup has already fetched the record; the drawer reuses it instead of asking again.
  const preloadedDetail = useRef<QrDetail | null>(null);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    if (preloadedDetail.current?.qrId === selectedId) {
      setDetail(preloadedDetail.current);
      preloadedDetail.current = null;
      return;
    }
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const openQr = (qrId: string, known?: QrDetail) => {
    preloadedDetail.current = known ?? null;
    setSuggestOpen(false);
    setNotFound(null);
    setSelectedId(qrId);
  };

  const closeDrawer = () => {
    setSelectedId(null);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  // After a void/restore/damage, every view of this code must agree with the database.
  const refreshAfterChange = async () => {
    if (selectedId) await loadDetail(selectedId);
    await loadOverview(filters, groupPage, { withSummary: true });
    for (const [batchId, state] of Object.entries(expanded)) void loadMembers(batchId, state.page);
  };

  // ── Search ──
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
        if (typeof api.searchQrCodes !== "function") {
          throw new Error("This feature is not available in the running app yet — restart the app to load it.");
        }
        const rows = await api.searchQrCodes(q, SEARCH_LIMIT);
        if (ticket !== latestSearch.current) return;
        setSuggestions(rows);
        setSuggestionsFor(q);
        setSuggestOpen(true);
      } catch (error) {
        if (ticket === latestSearch.current) {
          setSuggestions([]);
          setSuggestionsFor("");
          setSuggestOpen(false);
          push("error", copy.toast.searchFailed, error instanceof Error && error.message ? error.message : "Could not search registered codes");
        }
      } finally {
        if (ticket === latestSearch.current) setSearching(false);
      }
    },
    [api, push],
  );

  useEffect(() => {
    setNotFound(null);
    const handle = window.setTimeout(() => void runSearch(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query, runSearch]);

  // Enter (or a handheld scanner, which types the code and presses Enter) opens the
  // exact code straight away; an unknown value is reported, never created.
  const submitSearch = async () => {
    const raw = query.trim();
    const q = raw.toUpperCase();
    if (!q) return;
    ++latestSearch.current; // cancel any in-flight suggestion search
    setSearching(true);
    try {
      const found = await api.getQrDetail(q);
      if (found) {
        openQr(found.qrId, found);
        return;
      }
      // Fall back on the suggestion list only if it was computed for this very input.
      const fresh = suggestionsFor === raw ? suggestions : [];
      const exact = fresh.find((r) => r.qrId === q);
      if (exact) {
        openQr(exact.qrId);
        return;
      }
      if (fresh.length === 1) {
        openQr(fresh[0].qrId);
        return;
      }
      setSuggestOpen(false);
      setNotFound(q);
    } catch {
      push("error", copy.toast.searchFailed, "Could not look up this code");
    } finally {
      setSearching(false);
    }
  };

  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // While the drawer is open, Escape closes it instead of navigating to Dashboard.
  useEffect(() => {
    if (!selectedId) return;
    const sentinel = document.createElement("div");
    sentinel.setAttribute("data-suppress-esc", "1");
    sentinel.style.display = "none";
    document.body.appendChild(sentinel);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".qrm-drawer-backdrop .member-modal")) closeDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      sentinel.remove();
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Filter panel: closes on outside click or Escape (Escape must not navigate away).
  useEffect(() => {
    if (!filterOpen) return;
    const sentinel = document.createElement("div");
    sentinel.setAttribute("data-suppress-esc", "1");
    sentinel.style.display = "none";
    document.body.appendChild(sentinel);
    const onMouseDown = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFilterOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFilterOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      sentinel.remove();
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [filterOpen]);

  // ── Derived ──
  const setDatePreset = (preset: "today" | "7d" | "30d" | "all") => {
    const today = toLocalYmd(new Date());
    updateFilters((f) => {
      switch (preset) {
        case "today":
          return { ...f, fromDate: today, toDate: today };
        case "7d":
          return { ...f, fromDate: daysAgoYmd(6), toDate: today };
        case "30d":
          return { ...f, fromDate: daysAgoYmd(29), toDate: today };
        default:
          return { ...f, fromDate: "", toDate: "" };
      }
    });
  };

  const activePreset = useMemo(() => {
    const today = toLocalYmd(new Date());
    const { fromDate, toDate } = effectiveDates(filters);
    if (!fromDate && !toDate) return "all";
    if (fromDate === today && toDate === today) return "today";
    if (fromDate === daysAgoYmd(6) && toDate === today) return "7d";
    if (fromDate === daysAgoYmd(29) && toDate === today) return "30d";
    return null;
  }, [filters]);

  const dateActive = Boolean(effectiveDates(filters).fromDate || effectiveDates(filters).toDate);
  const activeFilterCount = (dateActive ? 1 : 0) + (filters.article ? 1 : 0) + (filters.color ? 1 : 0) + (filters.size ? 1 : 0);
  const clearAllFilters = () => {
    updateFilters(() => ({ fromDate: "", toDate: "", article: "", color: "", size: "" }));
    setFilterOpen(false);
  };
  // Never show tallies computed for a different selection while the new one loads.
  const currentSummary = summary && summary.key === filterKeyOf(filters) ? summary : null;
  const summaryEntries = currentSummary ? orderedStageCounts(currentSummary.stageCounts) : [];
  const totalGroupPages = overview ? Math.max(1, Math.ceil(overview.total / overview.pageSize)) : 1;

  return (
    <div className="page qr-management-page">
      <div className="page-header qrm-page-header">
        <h1>QR Management</h1>
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
              placeholder="Search QR Code — scan a label, paste a code, or type SK6 RED 000037"
              aria-label="Search QR Code"
              autoComplete="off"
              spellCheck={false}
            />
            {searching && <span className="qrm-lookup-spinner text-muted">…</span>}
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
                      onClick={() => openQr(row.qrId)}
                    >
                      <code className="qrm-code">{row.qrId}</code>
                      <StageBadge stage={row.stage} />
                    </button>
                  ))}
                  {suggestions.length >= SEARCH_LIMIT && (
                    <div className="qrm-suggest-empty">First {SEARCH_LIMIT} matches — keep typing to narrow down.</div>
                  )}
                </>
              )}
            </div>
          )}
          {notFound && (
            <div className="qrm-lookup-notfound" role="alert">
              <strong>QR NOT FOUND</strong>
              <span>
                <code className="qrm-code">{notFound}</code> is not registered. Only codes generated in the QR Generator exist; nothing was created.
              </span>
            </div>
          )}
        </form>
      </div>

      {/* ── Toolbar: filter button + active filter chips ─────────────────── */}
      <div className="qrm-toolbar">
        <div className="party-filter-wrap" ref={filterRef} style={{ position: "relative" }}>
          <button
            type="button"
            className={`btn btn-secondary party-filter-btn${activeFilterCount > 0 ? " party-filter-btn--active" : ""}`}
            onClick={() => setFilterOpen((prev) => !prev)}
            aria-expanded={filterOpen}
            aria-haspopup="true"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path
                fillRule="evenodd"
                d="M3 5a1 1 0 011-1h12a1 1 0 010 2H4a1 1 0 01-1-1zm2 4a1 1 0 011-1h8a1 1 0 010 2H6a1 1 0 01-1-1zm2 4a1 1 0 011-1h4a1 1 0 010 2H8a1 1 0 01-1-1z"
                clipRule="evenodd"
              />
            </svg>
            Filters
            {activeFilterCount > 0 && <span className="party-filter-badge">{activeFilterCount}</span>}
          </button>

          {filterOpen && (
            <div className="party-filter-panel qrm-filter-panel" role="dialog" aria-label={copy.filters.filterOptions}>
              <div className="qrm-filter-panel-head">
                <strong>Filters</strong>
                <span className="text-muted">Applied as you change them</span>
              </div>

              <div className="qrm-filter-grid">
              {/* Generated on */}
              <section className="qrm-filter-section">
                <div className="party-filter-panel__field-label">Generated on</div>
                <div className="qrm-filter-presets" role="group" aria-label="Quick dates">
                  {(
                    [
                      ["today", "Today"],
                      ["7d", "Last 7 days"],
                      ["30d", "Last 30 days"],
                      ["all", "All time"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      className={`party-filter-status-btn${activePreset === key ? " selected" : ""}`}
                      onClick={() => setDatePreset(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="qrm-filter-dates">
                  <label className="qrm-filter-date">
                    <span>From</span>
                    <input
                      type="date"
                      className="form-input"
                      aria-label={copy.filters.fromDate}
                      value={filters.fromDate}
                      onChange={(e) => {
                        const value = e.target.value;
                        // Picking a start with no end (or an earlier end) selects just that day;
                        // change "To" afterwards to widen it into a range.
                        updateFilters((f) => ({ ...f, fromDate: value, toDate: !f.toDate || (value && f.toDate < value) ? value : f.toDate }));
                      }}
                    />
                  </label>
                  <label className="qrm-filter-date">
                    <span>To</span>
                    <input
                      type="date"
                      className="form-input"
                      aria-label={copy.filters.toDate}
                      value={filters.toDate}
                      min={filters.fromDate || undefined}
                      onChange={(e) => {
                        const value = e.target.value;
                        updateFilters((f) => ({ ...f, toDate: value }));
                      }}
                    />
                  </label>
                </div>
                <p className="qrm-note">Same day in both = one date. Uses the generation time, not the scan time.</p>
              </section>

              {/* Product */}
              <section className="qrm-filter-section">
                <div className="party-filter-panel__field-label">{copy.columns.product}</div>
                <div className="qrm-filter-field">
                  <span>{copy.columns.article}</span>
                  <FilterCombobox
                    label={copy.columns.article}
                    value={filters.article}
                    options={options.articles}
                    placeholder={copy.filters.allArticles}
                    onChange={(value) => updateFilters((f) => ({ ...f, article: value }))}
                  />
                </div>
                <div className="qrm-filter-field">
                  <span>Colour</span>
                  <FilterCombobox
                    label="Colour"
                    value={filters.color}
                    options={options.colors}
                    placeholder="All colours"
                    onChange={(value) => updateFilters((f) => ({ ...f, color: value }))}
                  />
                </div>
                <div className="qrm-filter-field">
                  <span>{copy.columns.size}</span>
                  <FilterCombobox
                    label={copy.columns.size}
                    value={filters.size}
                    options={options.sizes}
                    placeholder="All sizes"
                    onChange={(value) => updateFilters((f) => ({ ...f, size: value }))}
                  />
                </div>
              </section>
              </div>

              <div className="qrm-filter-panel-foot">
                <button type="button" className="btn btn-ghost btn-sm" onClick={clearAllFilters} disabled={activeFilterCount === 0}>
                  Clear all
                </button>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setFilterOpen(false)}>
                  Done
                </button>
              </div>
            </div>
          )}
        </div>

        {activeFilterCount > 0 && (
          <div className="party-filter-chips qrm-filter-chips">
            {dateActive && (
              <span className="party-chip">
                {describeDates(filters)}
                <button type="button" className="party-chip__remove" aria-label="Remove date filter" onClick={() => setDatePreset("all")}>
                  ×
                </button>
              </span>
            )}
            {filters.article && (
              <span className="party-chip">
                Article: {filters.article}
                <button type="button" className="party-chip__remove" aria-label="Remove article filter" onClick={() => updateFilters((f) => ({ ...f, article: "" }))}>
                  ×
                </button>
              </span>
            )}
            {filters.color && (
              <span className="party-chip">
                Colour: {filters.color}
                <button type="button" className="party-chip__remove" aria-label="Remove colour filter" onClick={() => updateFilters((f) => ({ ...f, color: "" }))}>
                  ×
                </button>
              </span>
            )}
            {filters.size && (
              <span className="party-chip">
                Size: {filters.size}
                <button type="button" className="party-chip__remove" aria-label="Remove size filter" onClick={() => updateFilters((f) => ({ ...f, size: "" }))}>
                  ×
                </button>
              </span>
            )}
          </div>
        )}
        {activeFilterCount === 0 && <span className="qrm-summary-scope">All time</span>}

        {overview && currentSummary && (
          <span className="qrm-summary-total">
            <strong>{currentSummary.totalQrCount.toLocaleString()}</strong> {currentSummary.totalQrCount === 1 ? "code" : "codes"} in{" "}
            <strong>{overview.total.toLocaleString()}</strong> generation {overview.total === 1 ? "run" : "runs"}
          </span>
        )}
      </div>

      {/* ── Summary ─────────────────────────────────────────────────────── */}
      <div className="qrm-summary" aria-live="polite">
        <div className="qrm-summary-tiles">
          {currentSummary && summaryEntries.length === 0 && !loadingOverview && <span className="text-muted">Nothing generated in this selection.</span>}
          {summaryEntries.map(({ stage, count }) => {
            const meta = qrStageMeta(stage);
            return (
              <div key={stage} className={`qrm-tile qrm-tile--${meta.badge}`} title={meta.hint}>
                <span className="qrm-tile-value">{count.toLocaleString()}</span>
                <span className="qrm-tile-label">{meta.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Grouped generation runs ─────────────────────────────────────── */}
      <div className="card qrm-groups-card">
        <div className="card-header">
          <h2 className="card-title">Generation runs</h2>
          <span className="qrm-count">
            {loadingOverview ? "Loading…" : overview ? `${overview.total.toLocaleString()} ${overview.total === 1 ? "run" : "runs"}` : ""}
          </span>
        </div>
        <div className="table-container">
          <table className="data-table qrm-groups-table">
            <thead>
              <tr>
                <th>{copy.columns.date}</th>
                <th>{copy.columns.article}</th>
                <th>Colour</th>
                <th>{copy.columns.size}</th>
                <th>Range</th>
                <th className="qrm-num-col">{copy.columns.qty}</th>
                <th>Status summary</th>
                <th aria-label={copy.columns.actions} />
              </tr>
            </thead>
            <tbody>
              {overviewError && (
                <tr>
                  <td colSpan={8}>
                    <div className="empty-state qrm-search-error" role="alert">
                      <strong>Could not load generation records</strong>
                      <span>{overviewError}</span>
                    </div>
                  </td>
                </tr>
              )}
              {!overviewError && loadingOverview && !overview && (
                <tr>
                  <td colSpan={8} className="loading" style={{ textAlign: "center" }}>{copy.common.loading}</td>
                </tr>
              )}
              {!overviewError && overview && overview.groups.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <div className="empty-state">
                      <strong>No codes were generated in this selection</strong>
                      <span>Widen the date range or clear the product filters. Codes are registered only by the QR Generator.</span>
                    </div>
                  </td>
                </tr>
              )}
              {overview?.groups.map((group) => {
                const members = expanded[group.batchId];
                const isOpen = Boolean(members);
                return (
                  <React.Fragment key={group.batchId}>
                    <tr className={`qrm-group-row${isOpen ? " is-open" : ""}`} onClick={() => toggleExpanded(group.batchId)} aria-expanded={isOpen}>
                      <td>
                        <div className="qr-generated-cell">
                          <span className="qr-generated-date">{formatDate(group.generatedAt)}</span>
                          <span className="qr-generated-time">
                            {formatTime(group.generatedAt)}
                            {group.generatedBy ? ` · ${group.generatedBy}` : ""}
                          </span>
                          {group.requestedBy && <span className="qr-generated-time">for {group.requestedBy}</span>}
                        </div>
                      </td>
                      <td>
                        <strong>{group.article}</strong>
                      </td>
                      <td>{group.color}</td>
                      <td>{group.size}</td>
                      <td className="qrm-range-cell">
                        <code>{pad6(group.startSequence)}</code>
                        <span className="qr-range-sep">→</span>
                        <code>{pad6(group.endSequence)}</code>
                      </td>
                      <td className="qrm-num-col">{group.quantity.toLocaleString()}</td>
                      <td>
                        <StageSummaryInline counts={group.stageCounts} />
                      </td>
                      <td className="qrm-row-action">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          aria-label={`${isOpen ? "Hide" : "View"} codes ${group.firstQrId} to ${group.lastQrId}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpanded(group.batchId);
                          }}
                        >
                          {isOpen ? "Hide" : "View"}
                        </button>
                      </td>
                    </tr>
                    {isOpen && members && (
                      <tr className="qrm-group-detail">
                        <td colSpan={8}>
                          <BatchMembers group={group} state={members} onPage={(p) => void loadMembers(group.batchId, p)} onView={openQr} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {overview && totalGroupPages > 1 && (
          <div className="pagination">
            <button type="button" className="btn btn-sm" disabled={groupPage === 1 || loadingOverview} onClick={() => setGroupPage(1)}>
              First
            </button>
            <button type="button" className="btn btn-sm" disabled={groupPage === 1 || loadingOverview} onClick={() => setGroupPage((p) => p - 1)}>
              Previous
            </button>
            <span className="page-info">
              Page {groupPage} of {totalGroupPages}
            </span>
            <button type="button" className="btn btn-sm" disabled={groupPage >= totalGroupPages || loadingOverview} onClick={() => setGroupPage((p) => p + 1)}>
              Next
            </button>
            <button type="button" className="btn btn-sm" disabled={groupPage >= totalGroupPages || loadingOverview} onClick={() => setGroupPage(totalGroupPages)}>
              Last
            </button>
          </div>
        )}
      </div>

      {bridgeMissing && !overviewError && (
        <p className="qrm-note" role="status">
          Restart the app to load the QR Management overview.
        </p>
      )}

      {selectedId && (
        <QrDetailDrawer qrId={selectedId} detail={detail} loading={loadingDetail} username={username} onClose={closeDrawer} onChanged={refreshAfterChange} />
      )}
    </div>
  );
};
