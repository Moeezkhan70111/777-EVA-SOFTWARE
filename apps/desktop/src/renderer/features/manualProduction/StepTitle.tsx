import React from "react";

// A step of the Manual Production page as a heading: its number (a tick once done) and its name. The same look as
// StepHeading (the generators' steps), but a real heading, so the page reads as Machine, Article, then the list.

interface StepTitleProps {
  id: string;
  index: number;
  done: boolean;
  title: string;
}

export const StepTitle: React.FC<StepTitleProps> = ({ id, index, done, title }) => (
  <h2 id={id} className="mnp-card-title">
    <span className={`qr-step-num${done ? " is-done" : ""}`} aria-hidden="true">{done ? "✓" : index}</span>
    {title}
  </h2>
);
