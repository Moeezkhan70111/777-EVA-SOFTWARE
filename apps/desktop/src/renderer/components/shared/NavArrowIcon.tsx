import React from "react";

// The ‹ › of the compact document pagers (Gatepass, Sale Voucher). Decorative: the button around it carries the
// name ("Previous Gatepass"), so screen readers say what it does.
export const NavArrowIcon: React.FC<{ direction: "left" | "right" }> = ({ direction }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={direction === "left" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
  </svg>
);
