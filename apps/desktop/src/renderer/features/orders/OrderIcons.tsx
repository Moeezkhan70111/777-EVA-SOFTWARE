import React from "react";

// Enter Orders' two marks, drawn as SVG on a 24-unit box so they sit at the optical centre of their tiles (a text "✕"
// or "✓" rides on the font's baseline and looks low). Decorative: the button around each carries its name.

export const OrderCloseIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
    <path d="M7 7l10 10M17 7L7 17" />
  </svg>
);

export const OrderCheckIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 12.5l4 4 8-9" />
  </svg>
);
