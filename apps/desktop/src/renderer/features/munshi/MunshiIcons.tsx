import React from "react";

// Pictures for the Munshi's cards, drawn in the same line style and on the same 24×24 grid as
// the store station's icons (features/store/StoreIcons.tsx), so the two stations look like one
// system. Raw Material Stock reuses that file's StockIcon rather than drawing a second box.

/** A gatepass being written: a sheet with lines and a pen. */
export const GatepassIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7" />
    <path d="M14 3v5h5" />
    <path d="M8 11h5M8 15h3" />
    <path d="m18.5 13.5 2 2-4 4H14v-2.5Z" />
  </svg>
);

/** The book of gatepasses: a stack of numbered rows. */
export const GatepassListIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18" />
    <path d="M7 13h10M7 16.5h6" />
  </svg>
);
