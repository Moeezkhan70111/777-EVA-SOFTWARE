import React, { useCallback, useEffect, useRef, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { DashboardSnapshot } from "../types/desktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { cartonsToDozens } from "@erp/domain";
import { playScanSound } from "../utils/playScanSound";
import { formatTime, productLabel } from "../utils/storeScanner";
import { isCompleteQr, parseQrForDisplay, sanitizeScanInput } from "../utils/qr";
import { copy } from "../config/copy";

// Live Production — the line operator's recording station.
//
//   open the screen → scanner is focused → scan carton → ✓ RECORDED → ready for the next
//
// Every scan goes straight to the main process (processScan), which owns the PRODUCED
// event and the stock move. This page only shows what the business layer answered and
// keeps the scanner ready. Same station layout and scanner-dock conventions as the
// store stations (Move In / Move Out), in the app's navy accent.

// ─── Data helpers ─────────────────────────────────────────────────────────────
// QR shape and article/colour/size come from the shared scanner utils, which defer to the
// @erp/domain parser; this page never decides what a code means.

type ScanStatus = "idle" | "success" | "error";

interface ScanResult {
  status: ScanStatus;
  article: string;
  color: string;
  size: string;
  serial?: string;
  /** The code as scanned (or as the business layer normalised it). */
  qrId?: string;
  reason?: string;
  /**
   * The carton's identity had never been generated, so this scan registered it (owner,
   * 2026-10-13). Said on the panel rather than passing silently: the production IS recorded,
   * and the operator should know the label came from outside the QR Generator.
   */
  registeredOnScan?: boolean;
}

const IDLE: ScanResult = { status: "idle", article: "", color: "", size: "" };

/** How long a result stays on screen before the station returns to READY (a new scan overrides it at once). */
const RESULT_HOLD_MS = 3500;

const classifyScanError = (
  reason?: string,
): { message: string; label: string } => {
  const n = reason?.toLowerCase() ?? "";
  if (n.includes("invalid") || n.includes("unsupported"))
    return {
      message: "Invalid QR format. Please check the carton label.",
      label: "INVALID FORMAT",
    };
  if (n.includes("article_size_not_found"))
    return {
      message: "Article or size is not registered in Setup.",
      label: "PRODUCT NOT FOUND",
    };
  if (n.includes("already") || n.includes("duplicate"))
    return {
      message: "This unit has already been scanned into production.",
      label: "DUPLICATE SCAN",
    };
  if (n.includes("not registered") || n.includes("product_not_found"))
    return {
      message:
        "This code was never issued. Generate it in the QR Generator before scanning.",
      label: "NOT REGISTERED",
    };
  return { message: reason || "Scan could not be processed.", label: "SCAN REJECTED" };
};

const buildSessionSummary = (snap: DashboardSnapshot | null) => {
  if (!snap) return { byArticle: [], total: 0 };
  const map = new Map<string, { total: number; colors: Map<string, number> }>();
  for (const s of snap.recentScans) {
    const a = s.article || "UNKNOWN",
      c = s.color || "—",
      z = s.size || "";
    const key = z ? `${a} · ${z}` : a;
    if (!map.has(key)) map.set(key, { total: 0, colors: new Map() });
    const e = map.get(key)!;
    e.total += 1;
    e.colors.set(c, (e.colors.get(c) ?? 0) + 1);
  }
  for (const p of snap.byProduct) {
    const parts = p.key.split("_");
    const a = parts[0] || "UNKNOWN",
      c = parts[1] || "—",
      z = parts[2] || "";
    const key = z ? `${a} · ${z}` : a;
    if (!map.has(key)) map.set(key, { total: 0, colors: new Map() });
    const e = map.get(key)!;
    const cur = e.colors.get(c) ?? 0;
    if (p.quantity > cur) {
      e.total = e.total - cur + p.quantity;
      e.colors.set(c, p.quantity);
    }
  }
  const byArticle = [...map.entries()]
    .map(([article, { total, colors }]) => ({
      article,
      total,
      colors: [...colors.entries()],
    }))
    .sort((a, b) => b.total - a.total);
  return { byArticle, total: byArticle.reduce((s, a) => s + a.total, 0) };
};

/** Cartons → dozens for display (the rule lives in @erp/domain units.ts). */
const fmtDzn = (cartons: number): string => `${cartonsToDozens(cartons)}`;

// Product colour swatches (physical slipper colours) — deliberately literal, not theme tokens.
const COLOR_MAP: Record<string, string> = {
  RED: "#db0000", BLUE: "#17365d", GREEN: "#10b981", BLACK: "#111827",
  WHITE: "#f8fafc", YELLOW: "#eab308", BROWN: "#92400e", PINK: "#ec4899",
  PURPLE: "#8b5cf6", ORANGE: "#f97316", GREY: "#64748b", GRAY: "#64748b",
  NAVY: "#1d4ed8", BEIGE: "#d4b996", TAN: "#b49b78", MAROON: "#991b1b",
};
const dot = (c: string) => COLOR_MAP[c.toUpperCase()] ?? "#64748b";

// ─── Styles ────────────────────────────────────────────────────────────────
// Neutral base (white surfaces, cool grey text and lines) with the app's navy as the
// single accent. Scoped entirely under `.lpr` so it never leaks into (or is affected by)
// the app's shared theme.
//
// Layout is two zones in one flex column:
//
//   toolbar
//   workspace ─ recent activity │ scan panel (fills the middle) │ today's output
//
// The workspace takes all remaining height; the activity feed, the scan stage and the
// by-article list each scroll internally, so nothing relies on a magic min-height.

const PAGE_CSS = `
.lpr {
  --pro-50: #eef3f9;
  --pro-100: #dce7f3;
  --pro-200: #bcd0e6;
  --pro-300: #8fb1d3;
  --pro-400: #5a8abc;
  --pro-500: #2d5b8f;
  --pro-600: var(--primary-blue);
  --pro-700: #0f2744;
  --ink: #16202b;
  --ink-2: #4a5568;
  --ink-3: #8794a3;
  --line: #e2e6eb;
  --line-2: #eef1f4;
  --surface: var(--white);
  --canvas: #f4f6f8;
  --ok: #15803d;   --ok-bg: #ecfdf3;   --ok-line: #a7e6c0;
  --warn: #a16207; --warn-bg: #fffbeb; --warn-line: #f2d98a;
  --err: var(--danger-strong);  --err-bg: #fef2f2;  --err-line: #f3b9b9;
  --r-sm: 8px; --r-md: 12px; --r-lg: 16px;
  --shadow-card: 0 1px 2px rgba(22, 32, 43, .04);
  --shadow-scan: 0 10px 30px rgba(22, 32, 43, .07), 0 1px 2px rgba(22, 32, 43, .05);
  --focus: 0 0 0 3px rgba(45, 91, 143, .30);
  --mono: "JetBrains Mono", "SF Mono", Consolas, "Liberation Mono", Menlo, monospace;

  display: flex; flex-direction: column; gap: 14px;
  height: 100%; min-height: 0; box-sizing: border-box;
  padding: 16px 24px;
  overflow: auto;
  background: var(--canvas);
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}
.lpr * { box-sizing: border-box; }
.lpr-mono { font-family: var(--mono); letter-spacing: .01em; }
.lpr-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }

/* ── Buttons (page-local, so the shared claymorphic .btn never has to be overridden) ── */
.lpr-btn { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 14px; border-radius: var(--r-sm); border: 1px solid var(--line); background: var(--surface); color: var(--ink); font: inherit; font-size: .8rem; font-weight: 700; white-space: nowrap; cursor: pointer; box-shadow: var(--shadow-card); transition: background .12s ease, border-color .12s ease, color .12s ease; }
.lpr-btn:hover:not(:disabled) { background: var(--pro-50); border-color: var(--pro-300); color: var(--pro-700); }
.lpr-btn:focus-visible { outline: none; box-shadow: var(--focus); }
.lpr-btn:disabled { opacity: .5; cursor: default; }
.lpr-btn--ghost { border-color: transparent; background: transparent; box-shadow: none; color: var(--ink-2); padding: 0 10px; }
.lpr-btn--sm { height: 28px; padding: 0 10px; font-size: .72rem; }

/* ── Toolbar ─────────────────────────────────────────────────────────────── */
.lpr-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; flex-shrink: 0; }
.lpr-brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.lpr-brand-icon { width: 38px; height: 38px; border-radius: 10px; flex-shrink: 0; background: linear-gradient(150deg, var(--pro-400), var(--pro-600)); box-shadow: 0 4px 12px rgba(23, 54, 93, .25); display: flex; align-items: center; justify-content: center; color: var(--white); }
.lpr-brand-icon svg { width: 20px; height: 20px; }
.lpr-brand-text { min-width: 0; }
.lpr-eyebrow { display: block; font-size: .64rem; font-weight: 700; color: var(--pro-500); text-transform: uppercase; letter-spacing: .12em; }
.lpr-title { margin: 0; font-size: 1.1rem; font-weight: 800; color: var(--ink); letter-spacing: -.02em; line-height: 1.2; }
.lpr-toolbar-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.lpr-pill { display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 14px; border-radius: 999px; background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow-card); font-size: .74rem; font-weight: 700; color: var(--ink-2); white-space: nowrap; }
.lpr-pill-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; box-shadow: 0 0 0 3px rgba(0,0,0,.04); }

/* ── Workspace ───────────────────────────────────────────────────────────── */
.lpr-workspace { flex: 1; min-height: 380px; display: grid; grid-template-columns: minmax(240px, 280px) minmax(0, 1fr) minmax(270px, 320px); grid-template-areas: "activity scan summary"; gap: 14px; }
.lpr-activity { grid-area: activity; }
.lpr-scan { grid-area: scan; }
.lpr-summary { grid-area: summary; }
@media (max-width: 1100px) {
  .lpr-workspace { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: minmax(360px, 1fr) minmax(260px, auto); grid-template-areas: "scan scan" "activity summary"; }
}

/* ── Cards (the two side panels) ─────────────────────────────────────────── */
.lpr-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow-card); min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.lpr-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 14px 16px 10px; flex-shrink: 0; }
.lpr-card-title { font-size: .64rem; font-weight: 700; color: var(--pro-500); text-transform: uppercase; letter-spacing: .1em; }
.lpr-card-note { font-size: .7rem; font-weight: 600; color: var(--ink-3); white-space: nowrap; }
.lpr-card-foot { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--line-2); background: var(--canvas); font-size: .66rem; font-weight: 700; color: var(--ink-3); text-transform: uppercase; letter-spacing: .08em; flex-shrink: 0; }
.lpr-card-foot strong { font-size: 1rem; font-weight: 800; color: var(--ink); letter-spacing: 0; text-transform: none; }
.lpr-empty { padding: 28px 12px; color: var(--ink-3); font-size: .8rem; font-weight: 600; text-align: center; }

.lpr-live { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px; border-radius: 999px; background: var(--ok-bg); border: 1px solid var(--ok-line); color: var(--ok); font-size: .62rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.lpr-live-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: lpr-blink 1.6s ease-in-out infinite; }

/* Activity feed — auto-scrolls on a wall display (see RecentActivity) */
.lpr-feed { flex: 1; min-height: 0; overflow-y: auto; padding: 0 10px 10px; display: flex; flex-direction: column; gap: 3px; }
.lpr-feed-row { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 8px 8px; border-radius: var(--r-sm); }
.lpr-feed-row--latest { background: var(--pro-50); }
.lpr-feed-dot { width: 10px; height: 10px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgba(22, 32, 43, .12); }
.lpr-feed-main { min-width: 0; }
.lpr-feed-article { font-size: .84rem; font-weight: 800; color: var(--ink); line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lpr-feed-sub { font-size: .72rem; font-weight: 600; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lpr-feed-time { font-size: .7rem; font-weight: 700; color: var(--ink-3); }

/* Today's output — one KPI, then the by-article breakdown */
.lpr-kpi { margin: 0 12px 4px; padding: 12px 14px; background: var(--canvas); border: 1px solid var(--line-2); border-radius: var(--r-md); display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-shrink: 0; }
.lpr-kpi-label { display: block; font-size: .6rem; font-weight: 700; color: var(--ink-3); text-transform: uppercase; letter-spacing: .08em; }
.lpr-kpi-sub { display: block; margin-top: 2px; font-size: .74rem; font-weight: 600; color: var(--ink-2); }
.lpr-kpi-value { display: inline-flex; align-items: baseline; gap: 5px; font-size: 1.8rem; font-weight: 800; color: var(--ink); line-height: 1; letter-spacing: -.02em; white-space: nowrap; }
.lpr-kpi-unit { font-size: .74rem; font-weight: 700; color: var(--pro-500); }
.lpr-subhead { padding: 12px 16px 6px; font-size: .62rem; font-weight: 700; color: var(--ink-3); text-transform: uppercase; letter-spacing: .08em; flex-shrink: 0; }
.lpr-articles { flex: 1; min-height: 0; overflow-y: auto; padding: 0 12px 12px; display: flex; flex-direction: column; gap: 6px; }
.lpr-article { padding: 10px 12px; background: var(--surface); border: 1px solid var(--line-2); border-radius: var(--r-md); }
.lpr-article-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.lpr-article-name { font-size: .84rem; font-weight: 800; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lpr-article-qty { font-size: .84rem; font-weight: 800; color: var(--pro-600); white-space: nowrap; }
.lpr-article-qty small { font-size: .66rem; font-weight: 700; color: var(--ink-3); margin-left: 3px; }
.lpr-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.lpr-chip { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 7px; border-radius: 999px; background: var(--canvas); border: 1px solid var(--line); font-size: .66rem; font-weight: 700; color: var(--ink-2); }
.lpr-chip-dot { width: 6px; height: 6px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgba(22, 32, 43, .12); }
.lpr-chip strong { color: var(--ink); font-weight: 800; }

/* ── Scan panel — the page's focal point; its tone follows the last answer ── */
.lpr-scan { position: relative; display: flex; flex-direction: column; min-height: 0; background: var(--surface); border: 1.5px solid var(--pro-200); border-radius: var(--r-lg); box-shadow: var(--shadow-scan); overflow: hidden; transition: border-color .15s ease, background .15s ease; }
.lpr-scan::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 4px; background: var(--pro-500); transition: background .15s ease; }
.lpr-scan--success { border-color: var(--ok-line);  background: linear-gradient(180deg, var(--ok-bg),  var(--surface) 180px); }
.lpr-scan--error   { border-color: var(--err-line); background: linear-gradient(180deg, var(--err-bg), var(--surface) 180px); }
.lpr-scan--success::before { background: var(--ok); }
.lpr-scan--error::before   { background: var(--err); }

.lpr-scan-stage { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; padding: 28px 28px 20px; }
.lpr-scan-stage-inner { margin: auto; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 14px; width: 100%; max-width: 580px; }
.lpr-scan-title { margin: 0; font-size: clamp(1.8rem, 3.4vw, 2.5rem); font-weight: 800; letter-spacing: -.025em; line-height: 1.1; }
.lpr-scan--idle    .lpr-scan-title { color: var(--pro-600); }
.lpr-scan--success .lpr-scan-title { color: var(--ok); }
.lpr-scan--error   .lpr-scan-title { color: var(--err); }
.lpr-scan-message { margin: 0; font-size: 1rem; font-weight: 500; color: var(--ink-2); max-width: 520px; }

.lpr-ready-icon { width: 96px; height: 96px; border-radius: 50%; background: radial-gradient(circle at 34% 28%, var(--white), var(--pro-100) 72%); border: 1px solid var(--pro-200); display: flex; align-items: center; justify-content: center; position: relative; margin-bottom: 6px; }
.lpr-ready-icon::before { content: ""; position: absolute; inset: -9px; border-radius: 50%; border: 2px solid var(--pro-200); opacity: .55; animation: lpr-pulse-ring 2.4s ease-out infinite; }
@keyframes lpr-pulse-ring { 0% { transform: scale(.9); opacity: .55; } 75% { transform: scale(1.18); opacity: 0; } 100% { opacity: 0; } }

/* Result summary — one contained block below the verdict */
.lpr-result { width: 100%; display: flex; flex-direction: column; align-items: center; gap: 12px; margin-top: 6px; padding: 16px 20px; background: rgba(255,255,255,.7); border: 1px solid var(--line); border-radius: var(--r-md); animation: lpr-pop .18s ease-out; }
@keyframes lpr-pop { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.lpr-result-id { display: flex; align-items: center; justify-content: center; gap: 10px; flex-wrap: wrap; }
.lpr-scan-product { font-size: 1.25rem; font-weight: 800; color: var(--ink); letter-spacing: -.01em; }
.lpr-scan-qr { font-size: .8rem; font-weight: 700; color: var(--pro-700); background: var(--pro-50); border: 1px solid var(--pro-100); padding: 3px 10px; border-radius: 6px; }
.lpr-scan-facts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; width: 100%; }
.lpr-fact { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 8px 10px; min-width: 0; text-align: left; }
.lpr-fact-label { font-size: .6rem; font-weight: 700; color: var(--ink-3); text-transform: uppercase; letter-spacing: .08em; }
.lpr-fact-value { margin-top: 2px; font-size: .95rem; font-weight: 800; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lpr-fact-value--swatch { display: flex; align-items: center; gap: 6px; }
.lpr-fact-value--swatch i { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; box-shadow: inset 0 0 0 1px rgba(22, 32, 43, .12); }

/* Scanner dock — the keyboard-wedge target. The row itself is the visual control; the
   input inside is chromeless. It reads as "armed" while it has focus. */
.lpr-dock { flex-shrink: 0; padding: 14px 20px; border-top: 1px solid var(--line-2); background: var(--surface); }
.lpr-dock-row { position: relative; display: flex; align-items: center; gap: 12px; height: 54px; padding: 0 10px 0 8px; background: var(--canvas); border: 1.5px solid var(--line); border-radius: var(--r-md); cursor: text; transition: border-color .15s ease, box-shadow .15s ease, background .15s ease; }
.lpr-dock-row:focus-within { border-color: var(--pro-500); background: var(--surface); box-shadow: 0 0 0 4px rgba(45, 91, 143, .14), 0 6px 18px rgba(22, 32, 43, .08); }
.lpr-dock-row--busy { cursor: progress; }

.lpr-dock-icon { width: 36px; height: 36px; border-radius: 9px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; color: var(--pro-600); background: var(--pro-100); cursor: inherit; transition: background .15s ease, color .15s ease; }
.lpr-dock-row:focus-within .lpr-dock-icon, .lpr-dock-row--busy .lpr-dock-icon { background: linear-gradient(150deg, var(--pro-400), var(--pro-600)); color: var(--white); }

/* Reset every global input rule (theme.css styles bare <input> and input:focus), so the
   row — not the field — is the only thing that draws chrome. */
.lpr-dock-row .lpr-input, .lpr-dock-row .lpr-input:focus, .lpr-dock-row .lpr-input:focus-visible {
  flex: 1; min-width: 0; height: 100%; margin: 0; padding: 0;
  border: 0; border-radius: 0; outline: none; box-shadow: none; background: transparent;
  color: var(--ink); font-family: var(--mono); font-size: 1.05rem; font-weight: 700; letter-spacing: .03em;
  caret-color: var(--pro-500);
}
.lpr-dock-row .lpr-input::placeholder { color: var(--ink-3); font-family: "Segoe UI", "Helvetica Neue", sans-serif; font-size: .92rem; font-weight: 600; letter-spacing: 0; opacity: 1; }
.lpr-dock-row .lpr-input:disabled { color: var(--ink-3); }

/* Live state chip — pure CSS: which label is visible depends on focus / busy */
.lpr-dock-state { display: none; align-items: center; gap: 7px; height: 26px; padding: 0 10px; border-radius: 999px; border: 1px solid transparent; font-size: .64rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; white-space: nowrap; flex-shrink: 0; }
.lpr-dock-state-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
.lpr-dock-state--armed { color: var(--ok); background: var(--ok-bg); border-color: var(--ok-line); }
.lpr-dock-state--armed .lpr-dock-state-dot { animation: lpr-blink 1.4s ease-in-out infinite; }
.lpr-dock-state--paused { color: var(--warn); background: var(--warn-bg); border-color: var(--warn-line); }
.lpr-dock-state--busy { color: var(--pro-600); background: var(--pro-50); border-color: var(--pro-200); }
.lpr-dock-state--busy .lpr-dock-state-dot { animation: lpr-blink .7s ease-in-out infinite; }
.lpr-dock-row:focus-within .lpr-dock-state--armed { display: inline-flex; }
.lpr-dock-row:not(:focus-within):not(.lpr-dock-row--busy) .lpr-dock-state--paused { display: inline-flex; }
.lpr-dock-row--busy .lpr-dock-state--busy { display: inline-flex; }
@keyframes lpr-blink { 0%, 100% { opacity: 1; } 50% { opacity: .2; } }

.lpr-dock-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; }
.lpr-dock-hint { display: inline-flex; align-items: center; gap: 6px; font-size: .72rem; color: var(--ink-3); font-weight: 600; }
.lpr-dock-hint kbd { display: inline-block; min-width: 20px; padding: 1px 6px; border-radius: 5px; border: 1px solid var(--line); background: var(--surface); color: var(--ink-2); font: inherit; font-size: .66rem; font-weight: 800; box-shadow: inset 0 -2px 0 rgba(22, 32, 43, .08); }

@media (prefers-reduced-motion: reduce) {
  .lpr-ready-icon::before, .lpr-live-dot, .lpr-dock-state-dot { animation: none; }
}
`;

// ─── Icons ────────────────────────────────────────────────────────────────

const BrandIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M4 5v14M8 5v14M12 5v14M15 8v8M18 6v12M21 8v8"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  </svg>
);

const ReadyIcon: React.FC = () => (
  <div className="lpr-ready-icon" aria-hidden="true">
    <svg width="44" height="44" viewBox="0 0 48 48" fill="none">
      <path
        d="M8 18V8h10M30 8h10v10M8 30v10h10M30 40h10V30"
        stroke="var(--pro-600)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M16 24h16"
        stroke="var(--pro-400)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeDasharray="2 3"
      />
    </svg>
  </div>
);

const ScannerIcon: React.FC = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <path
      d="M4 5v14M8 5v14M12 5v14M15 8v8M18 6v12M21 8v8"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  </svg>
);

// ─── Left: Recent activity ────────────────────────────────────────────────────

const RecentActivity: React.FC<{
  scans: DashboardSnapshot["recentScans"];
  todayTotal: number;
}> = ({ scans, todayTotal }) => {
  // On a wall display nobody scrolls, so the feed walks itself: down to the middle, hold,
  // down to the end, hold, back up — restarting from the top whenever a new scan lands.
  const listRef = useRef<HTMLDivElement>(null);
  const phaseRef = useRef<"down" | "hold" | "up">("down");
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafHandle = useRef<number | null>(null);
  const prevScanLen = useRef(scans.length);
  const midPassed = useRef(false);

  const PX_PER_FRAME = 0.6;
  const HOLD_MS = 5000;

  const stopAll = () => {
    if (rafHandle.current !== null) {
      cancelAnimationFrame(rafHandle.current);
      rafHandle.current = null;
    }
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  };

  const resumeDown = () => {
    phaseRef.current = "down";
    tickDown();
  };
  const resumeUp = () => {
    phaseRef.current = "up";
    tickUp();
  };

  const pause = (resumeFn: () => void) => {
    phaseRef.current = "hold";
    if (rafHandle.current !== null) {
      cancelAnimationFrame(rafHandle.current);
      rafHandle.current = null;
    }
    holdTimer.current = setTimeout(resumeFn, HOLD_MS);
  };

  const tickDown = () => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    if (atBottom) {
      midPassed.current = false;
      pause(resumeUp);
      return;
    }
    if (!midPassed.current) {
      const mid = (el.scrollHeight - el.clientHeight) / 2;
      if (el.scrollTop >= mid) {
        midPassed.current = true;
        pause(resumeDown);
        return;
      }
    }
    el.scrollTop += PX_PER_FRAME;
    rafHandle.current = requestAnimationFrame(tickDown);
  };

  const tickUp = () => {
    const el = listRef.current;
    if (!el) return;
    if (el.scrollTop <= 0) {
      el.scrollTop = 0;
      midPassed.current = false;
      pause(resumeDown);
      return;
    }
    if (!midPassed.current) {
      const mid = (el.scrollHeight - el.clientHeight) / 2;
      if (el.scrollTop >= mid) {
        midPassed.current = true;
        pause(resumeUp);
        return;
      }
    }
    el.scrollTop -= PX_PER_FRAME;
    rafHandle.current = requestAnimationFrame(tickUp);
  };

  const startDown = () => {
    phaseRef.current = "down";
    midPassed.current = false;
    pause(resumeDown);
  };

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const newScanArrived = scans.length !== prevScanLen.current;
    prevScanLen.current = scans.length;
    if (el.scrollHeight <= el.clientHeight) {
      stopAll();
      return;
    }
    if (newScanArrived) {
      stopAll();
      el.scrollTop = 0;
      startDown();
      return;
    }
    if (rafHandle.current === null && holdTimer.current === null) {
      el.scrollTop = 0;
      startDown();
    }
  }, [scans]);

  useEffect(() => () => stopAll(), []);

  return (
    <aside className="lpr-card lpr-activity" aria-label="Recent activity">
      <div className="lpr-card-head">
        <span className="lpr-card-title">Recent activity</span>
        <span className="lpr-live" title="Updates every few seconds">
          <span className="lpr-live-dot" aria-hidden="true" />
          Live
        </span>
      </div>
      <div ref={listRef} className="lpr-feed">
        {scans.length === 0 ? (
          <div className="lpr-empty">No scans logged yet.</div>
        ) : (
          scans.map((r, i) => (
            <div
              key={`${r.qrId}-${i}`}
              className={`lpr-feed-row${i === 0 ? " lpr-feed-row--latest" : ""}`}
            >
              <span
                className="lpr-feed-dot"
                style={{ background: dot(r.color) }}
                aria-hidden="true"
              />
              <div className="lpr-feed-main">
                <div className="lpr-feed-article">{r.article || "—"}</div>
                <div className="lpr-feed-sub">
                  {[r.color, r.size].filter(Boolean).join(" · ") || "—"}
                </div>
              </div>
              <span className="lpr-feed-time">{formatTime(r.occurredAt)}</span>
            </div>
          ))
        )}
      </div>
      <div className="lpr-card-foot">
        <span>Today</span>
        <strong>{todayTotal.toLocaleString()} cartons</strong>
      </div>
    </aside>
  );
};

// ─── Right: Today's output ────────────────────────────────────────────────────

const SessionSummary: React.FC<{ snap: DashboardSnapshot | null }> = ({
  snap,
}) => {
  const { byArticle, total } = buildSessionSummary(snap);
  const cartons = total || (snap?.todaysProduction ?? 0);

  return (
    <aside className="lpr-card lpr-summary" aria-label="Today's production">
      <div className="lpr-card-head">
        <span className="lpr-card-title">Today's production</span>
        <span className="lpr-card-note">this shift</span>
      </div>

      <div className="lpr-kpi">
        <div>
          <span className="lpr-kpi-label">Output</span>
          <span className="lpr-kpi-sub">
            {cartons.toLocaleString()} cartons recorded
          </span>
        </div>
        <span className="lpr-kpi-value">
          {fmtDzn(cartons)}
          <span className="lpr-kpi-unit">dzn</span>
        </span>
      </div>

      <div className="lpr-subhead">By article</div>
      <div className="lpr-articles">
        {byArticle.length === 0 ? (
          <div className="lpr-empty">No output recorded yet.</div>
        ) : (
          byArticle.map(({ article, total: at, colors }) => (
            <div className="lpr-article" key={article}>
              <div className="lpr-article-head">
                <span className="lpr-article-name">{article}</span>
                <span className="lpr-article-qty">
                  {fmtDzn(at)}
                  <small>dzn</small>
                </span>
              </div>
              <div className="lpr-chips">
                {colors.map(([c, n]) => (
                  <span className="lpr-chip" key={c}>
                    <span
                      className="lpr-chip-dot"
                      style={{ background: dot(c) }}
                      aria-hidden="true"
                    />
                    {c}
                    <strong>{n}</strong>
                  </span>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
};

// ─── Centre: scan panel ───────────────────────────────────────────────────────

const ScanPanel: React.FC<{
  result: ScanResult;
  inputVal: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onInputChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onFocusScanner: () => void;
  onClear: () => void;
  isProcessing: boolean;
}> = ({
  result,
  inputVal,
  inputRef,
  onInputChange,
  onKeyDown,
  onFocusScanner,
  onClear,
  isProcessing,
}) => {
  const isIdle = result.status === "idle";
  const isSuccess = result.status === "success";
  const errInfo = result.status === "error" ? classifyScanError(result.reason) : null;
  const hasIdentity = Boolean(result.article || result.color || result.size);

  const title = isIdle
    ? "READY TO SCAN"
    : isSuccess
      ? "✓ RECORDED"
      : `✕ ${errInfo?.label ?? "SCAN REJECTED"}`;
  const message = isIdle
    ? "Point the scanner at the carton label — recording is automatic"
    : isSuccess
      ? result.registeredOnScan
        ? "Unit recorded — this label was not generated here, so its code was registered now"
        : "Unit recorded into today's production"
      : (errInfo?.message ?? "Please scan again");

  return (
    <section
      className={`lpr-scan lpr-scan--${result.status}`}
      aria-live="polite"
      aria-label={copy.scanning.station}
    >
      <div className="lpr-scan-stage">
        <div className="lpr-scan-stage-inner">
          {isIdle && <ReadyIcon />}
          <h2 className="lpr-scan-title" data-testid="scan-status">
            {title}
          </h2>
          <p className="lpr-scan-message">{message}</p>

          {!isIdle && (hasIdentity || result.qrId) && (
            <div className="lpr-result">
              <div className="lpr-result-id">
                {hasIdentity && (
                  <span className="lpr-scan-product">{productLabel(result)}</span>
                )}
                {result.qrId && (
                  <span className="lpr-scan-qr lpr-mono">{result.qrId}</span>
                )}
              </div>
              {isSuccess && (
                <div className="lpr-scan-facts">
                  <div className="lpr-fact">
                    <div className="lpr-fact-label">{copy.columns.article}</div>
                    <div className="lpr-fact-value">{result.article || "—"}</div>
                  </div>
                  <div className="lpr-fact">
                    <div className="lpr-fact-label">{copy.columns.color}</div>
                    <div className="lpr-fact-value lpr-fact-value--swatch">
                      {result.color && (
                        <i style={{ background: dot(result.color) }} aria-hidden="true" />
                      )}
                      {result.color || "—"}
                    </div>
                  </div>
                  <div className="lpr-fact">
                    <div className="lpr-fact-label">{copy.columns.size}</div>
                    <div className="lpr-fact-value">{result.size || "—"}</div>
                  </div>
                  <div className="lpr-fact">
                    <div className="lpr-fact-label">Serial</div>
                    <div className="lpr-fact-value">{result.serial || "—"}</div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Keyboard-wedge scanner target. Kept visible but secondary, so a supervisor can
          type a code for troubleshooting without this becoming a manual-entry workflow. */}
      <div className="lpr-dock">
        <div className={`lpr-dock-row${isProcessing ? " lpr-dock-row--busy" : ""}`}>
          <label
            className="lpr-dock-icon"
            htmlFor="lpr-scanner-input"
            title={copy.scanning.scannerInput}
          >
            <ScannerIcon />
            <span className="lpr-sr-only">Scanner</span>
          </label>
          <input
            id="lpr-scanner-input"
            ref={inputRef}
            className="lpr-input"
            value={inputVal}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={isProcessing ? "Recording…" : "Waiting for scan…"}
            aria-label={copy.scanning.scannerInput}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={isProcessing}
          />
          {/* Exactly one of these is visible, chosen by CSS from focus / busy state. */}
          <span className="lpr-dock-state lpr-dock-state--armed" aria-hidden="true">
            <span className="lpr-dock-state-dot" />
            Listening
          </span>
          <span className="lpr-dock-state lpr-dock-state--paused" aria-hidden="true">
            <span className="lpr-dock-state-dot" />
            Click to focus
          </span>
          <span className="lpr-dock-state lpr-dock-state--busy" aria-hidden="true">
            <span className="lpr-dock-state-dot" />
            Recording
          </span>
        </div>
        <div className="lpr-dock-foot">
          <span className="lpr-dock-hint">
            Auto-submits on scan · <kbd>Esc</kbd> resets
          </span>
          {inputVal ? (
            <button
              type="button"
              className="lpr-btn lpr-btn--ghost lpr-btn--sm"
              onClick={onClear}
              title="Clear the typed code (Esc)"
            >{copy.actions.clear}</button>
          ) : (
            <button
              type="button"
              className="lpr-btn lpr-btn--ghost lpr-btn--sm"
              onClick={onFocusScanner}
              title={copy.scanning.refocus}
            >
              Focus scanner
            </button>
          )}
        </div>
      </div>
    </section>
  );
};

// ─── Page ────────────────────────────────────────────────────────────────────

export const LiveProductionPage: React.FC = () => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [result, setResult] = useState<ScanResult>(IDLE);
  const [inputVal, setInputVal] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [scannerConnected, setScannerConnected] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isProcessingRef = useRef(false);

  const focusScanner = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  // ── Snapshot ──────────────────────────────────────────────────────────────
  const loadSnapshot = useCallback(async () => {
    try {
      setSnapshot(await api.getDashboard());
    } catch (err) {
      console.error("Failed to load dashboard snapshot:", err);
    }
  }, [api]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);
  useEffect(() => {
    const iv = setInterval(() => void loadSnapshot(), 2500);
    return () => clearInterval(iv);
  }, [loadSnapshot]);

  // ── Scanner hardware presence ─────────────────────────────────────────────
  useEffect(() => {
    const check = async () => {
      try {
        setScannerConnected(await api.getScannerStatus());
      } catch {
        setScannerConnected(false);
      }
    };
    void check();
    const iv = setInterval(check, 3000);
    return () => clearInterval(iv);
  }, [api]);

  // ── Auto-return to READY (a new scan simply replaces the result) ──────────
  useEffect(() => {
    if (result.status === "idle") return;
    const t = setTimeout(() => setResult(IDLE), RESULT_HOLD_MS);
    return () => clearTimeout(t);
  }, [result]);

  // ── Focus on mount ────────────────────────────────────────────────────────
  useEffect(() => {
    focusScanner();
  }, [focusScanner]);

  const resetScan = useCallback(() => {
    setResult(IDLE);
    setInputVal("");
    focusScanner();
  }, [focusScanner]);

  // ── The scan itself ───────────────────────────────────────────────────────
  const handleScan = useCallback(
    async (raw: string) => {
      if (isProcessingRef.current) return;
      isProcessingRef.current = true;
      setIsProcessing(true);

      const cleaned = sanitizeScanInput(raw);
      const parsed = parseQrForDisplay(cleaned);

      try {
        const res = await api.processScan(cleaned);
        if (res.accepted) {
          playScanSound("success");
          setResult({ status: "success", ...parsed, qrId: res.qrId ?? cleaned, registeredOnScan: res.registeredOnScan });
          push("success", "Recorded", res.qrId ?? cleaned);
          await loadSnapshot();
        } else {
          playScanSound("error");
          const { message } = classifyScanError(res.reason);
          setResult({ status: "error", ...parsed, qrId: cleaned, reason: res.reason });
          push("error", message, res.reason ?? "");
        }
      } catch (err) {
        playScanSound("error");
        const errMessage =
          err instanceof Error ? err.message : "Error processing scan";
        setResult({ status: "error", ...parsed, qrId: cleaned, reason: errMessage });
        push("error", "Scan Error", errMessage);
      } finally {
        isProcessingRef.current = false;
        setIsProcessing(false);
        focusScanner();
      }
    },
    [api, push, loadSnapshot, focusScanner],
  );

  const processInput = useCallback(
    (val: string) => {
      const cleaned = sanitizeScanInput(val);
      if (!cleaned || cleaned.length < 3) return;
      setInputVal("");
      void handleScan(cleaned);
    },
    [handleScan],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      processInput(inputVal);
    } else if (e.key === "Escape") {
      e.preventDefault();
      resetScan();
    }
  };

  // Hardware scanners type the whole code in one burst; submit as soon as it is complete
  // rather than waiting for a suffix key the scanner may not be configured to send.
  useEffect(() => {
    if (!inputVal) return;
    const cleaned = sanitizeScanInput(inputVal);
    if (!cleaned || cleaned.length < 3) return;

    if (isCompleteQr(cleaned)) {
      const timer = setTimeout(() => processInput(cleaned), 40);
      return () => clearTimeout(timer);
    }
    if (cleaned.length >= 5) {
      const timer = setTimeout(() => processInput(cleaned), 80);
      return () => clearTimeout(timer);
    }
  }, [inputVal, processInput]);

  // ── Keyboard: Esc resets; a scanner burst arriving elsewhere is redirected ─
  useEffect(() => {
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        resetScan();
        return;
      }
      const target = e.target as HTMLElement | null;
      const inField =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        Boolean(target?.isContentEditable);
      if (
        !inField &&
        e.key.length === 1 &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        focusScanner();
      }
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [resetScan, focusScanner]);

  const recentScans = snapshot?.recentScans ?? [];
  const todayTotal = snapshot?.todaysProduction ?? 0;
  const scannerPill =
    scannerConnected === null
      ? { color: "var(--ink-3)", text: "Checking scanner…" }
      : scannerConnected
        ? { color: "var(--ok)", text: "Hardware scanner ready" }
        : { color: "var(--warn)", text: "No hardware scanner — keyboard active" };

  return (
    <div
      className="lpr"
      onClick={(e) => {
        // Clicking empty space is never an action; it just hands focus back to the scanner.
        const target = e.target as HTMLElement | null;
        if (
          target &&
          !target.closest("button, a, input, select, textarea, [role='dialog']")
        ) {
          focusScanner();
        }
      }}
    >
      <style>{PAGE_CSS}</style>

      <header className="lpr-toolbar">
        <div className="lpr-brand">
          <div className="lpr-brand-icon">
            <BrandIcon />
          </div>
          <div className="lpr-brand-text">
            <span className="lpr-eyebrow">Production Station</span>
            <h1 className="lpr-title">Live Production</h1>
          </div>
        </div>
        <div className="lpr-toolbar-actions">
          <span className="lpr-pill" title={copy.scanning.scannerStatus}>
            <span
              className="lpr-pill-dot"
              style={{ background: scannerPill.color }}
            />
            {scannerPill.text}
          </span>
        </div>
      </header>

      <div className="lpr-workspace">
        <RecentActivity scans={recentScans} todayTotal={todayTotal} />
        <ScanPanel
          result={result}
          inputVal={inputVal}
          inputRef={inputRef}
          onInputChange={setInputVal}
          onKeyDown={handleKeyDown}
          onFocusScanner={focusScanner}
          onClear={resetScan}
          isProcessing={isProcessing}
        />
        <SessionSummary snap={snapshot} />
      </div>
    </div>
  );
};
