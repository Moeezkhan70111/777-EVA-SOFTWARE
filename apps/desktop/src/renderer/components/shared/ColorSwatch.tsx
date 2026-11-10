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
  mustard: "#d9a520",
  orange: "#ea7317",
  yellow: "#facc15",
  sky: "#38bdf8",
  golden: "#d4a017",
  skin: "#e8b796",
  neon: "#a3e635",
  commando: "#4b5320",
  "army green": "#4b5320",
  "dark caramel": "#8a5a2b",
  "smoke grey": "#7d8590",
  "sand grey": "#b8ad9a",
  "silver grey": "#cbd5e1",
  "light coffee": "#a47c5b",
  "light coffe": "#a47c5b",
  "brown mitalic": "#7a4e2d",
};

const UNKNOWN_COLOUR = "#64748b";

export const getColorHex = (color: string): string => COLOR_HEX[color.trim().toLowerCase()] ?? UNKNOWN_COLOUR;

/** "blackblue" as ["black", "blue"] when both halves are known colours; otherwise the name as it is. */
const splitJoined = (name: string): string[] => {
  for (let cut = 3; cut <= name.length - 3; cut += 1) {
    if (COLOR_HEX[name.slice(0, cut)] && COLOR_HEX[name.slice(cut)]) return [name.slice(0, cut), name.slice(cut)];
  }
  return [name];
};

/**
 * The swatch's fill. A colour the store names from two (BLACK RED, or BLACKRED) is drawn as both,
 * half and half; one nobody has mapped is a neutral grey, and its printed name still says what it is.
 */
export const swatchBackground = (color: string): string => {
  const normalized = color.trim().toLowerCase();
  if (COLOR_HEX[normalized]) return COLOR_HEX[normalized];
  // Products store a pair of colours joined (BLACKBLUE) as well as spaced (BLACK BLUE).
  const words = normalized.includes(" ") ? normalized.split(/\s+/) : splitJoined(normalized);
  const [first, second] = words.flatMap((word) => COLOR_HEX[word] ?? []);
  if (first && second) return `linear-gradient(90deg, ${first} 50%, ${second} 50%)`;
  return first ?? UNKNOWN_COLOUR;
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
  <span className={`color-swatch${className ? ` ${className}` : ""}`} style={{ background: swatchBackground(color) }} aria-hidden="true" />
);
