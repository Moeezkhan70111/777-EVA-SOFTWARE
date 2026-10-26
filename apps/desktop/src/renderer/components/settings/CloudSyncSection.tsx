import React, { useCallback, useEffect, useState } from "react";
import { StateView } from "../shared/StateView";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import { copy } from "../../config/copy";
import type { CloudSyncStatus, DeadLetterEvent, DesktopApi } from "../../types/desktopApi";
import { BackfillPanel } from "../../features/sync/BackfillPanel";

// WHAT THIS COMPUTER HAS SENT, AND THE TWO THINGS AN ADMINISTRATOR CAN DO ABOUT IT.
//
// Until this panel existed, both actions were reachable only from the DevTools console: the IPC
// channels were registered, bridged and typed, and nothing called them. So a parked carton --
// one the cloud refused its agreed number of times -- could not be seen or recovered by anyone
// working in the application.
//
// WHAT IT DOES NOT DO. There is no scheduler and no background pass: a sync happens when an
// administrator asks for one, which is what the main process offers and all it offers. There is
// no "put everything back" either, deliberately -- the reason each event stopped is its own, and
// a sweep would spend five fresh attempts on every one of them against a cause nobody has looked
// at. One event, named, per action.
//
// WHAT IT NEVER SHOWS. A parked event is listed by what identifies it -- the aggregate type and
// id -- and why it stopped. The payload is not in the shape the main process hands over at all,
// so a production scan's operator, station and article snapshots cannot reach this screen. The
// key, the token and the device password never leave the main process.

type SyncOutcome = Awaited<ReturnType<DesktopApi["runCloudSync"]>>;

/**
 * The bridge's answers, checked before they are rendered.
 *
 * A missing field must not blank the panel or throw inside render (CLAUDE.md R25: a type
 * declaration is not a runtime guarantee). Both guards check only what this panel reads.
 */
const isStatus = (value: unknown): value is CloudSyncStatus => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const queue = record.queue as Record<string, unknown> | undefined;
  return (
    typeof record.configured === "boolean" &&
    typeof record.running === "boolean" &&
    typeof record.pullCursor === "number" &&
    typeof queue === "object" &&
    queue !== null &&
    typeof queue.pushableNow === "number" &&
    typeof queue.counts === "object" &&
    queue.counts !== null
  );
};

const isDeadLetter = (value: unknown): value is DeadLetterEvent => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.outboxId === "string" &&
    record.outboxId !== "" &&
    typeof record.aggregateType === "string" &&
    typeof record.aggregateId === "string" &&
    typeof record.attempts === "number"
  );
};

/** A time this computer actually recorded, or "Never". Nothing here invents one. */
const when = (iso: string | null | undefined): string =>
  iso === null || iso === undefined || iso === "" ? copy.sync.never : new Date(iso).toLocaleString();

interface CloudSyncSectionProps {
  /** Only an administrator is offered a pass or a requeue; the main process requires it too. */
  isAdmin: boolean;
}

export const CloudSyncSection: React.FC<CloudSyncSectionProps> = ({ isAdmin }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [status, setStatus] = useState<CloudSyncStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [parked, setParked] = useState<DeadLetterEvent[] | null>(null);
  const [parkedFailed, setParkedFailed] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null);
  const [confirming, setConfirming] = useState<DeadLetterEvent | null>(null);

  // getCloudSyncStatus THROWS on an authorisation failure rather than answering with a refusal
  // shape, unlike the other three channels. Caught here so the rest of Settings still renders.
  const loadStatus = useCallback(async () => {
    setStatusFailed(false);
    try {
      const answer: unknown = await api.getCloudSyncStatus();
      if (!isStatus(answer)) throw new Error("unexpected shape");
      setStatus(answer);
    } catch {
      setStatus(null);
      setStatusFailed(true);
    }
  }, [api]);

  // Admin-only on the main process side, so a non-administrator is never asked: the call would
  // come back refused and the refusal would read like a fault.
  const loadParked = useCallback(async () => {
    if (!isAdmin) return;
    setParkedFailed(null);
    try {
      const answer = await api.listDeadLetterEvents();
      if (!answer.accepted) {
        setParked(null);
        setParkedFailed(answer.reason ?? copy.sync.parkedLoadFailed);
        return;
      }
      setParked((answer.entries ?? []).filter(isDeadLetter));
    } catch {
      setParked(null);
      setParkedFailed(copy.sync.parkedLoadFailed);
    }
  }, [api, isAdmin]);

  useEffect(() => {
    void loadStatus();
    void loadParked();
  }, [loadStatus, loadParked]);

  const runSync = async (): Promise<void> => {
    setSyncing(true);
    try {
      const result = await api.runCloudSync();
      // KEPT WHETHER OR NOT IT WAS ACCEPTED. A transport failure part-way through still carries
      // the counts of what did go, and throwing them away would make a partial pass look like
      // nothing at all.
      setOutcome(result);
      if (result.accepted) {
        push(
          "success",
          copy.sync.doneTitle,
          copy.sync.doneBody(result.pushed ?? 0, result.applied ?? 0, result.duplicates ?? 0)
        );
      } else {
        push("error", copy.sync.failedTitle, result.reason);
      }
    } catch {
      setOutcome(null);
      push("error", copy.sync.failedTitle, copy.common.unknownError);
    } finally {
      setSyncing(false);
      await loadStatus();
      await loadParked();
    }
  };

  /**
   * Re-reads both views. Cannot throw: `loadStatus` and `loadParked` each catch and record
   * their own failure. Wrapped anyway so this function's contract is local rather than
   * inherited — a refresh must never replace the error an operator is waiting to read.
   */
  const refresh = async (): Promise<void> => {
    try {
      await loadStatus();
      await loadParked();
    } catch {
      // Already reflected in the panel's own error states.
    }
  };

  /**
   * Resolves with a reason to keep the dialog open, or null to close it.
   *
   * NEVER REJECTS. ConfirmDialog awaits this inside a try/finally with no catch, so a rejection
   * here would clear the busy flag, show nothing, close nothing, and escape as an unhandled
   * promise rejection — the operator would click Put Back and watch the dialog do nothing at
   * all. A thrown call is therefore turned into a visible reason, and the event is never
   * reported as requeued when it was not.
   */
  const requeue = async (event: DeadLetterEvent): Promise<string | null> => {
    let result: Awaited<ReturnType<DesktopApi["requeueDeadLetterEvent"]>>;
    try {
      result = await api.requeueDeadLetterEvent(event.outboxId);
    } catch {
      // The queue may still have moved, so the views are re-read — but the message the operator
      // sees is the one about the action they took, not about the refresh.
      await refresh();
      return copy.common.unknownError;
    }

    await refresh();
    if (!result.accepted) return result.reason ?? copy.sync.parkedLoadFailed;
    push("success", copy.sync.putBackDoneTitle, copy.sync.putBackDoneBody(event.aggregateId));
    return null;
  };

  return (
    <div className="settings-section">
      <div className="settings-section-title">{copy.sync.title}</div>

      {statusFailed && <StateView kind="error" compact onRetry={() => void loadStatus()} />}
      {!statusFailed && status === null && <StateView kind="loading" compact />}
      {status !== null && (
        <SyncFacts
          status={status}
          isAdmin={isAdmin}
          syncing={syncing}
          outcome={outcome}
          onRun={() => void runSync()}
        />
      )}

      {/* Parked events are an administrator's concern and an administrator's action. */}
      {isAdmin && (
        <ParkedEvents
          parked={parked}
          failure={parkedFailed}
          onRetry={() => void loadParked()}
          onPutBack={setConfirming}
        />
      )}

      {/* The one-time backfill: an administrator, on the store computer. */}
      {isAdmin && status?.configured === true && <BackfillPanel />}

      {confirming !== null && (
        <ConfirmDialog
          title={copy.sync.putBackTitle}
          facts={[
            { label: copy.columns.type, value: confirming.aggregateType },
            { label: copy.columns.code, value: confirming.aggregateId },
            // The bare number: the label already says what it counts. The table keeps
            // "5 refusals" because its own column header does different work.
            { label: copy.sync.refusalsLabel, value: String(confirming.attempts) },
          ]}
          explain={copy.sync.putBackExplain}
          warning={copy.sync.putBackWarning}
          confirmLabel={copy.sync.putBack}
          busyLabel={copy.sync.putBackBusy}
          tone="primary"
          onConfirm={() => requeue(confirming)}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  );
};

// ─── what the panel shows ───────────────────────────────────────────────────

const SyncFacts: React.FC<{
  status: CloudSyncStatus;
  isAdmin: boolean;
  syncing: boolean;
  outcome: SyncOutcome | null;
  onRun: () => void;
}> = ({ status, isAdmin, syncing, outcome, onRun }) => {
  const { queue } = status;
  // Offered only to an administrator, and only where there is something to sync with. A button
  // that would certainly be refused is worse than no button.
  const canRun = isAdmin && status.configured;

  return (
    <>
      <div className="settings-grid">
        <div className="input-group">
          <span className="input-label">{copy.sync.title}</span>
          {status.configured ? (
            <span className="badge badge-ok">{copy.sync.setUpOn(status.host ?? "")}</span>
          ) : (
            <span className="badge badge-warn">{copy.sync.notConfiguredTitle}</span>
          )}
        </div>
        {status.configured && status.email !== undefined && (
          <div className="input-group">
            <span className="input-label">{copy.sync.account}</span>
            <span>{status.email}</span>
          </div>
        )}
        <div className="input-group">
          <span className="input-label">{copy.sync.readyToSend}</span>
          <span>{queue.pushableNow}</span>
        </div>
        <div className="input-group">
          <span className="input-label">{copy.sync.waitingToRetry}</span>
          <span>{queue.pushableWaiting}</span>
        </div>
        <div className="input-group">
          <span className="input-label">{copy.sync.noTransportYet}</span>
          <span>{queue.notPushable}</span>
        </div>
        <div className="input-group">
          <span className="input-label">{copy.sync.parked}</span>
          <span>{queue.counts.DEAD_LETTER}</span>
        </div>
        <div className="input-group">
          <span className="input-label">{copy.sync.sentSoFar}</span>
          <span>{queue.counts.SYNCED}</span>
        </div>
        <div className="input-group">
          <span className="input-label">{copy.sync.lastSent}</span>
          <span>{when(queue.lastSyncedAt)}</span>
        </div>
        <div className="input-group">
          <span className="input-label">{copy.sync.lastFailure}</span>
          <span>{when(queue.lastFailureAt)}</span>
        </div>
        <div className="input-group">
          <span className="input-label">{copy.sync.logReadTo}</span>
          <span>{status.pullCursor}</span>
        </div>
      </div>

      {!status.configured && (
        <p role="status">
          ⚠ {copy.sync.notConfiguredHint}
          {status.problems && status.problems.length > 0 ? ` ${status.problems.join("; ")}` : ""}
        </p>
      )}

      {status.running && <p role="status">{copy.sync.runningNow}</p>}

      {canRun && (
        <button type="button" className="btn btn-primary" onClick={onRun} disabled={syncing || status.running}>
          {syncing ? copy.sync.syncing : copy.sync.syncNow}
        </button>
      )}

      {outcome !== null && <SyncOutcomeLines outcome={outcome} />}
    </>
  );
};

/**
 * The last pass, as the main process reported it.
 *
 * Three different things are kept apart on purpose. A REFUSAL is the cloud declining a specific
 * event and will happen again until someone fixes the cause. A DEFERRAL is the puller waiting on
 * something that has not arrived yet, which is normal and heals itself. A TRANSPORT FAILURE is
 * the pass not finishing -- and it still carries the counts of whatever did get through.
 */
const SyncOutcomeLines: React.FC<{ outcome: SyncOutcome }> = ({ outcome }) => (
  <div className="settings-grid">
    <div className="input-group">
      <span className="input-label">{copy.sync.sentThisPass}</span>
      <span>{outcome.pushed ?? 0}</span>
    </div>
    <div className="input-group">
      <span className="input-label">{copy.sync.appliedLabel}</span>
      <span>{outcome.applied ?? 0}</span>
    </div>
    {!outcome.accepted && outcome.reason !== undefined && (
      <div className="input-group">
        <span className="input-label">{copy.sync.failedTitle}</span>
        <span role="alert">{outcome.reason}</span>
      </div>
    )}
    {outcome.waitingFor !== undefined && (
      <div className="input-group">
        <span className="input-label">{copy.sync.deferredLabel}</span>
        <span role="status">{copy.sync.waitingFor(outcome.waitingFor)}</span>
      </div>
    )}
    {outcome.refused !== undefined && outcome.refused.length > 0 && (
      <div className="input-group">
        <span className="input-label">{copy.sync.refusedLabel}</span>
        <span role="status">{copy.sync.refusedCount(outcome.refused.length)}</span>
      </div>
    )}
  </div>
);

const ParkedEvents: React.FC<{
  parked: DeadLetterEvent[] | null;
  failure: string | null;
  onRetry: () => void;
  onPutBack: (event: DeadLetterEvent) => void;
}> = ({ parked, failure, onRetry, onPutBack }) => {
  if (failure !== null) {
    return <StateView kind="error" compact title={copy.sync.parkedLoadFailed} message={failure} onRetry={onRetry} />;
  }
  if (parked === null) return <StateView kind="loading" compact />;
  if (parked.length === 0) {
    return <StateView kind="empty" compact title={copy.sync.parkedEmpty} hint={copy.sync.parkedEmptyHint} />;
  }

  return (
    <>
      <div className="settings-section-title">{copy.sync.parkedTitle}</div>
      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>{copy.columns.type}</th>
              <th>{copy.columns.code}</th>
              <th>{copy.sync.refusalsLabel}</th>
              <th>{copy.sync.reasonLabel}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {parked.map((event) => (
              <tr key={event.outboxId}>
                <td>{event.aggregateType}</td>
                <td>{event.aggregateId}</td>
                <td>{copy.sync.attempts(event.attempts)}</td>
                <td>{event.error}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => onPutBack(event)}
                    aria-label={`${copy.sync.putBack} ${event.aggregateId}`}
                  >
                    {copy.sync.putBack}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
};
