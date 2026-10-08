import React from "react";
import { copy } from "../../config/copy";
import type { GatepassStatus } from "../../types/desktopApi";

// What the bill says about the gatepass it was made from. Quiet when all is well; loud —
// with the one action that fixes it — when that gatepass has since been cancelled.

export interface GatepassLink {
  id: string;
  code: string;
  status: GatepassStatus;
}

interface GatepassLinkBannerProps {
  link: GatepassLink;
  /** True once the bill exists in the database (the delete action needs it). */
  saved: boolean;
  busy: boolean;
  onDelete: () => void;
}

export const GatepassLinkBanner: React.FC<GatepassLinkBannerProps> = ({ link, saved, busy, onDelete }) => {
  if (link.status === "CANCELLED") {
    return (
      <div className="gp-alert gp-alert--error billing-gatepass-banner" role="alert" data-testid="gatepass-cancelled-bill-banner">
        <div>
          <strong>⚠ {copy.billing.gatepassCancelledTitle(link.code)}</strong>
          <div>{saved ? copy.billing.gatepassCancelledBody : copy.billing.gatepassCancelledUnsaved}</div>
        </div>
        {saved && (
          <button type="button" className="btn btn-primary" onClick={onDelete} disabled={busy} data-testid="delete-bill-for-cancelled-gatepass">
            🗑 {copy.billing.deleteThisVoucher}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="gp-alert billing-gatepass-chip" role="status" data-testid="gatepass-link-chip">
      {copy.billing.fromGatepass(link.code)}
    </div>
  );
};
