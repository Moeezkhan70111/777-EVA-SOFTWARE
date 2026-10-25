import React, { useState } from "react";
import { copy } from "../../config/copy";
import { appNotice } from "./syncWaiting";
import { useSyncWaiting } from "./useSyncWaiting";

// The app-wide notice that something sent to this computer has not arrived (owner decision
// 2026-10-25, point 1). Over an hour is a warning; over a day is an error that stays up until
// dismissed. A dismissal holds only for the waits it was shown for: a new one brings it back.
//
// Said in words with a symbol, never by colour alone (R18).

export const SyncWaitingNotice: React.FC<{ onOpenHealth: () => void }> = ({ onOpenHealth }) => {
  const { value } = useSyncWaiting();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const notice = appNotice(value);
  if (notice === null || notice.signature === dismissed) return null;

  const stale = notice.level === "STALE";
  return (
    <div className={`sync-notice ${stale ? "is-error" : "is-warning"}`} role={stale ? "alert" : "status"} aria-label={copy.syncWaiting.noticeLabel}>
      <span className="sync-notice-icon" aria-hidden="true">{stale ? "⛔" : "⚠"}</span>
      <p className="sync-notice-body">{notice.text}</p>
      <div className="sync-notice-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onOpenHealth}>
          {copy.syncWaiting.openHealth}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDismissed(notice.signature)}>
          {copy.syncWaiting.dismiss}
        </button>
      </div>
    </div>
  );
};
