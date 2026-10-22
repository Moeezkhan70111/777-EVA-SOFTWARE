import React, { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePolledRead } from "../../hooks/usePolledRead";
import { useDismissOnOutsideClick } from "../../hooks/useDismissOnOutsideClick";
import { copy } from "../../config/copy";
import { deriveSyncHealth, describeAge, type SyncHealthLevel } from "./syncHealth";
import type { CloudSyncStatus } from "../../types/desktopApi";

// IS IT WORKING? — answered at a glance, for somebody who does not know what a sync is.
//
// Four states, one dot, four words. The detail lives behind a click, so the rail says whether
// to worry and nothing else. Every string is in copy.syncStatus, in the words a person on the
// floor would use: "Other Computers", not "Cloud Sync"; "Up To Date", not "IDLE"; "waiting to
// send", not "outbox depth".
//
// NEVER COLOUR ALONE (R18). Each state carries a symbol and a word as well as a colour, so it
// reads the same to somebody who cannot tell the green from the amber.
//
// PORTALLED, because the rail is a scroll container and clips a flyout on both axes — the same
// reason ProductDetailModal is portalled. The rail sits at z-index 400 so modals cover it; this
// panel sits just above the rail and below modals.

const POLL_INTERVAL_MS = 10_000;

/** Symbol, word and class per state. The symbol is what makes it readable without colour. */
const PRESENTATION: Record<SyncHealthLevel, { mark: string; className: string }> = {
  WORKING: { mark: "✓", className: "sync-dot-working" },
  WAITING: { mark: "⟳", className: "sync-dot-waiting" },
  ATTENTION: { mark: "!", className: "sync-dot-attention" },
  OFF: { mark: "–", className: "sync-dot-off" },
};

const isCloudSyncStatus = (value: unknown): value is CloudSyncStatus => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.configured === "boolean" && typeof record.running === "boolean";
};

/**
 * The two bridge calls this needs, or null when they are not there.
 *
 * Read defensively rather than through useDesktopApi, which assumes `window.desktop` exists.
 * This component lives in the navigation rail — the one piece of chrome on every screen — so it
 * must not be able to take the rail down with it. An older preload without these channels, or a
 * test that renders the rail without a bridge, gets a rail with no indicator rather than a
 * crash.
 */
type SyncBridge = {
  getCloudSyncStatus: () => Promise<unknown>;
  runCloudSync: () => Promise<{ accepted: boolean; reason?: string }>;
};

const readBridge = (): SyncBridge | null => {
  const api = (globalThis as { desktop?: { api?: Partial<SyncBridge> } }).desktop?.api;
  if (typeof api?.getCloudSyncStatus !== "function" || typeof api.runCloudSync !== "function") return null;
  return api as SyncBridge;
};

export interface SyncStatusIndicatorProps {
  /** Opens Settings, where the stuck items and this computer's setup live. */
  onOpenSettings: () => void;
}

export const SyncStatusIndicator: React.FC<SyncStatusIndicatorProps> = ({ onOpenSettings }) => {
  const bridge = readBridge();
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  /** A refused or failed send, shown in the panel beside the button that caused it. */
  const [sendError, setSendError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // The panel is portalled out of wrapRef, so the dismiss hook is told about it explicitly —
  // otherwise its own buttons would count as outside clicks and close it before they fired.
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissOnOutsideClick(wrapRef, open, close, panelRef);

  const read = useCallback(async () => {
    if (bridge === null) return { accepted: false as const };
    const status = await bridge.getCloudSyncStatus();
    return isCloudSyncStatus(status) ? { accepted: true as const, value: status } : { accepted: false as const };
  }, [bridge]);

  const { value: status, reload } = usePolledRead(read, { intervalMs: POLL_INTERVAL_MS, failed: "" });
  const health = deriveSyncHealth(status);
  // The newest push verdict, so the panel can name the cause rather than only count it.
  const refusalReason = status?.lastAttempt?.reason ?? "";

  const sendNow = useCallback(async () => {
    if (bridge === null) return;
    setSending(true);
    setSendError(null);
    try {
      const outcome = await bridge.runCloudSync();
      // Only a refusal needs saying, and it is said HERE rather than as a toast in the corner:
      // the message belongs beside the button that caused it. That also keeps this component
      // free of the notifications provider, so the navigation rail does not depend on one.
      if (!outcome.accepted) setSendError(outcome.reason ?? copy.common.unknownError);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : copy.common.unknownError);
    } finally {
      setSending(false);
      await reload();
    }
  }, [bridge, reload]);

  // No bridge, no indicator. The rail renders exactly as it did before this component existed.
  if (bridge === null) return null;

  const { mark, className } = PRESENTATION[health.level];
  const headline =
    health.level === "OFF"
      ? copy.syncStatus.off
      : health.level === "ATTENTION"
        ? copy.syncStatus.attention
        : health.level === "WAITING"
          ? copy.syncStatus.waiting
          : health.busy
            ? copy.syncStatus.workingBusy
            : copy.syncStatus.working;

  const body = bodyFor(health, refusalReason);
  const age = describeAge(health.lastSuccessAt);

  return (
    <div className="sync-indicator-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`sync-indicator ${className}`}
        aria-expanded={open}
        // The accessible name carries the whole answer, so a screen reader does not get "button".
        aria-label={`${copy.syncStatus.label}: ${headline}${age ? `. ${copy.syncStatus.lastSuccess} ${age}` : ""}`}
        title={`${copy.syncStatus.label}: ${headline}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="sync-indicator-mark" aria-hidden="true">{mark}</span>
        <span className="sync-indicator-text">{headline}</span>
      </button>

      {open && wrapRef.current
        ? createPortal(
            <SyncDetailPanel
              panelRef={panelRef}
              anchor={wrapRef.current.getBoundingClientRect()}
              headline={headline}
              body={body}
              age={age}
              waiting={health.waiting}
              stuck={health.stuck}
              refusedPending={health.refusedPending}
              showActions={health.level !== "OFF"}
              sending={sending}
              sendError={sendError}
              onSendNow={() => void sendNow()}
              onOpenSettings={() => {
                close();
                onOpenSettings();
              }}
            />,
            document.body
          )
        : null}
    </div>
  );
};

/** The sentence under the headline. One state, one explanation, no jargon. */
function bodyFor(health: ReturnType<typeof deriveSyncHealth>, refusalReason: string): string {
  if (health.level === "OFF") return copy.syncStatus.offBody;
  if (health.refused) return copy.syncStatus.refusedBody;
  if (health.stuck > 0) return copy.syncStatus.stuckBody(health.stuck);
  // Refused but still retrying. Said before "waiting", because it is a verdict and the operator
  // needs to know it will not come right on its own.
  if (health.refusedPending > 0) {
    return copy.syncStatus.refusedPendingBody(health.refusedPending, refusalReason);
  }
  if (health.level === "WAITING") {
    return health.waiting > 0 ? copy.syncStatus.waitingBody(health.waiting) : copy.syncStatus.waitingBodyNoCount;
  }
  return health.busy ? copy.syncStatus.workingBusyBody : copy.syncStatus.workingBody;
}

interface SyncDetailPanelProps {
  panelRef: React.RefObject<HTMLDivElement | null>;
  anchor: DOMRect;
  headline: string;
  body: string;
  age: string | null;
  waiting: number;
  stuck: number;
  refusedPending: number;
  showActions: boolean;
  sending: boolean;
  sendError: string | null;
  onSendNow: () => void;
  onOpenSettings: () => void;
}

/**
 * The detail behind the dot: the same answer in a sentence, the two numbers worth knowing, and
 * the two things a person can do about it.
 *
 * Positioned against the trigger's rect rather than nested in it, because it is portalled to
 * the body — see the note at the top of this file on why.
 */
const SyncDetailPanel: React.FC<SyncDetailPanelProps> = ({
  panelRef,
  anchor,
  headline,
  body,
  age,
  waiting,
  stuck,
  refusedPending,
  showActions,
  sending,
  sendError,
  onSendNow,
  onOpenSettings,
}) => (
  <div
    ref={panelRef}
    className="sync-detail"
    role="dialog"
    aria-label={copy.syncStatus.label}
    style={{ top: `${String(Math.round(anchor.bottom + 8))}px`, right: `${String(Math.round(window.innerWidth - anchor.right))}px` }}
  >
    <div className="sync-detail-head">{headline}</div>
    <p className="sync-detail-body">{body}</p>

    <dl className="sync-detail-facts">
      <div>
        <dt>{copy.syncStatus.lastSuccess}</dt>
        <dd>{age ?? copy.syncStatus.never}</dd>
      </div>
      <div>
        <dt>{copy.syncStatus.waitingCount}</dt>
        <dd>{waiting.toLocaleString()}</dd>
      </div>
      {refusedPending > 0 && (
        <div>
          <dt>{copy.syncStatus.refusedCount}</dt>
          <dd className="sync-detail-stuck">{refusedPending.toLocaleString()}</dd>
        </div>
      )}
      {stuck > 0 && (
        <div>
          <dt>{copy.syncStatus.stuckCount}</dt>
          <dd className="sync-detail-stuck">{stuck.toLocaleString()}</dd>
        </div>
      )}
    </dl>

    {sendError !== null && (
      <p className="sync-detail-error" role="status">
        {sendError}
      </p>
    )}

    {showActions && (
      <div className="sync-detail-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={sending} onClick={onSendNow}>
          {sending ? copy.syncStatus.sending : copy.syncStatus.syncNow}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onOpenSettings}>
          {copy.syncStatus.openSettings}
        </button>
      </div>
    )}
  </div>
);
