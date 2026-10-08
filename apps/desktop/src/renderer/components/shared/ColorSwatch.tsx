import React from "react";

// Product colour swatches: these are the physical slipper colours (BLACK, NAVY, TAN…), not
// theme colours, so they are deliberately literal and must not follow the design tokens.
// One mapping for every screen that shows a colour dot (Stock, Gatepass, …).
const COLOR_HEX: Record<string, string> = {
  black: "#111827",
  blue: "#2563eb",
  navy: "#1e3a8a",
  red: "#dc2626",
  maroon: "#7f1d1d",
  white: "#f8fafc",
  tan: "#d6b38a",
  brown: "#8b5e3c",
  grey: "#9ca3af",
  gray: "#9ca3af",
  green: "#16a34a",
  olive: "#4d7c0f",
  gold: "#d4a017",
  beige: "#e7d3b1",
  silver: "#cbd5e1",
  pink: "#ec4899",
  purple: "#7c3aed",
  khaki: "#b4a67a",
  cream: "#f5e7c7",
};

export const getColorHex = (color: string): string => {
  const normalized = color.trim().toLowerCase();
  return COLOR_HEX[normalized] ?? (color ? `#${(normalized.replace(/[^a-z]/g, "") || "64748b").slice(0, 6)}` : "#64748b");
};

interface ColorSwatchProps {
  color: string;
  className?: string;
}

/**
 * A small dot in the product colour. Decorative only — callers always print the colour
 * name beside it, so colour is never the sole cue (R18).
 */
export const ColorSwatch: React.FC<ColorSwatchProps> = ({ color, className }) => (
  <span className={`color-swatch${className ? ` ${className}` : ""}`} style={{ background: getColorHex(color) }} aria-hidden="true" />
);
