// The one HTML escaper for every hand-built document (print-outs, labels, rate lists).
// Anything user-entered (article, colour, party, remarks…) must pass through this before
// it is interpolated into an HTML string.

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (value: string | number | null | undefined): string =>
  String(value ?? "").replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
