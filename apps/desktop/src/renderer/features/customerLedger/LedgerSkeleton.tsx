import React from "react";
import { copy } from "../../config/copy";

// What the page shows the moment a customer is chosen, before their ledger arrives (Doherty threshold: an answer
// within 400 ms, even if it is only the shape of what is coming). Same places and sizes as the real cards and table,
// so nothing moves when they land (no layout shift). Said to a screen reader as loading (R12).

const text = copy.customerLedger;
const ROWS = 6;

export const HeroSkeleton: React.FC = () => (
  <div className="cl-hero cl-skeleton-hero" aria-hidden="true">
    <span className="cl-skeleton cl-skeleton--label" />
    <span className="cl-skeleton cl-skeleton--figure" />
    <span className="cl-skeleton cl-skeleton--line" />
  </div>
);

export const WorkspaceSkeleton: React.FC = () => (
  <section className="cl-workspace card cl-skeleton-workspace" role="status" aria-label={text.loadingLabel}>
    <span className="sr-only">{text.loading}</span>
    <div className="cl-workspace-head"><span className="cl-skeleton cl-skeleton--tabs" /><span className="cl-skeleton cl-skeleton--period" /></div>
    <div className="cl-ledger-tab">
      <span className="cl-skeleton cl-skeleton--equation" />
      {Array.from({ length: ROWS }, (_, index) => <span key={index} className="cl-skeleton cl-skeleton--row" />)}
    </div>
  </section>
);
