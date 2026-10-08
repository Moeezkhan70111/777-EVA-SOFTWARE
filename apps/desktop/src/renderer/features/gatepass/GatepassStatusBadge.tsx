import React from "react";
import { GATEPASS_STATUS_LABEL } from "@erp/domain";
import type { GatepassStatus } from "../../types/desktopApi";

// Where a gatepass stands, as one badge — shared by the list, the create screen and the
// journey. The word is the signal: colour only reinforces it, so the status is still readable
// to someone who cannot tell the two greens apart (R18).

/** Finished work is quiet, outstanding work is blue, a torn-up document is red. */
const TONE: Record<GatepassStatus, string> = {
  CREATED: "badge-info",
  BILLED: "badge-info",
  AT_GATE: "badge-info",
  DISPATCHED: "badge-info",
  DELIVERED: "badge-ok",
  CANCELLED: "badge-err",
};

export const GatepassStatusBadge: React.FC<{ status: GatepassStatus }> = ({ status }) => (
  <span className={`badge ${TONE[status] ?? "badge-info"}`}>{GATEPASS_STATUS_LABEL[status] ?? status}</span>
);
