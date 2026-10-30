import React from "react";
import { copy } from "../../config/copy";
import type { WriteLeaseStatus } from "../../types/desktopApi";

// The one way a screen says "this domain is written on another computer" (docs/37 section W).
// Shown above a leased screen on a reader; renders nothing where this computer may write. Says it
// in words with a lock, never by colour alone (R18).

/** The sentence for a refusal, or null when this computer may write. */
export const readOnlyReason = (status: WriteLeaseStatus): string | null => {
  if (status.canWrite) return null;
  const what = copy.writeLease.domainName[status.domain];
  switch (status.reason) {
    case "HELD_ELSEWHERE":
      return copy.writeLease.heldElsewhere(what, status.holderLabel);
    case "NOT_HELD":
      return copy.writeLease.notHeld(what);
    case "CATCHING_UP":
      return copy.writeLease.catchingUp(what);
    case "NO_LEASE_INFO":
      return copy.writeLease.noLeaseInfo(what);
    default:
      return copy.writeLease.notReady;
  }
};

export const ReadOnlyNotice: React.FC<{ status: WriteLeaseStatus | null }> = ({ status }) => {
  const reason = status === null ? null : readOnlyReason(status);
  if (reason === null) return null;
  return (
    <div className="read-only-notice" role="status" data-testid="read-only-notice">
      <span className="read-only-notice-icon" aria-hidden="true">🔒</span>
      <div>
        <div className="read-only-notice-title">{copy.writeLease.readOnlyTitle}</div>
        <div className="read-only-notice-body">{reason}</div>
      </div>
    </div>
  );
};
