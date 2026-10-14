import React from "react";
import { copy } from "../../config/copy";
import { formatDateTime, formatTime } from "../../utils/dates";

// The scan station: the shared look and behaviour of every full-screen scanning terminal
// in the ERP — Store Move In, Store Move Out and Raw Material Input.
//
// The stylesheet and the four panels live here rather than in each page so a change to the
// station (its colours, its dock, its result card) reaches every terminal at once. The
// panels take plain display data, not any one screen's result type, which is what lets a
// carton screen and a raw material screen share them (R1 — do not copy-paste UI).
export const SCAN_STATION_CSS = `
.ssn {
  --sky-50: #eef7fd;
  --sky-100: #dbeefb;
  --sky-200: #b9e0f7;
  --sky-300: #86cbf1;
  --sky-400: #4db3e8;
  --sky-500: #2299d8;
  --sky-600: #187fbb;
  --sky-700: #126797;
  --ink: #0f2233;
  --ink-2: #46617a;
  --ink-3: #7f97aa;
  --line: #d9e7f1;
  --line-2: #eaf2f8;
  --surface: var(--white);
  --canvas: #f4f9fd;
  --ok: #15803d;   --ok-bg: #ecfdf3;   --ok-line: #a7e6c0;
  --warn: #a16207; --warn-bg: #fffbeb; --warn-line: #f2d98a;
  --err: var(--danger-strong);  --err-bg: #fef2f2;  --err-line: #f3b9b9;
  --r-sm: 8px; --r-md: 12px; --r-lg: 16px;
  --shadow-card: 0 1px 2px rgba(15, 34, 51, .04);
  --shadow-scan: 0 10px 30px rgba(24, 127, 187, .10), 0 1px 2px rgba(15, 34, 51, .05);
  --focus: 0 0 0 3px rgba(77, 179, 232, .35);
  --mono: "JetBrains Mono", "SF Mono", Consolas, "Liberation Mono", Menlo, monospace;

  display: flex; flex-direction: column; gap: 14px;
  height: 100%; min-height: 0; box-sizing: border-box;
  padding: 16px 24px;
  overflow: auto;
  background: var(--canvas);
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}
.ssn * { box-sizing: border-box; }
.ssn-mono { font-family: var(--mono); letter-spacing: .01em; }
.ssn-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }

/* ── Buttons (page-local, so the shared claymorphic .btn never has to be overridden) ── */
.ssn-btn { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 14px; border-radius: var(--r-sm); border: 1px solid var(--line); background: var(--surface); color: var(--ink); font: inherit; font-size: .8rem; font-weight: 700; white-space: nowrap; cursor: pointer; box-shadow: var(--shadow-card); transition: background .12s ease, border-color .12s ease, color .12s ease; }
.ssn-btn svg { width: 15px; height: 15px; flex-shrink: 0; }
.ssn-btn:hover:not(:disabled) { background: var(--sky-50); border-color: var(--sky-300); color: var(--sky-700); }
.ssn-btn:focus-visible { outline: none; box-shadow: var(--focus); }
.ssn-btn:disabled { opacity: .5; cursor: default; }
.ssn-btn--ghost { border-color: transparent; background: transparent; box-shadow: none; color: var(--ink-2); padding: 0 10px; }
.ssn-btn--sm { height: 28px; padding: 0 10px; font-size: .72rem; }

/* ── Toolbar ─────────────────────────────────────────────────────────────── */
.ssn-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; flex-shrink: 0; }
.ssn-brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.ssn-brand-icon { width: 38px; height: 38px; border-radius: 10px; flex-shrink: 0; background: linear-gradient(150deg, var(--sky-400), var(--sky-600)); box-shadow: 0 4px 12px rgba(24, 127, 187, .25); display: flex; align-items: center; justify-content: center; color: var(--white); }
.ssn-brand-icon svg { width: 20px; height: 20px; }
.ssn-brand-text { min-width: 0; }
.ssn-eyebrow { display: block; font-size: .64rem; font-weight: 700; color: var(--sky-600); text-transform: uppercase; letter-spacing: .12em; }
.ssn-title { margin: 0; font-size: 1.1rem; font-weight: 800; color: var(--ink); letter-spacing: -.02em; line-height: 1.2; }
.ssn-supplier-pick { min-width: 260px; }
.ssn-supplier-pick input { height: 34px; font-size: .8rem; }

.ssn-toolbar-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ssn-pill { display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 14px; border-radius: 999px; background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow-card); font-size: .74rem; font-weight: 700; color: var(--ink-2); white-space: nowrap; }
.ssn-pill-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; box-shadow: 0 0 0 3px rgba(0,0,0,.04); }

/* ── Embedded (half of the Move In desk) ─────────────────────────────────────
   Half a screen, so it keeps only what the operator works with: the session controls, the
   scan verdict, the tally and the recent list, one under the other at their natural height
   (the pane scrolls). The scan panel never shrinks — it is the point of the station. */
.ssn--embedded { height: 100%; padding: 16px; gap: 12px; background: var(--surface); }
.ssn--embedded .ssn-brand-icon, .ssn--embedded .ssn-eyebrow { display: none; }
.ssn--embedded .ssn-toolbar { gap: 10px; }
.ssn--embedded .ssn-toolbar-actions { flex: 1 1 100%; }
.ssn--embedded .ssn-supplier-pick { min-width: 0; flex: 1 1 200px; }
.ssn--embedded .ssn-workspace { flex: none; display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.ssn--embedded .ssn-scan { flex: none; }
.ssn--embedded .ssn-scan-stage { flex: none; padding: 20px 18px 16px; }
.ssn--embedded .ssn-scan-stage-inner { gap: 8px; }
.ssn--embedded .ssn-scan-title { font-size: 1.6rem; }
.ssn--embedded .ssn-scan-message { font-size: .9rem; }
.ssn--embedded .ssn-ready-icon { width: 56px; height: 56px; margin-bottom: 2px; }
.ssn--embedded .ssn-ready-icon svg { width: 28px; height: 28px; }
.ssn--embedded .ssn-result { gap: 8px; padding: 12px 14px; }
.ssn--embedded .ssn-scan-product { font-size: 1.05rem; }
.ssn--embedded .ssn-scan--success .ssn-transition, .ssn--embedded .ssn-scan-facts { display: none; }
.ssn--embedded .ssn-dock { padding: 12px 14px; }
.ssn--embedded .ssn-dock-row { height: 48px; }
.ssn--embedded .ssn-dock-foot { display: none; }
.ssn--embedded .ssn-side { min-height: auto; }
.ssn--embedded .ssn-session { flex: none; }
.ssn--embedded .ssn-session-meta { margin-bottom: 4px; }
.ssn--embedded .ssn-kpis, .ssn--embedded .ssn-subhead, .ssn--embedded .ssn-summary-bar { display: none; }
.ssn--embedded .ssn-summary { flex: none; min-height: 0; max-height: 168px; }
.ssn--embedded .ssn-summary-row { padding: 6px 8px; border-bottom: 1px solid var(--line-2); border-radius: 0; }
.ssn--embedded .ssn-summary-row + .ssn-summary-row { margin-top: 0; }
.ssn--embedded .ssn-empty { padding: 10px 8px; }
.ssn--embedded .ssn-recent th.ssn-col-status, .ssn--embedded .ssn-recent td.ssn-col-status { display: none; }
.ssn--embedded .ssn-recent td { white-space: normal; }

/* ── Workspace ───────────────────────────────────────────────────────────── */
.ssn-workspace { flex: 1; min-height: 380px; display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 340px); gap: 14px; }
@media (max-width: 960px) {
  .ssn-workspace { grid-template-columns: minmax(0, 1fr); }
  .ssn-side { min-height: auto; }
}

/* Scan panel — the page's focal point; its tone follows the last answer */
.ssn-scan { position: relative; display: flex; flex-direction: column; min-height: 0; background: var(--surface); border: 1.5px solid var(--sky-200); border-radius: var(--r-lg); box-shadow: var(--shadow-scan); overflow: hidden; transition: border-color .15s ease, background .15s ease; }
.ssn-scan::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 4px; background: var(--sky-400); transition: background .15s ease; }
.ssn-scan--success { border-color: var(--ok-line);   background: linear-gradient(180deg, var(--ok-bg),   var(--surface) 180px); }
.ssn-scan--warn    { border-color: var(--warn-line); background: linear-gradient(180deg, var(--warn-bg), var(--surface) 180px); }
.ssn-scan--error   { border-color: var(--err-line);  background: linear-gradient(180deg, var(--err-bg),  var(--surface) 180px); }
.ssn-scan--success::before { background: var(--ok); }
.ssn-scan--warn::before    { background: var(--warn); }
.ssn-scan--error::before   { background: var(--err); }

.ssn-scan-stage { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; padding: 28px 28px 20px; }
.ssn-scan-stage-inner { margin: auto; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 14px; width: 100%; max-width: 580px; }
.ssn-scan-title { margin: 0; font-size: clamp(1.8rem, 3.4vw, 2.5rem); font-weight: 800; letter-spacing: -.025em; line-height: 1.1; }
.ssn-scan--idle    .ssn-scan-title { color: var(--sky-600); }
.ssn-scan--success .ssn-scan-title { color: var(--ok); }
.ssn-scan--warn    .ssn-scan-title { color: var(--warn); }
.ssn-scan--error   .ssn-scan-title { color: var(--err); }
.ssn-scan-message { margin: 0; font-size: 1rem; font-weight: 500; color: var(--ink-2); max-width: 520px; }

.ssn-ready-icon { width: 96px; height: 96px; border-radius: 50%; background: radial-gradient(circle at 34% 28%, var(--white), var(--sky-100) 72%); border: 1px solid var(--sky-200); display: flex; align-items: center; justify-content: center; position: relative; margin-bottom: 6px; }
.ssn-ready-icon::before { content: ""; position: absolute; inset: -9px; border-radius: 50%; border: 2px solid var(--sky-200); opacity: .55; animation: ssn-pulse-ring 2.4s ease-out infinite; }
@keyframes ssn-pulse-ring { 0% { transform: scale(.9); opacity: .55; } 75% { transform: scale(1.18); opacity: 0; } 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .ssn-ready-icon::before { animation: none; } }

/* Result summary — one contained block below the verdict */
.ssn-result { width: 100%; display: flex; flex-direction: column; align-items: center; gap: 12px; margin-top: 6px; padding: 16px 20px; background: rgba(255,255,255,.7); border: 1px solid var(--line); border-radius: var(--r-md); }
.ssn-result-id { display: flex; align-items: center; justify-content: center; gap: 10px; flex-wrap: wrap; }
.ssn-scan-product { font-size: 1.25rem; font-weight: 800; color: var(--ink); letter-spacing: -.01em; }
.ssn-scan-qr { font-size: .8rem; font-weight: 700; color: var(--sky-700); background: var(--sky-50); border: 1px solid var(--sky-100); padding: 3px 10px; border-radius: 6px; }

.ssn-transition { display: inline-flex; align-items: center; gap: 10px; height: 32px; padding: 0 14px; border-radius: 999px; background: var(--surface); border: 1px solid var(--line); font-size: .8rem; font-weight: 700; color: var(--ink-2); }
.ssn-transition strong { color: var(--ink); }
.ssn-transition-arrow { color: var(--sky-400); font-weight: 800; }

.ssn-scan-facts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; width: 100%; }
.ssn-fact { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 8px 10px; min-width: 0; text-align: left; }
.ssn-fact-label { font-size: .6rem; font-weight: 700; color: var(--ink-3); text-transform: uppercase; letter-spacing: .08em; }
.ssn-fact-value { margin-top: 2px; font-size: .95rem; font-weight: 800; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ssn-scan-time { font-size: .74rem; color: var(--ink-3); font-weight: 600; }

/* Scanner dock — the keyboard-wedge target. The row itself is the visual control; the
   input inside is chromeless. It reads as "armed" while it has focus (which, thanks to
   the auto-refocus logic, is nearly always). */
.ssn-dock { flex-shrink: 0; padding: 14px 20px; border-top: 1px solid var(--line-2); background: var(--surface); }
.ssn-dock-row { position: relative; display: flex; align-items: center; gap: 12px; height: 54px; padding: 0 10px 0 8px; background: var(--canvas); border: 1.5px solid var(--line); border-radius: var(--r-md); cursor: text; transition: border-color .15s ease, box-shadow .15s ease, background .15s ease; }
/* The Enter button of a box that is also a manual entry field (Receive Production). */
.ssn-dock-submit { flex: none; height: 36px; padding: 0 18px; background: var(--sky-600); border-color: var(--sky-600); color: var(--white); }
.ssn-dock-submit:hover:not(:disabled) { background: var(--sky-700); border-color: var(--sky-700); color: var(--white); }
.ssn-dock-row:focus-within { border-color: var(--sky-500); background: var(--surface); box-shadow: 0 0 0 4px rgba(34, 153, 216, .14), 0 6px 18px rgba(24, 127, 187, .10); }
.ssn-dock-row--disabled { cursor: not-allowed; background: var(--line-2); }

.ssn-dock-icon { width: 36px; height: 36px; border-radius: 9px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; color: var(--sky-600); background: var(--sky-100); cursor: inherit; transition: background .15s ease, color .15s ease; }
.ssn-dock-row:focus-within .ssn-dock-icon { background: linear-gradient(150deg, var(--sky-400), var(--sky-600)); color: var(--white); }
.ssn-dock-row--disabled .ssn-dock-icon { background: var(--line); color: var(--ink-3); }

/* Reset every global input rule (theme.css styles bare <input> and input:focus), so the
   row — not the field — is the only thing that draws chrome. */
.ssn-dock-row .ssn-input, .ssn-dock-row .ssn-input:focus, .ssn-dock-row .ssn-input:focus-visible {
  flex: 1; min-width: 0; height: 100%; margin: 0; padding: 0;
  border: 0; border-radius: 0; outline: none; box-shadow: none; background: transparent;
  color: var(--ink); font-family: var(--mono); font-size: 1.05rem; font-weight: 700; letter-spacing: .03em;
  caret-color: var(--sky-500);
}
.ssn-dock-row .ssn-input::placeholder { color: var(--ink-3); font-family: "Segoe UI", "Helvetica Neue", sans-serif; font-size: .92rem; font-weight: 600; letter-spacing: 0; opacity: 1; }
.ssn-dock-row .ssn-input:disabled { color: var(--ink-3); cursor: not-allowed; }

/* Live state chip — pure CSS: which label is visible depends on focus / disabled */
.ssn-dock-state { display: none; align-items: center; gap: 7px; height: 26px; padding: 0 10px; border-radius: 999px; border: 1px solid transparent; font-size: .64rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; white-space: nowrap; flex-shrink: 0; }
.ssn-dock-state-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
.ssn-dock-state--armed { color: var(--ok); background: var(--ok-bg); border-color: var(--ok-line); }
.ssn-dock-state--armed .ssn-dock-state-dot { animation: ssn-blink 1.4s ease-in-out infinite; }
.ssn-dock-state--paused { color: var(--warn); background: var(--warn-bg); border-color: var(--warn-line); }
.ssn-dock-state--off { color: var(--ink-3); background: var(--surface); border-color: var(--line); }
.ssn-dock-row:focus-within .ssn-dock-state--armed { display: inline-flex; }
.ssn-dock-row:not(:focus-within):not(.ssn-dock-row--disabled) .ssn-dock-state--paused { display: inline-flex; }
.ssn-dock-row--disabled .ssn-dock-state--off { display: inline-flex; }
@keyframes ssn-blink { 0%, 100% { opacity: 1; } 50% { opacity: .2; } }
@media (prefers-reduced-motion: reduce) { .ssn-dock-state--armed .ssn-dock-state-dot { animation: none; } }

.ssn-dock-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; }
.ssn-dock-hint { display: inline-flex; align-items: center; gap: 6px; font-size: .72rem; color: var(--ink-3); font-weight: 600; }
.ssn-dock-hint kbd { display: inline-block; min-width: 20px; padding: 1px 6px; border-radius: 5px; border: 1px solid var(--line); background: var(--surface); color: var(--ink-2); font: inherit; font-size: .66rem; font-weight: 800; box-shadow: inset 0 -2px 0 rgba(15, 34, 51, .08); }

/* ── Sidebar ─────────────────────────────────────────────────────────────── */
.ssn-side { display: flex; flex-direction: column; gap: 14px; min-height: 0; }
.ssn-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow-card); padding: 14px 16px; min-height: 0; display: flex; flex-direction: column; }
.ssn-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; flex-shrink: 0; }
.ssn-card-title { font-size: .64rem; font-weight: 700; color: var(--sky-600); text-transform: uppercase; letter-spacing: .1em; }
.ssn-card-note { font-size: .7rem; font-weight: 600; color: var(--ink-3); white-space: nowrap; }

/* Session card: identity → counters → by-product breakdown → total */
.ssn-session { flex: 1; }
.ssn-session-code { font-size: .82rem; font-weight: 700; color: var(--ink); background: var(--sky-50); border: 1px solid var(--sky-100); padding: 2px 8px; border-radius: 6px; }
.ssn-session-meta { font-size: .74rem; font-weight: 600; color: var(--ink-3); margin: -4px 0 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ssn-kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; flex-shrink: 0; }
.ssn-kpi { background: var(--canvas); border: 1px solid var(--line-2); border-radius: var(--r-md); padding: 10px 12px; min-width: 0; }
.ssn-kpi-label { display: block; font-size: .6rem; font-weight: 700; color: var(--ink-3); text-transform: uppercase; letter-spacing: .08em; }
.ssn-kpi-value { display: block; margin-top: 2px; font-size: 1.6rem; font-weight: 800; color: var(--ink); line-height: 1.1; letter-spacing: -.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ssn-kpi-sub { display: block; font-size: .68rem; font-weight: 600; color: var(--ink-3); }
.ssn-subhead { display: flex; align-items: baseline; justify-content: space-between; margin: 14px 0 6px; font-size: .62rem; font-weight: 700; color: var(--ink-3); text-transform: uppercase; letter-spacing: .08em; flex-shrink: 0; }

.ssn-summary { flex: 1; overflow-y: auto; min-height: 60px; margin: 0 -6px; padding: 0 6px; }
.ssn-summary-row { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 8px; border-radius: var(--r-sm); overflow: hidden; font-size: .8rem; font-weight: 600; color: var(--ink-2); }
.ssn-summary-row + .ssn-summary-row { margin-top: 2px; }
.ssn-summary-bar { position: absolute; inset: 0; background: var(--sky-50); border-radius: var(--r-sm); z-index: 0; transition: width .25s ease; }
.ssn-summary-row > span, .ssn-summary-row > strong { z-index: 1; }
.ssn-summary-row > span:not(.ssn-summary-bar) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.ssn-summary-row strong { color: var(--ink); font-weight: 800; flex-shrink: 0; }
.ssn-summary-total { display: flex; justify-content: space-between; align-items: baseline; padding-top: 10px; margin-top: 8px; border-top: 1px solid var(--line); font-size: .66rem; font-weight: 700; color: var(--ink-3); text-transform: uppercase; letter-spacing: .08em; flex-shrink: 0; }
.ssn-summary-total span[data-testid] { font-size: 1.05rem; font-weight: 800; color: var(--ink); letter-spacing: 0; text-transform: none; }

/* Last received */
.ssn-last-body { display: flex; flex-direction: column; gap: 6px; }
.ssn-last-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ssn-last-product { font-size: .92rem; font-weight: 800; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ssn-last-qr { font-size: .76rem; font-weight: 700; color: var(--sky-700); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ssn-last-time { font-size: .74rem; font-weight: 700; color: var(--ink-2); }

.ssn-badge { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 8px; border-radius: 999px; font-size: .66rem; font-weight: 700; letter-spacing: .02em; white-space: nowrap; flex-shrink: 0; }
.ssn-badge--ok { background: var(--ok-bg); color: var(--ok); border: 1px solid var(--ok-line); }
.ssn-empty { padding: 20px 8px; color: var(--ink-3); font-size: .8rem; font-weight: 600; text-align: center; }
.ssn-empty--inline { padding: 4px 0; text-align: left; }

/* ── Recent activity ─────────────────────────────────────────────────────── */
.ssn-recent-wrap { flex-shrink: 0; padding-bottom: 6px; }
.ssn-recent { max-height: 196px; overflow-y: auto; margin: 0 -8px; padding: 0 8px; }
.ssn-recent table { width: 100%; border-collapse: collapse; font-size: .78rem; }
.ssn-recent th { position: sticky; top: 0; z-index: 1; text-align: left; font-size: .6rem; font-weight: 700; color: var(--ink-3); text-transform: uppercase; letter-spacing: .08em; padding: 4px 10px 8px; background: var(--surface); box-shadow: inset 0 -1px 0 var(--line); }
.ssn-recent td { padding: 8px 10px; border-bottom: 1px solid var(--line-2); color: var(--ink-2); font-weight: 600; white-space: nowrap; }
.ssn-recent td.ssn-col-product { color: var(--ink); font-weight: 700; }
.ssn-recent th.ssn-col-time, .ssn-recent td.ssn-col-time { width: 84px; }
.ssn-recent th.ssn-col-status, .ssn-recent td.ssn-col-status { width: 110px; text-align: right; }
.ssn-recent tr.ssn-recent-row { cursor: pointer; transition: background .1s ease; }
.ssn-recent tr.ssn-recent-row:hover td { background: var(--sky-50); }
.ssn-recent tr.ssn-recent-row:focus-visible { outline: none; }
.ssn-recent tr.ssn-recent-row:focus-visible td { background: var(--sky-100); }
.ssn-recent tr.ssn-recent-row:last-child td { border-bottom: 0; }

/* ── Blocked state ───────────────────────────────────────────────────────── */
.ssn-blocked { grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; padding: 40px 28px; background: var(--surface); border: 1px dashed var(--line); border-radius: var(--r-lg); color: var(--ink-2); font-size: .9rem; }
.ssn-blocked-icon { width: 48px; height: 48px; border-radius: 50%; background: var(--err-bg); color: var(--err); border: 1px solid var(--err-line); display: flex; align-items: center; justify-content: center; margin-bottom: 4px; }
.ssn-blocked-icon svg { width: 22px; height: 22px; }
.ssn-blocked strong { font-size: 1.05rem; color: var(--ink); }
.ssn-blocked .ssn-btn { margin-top: 6px; }
`;

// ─── Icons ────────────────────────────────────────────────────────────────

const BrandIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
    />
    <path
      d="M4 7.5L12 12l8-4.5M12 12v9"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
    />
  </svg>
);

const ReadyIcon: React.FC = () => (
  <div className="ssn-ready-icon" aria-hidden="true">
    <svg width="44" height="44" viewBox="0 0 48 48" fill="none">
      <path
        d="M8 18V8h10M30 8h10v10M8 30v10h10M30 40h10V30"
        stroke="var(--sky-600)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  </div>
);

const ChevronLeftIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M15 5l-7 7 7 7"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const PlusIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M12 5v14M5 12h14"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
);

const AlertIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M12 3.5 21 19.5H3L12 3.5Z"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
    />
    <path d="M12 9.5v4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <circle cx="12" cy="16.8" r="1" fill="currentColor" />
  </svg>
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

// ─── What a station shows about one scan ─────────────────────────────────────
// Deliberately plain display data. A carton screen fills it from a StoreEntryScanResult
// and a raw material screen from a RawMaterialReceiptResult; the panel knows neither.

export type ScanTone = "idle" | "success" | "warn" | "error";

export interface ScanStationResult {
  qrId?: string;
  /** What was scanned, in words: "SK6 · RED · 7/10" or "RUBBER UPPER — SK6 — RED — 7/10". */
  product?: string;
  /** Status before and after, already turned into labels by the caller. */
  fromStatus?: string | null;
  toStatus?: string | null;
  /** Shown instead of the transition when the scan was refused. */
  currentStatusLabel?: string | null;
  /** The name/value pairs under a successful scan. */
  facts?: Array<{ label: string; value: string | null | undefined }>;
  /** ISO timestamp of the movement, shown as "Received …". */
  at?: string;
  atLabel?: string;
}

export interface ScanStationFeedback {
  tone: ScanTone;
  title: string;
  message: string;
  result: ScanStationResult | null;
  /** Bumped on every scan so the panel re-animates even for an identical result. */
  seq: number;
}

export const ScanPanel: React.FC<{
  feedback: ScanStationFeedback;
  inputRef: React.RefObject<HTMLInputElement | null>;
  inputVal: string;
  onInputChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onFocusScanner: () => void;
  disabled: boolean;
  /** Placeholder when the station cannot accept scans yet. */
  disabledHint?: string;
  /**
   * A station where the box is also a manual entry field (Receive Production) gets an Enter button
   * that sends what is typed. Left out, the box is scanner-first, as on every other station.
   */
  onSubmit?: () => void;
  submitLabel?: string;
  /** Placeholder while armed, and the line under the box, for such a station. */
  placeholder?: string;
  dockHint?: string;
}> = ({ feedback, inputRef, inputVal, onInputChange, onKeyDown, onFocusScanner, disabled, disabledHint, onSubmit, submitLabel, placeholder, dockHint }) => {
  const r = feedback.result;
  const isIdle = feedback.tone === "idle";
  return (
    <section className={`ssn-scan ssn-scan--${feedback.tone}`} aria-live="polite" aria-label={copy.scanning.station}>
      <div className="ssn-scan-stage">
        <div className="ssn-scan-stage-inner">
          {isIdle && <ReadyIcon />}
          <h2 className="ssn-scan-title" data-testid="scan-status">
            {feedback.title}
          </h2>
          <p className="ssn-scan-message">{feedback.message}</p>

          {r && (
            <div className="ssn-result">
              <div className="ssn-result-id">
                {r.product && <span className="ssn-scan-product">{r.product}</span>}
                {r.qrId && <span className="ssn-scan-qr ssn-mono">{r.qrId}</span>}
              </div>

              {feedback.tone === "success" && r.toStatus && (
                <div className="ssn-transition" aria-label={copy.scanning.statusChange}>
                  <span>{r.fromStatus ?? "—"}</span>
                  <span className="ssn-transition-arrow" aria-hidden="true">
                    →
                  </span>
                  <strong>{r.toStatus}</strong>
                </div>
              )}
              {feedback.tone !== "success" && r.currentStatusLabel && (
                <div className="ssn-transition" aria-label={copy.scanning.currentStatus}>
                  <span>{copy.scanning.currentStatus}</span>
                  <strong>{r.currentStatusLabel}</strong>
                </div>
              )}

              {feedback.tone === "success" && r.facts && r.facts.length > 0 && (
                <div className="ssn-scan-facts">
                  {r.facts.map((fact) => (
                    <div className="ssn-fact" key={fact.label}>
                      <div className="ssn-fact-label">{fact.label}</div>
                      <div className="ssn-fact-value">{fact.value || "—"}</div>
                    </div>
                  ))}
                </div>
              )}
              {r.at && (
                <div className="ssn-scan-time">
                  {r.atLabel ?? "Received"} {formatDateTime(r.at)}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Keyboard-wedge scanner target. Kept visible but secondary, so a supervisor can
          type a code for troubleshooting without this becoming a manual-entry workflow. */}
      <div className="ssn-dock">
        <div className={`ssn-dock-row${disabled ? " ssn-dock-row--disabled" : ""}`}>
          <label className="ssn-dock-icon" htmlFor="ssn-scanner-input" title={copy.scanning.scannerInput}>
            <ScannerIcon />
            <span className="ssn-sr-only">Scanner</span>
          </label>
          <input
            id="ssn-scanner-input"
            ref={inputRef}
            className="ssn-input"
            value={inputVal}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={disabled ? (disabledHint ?? "Session not ready") : (placeholder ?? "Waiting for scan…")}
            aria-label={copy.scanning.scannerInput}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={disabled}
          />
          {onSubmit ? (
            <button
              type="button"
              className="ssn-btn ssn-dock-submit"
              onClick={onSubmit}
              disabled={disabled || inputVal.trim() === ""}
            >
              {submitLabel ?? "Enter"}
            </button>
          ) : null}
          {/* Exactly one of these is visible, chosen by CSS from focus / disabled state. */}
          <span className="ssn-dock-state ssn-dock-state--armed" aria-hidden="true">
            <span className="ssn-dock-state-dot" />
            Listening
          </span>
          <span className="ssn-dock-state ssn-dock-state--paused" aria-hidden="true">
            <span className="ssn-dock-state-dot" />
            Click to focus
          </span>
          <span className="ssn-dock-state ssn-dock-state--off" aria-hidden="true">
            <span className="ssn-dock-state-dot" />
            Not ready
          </span>
        </div>
        <div className="ssn-dock-foot">
          <span className="ssn-dock-hint">
            {dockHint ?? "Auto-submits on scan"} · <kbd>Esc</kbd> clears
          </span>
          <button
            type="button"
            className="ssn-btn ssn-btn--ghost ssn-btn--sm"
            onClick={onFocusScanner}
            title={copy.scanning.refocus}
          >
            Focus scanner
          </button>
        </div>
      </div>
    </section>
  );
};

/** One tally line in the session card: a label and how many of it. */
export interface StationTally {
  key: string;
  label: string;
  count: number;
  /** Shown instead of the count when a station measures in something other than pieces. */
  countLabel?: string;
}

export const SessionCard: React.FC<{
  code: string | null;
  meta: string;
  tallies: StationTally[];
  total: number;
  /** "cartons" / "packets" — what the big number counts. */
  totalNoun: string;
  /** "Received" / "Issued" — what the station did to them. */
  totalLabel?: string;
  /** "Products" / "Materials" — what the second KPI counts. */
  groupNoun: string;
  subhead: string;
  emptyLabel: string;
}> = ({ code, meta, tallies, total, totalNoun, totalLabel = "Received", groupNoun, subhead, emptyLabel }) => {
  const max = tallies.reduce((m, row) => Math.max(m, row.count), 0) || 1;
  return (
    <section className="ssn-card ssn-session" aria-label="This session">
      <div className="ssn-card-head">
        <span className="ssn-card-title">Session</span>
        <span className="ssn-session-code ssn-mono" data-testid="session-code">
          {code ?? "—"}
        </span>
      </div>
      <div className="ssn-session-meta">{meta}</div>

      <div className="ssn-kpis">
        <div className="ssn-kpi">
          <span className="ssn-kpi-label">{totalLabel}</span>
          <span className="ssn-kpi-value" data-testid="received-count">
            {total.toLocaleString()}
          </span>
          <span className="ssn-kpi-sub">{totalNoun}</span>
        </div>
        <div className="ssn-kpi">
          <span className="ssn-kpi-label">{groupNoun}</span>
          <span className="ssn-kpi-value">{tallies.length.toLocaleString()}</span>
          <span className="ssn-kpi-sub">distinct</span>
        </div>
      </div>

      <div className="ssn-subhead">
        <span>{subhead}</span>
      </div>
      <div className="ssn-summary">
        {tallies.length === 0 ? (
          <div className="ssn-empty">{emptyLabel}</div>
        ) : (
          tallies.map((row) => (
            <div className="ssn-summary-row" key={row.key}>
              <span
                className="ssn-summary-bar"
                aria-hidden="true"
                style={{ width: `${Math.max((row.count / max) * 100, 8)}%` }}
              />
              <span>{row.label}</span>
              <strong>{row.countLabel ?? row.count.toLocaleString()}</strong>
            </div>
          ))
        )}
      </div>
      <div className="ssn-summary-total">
        <span>{copy.columns.total}</span>
        <span data-testid="session-total">{total.toLocaleString()}</span>
      </div>
    </section>
  );
};

/** One scanned line, as every station's cards and tables show it. */
export interface StationScanRow {
  key: string;
  qrId: string;
  product: string;
  at: string;
  /** The green pill: "In Store", "To Gate", … */
  badge: string;
}

export const LastScanCard: React.FC<{ title: string; row: StationScanRow | null }> = ({ title, row }) => (
  <section className="ssn-card" aria-label={title}>
    <div className="ssn-card-head">
      <span className="ssn-card-title">{title}</span>
      {row && <span className="ssn-last-time">{formatTime(row.at)}</span>}
    </div>
    <div className="ssn-last-body" data-testid="last-received">
      {row ? (
        <>
          <div className="ssn-last-row">
            <span className="ssn-badge ssn-badge--ok">{row.badge}</span>
            <span className="ssn-last-product">{row.product}</span>
          </div>
          <span className="ssn-mono ssn-last-qr">{row.qrId}</span>
        </>
      ) : (
        <span className="ssn-empty ssn-empty--inline">—</span>
      )}
    </div>
  </section>
);

export const RecentScansCard: React.FC<{
  title: string;
  note: string;
  emptyLabel: string;
  rows: StationScanRow[];
  onOpen?: (qrId: string) => void;
}> = ({ title, note, emptyLabel, rows, onOpen }) => (
  <section className="ssn-card ssn-recent-wrap" aria-label={title}>
    <div className="ssn-card-head">
      <span className="ssn-card-title">{title}</span>
      <span className="ssn-card-note">{note}</span>
    </div>
    <div className="ssn-recent">
      {rows.length === 0 ? (
        <div className="ssn-empty">{emptyLabel}</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="ssn-col-time">{copy.columns.time}</th>
              <th>QR</th>
              <th>{copy.columns.product}</th>
              <th className="ssn-col-status">{copy.columns.status}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.key}
                className="ssn-recent-row"
                tabIndex={onOpen ? 0 : undefined}
                onClick={onOpen ? () => onOpen(row.qrId) : undefined}
                onKeyDown={
                  onOpen
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onOpen(row.qrId);
                        }
                      }
                    : undefined
                }
                title={onOpen ? "Open QR details" : undefined}
              >
                <td className="ssn-col-time">{formatTime(row.at)}</td>
                <td className="ssn-mono">{row.qrId}</td>
                <td className="ssn-col-product">{row.product}</td>
                <td className="ssn-col-status">
                  <span className="ssn-badge ssn-badge--ok">{row.badge}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  </section>
);

/** The toolbar every station wears: back, brand, scanner pill, actions. */
export const StationToolbar: React.FC<{
  /** Both are left out where the screen around the station already names it. */
  eyebrow?: string;
  title?: string;
  onBack?: () => void;
  backLabel?: string;
  scannerPill?: { text: string; color: string };
  children?: React.ReactNode;
}> = ({ eyebrow, title, onBack, backLabel = "Store", scannerPill, children }) => (
  <header className="ssn-toolbar">
    <div className="ssn-brand">
      {onBack && (
        <button
          type="button"
          className="ssn-btn ssn-btn--ghost"
          onClick={onBack}
          title={`Back to ${backLabel}`}
          aria-label={`Back to ${backLabel}`}
        >
          <ChevronLeftIcon />
          {backLabel}
        </button>
      )}
      <div className="ssn-brand-icon">
        <BrandIcon />
      </div>
      {eyebrow || title ? (
        <div className="ssn-brand-text">
          {eyebrow ? <span className="ssn-eyebrow">{eyebrow}</span> : null}
          {title ? <h1 className="ssn-title">{title}</h1> : null}
        </div>
      ) : null}
    </div>
    <div className="ssn-toolbar-actions">
      {scannerPill && (
        <span className="ssn-pill" title={copy.scanning.scannerStatus}>
          <span className="ssn-pill-dot" style={{ background: scannerPill.color }} />
          {scannerPill.text}
        </span>
      )}
      {children}
    </div>
  </header>
);

/** The full-bleed "this station cannot run" state. */
export const StationBlocked: React.FC<{ title: string; message: string; onRetry: () => void }> = ({
  title,
  message,
  onRetry,
}) => (
  <div className="ssn-blocked" role="alert">
    <div className="ssn-blocked-icon" aria-hidden="true">
      <AlertIcon />
    </div>
    <strong>{title}</strong>
    <span>{message}</span>
    <button type="button" className="ssn-btn" onClick={onRetry}>
      Try again
    </button>
  </div>
);

export { PlusIcon };
