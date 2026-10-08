import type { QrStage, QrStageCounts } from "../types/desktopApi";

// One vocabulary for a QR's lifecycle, shared by the QR Management overview, the
// expanded code lists and the detail drawer. `QrStage` is the database's derived state
// (registry row + live qr_master row) — this file only decides how to say it.

export interface QrStageMeta {
  /** Full label shown on badges and in the detail drawer. */
  label: string;
  /** Shorter form for dense status summaries ("30 Printed · 15 Production"). */
  short: string;
  badge: string;
  hint: string;
}

export const QR_STAGE_META: Record<QrStage, QrStageMeta> = {
  REGISTERED: {
    label: "Generated",
    short: "Generated",
    badge: "badge-muted",
    hint: "Registered by the QR Generator. Not yet scanned into production.",
  },
  PRODUCED: {
    label: "Production / Stock",
    short: "Production",
    badge: "badge-warn",
    hint: "Scanned in Live Production and counted in production stock.",
  },
  RETURNED: {
    label: "Returned",
    short: "Returned",
    badge: "badge-warn",
    hint: "Came back from a customer and is counted in production stock again.",
  },
  // Raw material only: the packet has left the store for the section that consumes it.
  ISSUED: {
    label: "Issued",
    short: "Issued",
    badge: "badge-muted",
    hint: "This packet has been issued out of the store to the section that uses it.",
  },
  WAREHOUSE: {
    label: "In Store",
    short: "In Store",
    badge: "badge-ok",
    hint: "Received by Store Scanning. In the store / warehouse and counted in stock.",
  },
  TO_GATE: {
    label: "To Gate",
    short: "To Gate",
    badge: "badge-ok",
    hint: "Moved out of the store by Store Move Out. Waiting at the gate, ready to be dispatched, still counted in stock.",
  },
  DISPATCHED: {
    label: "Dispatched",
    short: "Dispatched",
    badge: "badge-navy",
    hint: "Left the factory for a customer.",
  },
  ON_GATE: {
    label: "On Gate",
    short: "On Gate",
    badge: "badge-warn",
    hint: "Returned by the customer and standing at the gate. The customer has been credited, but the carton is not in stock until Store Move In receives it.",
  },
  SOLD: {
    label: "Sold",
    short: "Sold",
    badge: "badge-navy",
    hint: "Sold to a customer.",
  },
  VOID: {
    label: "Void",
    short: "Void",
    badge: "badge-err",
    hint: "Withdrawn before production. The production scanner refuses this code.",
  },
  DAMAGED: {
    label: "Damaged",
    short: "Damaged",
    badge: "badge-err",
    hint: "Written off as damaged. Not counted in stock.",
  },
  SCRAPPED: {
    label: "Scrapped",
    short: "Scrapped",
    badge: "badge-err",
    hint: "Scrapped. Not counted in stock.",
  },
};

export const qrStageMeta = (stage: QrStage | string): QrStageMeta =>
  QR_STAGE_META[stage as QrStage] ?? {
    label: String(stage),
    short: String(stage),
    badge: "badge-muted",
    hint: "",
  };

/**
 * Display order for tallies: the forward lifecycle first, then the states that leave it.
 * Stages with a zero count are omitted by callers, so the order only matters for what
 * is shown.
 */
export const QR_STAGE_ORDER: QrStage[] = [
  "REGISTERED",
  "PRODUCED",
  "RETURNED",
  "WAREHOUSE",
  "ISSUED",
  "TO_GATE",
  "DISPATCHED",
  "ON_GATE",
  "SOLD",
  "VOID",
  "DAMAGED",
  "SCRAPPED",
];

export const orderedStageCounts = (counts: QrStageCounts): Array<{ stage: QrStage; count: number }> =>
  QR_STAGE_ORDER.map((stage) => ({ stage, count: counts[stage] ?? 0 })).filter((entry) => entry.count > 0);

/**
 * The canonical lifecycle a code moves through. Only steps the system actually records
 * are `tracked`; the others are shown so the order is clear, but no code is ever placed
 * on them — there is no scan or event in the database that could put it there.
 */
export interface QrLifecycleStep {
  key: string;
  label: string;
  /** Derived stages that sit at this step. */
  stages: QrStage[];
  tracked: boolean;
  /** Why an untracked step is untracked, for the tooltip. */
  note?: string;
}

export const QR_LIFECYCLE_RAIL: QrLifecycleStep[] = [
  { key: "GENERATED", label: "Generated", stages: ["REGISTERED"], tracked: true },
  { key: "PRODUCTION", label: "Production / Stock", stages: ["PRODUCED", "RETURNED"], tracked: true },
  { key: "IN_STORE", label: "In Store", stages: ["WAREHOUSE"], tracked: true },
  { key: "TO_GATE", label: "To Gate", stages: ["TO_GATE"], tracked: true },
  { key: "DISPATCHED", label: "Dispatched", stages: ["DISPATCHED", "SOLD"], tracked: true },
  // A returned carton steps back onto the rail here: credited, at the gate, waiting for the
  // store to receive it and put it back on "In Store".
  { key: "ON_GATE", label: "On Gate (returned)", stages: ["ON_GATE"], tracked: true },
  {
    key: "DELIVERED",
    label: "Delivered",
    stages: [],
    tracked: false,
    note: "Customer receiving is not recorded yet, so no code reaches this step.",
  },
];

/** States that leave the forward lifecycle rather than sitting on a step of it. */
export const QR_OFF_RAIL_STAGES: QrStage[] = ["VOID", "DAMAGED", "SCRAPPED"];

/**
 * A raw material packet has a shorter life than a carton: it is printed, received into the
 * store, and issued to the section that consumes it. There is no production, gate or
 * customer step, so it gets its own rail rather than being shown against a carton's.
 */
export const RAW_MATERIAL_LIFECYCLE_RAIL: QrLifecycleStep[] = [
  { key: "GENERATED", label: "Generated", stages: ["REGISTERED"], tracked: true },
  { key: "IN_STORE", label: "In Store", stages: ["WAREHOUSE"], tracked: true },
  { key: "ISSUED", label: "Issued to section", stages: ["ISSUED"], tracked: true },
];

/** The rail a code belongs on. */
export const lifecycleRailFor = (kind: "CARTON" | "RAW_MATERIAL" | undefined): QrLifecycleStep[] =>
  kind === "RAW_MATERIAL" ? RAW_MATERIAL_LIFECYCLE_RAIL : QR_LIFECYCLE_RAIL;

/** Index of the rail step a derived stage sits on, or -1 when it has left the rail. */
export const railIndexOf = (stage: QrStage, rail: QrLifecycleStep[] = QR_LIFECYCLE_RAIL): number =>
  rail.findIndex((step) => step.stages.includes(stage));
