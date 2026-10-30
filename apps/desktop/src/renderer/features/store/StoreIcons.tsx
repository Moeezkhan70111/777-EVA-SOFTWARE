import React from "react";

// The store's two pictures: a box with an arrow going into the store, and a box with an arrow
// leaving it. Drawn with plain strokes so they read at any size and in any colour.

/** A store (a simple building) with a box arrow going in or coming out. */
/** The arrow on the card's Start button. */
export const ArrowRightIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const ArrowLeftIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M19 12H5M11 6l-6 6 6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** A box with a plus: a material the store has never had before. */
export const NewMaterialIcon: React.FC = () => (
  <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <path d="M6 15l18-9 18 9v18l-18 9-18-9V15z" stroke="currentColor" strokeWidth="2.8" strokeLinejoin="round" />
    <path d="M6 15l18 9 18-9M24 24v18" stroke="currentColor" strokeWidth="2.8" strokeLinejoin="round" />
    <circle cx="37" cy="37" r="9" fill="var(--surface)" stroke="currentColor" strokeWidth="2.8" />
    <path d="M37 32.5v9M32.5 37h9" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
  </svg>
);

/** A QR code: three finder squares and a scatter of modules. */
export const QrLabelIcon: React.FC = () => (
  <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <rect x="6" y="6" width="14" height="14" rx="2.5" stroke="currentColor" strokeWidth="2.8" />
    <rect x="28" y="6" width="14" height="14" rx="2.5" stroke="currentColor" strokeWidth="2.8" />
    <rect x="6" y="28" width="14" height="14" rx="2.5" stroke="currentColor" strokeWidth="2.8" />
    <rect x="11" y="11" width="4" height="4" fill="currentColor" />
    <rect x="33" y="11" width="4" height="4" fill="currentColor" />
    <rect x="11" y="33" width="4" height="4" fill="currentColor" />
    <path d="M28 28h5v5h-5zM37 28h5v5h-5zM28 37h5v5h-5zM37 37h5v5h-5zM33 33h4v4h-4z" fill="currentColor" />
  </svg>
);

/** Shelves holding boxes: what is in the store. */
export const StockIcon: React.FC = () => (
  <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <path d="M6 6v36M42 6v36M6 24h36M6 42h36" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
    <rect x="11" y="12" width="10" height="12" rx="1.5" stroke="currentColor" strokeWidth="2.6" />
    <rect x="24" y="15" width="12" height="9" rx="1.5" stroke="currentColor" strokeWidth="2.6" />
    <rect x="11" y="31" width="14" height="11" rx="1.5" stroke="currentColor" strokeWidth="2.6" />
    <rect x="28" y="29" width="9" height="13" rx="1.5" stroke="currentColor" strokeWidth="2.6" />
  </svg>
);

/** A receipt with a zig-zag foot: bills and deliveries. */
export const ReceiptIcon: React.FC = () => (
  <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <path d="M10 5h28v38l-4.7-3-4.6 3-4.7-3-4.7 3-4.6-3L10 43V5z" stroke="currentColor" strokeWidth="2.8" strokeLinejoin="round" />
    <path d="M16 14h16M16 21h16M16 28h10" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
  </svg>
);

/** A gear: categories, units and destinations. */
export const SetupIcon: React.FC = () => (
  <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <circle cx="24" cy="24" r="6.5" stroke="currentColor" strokeWidth="2.8" />
    <path d="M24 4.5v6M24 37.5v6M4.5 24h6M37.5 24h6M10.2 10.2l4.3 4.3M33.5 33.5l4.3 4.3M10.2 37.8l4.3-4.3M33.5 14.5l4.3-4.3" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
    <circle cx="24" cy="24" r="13.5" stroke="currentColor" strokeWidth="2.8" />
  </svg>
);

/** A handheld scanner reading a box: receiving packets into the store. */
export const ScanInIcon: React.FC = () => (
  <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <path d="M6 14V8a2 2 0 0 1 2-2h6M34 6h6a2 2 0 0 1 2 2v6M42 34v6a2 2 0 0 1-2 2h-6M14 42H8a2 2 0 0 1-2-2v-6" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
    <path d="M13 16v16M18 16v16M23 16v16M29 16v16M35 16v16" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
    <path d="M9 24h30" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".55" />
  </svg>
);
