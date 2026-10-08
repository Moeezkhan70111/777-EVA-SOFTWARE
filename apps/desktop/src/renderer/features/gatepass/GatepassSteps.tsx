import React from "react";
import { copy } from "../../config/copy";

// A quiet "1 Party → 2 Articles & Colors → 3 Summary" under the title. Guidance only:
// nothing is gated on it and everything stays on one screen.

interface GatepassStepsProps {
  partyDone: boolean;
  articlesDone: boolean;
}

export const GatepassSteps: React.FC<GatepassStepsProps> = ({ partyDone, articlesDone }) => {
  const current = !partyDone ? 1 : !articlesDone ? 2 : 3;
  const steps = [copy.gatepass.steps.party, copy.gatepass.steps.articles, copy.gatepass.steps.summary];

  return (
    <ol className="gp-steps" aria-label="Progress">
      {steps.map((label, index) => {
        const number = index + 1;
        const state = number < current ? "is-done" : number === current ? "is-current" : "";
        return (
          <li key={label} className={`gp-step ${state}`.trim()} aria-current={number === current ? "step" : undefined}>
            <span className="gp-step-no" aria-hidden="true">
              {number}
            </span>
            <span className="gp-step-label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
};
