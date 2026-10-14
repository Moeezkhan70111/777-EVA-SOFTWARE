import React from "react";
import { STORE_MOVEMENT_SOURCE, type StoreMovementSource } from "@erp/domain";
import { copy } from "../../../config/copy";

// The kind of a movement, as a small badge in its row. The word is always there — the colour
// only helps the eye find scans among typed moves (R18).

const TONE: Record<StoreMovementSource, string> = {
  [STORE_MOVEMENT_SOURCE.SCAN]: "badge-info",
  [STORE_MOVEMENT_SOURCE.MANUAL]: "badge-warn",
  [STORE_MOVEMENT_SOURCE.DANA]: "badge-warn",
  [STORE_MOVEMENT_SOURCE.CUT_SIZE]: "badge-muted",
  [STORE_MOVEMENT_SOURCE.CARTON]: "badge-ok",
  [STORE_MOVEMENT_SOURCE.GATE_RETURN]: "badge-muted",
  [STORE_MOVEMENT_SOURCE.OPENING]: "badge-muted",
  [STORE_MOVEMENT_SOURCE.CORRECTION]: "badge-err",
  [STORE_MOVEMENT_SOURCE.OTHER]: "badge-muted",
};

export const SourceBadge: React.FC<{ source: StoreMovementSource }> = ({ source }) => (
  <span className={`badge ${TONE[source]}`}>{copy.storeDailyReport.sourceTags[source]}</span>
);
