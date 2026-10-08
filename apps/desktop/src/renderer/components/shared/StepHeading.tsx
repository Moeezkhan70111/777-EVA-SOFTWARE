import React from "react";

// Numbered step header for a step-by-step generation flow (QR Generator, Raw Material QR
// Generator, …) — one implementation so every such flow looks and behaves the same (R1).
export const StepHeading: React.FC<{
  index: number;
  done: boolean;
  title: string;
}> = ({ index, done, title }) => (
  <div className="qr-step-head">
    <span className={`qr-step-num${done ? " is-done" : ""}`} aria-hidden="true">
      {done ? "✓" : index}
    </span>
    <span className="qr-step-title">{title}</span>
  </div>
);
