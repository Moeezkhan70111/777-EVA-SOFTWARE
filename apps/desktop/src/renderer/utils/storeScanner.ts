// Shared by the store stations (Move In / Move Out): keyboard-wedge scanner conventions and
// the operator-facing vocabulary for a unit's status. Neither page decides anything about a
// QR; these helpers only shape what the scanner typed and how the answer is read.

export { sanitizeScanInput, isCompleteQr } from "./qr";
export { formatTime, formatDateTime } from "./dates";

export const STATUS_LABELS: Record<string, string> = {
  PRODUCED: "Production / Stock",
  RETURNED: "Production / Stock (returned)",
  WAREHOUSE: "In Store",
  TO_GATE: "To Gate",
  DISPATCHED: "Dispatched",
  ON_GATE: "On Gate (returned)",
  SOLD: "Sold",
  DAMAGED: "Damaged",
  SCRAPPED: "Scrapped",
  GENERATED: "Generated",
  VOID: "Void",
};
export const statusLabel = (status?: string | null): string => (status ? STATUS_LABELS[status] ?? status : "—");

export const productLabel = (r: { article?: string; color?: string; size?: string }) =>
  [r.article, r.color, r.size].filter(Boolean).join(" · ") || "—";
