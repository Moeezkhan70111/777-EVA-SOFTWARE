import React from "react";
import { copy } from "../../config/copy";
import { StateView } from "../../components/shared/StateView";
import { describeWait } from "./syncWaiting";
import { useSyncWaiting } from "./useSyncWaiting";

// The Health page's list of what this computer is waiting on, oldest first, each in words with
// its tier (owner decision 2026-10-25, points 1 and 2). Also what this computer could not send
// (point 5): master-data changes made before it synced, and dead letters.

export const WaitingHere: React.FC = () => {
  const { value, loading, error, reload } = useSyncWaiting();

  if (loading) return <StateView kind="loading" compact message={copy.syncWaiting.hereLoading} />;
  if (error !== null || value === null) {
    return <StateView kind="error" compact message={error ?? copy.syncWaiting.hereFailed} onRetry={() => void reload()} />;
  }

  return (
    <div className="stack">
      {value.unsentMarks > 0 ? <p className="text-small">{copy.syncWaiting.unsentMarks(value.unsentMarks)}</p> : null}
      {value.deadLetters > 0 ? <p className="text-small">{copy.syncWaiting.deadLetters(value.deadLetters)}</p> : null}
      {value.entries.length === 0 ? (
        <StateView kind="empty" compact title={copy.syncWaiting.hereEmpty} />
      ) : (
        <ul className="sync-wait-list">
          {value.entries.map((entry) => {
            const words = describeWait(entry);
            return (
              <li key={entry.dedupeKey}>
                <span className="sync-wait-tier">{copy.syncWaiting.tier[entry.tier]}</span>
                <strong>{words.subject}</strong> — {words.waitingFor}, {copy.syncWaiting.waitedFor(words.duration)}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
