import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type {
  QrDetail,
  StoreExitScanResult,
  StoreMovedOutRow,
  StoreMoveOutSession,
  StoreMoveOutSessionSummary,
} from "../types/desktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { playScanSound } from "../utils/playScanSound";
import {
  formatDateTime,
  formatTime,
  isCompleteQr,
  productLabel,
  sanitizeScanInput,
  statusLabel,
} from "../utils/storeScanner";
import { QrDetailDrawer } from "./QrManagementPage";
import { copy } from "../config/copy";

// Store Move Out — the store operator's exit station, the mirror of Store Scanning.
//
//   open the screen → scanner is focused → scan carton → ✓ MOVED OUT → ready for the next
//
// Every scan goes straight to the main process (erp:store-exit-scan), which owns the
// IN STORE → TO GATE transition, the STORE_EXIT event and the stock move. A carton that
// was never received into the store is refused here, so the store's in/out record stays
// honest. Once at the gate a carton is ready to be dispatched; the Dispatch scanner takes
// it from there. This page never decides anything about a QR; it only shows what the
// business layer answered and keeps the scanner ready.
//
// Gatepass reservations are reconciled behind the scan by the business layer (oldest open
// gatepass line owing the scanned variant); the station itself is generic and shows nothing
// gatepass-specific.

const RECENT_LIMIT = 12;
/** How long a result stays on screen before the station returns to READY (a new scan overrides it at once). */
const RESULT_HOLD_MS = 2500;

// ─── Feedback model ──────────────────────────────────────────────────────────

type FeedbackTone = "idle" | "success" | "warn" | "error";

interface Feedback {
  tone: FeedbackTone;
  title: string;
  message: string;
  result: StoreExitScanResult | null;
  /** Monotonic counter so an identical repeat scan still restarts the hold timer. */
  seq: number;
}

const IDLE: Feedback = {
  tone: "idle",
  title: "READY TO SCAN",
  message: "Scan the carton leaving the store",
  result: null,
  seq: 0,
};


/** Turns the business layer's answer into what the operator reads. Text always, never colour alone. */
const feedbackFor = (result: StoreExitScanResult, seq: number): Feedback => {
  switch (result.outcome) {
    case "MOVED_OUT":
      return {
        tone: "success",
        title: "✓ MOVED OUT",
        message: "Carton moved out to the gate — ready to be dispatched",
        result,
        seq,
      };
    case "ALREADY_AT_GATE":
      return {
        tone: "warn",
        title: "⚠ ALREADY AT GATE",
        message: "This carton has already been moved out.",
        result,
        seq,
      };
    case "NOT_IN_STORE":
      return {
        tone: "error",
        title: "✕ NOT IN STORE",
        message:
          result.reason ?? "This carton has not been received into the store.",
        result,
        seq,
      };
    case "UNKNOWN_QR":
      return {
        tone: "error",
        title: "✕ UNKNOWN QR",
        message: "This QR is not registered.",
        result,
        seq,
      };
    case "NOT_PRODUCED":
    case "NOT_ELIGIBLE":
    case "STATUS_CHANGED":
      return {
        tone: "error",
        title: "✕ CANNOT MOVE OUT",
        message: result.reason ?? "This carton cannot be moved out.",
        result,
        seq,
      };
    case "RAW_MATERIAL_NOT_SUPPORTED":
      return {
        tone: "error",
        title: "✕ RAW MATERIAL QR",
        message: result.reason ?? "Raw materials cannot be moved from this screen yet.",
        result,
        seq,
      };
    case "INVALID_FORMAT":
      return {
        tone: "error",
        title: "✕ INVALID QR",
        message: result.reason ?? "This is not a valid carton QR.",
        result,
        seq,
      };
    case "NOT_AUTHORIZED":
      return {
        tone: "error",
        title: "✕ NOT AUTHORISED",
        message: result.reason ?? "Your account cannot move cartons out.",
        result,
        seq,
      };
    default:
      return {
        tone: "error",
        title: "✕ SCAN FAILED",
        message: result.reason ?? "The scan could not be saved.",
        result,
        seq,
      };
  }
};

// ─── Styles ────────────────────────────────────────────────────────────────
// The same station layout as Store Scanning. The base is neutral (white surfaces, cool
// grey text and lines) and the only colour is a single "outbound" orange accent — the
// same one the store used for "Move Out" — so the two stations read as
// one product yet are told apart at a glance (In = blue, Out = orange). Amber/yellow is
// reserved for the WARN tone. Scoped entirely under `.smo` so it never leaks into (or
// is affected by) the app's shared theme.
//
// Layout is three zones in one flex column:
//
//   toolbar
//   workspace ─ scan panel (fills the left)  │  session sidebar (fixed width, right)
//   recent activity (full width, anchored to the bottom)
//
// The workspace takes all remaining height; the scan stage, the by-product list and the
// recent table each scroll internally, so nothing relies on a magic min-height.

const PAGE_CSS = `
.smo {
  --out-50: #fff4ee;
  --out-100: #ffe4d4;
  --out-200: #fbd0b5;
  --out-300: #f8a173;
  --out-400: #f07a42;
  --out-500: #e05a1c;
  --out-600: #c2470f;
  --out-700: #9a3a10;
  --ink: #16202b;
  --ink-2: #4a5568;
  --ink-3: #8794a3;
  --line: #e2e6eb;
  --line-2: #eef1f4;
  --surface: var(--white);
  --canvas: #f6f7f9;
  --ok: #15803d;   --ok-bg: #ecfdf3;   --ok-line: #a7e6c0;
  --warn: #a16207; --warn-bg: #fffbeb; --warn-line: #f2d98a;
  --err: var(--danger-strong);  --err-bg: #fef2f2;  --err-line: #f3b9b9;
  --r-sm: 8px; --r-md: 12px; --r-lg: 16px;
  --shadow-card: 0 1px 2px rgba(22, 32, 43, .04);
  --shadow-scan: 0 10px 30px rgba(22, 32, 43, .07), 0 1px 2px rgba(22, 32, 43, .05);
  --focus: 0 0 0 3px rgba(240, 122, 66, .35);
  --mono: "JetBrains Mono", "SF Mono", Consolas, "Liberation Mono", Menlo, monospace;

  display: flex; flex-direction: column; gap: 14px;
  height: 100%; min-height: 0; box-sizing: border-box;
  padding: 16px 24px;
  overflow: auto;
  background: var(--canvas);
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}
.smo * { box-sizing: border-box; }
.smo-mono { font-family: var(--mono); letter-spacing: .01em; }
.smo-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }

/* ── Buttons (page-local, so the shared claymorphic .btn never has to be overridden) ── */
.smo-btn { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 14px; border-radius: var(--r-sm); border: 1px solid var(--line); background: var(--surface); color: var(--ink); font: inherit; font-size: .8rem; font-weight: 700; white-space: nowrap; cursor: pointer; box-shadow: var(--shadow-card); transition: background .12s ease, border-color .12s ease, color .12s ease; }
.smo-btn svg { width: 15px; height: 15px; flex-shrink: 0; }
.smo-btn:hover:not(:disabled) { background: var(--out-50); border-color: var(--out-300); color: var(--out-700); }
.smo-btn:focus-visible { outline: none; box-shadow: var(--focus); }
.smo-btn:disabled { opacity: .5; cursor: default; }
.smo-btn--ghost { border-color: transparent; background: transparent; box-shadow: none; color: var(--ink-2); padding: 0 10px; }
.smo-btn--sm { height: 28px; padding: 0 10px; font-size: .72rem; }


/* ── Toolbar ─────────────────────────────────────────────────────────────── */
.smo-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; flex-shrink: 0; }
.smo-brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.smo-brand-icon { width: 38px; height: 38px; border-radius: 10px; flex-shrink: 0; background: linear-gradient(150deg, var(--out-400), var(--out-600)); box-shadow: 0 4px 12px rgba(224, 90, 28, .25); display: flex; align-items: center; justify-content: center; color: var(--white); }
.smo-brand-icon svg { width: 20px; height: 20px; }
.smo-brand-text { min-width: 0; }
.smo-eyebrow { display: block; font-size: .64rem; font-weight: 700; color: var(--out-600); text-transform: uppercase; letter-spacing: .12em; }
.smo-title { margin: 0; font-size: 1.1rem; font-weight: 800; color: var(--ink); letter-spacing: -.02em; line-height: 1.2; }
.smo-toolbar-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.smo-pill { display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 14px; border-radius: 999px; background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow-card); font-size: .74rem; font-weight: 700; color: var(--ink-2); white-space: nowrap; }
.smo-pill-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; box-shadow: 0 0 0 3px rgba(0,0,0,.04); }

/* ── Workspace ───────────────────────────────────────────────────────────── */
.smo-workspace { flex: 1; min-height: 380px; display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 340px); gap: 14px; }
@media (max-width: 960px) {
  .smo-workspace { grid-template-columns: minmax(0, 1fr); }
  .smo-side { min-height: auto; }
}

/* Scan panel — the page's focal point; its tone follows the last answer */
.smo-scan { position: relative; display: flex; flex-direction: column; min-height: 0; background: var(--surface); border: 1.5px solid var(--out-200); border-radius: var(--r-lg); box-shadow: var(--shadow-scan); overflow: hidden; transition: border-color .15s ease, background .15s ease; }
.smo-scan::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 4px; background: var(--out-500); transition: background .15s ease; }
.smo-scan--success { border-color: var(--ok-line);   background: linear-gradient(180deg, var(--ok-bg),   var(--surface) 180px); }
.smo-scan--warn    { border-color: var(--warn-line); background: linear-gradient(180deg, var(--warn-bg), var(--surface) 180px); }
.smo-scan--error   { border-color: var(--err-line);  background: linear-gradient(180deg, var(--err-bg),  var(--surface) 180px); }
.smo-scan--success::before { background: var(--ok); }
.smo-scan--warn::before    { background: var(--warn); }
.smo-scan--error::before   { background: var(--err); }

.smo-scan-stage { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; padding: 28px 28px 20px; }
.smo-scan-stage-inner { margin: auto; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 14px; width: 100%; max-width: 580px; }
.smo-scan-title { margin: 0; font-size: clamp(1.8rem, 3.4vw, 2.5rem); font-weight: 800; letter-spacing: -.025em; line-height: 1.1; }
.smo-scan--idle    .smo-scan-title { color: var(--out-600); }
.smo-scan--success .smo-scan-title { color: var(--ok); }
.smo-scan--warn    .smo-scan-title { color: var(--warn); }
.smo-scan--error   .smo-scan-title { color: var(--err); }
.smo-scan-message { margin: 0; font-size: 1rem; font-weight: 500; color: var(--ink-2); max-width: 520px; }

.smo-ready-icon { width: 96px; height: 96px; border-radius: 50%; background: radial-gradient(circle at 34% 28%, var(--white), var(--out-100) 72%); border: 1px solid var(--out-200); display: flex; align-items: center; justify-content: center; position: relative; margin-bottom: 6px; }
.smo-ready-icon::before { content: ""; position: absolute; inset: -9px; border-radius: 50%; border: 2px solid var(--out-200); opacity: .55; animation: smo-pulse-ring 2.4s ease-out infinite; }
@keyframes smo-pulse-ring { 0% { transform: scale(.9); opacity: .55; } 75% { transform: scale(1.18); opacity: 0; } 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .smo-ready-icon::before { animation: none; } }

/* Result summary — one contained block below the verdict */
.smo-result { width: 100%; display: flex; flex-direction: column; align-items: center; gap: 12px; margin-top: 6px; padding: 16px 20px; background: rgba(255,255,255,.7); border: 1px solid var(--line); border-radius: var(--r-md); }
.smo-result-id { display: flex; align-items: center; justify-content: center; gap: 10px; flex-wrap: wrap; }
.smo-scan-product { font-size: 1.25rem; font-weight: 800; color: var(--ink); letter-spacing: -.01em; }
.smo-scan-qr { font-size: .8rem; font-weight: 700; color: var(--out-700); background: var(--out-50); border: 1px solid var(--out-100); padding: 3px 10px; border-radius: 6px; }

.smo-transition { display: inline-flex; align-items: center; gap: 10px; height: 32px; padding: 0 14px; border-radius: 999px; background: var(--surface); border: 1px solid var(--line); font-size: .8rem; font-weight: 700; color: var(--ink-2); }
.smo-transition strong { color: var(--ink); }
.smo-transition-arrow { color: var(--out-400); font-weight: 800; }

.smo-scan-facts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; width: 100%; }
.smo-fact { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 8px 10px; min-width: 0; text-align: left; }
.smo-fact-label { font-size: .6rem; font-weight: 700; color: var(--ink-3); text-transform: uppercase; letter-spacing: .08em; }
.smo-fact-value { margin-top: 2px; font-size: .95rem; font-weight: 800; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.smo-scan-time { font-size: .74rem; color: var(--ink-3); font-weight: 600; }

/* Scanner dock — the keyboard-wedge target. The row itself is the visual control; the
   input inside is chromeless. It reads as "armed" while it has focus (which, thanks to
   the auto-refocus logic, is nearly always). */
.smo-dock { flex-shrink: 0; padding: 14px 20px; border-top: 1px solid var(--line-2); background: var(--surface); }
.smo-dock-row { position: relative; display: flex; align-items: center; gap: 12px; height: 54px; padding: 0 10px 0 8px; background: var(--canvas); border: 1.5px solid var(--line); border-radius: var(--r-md); cursor: text; transition: border-color .15s ease, box-shadow .15s ease, background .15s ease; }
.smo-dock-row:focus-within { border-color: var(--out-500); background: var(--surface); box-shadow: 0 0 0 4px rgba(240, 122, 66, .16), 0 6px 18px rgba(22, 32, 43, .08); }
.smo-dock-row--disabled { cursor: not-allowed; background: var(--line-2); }

.smo-dock-icon { width: 36px; height: 36px; border-radius: 9px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; color: var(--out-600); background: var(--out-100); cursor: inherit; transition: background .15s ease, color .15s ease; }
.smo-dock-row:focus-within .smo-dock-icon { background: linear-gradient(150deg, var(--out-400), var(--out-600)); color: var(--white); }
.smo-dock-row--disabled .smo-dock-icon { background: var(--line); color: var(--ink-3); }

/* Reset every global input rule (theme.css styles bare <input> and input:focus), so the
   row — not the field — is the only thing that draws chrome. */
.smo-dock-row .smo-input, .smo-dock-row .smo-input:focus, .smo-dock-row .smo-input:focus-visible {
  flex: 1; min-width: 0; height: 100%; margin: 0; padding: 0;
  border: 0; border-radius: 0; outline: none; box-shadow: none; background: transparent;
  color: var(--ink); font-family: var(--mono); font-size: 1.05rem; font-weight: 700; letter-spacing: .03em;
  caret-color: var(--out-500);
}
.smo-dock-row .smo-input::placeholder { color: var(--ink-3); font-family: "Segoe UI", "Helvetica Neue", sans-serif; font-size: .92rem; font-weight: 600; letter-spacing: 0; opacity: 1; }
.smo-dock-row .smo-input:disabled { color: var(--ink-3); cursor: not-allowed; }

/* Live state chip — pure CSS: which label is visible depends on focus / disabled */
.smo-dock-state { display: none; align-items: center; gap: 7px; height: 26px; padding: 0 10px; border-radius: 999px; border: 1px solid transparent; font-size: .64rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; white-space: nowrap; flex-shrink: 0; }
.smo-dock-state-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
.smo-dock-state--armed { color: var(--ok); background: var(--ok-bg); border-color: var(--ok-line); }
.smo-dock-state--armed .smo-dock-state-dot { animation: smo-blink 1.4s ease-in-out infinite; }
.smo-dock-state--paused { color: var(--warn); background: var(--warn-bg); border-color: var(--warn-line); }
.smo-dock-state--off { color: var(--ink-3); background: var(--surface); border-color: var(--line); }
.smo-dock-row:focus-within .smo-dock-state--armed { display: inline-flex; }
.smo-dock-row:not(:focus-within):not(.smo-dock-row--disabled) .smo-dock-state--paused { display: inline-flex; }
.smo-dock-row--disabled .smo-dock-state--off { display: inline-flex; }
@keyframes smo-blink { 0%, 100% { opacity: 1; } 50% { opacity: .2; } }
@media (prefers-reduced-motion: reduce) { .smo-dock-state--armed .smo-dock-state-dot { animation: none; } }

.smo-dock-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; }
.smo-dock-hint { display: inline-flex; align-items: center; gap: 6px; font-size: .72rem; color: var(--ink-3); font-weight: 600; }
.smo-dock-hint kbd { display: inline-block; min-width: 20px; padding: 1px 6px; border-radius: 5px; border: 1px solid var(--line); background: var(--surface); color: var(--ink-2); font: inherit; font-size: .66rem; font-weight: 800; box-shadow: inset 0 -2px 0 rgba(22, 32, 43, .08); }

/* ── Sidebar ─────────────────────────────────────────────────────────────── */
.smo-side { display: flex; flex-direction: column; gap: 14px; min-height: 0; }
.smo-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow-card); padding: 14px 16px; min-height: 0; display: flex; flex-direction: column; }
.smo-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; flex-shrink: 0; }
.smo-card-title { font-size: .64rem; font-weight: 700; color: var(--out-600); text-transform: uppercase; letter-spacing: .1em; }
.smo-card-note { font-size: .7rem; font-weight: 600; color: var(--ink-3); white-space: nowrap; }

/* Session card: identity → counters → by-product breakdown → total */
.smo-session { flex: 1; }
.smo-session-code { font-size: .82rem; font-weight: 700; color: var(--ink); background: var(--out-50); border: 1px solid var(--out-100); padding: 2px 8px; border-radius: 6px; }
.smo-session-meta { font-size: .74rem; font-weight: 600; color: var(--ink-3); margin: -4px 0 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.smo-kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; flex-shrink: 0; }
.smo-kpi { background: var(--canvas); border: 1px solid var(--line-2); border-radius: var(--r-md); padding: 10px 12px; min-width: 0; }
.smo-kpi-label { display: block; font-size: .6rem; font-weight: 700; color: var(--ink-3); text-transform: uppercase; letter-spacing: .08em; }
.smo-kpi-value { display: block; margin-top: 2px; font-size: 1.6rem; font-weight: 800; color: var(--ink); line-height: 1.1; letter-spacing: -.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.smo-kpi-sub { display: block; font-size: .68rem; font-weight: 600; color: var(--ink-3); }
.smo-subhead { display: flex; align-items: baseline; justify-content: space-between; margin: 14px 0 6px; font-size: .62rem; font-weight: 700; color: var(--ink-3); text-transform: uppercase; letter-spacing: .08em; flex-shrink: 0; }

.smo-summary { flex: 1; overflow-y: auto; min-height: 60px; margin: 0 -6px; padding: 0 6px; }
.smo-summary-row { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 8px; border-radius: var(--r-sm); overflow: hidden; font-size: .8rem; font-weight: 600; color: var(--ink-2); }
.smo-summary-row + .smo-summary-row { margin-top: 2px; }
.smo-summary-bar { position: absolute; inset: 0; background: var(--out-50); border-radius: var(--r-sm); z-index: 0; transition: width .25s ease; }
.smo-summary-row > span, .smo-summary-row > strong { z-index: 1; }
.smo-summary-row > span:not(.smo-summary-bar) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.smo-summary-row strong { color: var(--ink); font-weight: 800; flex-shrink: 0; }
.smo-summary-total { display: flex; justify-content: space-between; align-items: baseline; padding-top: 10px; margin-top: 8px; border-top: 1px solid var(--line); font-size: .66rem; font-weight: 700; color: var(--ink-3); text-transform: uppercase; letter-spacing: .08em; flex-shrink: 0; }
.smo-summary-total span[data-testid] { font-size: 1.05rem; font-weight: 800; color: var(--ink); letter-spacing: 0; text-transform: none; }

/* Last moved out */
.smo-last-body { display: flex; flex-direction: column; gap: 6px; }
.smo-last-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.smo-last-product { font-size: .92rem; font-weight: 800; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.smo-last-qr { font-size: .76rem; font-weight: 700; color: var(--out-700); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.smo-last-time { font-size: .74rem; font-weight: 700; color: var(--ink-2); }

.smo-badge { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 8px; border-radius: 999px; font-size: .66rem; font-weight: 700; letter-spacing: .02em; white-space: nowrap; flex-shrink: 0; }
.smo-badge--ok { background: var(--ok-bg); color: var(--ok); border: 1px solid var(--ok-line); }
.smo-empty { padding: 20px 8px; color: var(--ink-3); font-size: .8rem; font-weight: 600; text-align: center; }
.smo-empty--inline { padding: 4px 0; text-align: left; }

/* ── Recent activity ─────────────────────────────────────────────────────── */
.smo-recent-wrap { flex-shrink: 0; padding-bottom: 6px; }
.smo-recent { max-height: 196px; overflow-y: auto; margin: 0 -8px; padding: 0 8px; }
.smo-recent table { width: 100%; border-collapse: collapse; font-size: .78rem; }
.smo-recent th { position: sticky; top: 0; z-index: 1; text-align: left; font-size: .6rem; font-weight: 700; color: var(--ink-3); text-transform: uppercase; letter-spacing: .08em; padding: 4px 10px 8px; background: var(--surface); box-shadow: inset 0 -1px 0 var(--line); }
.smo-recent td { padding: 8px 10px; border-bottom: 1px solid var(--line-2); color: var(--ink-2); font-weight: 600; white-space: nowrap; }
.smo-recent td.smo-col-product { color: var(--ink); font-weight: 700; }
.smo-recent th.smo-col-time, .smo-recent td.smo-col-time { width: 84px; }
.smo-recent th.smo-col-status, .smo-recent td.smo-col-status { width: 110px; text-align: right; }
.smo-recent tr.smo-recent-row { cursor: pointer; transition: background .1s ease; }
.smo-recent tr.smo-recent-row:hover td { background: var(--out-50); }
.smo-recent tr.smo-recent-row:focus-visible { outline: none; }
.smo-recent tr.smo-recent-row:focus-visible td { background: var(--out-100); }
.smo-recent tr.smo-recent-row:last-child td { border-bottom: 0; }

/* ── Blocked state ───────────────────────────────────────────────────────── */
.smo-blocked { grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; padding: 40px 28px; background: var(--surface); border: 1px dashed var(--line); border-radius: var(--r-lg); color: var(--ink-2); font-size: .9rem; }
.smo-blocked-icon { width: 48px; height: 48px; border-radius: 50%; background: var(--err-bg); color: var(--err); border: 1px solid var(--err-line); display: flex; align-items: center; justify-content: center; margin-bottom: 4px; }
.smo-blocked-icon svg { width: 22px; height: 22px; }
.smo-blocked strong { font-size: 1.05rem; color: var(--ink); }
.smo-blocked .smo-btn { margin-top: 6px; }
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
  <div className="smo-ready-icon" aria-hidden="true">
    <svg width="44" height="44" viewBox="0 0 48 48" fill="none">
      <path
        d="M8 18V8h10M30 8h10v10M8 30v10h10M30 40h10V30"
        stroke="var(--out-600)"
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

// ─── Sub-components ──────────────────────────────────────────────────────────

const ScanPanel: React.FC<{
  feedback: Feedback;
  inputRef: React.RefObject<HTMLInputElement | null>;
  inputVal: string;
  onInputChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onFocusScanner: () => void;
  disabled: boolean;
}> = ({
  feedback,
  inputRef,
  inputVal,
  onInputChange,
  onKeyDown,
  onFocusScanner,
  disabled,
}) => {
  const r = feedback.result;
  const isIdle = feedback.tone === "idle";
  return (
    <section
      className={`smo-scan smo-scan--${feedback.tone}`}
      aria-live="polite"
      aria-label={copy.scanning.station}
    >
      <div className="smo-scan-stage">
        <div className="smo-scan-stage-inner">
          {isIdle && <ReadyIcon />}
          <h2 className="smo-scan-title" data-testid="scan-status">
            {feedback.title}
          </h2>
          <p className="smo-scan-message">{feedback.message}</p>

          {r && (
            <div className="smo-result">
              <div className="smo-result-id">
                {(r.article || r.color || r.size) && (
                  <span className="smo-scan-product">{productLabel(r)}</span>
                )}
                {r.qrId && (
                  <span className="smo-scan-qr smo-mono">{r.qrId}</span>
                )}
              </div>

              {feedback.tone === "success" && (
                <div className="smo-transition" aria-label={copy.scanning.statusChange}>
                  <span>{statusLabel(r.previousStatus)}</span>
                  <span className="smo-transition-arrow" aria-hidden="true">
                    →
                  </span>
                  <strong>{statusLabel(r.currentStatus)}</strong>
                </div>
              )}
              {feedback.tone !== "success" &&
                (r.currentStatus || r.registryStatus) && (
                  <div className="smo-transition" aria-label={copy.scanning.currentStatus}>
                    <span>{copy.scanning.currentStatus}</span>
                    <strong>
                      {statusLabel(r.currentStatus ?? r.registryStatus)}
                    </strong>
                  </div>
                )}

              {feedback.tone === "success" && (
                <div className="smo-scan-facts">
                  {[
                    ["Article", r.article],
                    ["Color", r.color],
                    ["Size", r.size],
                    ["Serial", r.serial],
                  ].map(([label, value]) => (
                    <div className="smo-fact" key={label}>
                      <div className="smo-fact-label">{label}</div>
                      <div className="smo-fact-value">{value || "—"}</div>
                    </div>
                  ))}
                </div>
              )}
              {r.movedOutAt && (
                <div className="smo-scan-time">
                  Moved out {formatDateTime(r.movedOutAt)}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Keyboard-wedge scanner target. Kept visible but secondary, so a supervisor can
          type a code for troubleshooting without this becoming a manual-entry workflow. */}
      <div className="smo-dock">
        <div
          className={`smo-dock-row${disabled ? " smo-dock-row--disabled" : ""}`}
        >
          <label
            className="smo-dock-icon"
            htmlFor="smo-scanner-input"
            title={copy.scanning.scannerInput}
          >
            <ScannerIcon />
            <span className="smo-sr-only">Scanner</span>
          </label>
          <input
            id="smo-scanner-input"
            ref={inputRef}
            className="smo-input"
            value={inputVal}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={disabled ? "Session not ready" : "Waiting for scan…"}
            aria-label={copy.scanning.scannerInput}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={disabled}
          />
          {/* Exactly one of these is visible, chosen by CSS from focus / disabled state. */}
          <span className="smo-dock-state smo-dock-state--armed" aria-hidden="true">
            <span className="smo-dock-state-dot" />
            Listening
          </span>
          <span className="smo-dock-state smo-dock-state--paused" aria-hidden="true">
            <span className="smo-dock-state-dot" />
            Click to focus
          </span>
          <span className="smo-dock-state smo-dock-state--off" aria-hidden="true">
            <span className="smo-dock-state-dot" />
            Not ready
          </span>
        </div>
        <div className="smo-dock-foot">
          <span className="smo-dock-hint">
            Auto-submits on scan · <kbd>Esc</kbd> clears
          </span>
          <button
            type="button"
            className="smo-btn smo-btn--ghost smo-btn--sm"
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

const SessionCard: React.FC<{
  session: StoreMoveOutSession | null;
  sessionError: string | null;
  summary: StoreMoveOutSessionSummary | null;
}> = ({ session, sessionError, summary }) => {
  const rows = summary?.byProduct ?? [];
  const total = summary?.movedOutCount ?? 0;
  const max = rows.reduce((m, row) => Math.max(m, row.count), 0) || 1;
  return (
    <section className="smo-card smo-session" aria-label="This session">
      <div className="smo-card-head">
        <span className="smo-card-title">Session</span>
        <span className="smo-session-code smo-mono" data-testid="session-code">
          {session?.code ?? "—"}
        </span>
      </div>
      <div className="smo-session-meta">
        {session
          ? `Started ${formatDateTime(session.startedAt)}${session.startedBy ? ` · ${session.startedBy}` : ""}`
          : (sessionError ?? "Starting…")}
      </div>

      <div className="smo-kpis">
        <div className="smo-kpi">
          <span className="smo-kpi-label">Moved out</span>
          <span className="smo-kpi-value" data-testid="moved-out-count">
            {total.toLocaleString()}
          </span>
          <span className="smo-kpi-sub">cartons to gate</span>
        </div>
        <div className="smo-kpi">
          <span className="smo-kpi-label">Products</span>
          <span className="smo-kpi-value">{rows.length.toLocaleString()}</span>
          <span className="smo-kpi-sub">distinct</span>
        </div>
      </div>

      <div className="smo-subhead">
        <span>By product</span>
      </div>
      <div className="smo-summary">
        {rows.length === 0 ? (
          <div className="smo-empty">Nothing moved out yet.</div>
        ) : (
          rows.map((row) => (
            <div
              className="smo-summary-row"
              key={`${row.article}|${row.color}|${row.size}`}
            >
              <span
                className="smo-summary-bar"
                aria-hidden="true"
                style={{ width: `${Math.max((row.count / max) * 100, 8)}%` }}
              />
              <span>{productLabel(row)}</span>
              <strong>{row.count.toLocaleString()}</strong>
            </div>
          ))
        )}
      </div>
      <div className="smo-summary-total">
        <span>{copy.columns.total}</span>
        <span data-testid="session-total">{total.toLocaleString()}</span>
      </div>
    </section>
  );
};

const LastMovedOutCard: React.FC<{ row: StoreMovedOutRow | null }> = ({
  row,
}) => (
  <section className="smo-card" aria-label="Last moved out">
    <div className="smo-card-head">
      <span className="smo-card-title">Last moved out</span>
      {row && (
        <span className="smo-last-time">{formatTime(row.movedOutAt)}</span>
      )}
    </div>
    <div className="smo-last-body" data-testid="last-moved-out">
      {row ? (
        <>
          <div className="smo-last-row">
            <span className="smo-badge smo-badge--ok">To Gate</span>
            <span className="smo-last-product">{productLabel(row)}</span>
          </div>
          <span className="smo-mono smo-last-qr">{row.qrId}</span>
        </>
      ) : (
        <span className="smo-empty smo-empty--inline">—</span>
      )}
    </div>
  </section>
);

const RecentScansCard: React.FC<{
  rows: StoreMovedOutRow[];
  onOpen: (qrId: string) => void;
}> = ({ rows, onOpen }) => (
  <section className="smo-card smo-recent-wrap" aria-label="Recently moved out">
    <div className="smo-card-head">
      <span className="smo-card-title">Recently moved out</span>
      <span className="smo-card-note">
        Last {RECENT_LIMIT} · click a row for details
      </span>
    </div>
    <div className="smo-recent">
      {rows.length === 0 ? (
        <div className="smo-empty">No cartons moved out in this session yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="smo-col-time">{copy.columns.time}</th>
              <th>QR</th>
              <th>{copy.columns.product}</th>
              <th className="smo-col-status">{copy.columns.status}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.eventId}
                className="smo-recent-row"
                tabIndex={0}
                onClick={() => onOpen(row.qrId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpen(row.qrId);
                  }
                }}
                title="Open QR details"
              >
                <td className="smo-col-time">{formatTime(row.movedOutAt)}</td>
                <td className="smo-mono">{row.qrId}</td>
                <td className="smo-col-product">{productLabel(row)}</td>
                <td className="smo-col-status">
                  <span className="smo-badge smo-badge--ok">To Gate</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  </section>
);

// ─── Page ────────────────────────────────────────────────────────────────────

interface StoreMoveOutPageProps {
  /** Session token; the main process authorises every store-exit call with it. */
  token: string;
  username?: string;
  /** Returns to where this user starts — the Store page, or the Dashboard. Hidden when not provided. */
  onBack?: () => void;
}

export const StoreMoveOutPage: React.FC<StoreMoveOutPageProps> = ({
  token,
  username,
  onBack,
}) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [session, setSession] = useState<StoreMoveOutSession | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [summary, setSummary] = useState<StoreMoveOutSessionSummary | null>(
    null,
  );
  const [feedback, setFeedback] = useState<Feedback>(IDLE);
  const [inputVal, setInputVal] = useState("");
  const [scannerConnected, setScannerConnected] = useState<boolean | null>(
    null,
  );
  const [detailQrId, setDetailQrId] = useState<string | null>(null);
  const [detail, setDetail] = useState<QrDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const scannerReady = Boolean(session) && !sessionError;
  const blocked = Boolean(sessionError) && !session;

  const inputRef = useRef<HTMLInputElement>(null);
  const processingRef = useRef(false);
  const queueRef = useRef<string[]>([]);
  const seqRef = useRef(0);
  const sessionRef = useRef<StoreMoveOutSession | null>(null);
  sessionRef.current = session;

  const focusScanner = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  // ── Session + summary (targeted reads; never the whole event log) ─────────
  const loadSummary = useCallback(
    async (sessionId: string) => {
      try {
        const next = await api.getStoreMoveOutSessionSummary(sessionId, {
          token,
          recentLimit: RECENT_LIMIT,
        });
        if (next) setSummary(next);
      } catch (err) {
        console.error("Failed to load move-out session summary:", err);
      }
    },
    [api, token],
  );

  const openSession = useCallback(
    async (startNew: boolean) => {
      try {
        const res = await api.getStoreMoveOutSession({ token, startNew });
        if (!res.accepted || !res.session) {
          setSession(null);
          setSessionError(res.reason ?? "Could not start a move-out session.");
          return;
        }
        setSessionError(null);
        setSession(res.session);
        setSummary(null);
        await loadSummary(res.session.id);
        if (startNew) push("success", "New move-out session", res.session.code);
      } catch (err) {
        setSession(null);
        setSessionError(
          err instanceof Error
            ? err.message
            : "Could not start a move-out session.",
        );
      }
    },
    [api, token, loadSummary, push],
  );

  useEffect(() => {
    void openSession(false);
  }, [openSession]);

  // ── Scanner hardware presence (same check Live Production uses) ───────────
  useEffect(() => {
    if (typeof api.getScannerStatus !== "function") return;
    let cancelled = false;
    const check = async () => {
      try {
        const connected = await api.getScannerStatus();
        if (!cancelled) setScannerConnected(connected);
      } catch {
        if (!cancelled) setScannerConnected(false);
      }
    };
    void check();
    const iv = setInterval(check, 10000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [api]);

  // ── Focus: on mount, after every result, and whenever the operator strays ─
  useEffect(() => {
    focusScanner();
  }, [focusScanner, session]);

  useEffect(() => {
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (detailQrId) return; // the QR detail drawer owns the keyboard while open
      if (e.key === "Escape") {
        setInputVal("");
        focusScanner();
        return;
      }
      const target = e.target as HTMLElement | null;
      const inField =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        Boolean(target?.isContentEditable);
      // A scanner burst arriving while focus is elsewhere is redirected to the scanner input.
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
  }, [detailQrId, focusScanner]);

  // ── Auto-return to READY (a new scan simply replaces the result) ──────────
  useEffect(() => {
    if (feedback.tone === "idle") return;
    const t = setTimeout(() => setFeedback(IDLE), RESULT_HOLD_MS);
    return () => clearTimeout(t);
  }, [feedback]);

  // ── Apply a result to the on-screen session immediately, then reconcile ───
  const applyAccepted = useCallback(
    (result: StoreExitScanResult) => {
      setSummary((current) => {
        if (!current || !result.qrId || !result.movedOutAt) return current;
        const row: StoreMovedOutRow = {
          eventId: result.eventId ?? `${result.qrId}:${result.movedOutAt}`,
          qrId: result.qrId,
          article: result.article ?? "",
          color: result.color ?? "",
          size: result.size ?? "",
          serial: result.serial ?? "",
          movedOutAt: result.movedOutAt,
          actor: username ?? null,
        };
        const key = (p: { article: string; color: string; size: string }) =>
          `${p.article}|${p.color}|${p.size}`;
        const byProduct = current.byProduct.some((p) => key(p) === key(row))
          ? current.byProduct.map((p) =>
              key(p) === key(row) ? { ...p, count: p.count + 1 } : p,
            )
          : [
              ...current.byProduct,
              {
                article: row.article,
                color: row.color,
                size: row.size,
                count: 1,
              },
            ];
        byProduct.sort(
          (a, b) => b.count - a.count || key(a).localeCompare(key(b)),
        );
        return {
          ...current,
          movedOutCount: current.movedOutCount + 1,
          byProduct,
          recent: [row, ...current.recent].slice(0, RECENT_LIMIT),
          lastMovedOut: row,
        };
      });
    },
    [username],
  );

  // ── The scan itself ───────────────────────────────────────────────────────
  const runScan = useCallback(
    async (cleaned: string) => {
      const activeSession = sessionRef.current;
      seqRef.current += 1;
      const seq = seqRef.current;
      try {
        const result = await api.storeExitScan(cleaned, {
          token,
          sessionId: activeSession?.id,
        });
        if (result.accepted) {
          playScanSound("success");
          applyAccepted(result);
          if (activeSession) void loadSummary(activeSession.id);
        } else {
          playScanSound("error");
        }
        setFeedback(feedbackFor(result, seq));
      } catch (err) {
        playScanSound("error");
        const message =
          err instanceof Error
            ? err.message
            : "The scan could not be processed.";
        setFeedback({
          tone: "error",
          title: "✕ SCAN FAILED",
          message,
          result: {
            accepted: false,
            outcome: "ERROR",
            qrId: cleaned,
            reason: message,
          },
          seq,
        });
      }
    },
    [api, token, applyAccepted, loadSummary],
  );

  // Scans are processed strictly one at a time, in the order they arrived. A burst of
  // scans while one is in flight is queued, never dropped.
  const drainQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const next = queueRef.current.shift()!;
        await runScan(next);
      }
    } finally {
      processingRef.current = false;
      focusScanner();
    }
  }, [runScan, focusScanner]);

  const submitScan = useCallback(
    (raw: string) => {
      const cleaned = sanitizeScanInput(raw);
      if (!cleaned || cleaned.length < 3) return;
      setInputVal("");
      queueRef.current.push(cleaned);
      void drainQueue();
    },
    [drainQueue],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitScan(inputVal);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setInputVal("");
    }
  };

  // Hardware scanners type the whole code in one burst; submit as soon as it is complete
  // rather than waiting for a suffix key the scanner may not be configured to send.
  useEffect(() => {
    if (!inputVal) return;
    const cleaned = sanitizeScanInput(inputVal);
    if (!cleaned) return;
    if (isCompleteQr(cleaned)) {
      const t = setTimeout(() => submitScan(cleaned), 40);
      return () => clearTimeout(t);
    }
    if (cleaned.length >= 5) {
      const t = setTimeout(() => submitScan(cleaned), 120);
      return () => clearTimeout(t);
    }
  }, [inputVal, submitScan]);

  // ── QR detail (the existing QR Management drawer, read-only here) ─────────
  const openDetail = useCallback(
    async (qrId: string) => {
      setDetailQrId(qrId);
      setDetail(null);
      setDetailLoading(true);
      try {
        setDetail(await api.getQrDetail(qrId));
      } catch {
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [api],
  );

  const closeDetail = useCallback(() => {
    setDetailQrId(null);
    setDetail(null);
    focusScanner();
  }, [focusScanner]);

  const lastMovedOut = summary?.lastMovedOut ?? null;
  const scannerPill = useMemo(() => {
    if (scannerConnected === null)
      return { color: "var(--ink-3)", text: "Checking scanner…" };
    return scannerConnected
      ? { color: "var(--ok)", text: "Hardware scanner ready" }
      : { color: "var(--warn)", text: "No hardware scanner — keyboard active" };
  }, [scannerConnected]);

  return (
    <div
      className="smo"
      onClick={(e) => {
        // Clicking empty space is never an action; it just hands focus back to the scanner.
        const target = e.target as HTMLElement | null;
        if (
          target &&
          !target.closest(
            "button, a, input, select, textarea, [role='dialog'], tr.smo-recent-row",
          )
        ) {
          focusScanner();
        }
      }}
    >
      <style>{PAGE_CSS}</style>

      <header className="smo-toolbar">
        <div className="smo-brand">
          {onBack && (
            <button
              type="button"
              className="smo-btn smo-btn--ghost"
              onClick={onBack}
              title="Back"
              aria-label="Back"
            >
              <ChevronLeftIcon />
              Store
            </button>
          )}
          <div className="smo-brand-icon">
            <BrandIcon />
          </div>
          <div className="smo-brand-text">
            <span className="smo-eyebrow">Store · Carton Move Out</span>
            <h1 className="smo-title">Store Move Out</h1>
          </div>
        </div>
        <div className="smo-toolbar-actions">
          <span className="smo-pill" title={copy.scanning.scannerStatus}>
            <span
              className="smo-pill-dot"
              style={{ background: scannerPill.color }}
            />
            {scannerPill.text}
          </span>
          <button
            type="button"
            className="smo-btn"
            onClick={() => void openSession(true)}
            disabled={!session}
            title="Close this move-out session and start a new one"
          >
            <PlusIcon />
            New session
          </button>
        </div>
      </header>

      <div className="smo-workspace">
        {blocked ? (
          <div className="smo-blocked" role="alert">
            <div className="smo-blocked-icon" aria-hidden="true">
              <AlertIcon />
            </div>
            <strong>Store Move Out is not available</strong>
            <span>{sessionError}</span>
            <button
              type="button"
              className="smo-btn"
              onClick={() => void openSession(false)}
            >
              Try again
            </button>
          </div>
        ) : (
          <>
            <ScanPanel
              feedback={feedback}
              inputRef={inputRef}
              inputVal={inputVal}
              onInputChange={setInputVal}
              onKeyDown={handleKeyDown}
              onFocusScanner={focusScanner}
              disabled={!scannerReady}
            />
            <aside className="smo-side">
              <SessionCard
                session={session}
                sessionError={sessionError}
                summary={summary}
              />
              <LastMovedOutCard row={lastMovedOut} />
            </aside>
          </>
        )}
      </div>

      {!blocked && (
        <RecentScansCard
          rows={summary?.recent ?? []}
          onOpen={(qrId) => void openDetail(qrId)}
        />
      )}

      {detailQrId && (
        <QrDetailDrawer
          qrId={detailQrId}
          detail={detail}
          loading={detailLoading}
          username={username}
          readOnly
          onClose={closeDetail}
          onChanged={async () => {
            await openDetail(detailQrId);
          }}
        />
      )}
    </div>
  );
};
