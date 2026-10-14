import React from "react";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import type { PolledRead } from "../../hooks/usePolledRead";
import type { UpperIssueSummary, UpperIssueTotals } from "../../types/desktopApi";
import { formatUpperQuantities } from "./upperFeedback";

// SUMMARY — three different measures, each labelled for what it is:
//
//   THIS SESSION (#12)     TODAY TO THIS MACHINE     UPPER STOCK IN STORE
//   4 packets              6 packets                 38 packets
//   20 DOZEN               30 DOZEN                  190 DOZEN
//
// The session is this station's Raw Material Output issue session (the existing one). Quantities stay
// in each material's own unit, side by side, never added across units. All counted by the database.

const text = copy.upperMoveOut;

const Measure: React.FC<{ label: string; totals: UpperIssueTotals }> = ({ label, totals }) => (
  <div className="um-measure">
    <dt>{label}</dt>
    <dd>
      <strong>{totals.packets === 0 ? text.nothing : text.packets(totals.packets)}</strong>
      {totals.packets > 0 ? <span>{formatUpperQuantities(totals.quantities)}</span> : null}
    </dd>
  </div>
);

export const UpperSummaryCard: React.FC<{ summary: PolledRead<UpperIssueSummary | null> }> = ({ summary }) => {
  const value = summary.value;
  if (!value) {
    if (summary.error) return <StateView kind="error" compact message={text.summaryFailed} onRetry={() => void summary.reload()} />;
    return null;
  }
  return (
    <section className="card um-summary" aria-labelledby="um-summary-title">
      <h2 id="um-summary-title" className="section-label">{text.summaryTitle}</h2>
      <dl className="um-measures">
        <Measure label={text.summarySession(value.session.sessionNumber)} totals={value.session} />
        <Measure label={text.summaryToday} totals={value.day} />
        <Measure label={text.summaryStock} totals={value.stock} />
      </dl>
    </section>
  );
};
