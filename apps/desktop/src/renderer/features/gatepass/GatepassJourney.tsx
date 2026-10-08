import React from "react";
import type { GatepassJourneyStep } from "../../types/desktopApi";
import { StateView } from "../../components/shared/StateView";
import { formatDateTime } from "../../utils/dates";
import { copy } from "../../config/copy";

// Where a gatepass has got to, as a list of steps the operator can read at a glance:
// what has happened, what is happening now, and what is still to come.
//
// The steps, their order and their state all come from the data layer's getGatepassJourney,
// which reads them from the audit trail. Nothing here decides whether a step is done, and no
// time is ever shown that was not actually recorded — a step with no timestamp is simply one
// that has not happened yet.

const MARK: Record<GatepassJourneyStep["state"], string> = {
  DONE: "✓",
  CURRENT: "●",
  PENDING: "○",
};

/** Said in words as well as marked, so the state never rests on the symbol alone (R18). */
const STATE_WORD: Record<GatepassJourneyStep["state"], string> = {
  DONE: "Done",
  CURRENT: "Now",
  PENDING: "Pending",
};

interface GatepassJourneyProps {
  steps: GatepassJourneyStep[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** A cancelled document never finished its journey; the steps it did reach still stand. */
  cancelled?: boolean;
}

export const GatepassJourney: React.FC<GatepassJourneyProps> = ({ steps, loading, error, onRetry, cancelled = false }) => {
  if (loading) return <StateView kind="loading" compact message={copy.common.loading} />;
  if (error) return <StateView kind="error" compact message={error} onRetry={onRetry} />;
  if (!steps || steps.length === 0) return null;

  return (
    <div className="gp-journey">
      {cancelled ? (
        <p className="gp-journey-cancelled" role="status">
          ⚠ This gatepass was cancelled. Its journey stopped where it stands below.
        </p>
      ) : null}
      <ol className="gp-journey-list" aria-label="Gatepass journey">
        {steps.map((step) => (
          <li key={step.status} className={`gp-journey-step is-${step.state.toLowerCase()}`} aria-current={step.state === "CURRENT" ? "step" : undefined}>
            <span className="gp-journey-mark" aria-hidden="true">
              {MARK[step.state]}
            </span>
            <span className="gp-journey-body">
              <span className="gp-journey-label">{step.label}</span>
              <span className="gp-journey-meta">
                {step.at ? formatDateTime(step.at) : STATE_WORD[step.state]}
                {step.actor ? ` · ${step.actor}` : ""}
              </span>
            </span>
            {/* A step with a time shows the time, so its state is said here for a screen reader.
                A step without one already reads "Pending" in the line above. */}
            {step.at ? <span className="sr-only">{STATE_WORD[step.state]}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
};
