import React from "react";
import type { StoreDaySummary } from "@erp/domain";
import { copy } from "../../../config/copy";

// The day at a glance, one figure per kind of movement:
//
//   Movements 18 · Scanned packets 12 · By hand 2 · Dana for programs 1 · Cartons 3

const text = copy.storeDailyReport;

const Tile: React.FC<{ label: string; value: number; total?: boolean }> = ({ label, value, total }) => (
  <li className={`sdr-tile${total ? " sdr-tile--total" : ""}`}>
    <span className="sdr-tile-label">{label}</span>
    <strong className="sdr-tile-value">{value.toLocaleString("en-US")}</strong>
  </li>
);

export const DaySummary: React.FC<{ summary: StoreDaySummary }> = ({ summary }) => (
  <ul className="sdr-tiles" aria-label={text.summaryLabel}>
    <Tile label={text.movements} value={summary.movements} total />
    {summary.bySource.map((row) => (
      <Tile key={row.source} label={text.sources[row.source]} value={row.count} />
    ))}
  </ul>
);
