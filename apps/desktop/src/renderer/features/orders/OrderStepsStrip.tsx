import React from "react";
import { copy } from "../../config/copy";
import { OrderCheckIcon } from "./OrderIcons";
import type { OrderSteps } from "./orderDraft";

// THE ORDER'S THREE STEPS, beside the total (owner, 24 Nov 2026):
//
//   (✓) Party ── (✓) Articles ── (3) Dozens        Next: type the dozens
//   ████████████████████░░░░░░░░░
//
// Zeigarnik: what is unfinished stays in view. Goal-gradient: the bar fills as the order nears saving, which speeds
// the last step. The next step is said in words beside it (the paradox of the active user: guidance where the eye
// already is, not a manual). A step is marked by a tick AND its words, never by colour alone.

const words = copy.orders;
const STEP_KEYS = ["party", "articles", "dozens"] as const;

export const OrderStepsStrip: React.FC<{ steps: OrderSteps; showNext: boolean }> = ({ steps, showNext }) => {
  const done = STEP_KEYS.filter((key) => steps[key]).length;
  return (
    <div className="ord-steps">
      <ol className="ord-steps-list" aria-label={words.stepsLabel(done, STEP_KEYS.length)}>
        {STEP_KEYS.map((key, index) => (
          <li key={key} className={steps[key] ? "ord-step is-done" : "ord-step"}>
            <span className="ord-step-mark" aria-hidden="true">{steps[key] ? <OrderCheckIcon /> : index + 1}</span>
            {words.steps[key]}
          </li>
        ))}
      </ol>
      <span className="ord-steps-bar" aria-hidden="true"><span style={{ width: `${(done / STEP_KEYS.length) * 100}%` }} /></span>
      {showNext ? <span className="ord-next" aria-live="polite">{words.nextStep[steps.next]}</span> : null}
    </div>
  );
};
