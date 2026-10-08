import React, { useCallback, useEffect, useRef, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { DashboardSnapshot, DispatchSessionDetail, DispatchSessionSummary, HistoryRow } from "../types/desktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { playScanSound } from "../utils/playScanSound";
import { cartonsToDozens } from "@erp/domain";
import { parseQrForDisplay } from "../utils/qr";
import { copy } from "../config/copy";

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Article/colour/size for the result card come from the shared scanner utils (backed by the
// @erp/domain parser); the dispatch decision itself is made by the main process.

type ScanStatus = "idle" | "success" | "error";

interface ScanResult {
  status: ScanStatus;
  article: string;
  color: string;
  size: string;
  reason?: string;
}

/** The bill being dispatched. Progress is in cartons — the unit the scanner counts. */
type DispatchSession = Pick<DispatchSessionDetail, "sessionId" | "voucherNumber" | "partyName" | "voucherDate" | "status" | "allowedItems">;

// ─── CSS ──────────────────────────────────────────────────────────────────────

const CSS = `
* { box-sizing: border-box; }
button, input { font: inherit; }
@keyframes ld-card-in {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0);   }
}
@keyframes ld-dot-pulse {
  0%,100% { box-shadow: 0 0 0 0   rgba(217,119,6,0.35); }
  50%     { box-shadow: 0 0 0 5px rgba(217,119,6,0);    }
}
@keyframes ld-laser {
  0%  { top:15%; opacity:.9; }
  47% { top:80%; opacity:.9; }
  50% { top:80%; opacity:0;  }
  53% { top:15%; opacity:0;  }
  100%{ top:15%; opacity:.9; }
}
@keyframes ld-in {
  from { opacity:0; transform:translateY(6px); }
  to   { opacity:1; transform:translateY(0);   }
}
@keyframes ld-num-change {
  0%   { opacity:0; transform:scale(0.85); }
  60%  { opacity:1; transform:scale(1.06); }
  100% { opacity:1; transform:scale(1);    }
}
@keyframes ld-ready-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(37,99,235,.16); }
  50% { box-shadow: 0 0 0 12px rgba(37,99,235,0); }
}
.ld-workstation { color: #101828; background: #f5f7fa; }
.ld-topbar { min-height: 54px; }
.ld-layout { min-height: 0; }
.ld-rail { width: 270px; }
.ld-main { min-width: 0; }
.ld-progress-track { height: 8px; }
.ld-status { font-size: clamp(30px, 3vw, 42px); }
.ld-input { height: 48px; }
.ld-panel { border: 1px solid #e4e7ec; border-radius: 12px; background: var(--white); box-shadow: 0 3px 12px rgba(16,24,40,.035); }
.ld-table-row { display: grid; grid-template-columns: 1.1fr 1.1fr .8fr .9fr .7fr 1.25fr; align-items: center; gap: 12px; }
@media (max-width: 900px) {
  .ld-layout { overflow: hidden !important; flex-direction: column; }
  .ld-rail { width: 100%; border-right: 0 !important; border-bottom: 1px solid #dfe5ed; max-height: 42%; }
  .ld-main { min-height: 0; }
  .ld-table-row { grid-template-columns: 1fr 1fr .8fr .9fr 1fr; }
  .ld-table-row > :nth-child(5) { display: none; }
}
@media (max-width: 560px) {
  .ld-topbar { padding: 16px !important; align-items: flex-start !important; }
  .ld-topbar > div:nth-child(2) { text-align: right !important; }
  .ld-topbar > div:nth-child(2) > div:last-child { flex-direction: column; align-items: flex-end !important; gap: 2px !important; }
  .ld-topbar > div:last-child { display: none; }
  .ld-main { padding: 20px 16px !important; }
  .ld-status { font-size: 40px; }
  .ld-input { height: 64px; }
}
`;

// ─── Ambient backgrounds (mirrors LiveProduction) ─────────────────────────────

const AMBIENT: Record<ScanStatus, string> = {
  idle: "#f4f6f8",
  success: "#f0fdf4",
  error: "#fef2f2",
};

// ─── SVG icons (matches Live Production) ─────────────────────────────────────

const ScanIcon = ({ size = 80 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 80 80" fill="none">
    <path d="M10 26V10h16" stroke="var(--accent)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M54 10h16v16" stroke="var(--accent)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M10 54v16h16" stroke="var(--accent)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M54 70h16V54" stroke="var(--accent)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
    <line x1="20" y1="32" x2="60" y2="32" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" opacity=".45"/>
    <line x1="20" y1="40" x2="60" y2="40" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round"/>
    <line x1="20" y1="48" x2="60" y2="48" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" opacity=".45"/>
    <line x1="30" y1="26" x2="30" y2="54" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" opacity=".22"/>
    <line x1="40" y1="26" x2="40" y2="54" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" opacity=".22"/>
    <line x1="50" y1="26" x2="50" y2="54" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" opacity=".22"/>
  </svg>
);

const CheckIcon = ({ size = 80 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 80 80" fill="none">
    <circle cx="40" cy="40" r="37" stroke="var(--ok)" strokeWidth="3.5" fill="rgba(220,252,231,0.6)" />
    <path d="M22 41l12 13 24-26" stroke="var(--ok)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ErrorIcon = ({ size = 80 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 80 80" fill="none">
    <circle cx="40" cy="40" r="37" stroke="var(--err)" strokeWidth="3.5" fill="rgba(254,226,226,0.6)" />
    <path d="M26 26l28 28M54 26L26 54" stroke="var(--err)" strokeWidth="5" strokeLinecap="round" />
  </svg>
);

const LaserLine = () => (
  <div style={{
    position: "absolute", left: 10, right: 10, height: 2,
    background: "linear-gradient(90deg,transparent,var(--accent) 25%,var(--accent) 75%,transparent)",
    animation: "ld-laser 2.4s linear infinite",
    borderRadius: 1, pointerEvents: "none",
  }}/>
);

// ─── Bill card (pending queue) ────────────────────────────────────────────────

const BillCard = ({
  session,
  index,
  isSelected,
  onOpen,
}: {
  session: {
    sessionId: string;
    voucherNumber: string;
    partyName: string;
    voucherDate: string;
    totalQuantity: number;
    totalAmount: number;
    status: string;
  };
  index: number;
  isSelected: boolean;
  onOpen: () => void;
}) => {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  const dozensQty  = session.totalQuantity;
  const isInProgress = session.status === "IN_PROGRESS";

  const borderColor = isSelected ? "var(--accent)" : hovered ? "var(--neutral-400)" : "var(--neutral-200)";
  const shadow = pressed
    ? "0 1px 3px rgba(15,23,42,0.06)"
    : hovered || isSelected
      ? "0 6px 22px rgba(15,23,42,0.11), 0 2px 6px rgba(15,23,42,0.06)"
      : "0 1px 4px rgba(15,23,42,0.06)";
  const translateY = pressed ? "0px" : hovered && !isSelected ? "-2px" : "0px";

  return (
    <button
      type="button"
      onClick={onOpen}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setPressed(false); }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      style={{
        display: "flex", alignItems: "center", width: "100%",
        textAlign: "left", cursor: "pointer",
        background: isSelected ? "#fafcff" : "var(--white)",
        border: `1px solid ${borderColor}`,
        borderLeft: `3px solid ${isInProgress ? "var(--accent)" : "var(--warn)"}`,
        borderRadius: 10, padding: "16px 24px",
        boxShadow: shadow,
        transform: `translateY(${translateY}) scale(${pressed ? 0.997 : 1})`,
        transition: "box-shadow 0.16s ease, border-color 0.16s ease, transform 0.13s ease",
        animation: "ld-card-in 0.26s ease both",
        animationDelay: `${index * 60}ms`,
        opacity: 0, gap: 0,
      }}
    >
      {/* Status */}
      <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", justifyContent: "center", paddingRight: 20, minWidth: 68 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{
            width: 6, height: 6, borderRadius: "50%",
            background: isInProgress ? "var(--accent)" : "var(--warn)",
            display: "inline-block", flexShrink: 0,
            animation: isInProgress ? "none" : "ld-dot-pulse 2.6s ease-in-out infinite",
          }} />
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.11em", color: isInProgress ? "var(--accent)" : "var(--warning-deep)", textTransform: "uppercase" }}>
            {isInProgress ? "Active" : "Pending"}
          </span>
        </div>
      </div>

      {/* Identity */}
      <div style={{ flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: 5, paddingRight: 32 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: "#0f172a", letterSpacing: "-0.01em", lineHeight: 1.15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {session.partyName}
        </div>
        <div style={{ fontSize: 11, color: "var(--neutral-400)", fontWeight: 400 }}>
          Bill #{session.voucherNumber}<span style={{ margin: "0 5px", color: "var(--neutral-300)" }}>·</span>{session.voucherDate}
        </div>
      </div>

      {/* Quantity */}
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 28, paddingRight: 32 }}>
        <div>
          <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.13em", color: "var(--neutral-400)", textTransform: "uppercase", marginBottom: 3 }}>{copy.columns.quantity}</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
            <span style={{ fontSize: 17, fontWeight: 700, color: "#0f172a", fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em", lineHeight: 1 }}>{dozensQty.toLocaleString()}</span>
            <span style={{ fontSize: 9, fontWeight: 600, color: "var(--chrome-muted)", letterSpacing: "0.05em" }}>DOZEN</span>
          </div>
        </div>
        <div>
        </div>
      </div>

      {/* Action */}
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 3, paddingLeft: 20, borderLeft: "1px solid var(--neutral-100)" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)", letterSpacing: "0.01em", whiteSpace: "nowrap" }}>
          {isInProgress ? "Continue" : "Start Dispatch"}
        </span>
        <span style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600, display: "inline-block", transform: hovered ? "translateX(3px)" : "translateX(0)", transition: "transform 0.14s ease" }}>→</span>
      </div>
    </button>
  );
};

// ─── Progress sidebar (left panel of workstation) ─────────────────────────────

const ProgressSidebar = ({ session }: { session: DispatchSession | null }) => {
  if (!session) return <aside className="ld-rail" style={{ background: "var(--white)", display: "flex", alignItems: "center", justifyContent: "center" }}><div style={{ fontSize: 18, color: "#667085" }}>Loading bill…</div></aside>;

  const items = session.allowedItems;
  const totalReqCtn = items.reduce((sum, item) => sum + item.requiredCartons, 0);
  const totalDoneCtn = items.reduce((sum, item) => sum + item.dispatchedCartons, 0);
  const totalRemaining = Math.max(0, totalReqCtn - totalDoneCtn);
  const percent = totalReqCtn ? Math.min(100, Math.round((totalDoneCtn / totalReqCtn) * 100)) : 0;

  return (
    <aside className="ld-rail" style={{ flexShrink: 0, borderRight: "1px solid #dfe5ed", background: "var(--white)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ padding: "14px 18px 13px", borderBottom: "1px solid #edf0f4" }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#667085", marginBottom: 9 }}>DISPATCH PROGRESS</div>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ width: 88, height: 88, flexShrink: 0, borderRadius: "50%", background: `conic-gradient(${totalRemaining ? "#2463eb" : "var(--ok)"} ${percent}%, #edf0f4 0)`, display: "grid", placeItems: "center" }}><div style={{ width: 72, height: 72, borderRadius: "50%", background: "var(--white)", display: "grid", placeItems: "center", textAlign: "center" }}><div><div style={{ fontSize: 22, lineHeight: 1, fontWeight: 800, color: totalRemaining ? "#2463eb" : "#15803d" }}>{percent}%</div><div style={{ marginTop: 3, fontSize: 8, color: "#667085", fontWeight: 700 }}>SCANNED</div></div></div></div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 9, flex: 1, fontVariantNumeric: "tabular-nums" }}><div><strong style={{ fontSize: 17 }}>{totalDoneCtn}</strong><span style={{ display: "block", color: "#667085", fontSize: 9 }}>Scanned</span></div><div><strong style={{ fontSize: 17 }}>{totalRemaining}</strong><span style={{ display: "block", color: "#667085", fontSize: 9 }}>Pending</span></div><div><strong style={{ fontSize: 17, color: "#667085" }}>{totalReqCtn}</strong><span style={{ display: "block", color: "#667085", fontSize: 9 }}>{copy.columns.total}</span></div></div>
        </div>
      </div>
      <div style={{ padding: "12px 18px 6px", fontSize: 10, fontWeight: 700, color: "#667085" }}>PENDING ITEMS</div>
      <div style={{ flex: 1, overflow: "hidden", padding: "0 12px 10px" }}>
        {items.map((item) => {
          const required = item.requiredCartons;
          const scanned = item.dispatchedCartons;
          const complete = scanned >= required;
          return <div key={item.lineItemId} style={{ padding: "9px 6px", borderBottom: "1px solid #edf0f4", borderRadius: 7, opacity: complete ? .76 : 1, background: complete ? "linear-gradient(100deg, #f0fdf4, var(--white))" : "transparent", boxShadow: complete ? "inset 3px 0 0 #86efac" : "none" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ fontSize: 14, fontWeight: 750 }}>{item.article}</span><span style={{ fontSize: 12, color: "#667085" }}>{item.size}</span><span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, color: "#344054" }}>{complete ? "✓ COMPLETE" : `${required - scanned} PENDING`}</span></div>
            <div style={{ marginTop: 4, display: "flex", justifyContent: "flex-end", fontSize: 11, fontWeight: 650, color: "#344054" }}><span>{scanned}/{required}</span></div>
          </div>;
        })}
      </div>
    </aside>
  );
};

// ─── Center scanner panel ─────────────────────────────────────────────────────

const LegacyWorkstationCenter = ({
  result,
  session,
  inputRef,
  inputVal,
  onInputChange,
  onKeyDown,
}: {
  result: ScanResult;
  session: DispatchSession | null;
  inputRef: React.RefObject<HTMLInputElement | null>;
  inputVal: string;
  onInputChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) => {
  const isIdle    = result.status === "idle";
  const isSuccess = result.status === "success";
  const isError   = result.status === "error";

  const statusLabel =
    isIdle    ? "READY TO DISPATCH" :
    isSuccess ? "ITEM SCANNED" :
    result.reason === "ERROR: PRODUCT WAS NEVER PRODUCED"          ? "NEVER PRODUCED" :
    result.reason === "ERROR: PRODUCT NOT FOUND IN STOCK"          ? "NOT IN STOCK" :
    result.reason === "ERROR: PRODUCT HAS ALREADY BEEN DISPATCHED" ? "ALREADY DISPATCHED" :
    result.reason === "ERROR: PRODUCT MUST BE RECEIVED INTO STORE FIRST" ? "RETURNED — RECEIVE INTO STORE FIRST" :
    "WRONG ITEM";

  const statusColor = isSuccess ? "#15803d" : isError ? "var(--danger-strong)" : "#0f172a";
  const chipBorder  = isSuccess ? "#86efac" : isError ? "#fca5a5" : "var(--neutral-200)";
  const chipLabelC  = isSuccess ? "var(--success-strong)" : isError ? "#991b1b" : "var(--neutral-400)";

  // Derive remaining for the scanned article and size.
  const scannedItem = session?.allowedItems.find(
    (it) => it.article.toUpperCase() === result.article.toUpperCase() &&
            it.size.toUpperCase() === result.size.toUpperCase()
  );
  const remAfterScan = scannedItem
    ? Math.max(0, scannedItem.requiredCartons - scannedItem.dispatchedCartons)
    : null;

  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
      padding: "0 32px", overflow: "hidden",
    }}>
      {/* Label */}
      <div style={{ flexShrink: 0, paddingTop: 28, paddingBottom: 8, textAlign: "center" }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.18em", color: "var(--neutral-400)", textTransform: "uppercase" }}>
          DISPATCH WORKSTATION
        </span>
      </div>

      {/* Status */}
      <div style={{
        flexShrink: 0, width: "100%", textAlign: "center",
        height: 68, display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <div style={{
          fontSize: statusLabel.length > 16 ? 32 : 42,
          fontWeight: 800, color: statusColor,
          letterSpacing: "-0.02em", lineHeight: 1.05,
          transition: "color 0.2s ease",
          animation: !isIdle ? "ld-in 0.18s ease" : undefined,
        }}>
          {statusLabel}
        </div>
      </div>

      {/* Icon */}
      <div style={{
        flexShrink: 0, height: 108,
        display: "flex", alignItems: "center", justifyContent: "center",
        position: "relative", width: 108, overflow: "hidden",
      }}>
        {isIdle    && <><ScanIcon size={88}/><LaserLine/></>}
        {isSuccess && <CheckIcon size={88}/>}
        {isError   && <ErrorIcon size={88}/>}
      </div>

      {/* Result chips */}
      <div style={{
        flexShrink: 0, height: 80,
        display: "flex", alignItems: "center", justifyContent: "center", width: "100%",
      }}>
        {!isIdle && (
          <div style={{ display: "flex", gap: 10, animation: "ld-in 0.2s ease" }}>
            {[
              { label: "ARTICLE", value: result.article },
              { label: "SIZE",    value: result.size     },
            ].map(({ label, value }) => (
              <div key={label} style={{
                background: "var(--white)", border: `1.5px solid ${chipBorder}`,
                borderRadius: 10, padding: "10px 18px", textAlign: "center", minWidth: 80,
              }}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: chipLabelC, marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: "#0f172a" }}>{value || "—"}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Remaining counter — the key operational number */}
      <div style={{
        flexShrink: 0, height: 56,
        display: "flex", alignItems: "center", justifyContent: "center", width: "100%",
      }}>
        {isSuccess && remAfterScan !== null && (
          <div style={{ textAlign: "center", animation: "ld-num-change 0.25s ease" }}>
            {remAfterScan === 0 ? (
              <div style={{ fontSize: 18, fontWeight: 700, color: "var(--ok)" }}>
                ✓ Article complete
              </div>
            ) : (
              <div>
                <span style={{ fontSize: 36, fontWeight: 900, color: "#15803d", letterSpacing: "-0.03em", fontVariantNumeric: "tabular-nums" }}>
                  {remAfterScan}
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ok)", marginLeft: 6 }}>remaining</span>
              </div>
            )}
          </div>
        )}
        {isError && (
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--danger-strong)", textAlign: "center", maxWidth: 360, animation: "ld-in 0.2s ease" }}>
            {result.reason?.replace("ERROR: ", "") ?? "Scan rejected — check item."}
          </div>
        )}
      </div>

      {/* Scanner input */}
      <div style={{ flexShrink: 0, width: "100%", maxWidth: 440, paddingTop: 12 }}>
        <input
          ref={inputRef}
          aria-label={copy.scanning.scannerInput}
          value={inputVal}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Scan item QR code…"
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          style={{
            width: "100%", padding: "14px 18px", boxSizing: "border-box",
            background: "var(--white)",
            border: "1.5px solid var(--neutral-200)",
            borderLeft: "4px solid var(--accent)",
            borderRadius: 10,
            color: "#0f172a", fontSize: 14,
            outline: "none", caretColor: "var(--accent)",
            letterSpacing: "0.02em",
            boxShadow: "0 0 0 3px rgba(37,99,235,0.10)",
          }}
        />
        <div style={{ marginTop: 7, fontSize: 10, color: "var(--neutral-400)", letterSpacing: "0.07em", textAlign: "center", fontWeight: 600 }}>
          Scanner active — scan next item
        </div>
      </div>
    </div>
  );
};

const WorkstationCenter = ({
  result,
  session,
  inputRef,
  inputVal,
  onInputChange,
  onKeyDown,
}: {
  result: ScanResult;
  session: DispatchSession | null;
  inputRef: React.RefObject<HTMLInputElement | null>;
  inputVal: string;
  onInputChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}) => {
  const items = session?.allowedItems ?? [];
  const matchingItem = items.find((item) => item.article.toUpperCase() === result.article.toUpperCase() && item.size.toUpperCase() === result.size.toUpperCase());
  const currentItem = matchingItem && matchingItem.dispatchedCartons < matchingItem.requiredCartons
    ? matchingItem
    : items.find((item) => item.dispatchedCartons < item.requiredCartons) ?? items[0];
  const required = currentItem ? currentItem.requiredCartons : 0;
  const scanned = currentItem ? currentItem.dispatchedCartons : 0;
  const remaining = Math.max(0, required - scanned);
  const statusLabel = inputVal ? "SCANNING..." : result.status === "success" ? "ITEM SCANNED" : result.status === "error" ? "WRONG ITEM" : "READY TO SCAN";
  const statusColor = result.status === "success" ? "#15803d" : result.status === "error" ? "#b42318" : "#101828";
  const stateBackground = result.status === "success" ? "#f0fdf4" : result.status === "error" ? "#fff5f5" : "var(--white)";

  return <main className="ld-main" style={{ flex: 1, overflow: "hidden", background: stateBackground, transition: "background .25s ease" }}>
    <div style={{ maxWidth: 920, height: "100%", margin: "0 auto", padding: "16px clamp(18px, 3vw, 40px) 18px", display: "flex", flexDirection: "column", gap: 9 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: result.status === "success" ? "#15803d" : result.status === "error" ? "#b42318" : "#2463eb", fontSize: 11, fontWeight: 750, letterSpacing: ".09em" }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: "currentColor" }} /> LIVE DISPATCH</div>
      <div className="ld-status" style={{ textAlign: "center", color: statusColor, fontWeight: 850, letterSpacing: "-0.045em", lineHeight: 1, transition: "color .2s ease", animation: inputVal ? "ld-ready-pulse 1.2s infinite" : undefined }}>{statusLabel}</div>
      {result.status === "error" && <div style={{ margin: "-2px auto 0", color: "#b42318", fontSize: 12, fontWeight: 650 }}>{result.reason?.replace("ERROR: ", "") ?? "Please scan the correct item"}</div>}

      {currentItem ? <section className="ld-panel" style={{ padding: "15px 18px" }}>
        <div style={{ color: "#667085", fontSize: 11, fontWeight: 700, letterSpacing: ".08em" }}>CURRENT ITEM</div>
        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 18, alignItems: "center", marginTop: 10 }}>
          <div style={{ height: 96, borderRadius: 9, background: "var(--surface-2)", display: "grid", placeItems: "center", color: "#98a2b3", fontSize: 11, fontWeight: 600 }}>Image not found</div>
          <div><div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}><span style={{ fontSize: 28, fontWeight: 850, letterSpacing: "-0.04em" }}>{currentItem.article}</span><span style={{ fontSize: 19, color: "#667085", fontWeight: 650 }}>{currentItem.size}</span></div><div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 0, marginTop: 14, borderTop: "1px solid #edf0f4" }}>{[{ label: "SCANNED", value: scanned, color: "#159447" }, { label: "PENDING", value: remaining, color: "#f22727" }, { label: "TOTAL", value: required, color: "#667085" }].map((stat, index) => <div key={stat.label} style={{ padding: "8px 8px 0", borderLeft: index ? "1px solid #edf0f4" : "none" }}><div style={{ fontSize: 23, fontWeight: 850, color: stat.color, fontVariantNumeric: "tabular-nums" }}>{stat.value}</div><div style={{ color: "#667085", fontSize: 9, fontWeight: 750, letterSpacing: ".06em" }}>{stat.label}</div><div style={{ color: "#98a2b3", fontSize: 9 }}>ITEMS</div></div>)}</div></div>
        </div>
      </section> : <div className="ld-panel" style={{ padding: 30, textAlign: "center", color: "#667085" }}>Loading current item…</div>}

      <section className="ld-panel" style={{ padding: "13px 18px" }}><div style={{ fontSize: 12, fontWeight: 750, color: "#344054" }}>SCAN NEXT ITEM</div><div style={{ position: "relative", marginTop: 8 }}><div style={{ position: "absolute", left: 12, top: 7, width: 34, height: 34, overflow: "hidden", opacity: inputVal ? 1 : .7 }}><ScanIcon size={34}/><LaserLine/></div><input className="ld-input" ref={inputRef} aria-label={copy.scanning.scannerInput} value={inputVal} onChange={(event) => onInputChange(event.target.value)} onKeyDown={onKeyDown} placeholder="Scan item QR code" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} style={{ width: "100%", marginTop: 0, padding: "0 15px 0 58px", border: `2px solid ${inputVal ? "#2463eb" : "#d0d5dd"}`, borderRadius: 8, background: "var(--white)", color: "#101828", fontSize: 15, outline: "none", boxShadow: inputVal ? "0 0 0 4px rgba(36,99,235,.12)" : "none" }} /></div><div style={{ margin: "5px 0 0 4px", color: "#98a2b3", fontSize: 10 }}>{inputVal ? "Reading item…" : result.status === "success" ? "Ready for the next item" : "Click here and scan"}</div></section>

    </div>
  </main>;
};

// ─── Bill completion screen ───────────────────────────────────────────────────

const CompletionScreen = ({
  session,
  onBack,
}: {
  session: DispatchSession | null;
  onBack: () => void;
}) => (
  <div style={{
    display: "flex", flexDirection: "column", height: "100%",
    background: "#f0fdf4",
    alignItems: "center", justifyContent: "center",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  }}>
    <style>{CSS}</style>
    <div style={{ width: "min(720px, 90%)", padding: "56px 40px", textAlign: "center", animation: "ld-in 0.3s ease" }}>
      <CheckIcon size={96} />
      <div style={{ marginTop: 20, fontSize: "clamp(36px, 5vw, 54px)", fontWeight: 900, color: "#15803d", letterSpacing: "-0.05em", lineHeight: 1 }}>
        DISPATCH COMPLETE
      </div>
      <div style={{ marginTop: 14, fontSize: 19, fontWeight: 750, color: "var(--success-strong)" }}>
        {session?.partyName ?? "—"}
      </div>
      <div style={{ marginTop: 8, fontSize: 17, color: "var(--success-strong)", fontWeight: 700 }}>
        {session?.allowedItems.reduce((sum, item) => sum + item.dispatchedCartons, 0)} OF {session?.allowedItems.reduce((sum, item) => sum + item.requiredCartons, 0)} SCANNED
      </div>
      <div style={{ marginTop: 6, fontSize: 14, color: "var(--ok)" }}>
        Bill #{session?.voucherNumber} — All required items scanned
      </div>
      <button
        type="button"
        onClick={onBack}
        style={{
          marginTop: 32, padding: "12px 32px",
          background: "var(--ok)", color: "var(--white)",
          border: "none", borderRadius: 10,
          fontSize: 13, fontWeight: 700, cursor: "pointer",
          boxShadow: "0 4px 12px rgba(22,163,74,0.30)",
          letterSpacing: "0.02em",
        }}
      >
        ← Back to Pending Dispatch
      </button>
    </div>
  </div>
);

// ─── Full-screen dispatch workstation ─────────────────────────────────────────

const DispatchWorkstation = ({
  session,
  result,
  scannerOnline,
  onScan,
  onBack,
}: {
  session: DispatchSession | null;
  result: ScanResult;
  scannerOnline: boolean | null;
  onScan: (raw: string) => void;
  onBack: () => void;
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [inputVal, setInputVal] = useState("");

  // Keep input focused at all times
  useEffect(() => {
    inputRef.current?.focus();
    const interval = setInterval(() => {
      if (document.activeElement !== inputRef.current) inputRef.current?.focus();
    }, 100);
    return () => clearInterval(interval);
  }, []);

  const extractQr = (raw: string) => {
    const m = raw.trim().toUpperCase().match(/[A-Z0-9_\/]{5,}/);
    return m ? m[0] : "";
  };

  const processInput = useCallback((val: string) => {
    const raw = extractQr(val);
    if (!raw || raw.length < 5) return;
    setInputVal("");
    onScan(raw);
  }, [onScan]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); processInput(inputVal); }
    if (e.key === "Escape") { e.preventDefault(); onBack(); }
  };

  useEffect(() => {
    if (!extractQr(inputVal)) return;
    const t = setTimeout(() => processInput(inputVal), 150);
    return () => clearTimeout(t);
  }, [inputVal, processInput]);

  // Check if this bill is fully dispatched
  const items = session?.allowedItems ?? [];
  const totalReqCtn  = items.reduce((s, it) => s + it.requiredCartons, 0);
  const totalDoneCtn = items.reduce((s, it) => s + it.dispatchedCartons, 0);
  const totalBillDozens = items.reduce((s, it) => s + it.requiredDzn, 0);
  const billComplete = totalReqCtn > 0 && totalDoneCtn >= totalReqCtn;

  // Show completion screen if bill is done and last scan was success
  if (billComplete && result.status === "success") {
    return <CompletionScreen session={session} onBack={onBack} />;
  }

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100%", overflow: "hidden",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    }}>
      <style>{CSS}</style>

      {/* ── Header bar ──────────────────────────────────────────────────── */}
      <div className="ld-workstation ld-topbar" style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "18px 30px",
        background: "var(--white)",
        borderBottom: "1px solid var(--neutral-200)",
        flexShrink: 0,
        zIndex: 2,
      }}>
        {/* Back */}
        <button
          type="button"
          onClick={onBack}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            background: "transparent", border: "none", cursor: "pointer",
            fontSize: 12, fontWeight: 600, color: "var(--chrome-muted)",
            padding: "6px 0",
          }}
        >
          <span style={{ fontSize: 14 }}>←</span> Pending Bills
        </button>

        {/* Bill identity */}
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "var(--neutral-400)", textTransform: "uppercase", marginBottom: 2 }}>
            Live Dispatch
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 80, justifyContent: "center" }}>
            <span style={{ fontSize: 21, fontWeight: 850, color: "#0f172a", letterSpacing: "-0.025em" }}>
              {session?.partyName ?? "—"}
            </span>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--chrome-muted)" }}>
              Bill #{session?.voucherNumber ?? "—"}
            </span>
            <span style={{ fontSize: 12, color: "var(--neutral-400)" }}>
              {session?.voucherDate ?? ""}
            </span>
            <span style={{ fontSize: 21, fontWeight: 800, color: "#101828", fontVariantNumeric: "tabular-nums" }}>
              {totalBillDozens} dozen
            </span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 11px", border: "1px solid #edf0f4", borderRadius: 8, color: scannerOnline === false ? "#b42318" : "#344054", fontSize: 12, fontWeight: 650 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: scannerOnline === false ? "#ef4444" : scannerOnline === null ? "#98a2b3" : "var(--ok)" }} />
          {scannerOnline === false ? "Offline" : scannerOnline === null ? "Checking" : "Online"}
        </div>
      </div>

      {/* ── Main body: progress sidebar + scanner center ──────────────── */}
      <div className="ld-workstation ld-layout" style={{
        flex: 1, display: "flex", overflow: "hidden",
        background: "#f5f7fa",
        transition: "background 0.4s ease",
      }}>
        <ProgressSidebar session={session} />

        <WorkstationCenter
          result={result}
          session={session}
          inputRef={inputRef}
          inputVal={inputVal}
          onInputChange={setInputVal}
          onKeyDown={handleKeyDown}
        />
      </div>
    </div>
  );
};

// ─── Main page ────────────────────────────────────────────────────────────────

export const LiveDispatchPage = () => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [snapshot, setSnapshot]             = useState<DashboardSnapshot | null>(null);
  const [dispatchFeed, setDispatchFeed]     = useState<HistoryRow[]>([]);
  const [pendingSessions, setPendingSessions] = useState<DispatchSessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [activeSession,     setActiveSession]     = useState<DispatchSession | null>(null);
  const [workstationOpen,   setWorkstationOpen]   = useState(false);
  const [scannerOnline, setScannerOnline] = useState<boolean | null>(null);
  const [result, setResult] = useState<ScanResult>({ status: "idle", article: "", color: "", size: "" });

  const loadActiveSession = async (sessionId: string | null): Promise<DispatchSession | null> => {
    if (!sessionId) { setActiveSession(null); return null; }
    const detail = await api.getDispatchSession(sessionId);
    setActiveSession(detail ?? null);
    return detail ?? null;
  };

  const loadSnapshot = async () => {
    const [dashboard, history, sessions] = await Promise.all([
      api.getDashboard(),
      api.listDispatchHistory({ page: 1, pageSize: 100 }),
      api.listDispatchSessions({ status: "ALL" }),
    ]);
    setSnapshot(dashboard);
    setDispatchFeed(history.rows);

    type SessionRow = (typeof sessions)[number];
    const active = sessions
      .filter((s: SessionRow) => s.status === "PENDING" || s.status === "IN_PROGRESS")
      .sort((a: SessionRow, b: SessionRow) => {
        if (a.status !== b.status) return a.status === "IN_PROGRESS" ? -1 : 1;
        return a.voucherDate.localeCompare(b.voucherDate);
      });
    setPendingSessions(active);
    setSelectedSessionId((current: string | null) => {
      if (current && active.some((s: SessionRow) => s.sessionId === current)) return current;
      return active[0]?.sessionId ?? null;
    });
  };

  useEffect(() => { void loadSnapshot(); }, []);

  useEffect(() => {
    void api.getScannerStatus().then(setScannerOnline).catch(() => setScannerOnline(false));
  }, [api]);

  // Auto-refresh; also refresh active session detail while workstation is open
  useEffect(() => {
    const interval = setInterval(() => {
      void loadSnapshot();
      if (workstationOpen && selectedSessionId) void loadActiveSession(selectedSessionId);
    }, 2000);
    return () => clearInterval(interval);
  }, [workstationOpen, selectedSessionId]);

  // Auto-dismiss success/error feedback after 3s
  useEffect(() => {
    if (result.status === "idle") return;
    const t = setTimeout(() => setResult({ status: "idle", article: "", color: "", size: "" }), 3000);
    return () => clearTimeout(t);
  }, [result]);

  const handleScan = async (raw: string) => {
    const { article, color, size } = parseQrForDisplay(raw);
    const parsed = { article, color, size };
    const res = await api.dispatchScan(raw, selectedSessionId ?? undefined);
    if (res.accepted) {
      playScanSound("success");
      setResult({ status: "success", ...parsed });
      push("success", "Dispatched", res.qrId ?? raw);
      const [, refreshedSession] = await Promise.all([
        loadSnapshot(),
        loadActiveSession(selectedSessionId),
      ]);
      if (refreshedSession && refreshedSession.allowedItems.length > 0) {
        const requiredCartons = refreshedSession.allowedItems.reduce((sum, item) => sum + item.requiredCartons, 0);
        const scannedCartons = refreshedSession.allowedItems.reduce((sum, item) => sum + item.dispatchedCartons, 0);
        if (requiredCartons > 0 && scannedCartons >= requiredCartons) {
          setPendingSessions((sessions) => sessions.filter((session) => session.sessionId !== refreshedSession.sessionId));
        }
      }
    } else {
      playScanSound("error");
      setResult({ status: "error", ...parsed, reason: res.reason ?? "ERROR: PRODUCT NOT FOUND IN STOCK" });
      push("error", res.reason ?? "Dispatch failed", res.reason ?? "");
    }
  };

  const openWorkstation = (sessionId: string) => {
    setSelectedSessionId(sessionId);
    setResult({ status: "idle", article: "", color: "", size: "" });
    void loadActiveSession(sessionId);
    setWorkstationOpen(true);
  };

  const closeWorkstation = () => {
    setWorkstationOpen(false);
    setActiveSession(null);
    setResult({ status: "idle", article: "", color: "", size: "" });
    void loadSnapshot();
  };

  // ── Today's dispatched display ───────────────────────────────────────────
  // todaysDispatched counts DISPATCHED scans, i.e. cartons (two per dozen).
  const dispatchedCartons = snapshot?.todaysDispatched ?? 0;
  const dispatchedDozens  = Math.floor(cartonsToDozens(dispatchedCartons));
  const waitingCount      = pendingSessions.length;

  // ── Full-screen workstation view ─────────────────────────────────────────
  if (workstationOpen) {
    return (
      <DispatchWorkstation
        session={activeSession}
        result={result}
        scannerOnline={scannerOnline}
        onScan={(raw) => { void handleScan(raw); }}
        onBack={closeWorkstation}
      />
    );
  }

  // ── Pending queue view ───────────────────────────────────────────────────
  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100%", background: "var(--surface-2)",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    }}>
      <style>{CSS}</style>

      {/* Top bar */}
      <div style={{
        padding: "18px 28px", background: "var(--white)", borderBottom: "1px solid var(--neutral-200)",
        flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: "var(--neutral-400)", textTransform: "uppercase", marginBottom: 3 }}>Operations</div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.02em" }}>Live Dispatch</h1>
        </div>

        {/* Today's Dispatched */}
        <div style={{ background: "var(--surface-2)", border: "1px solid var(--neutral-200)", borderRadius: 10, padding: "10px 18px", boxShadow: "0 1px 3px rgba(15,23,42,0.04)", textAlign: "right" }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", color: "var(--neutral-400)", textTransform: "uppercase", marginBottom: 2 }}>Today's Dispatched</div>
          <div style={{ fontSize: 26, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.03em", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
            {dispatchedDozens.toLocaleString()}
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--chrome-muted)", marginLeft: 5 }}>Dozen</span>
          </div>
        </div>
      </div>

      {/* Pending Dispatch section */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", padding: "22px 28px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 18 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.02em" }}>Pending Dispatch</div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: waitingCount > 0 ? "var(--warning-deep)" : "var(--neutral-400)" }}>
            {waitingCount === 0 ? "All clear" : `${waitingCount} waiting`}
          </div>
        </div>

        {pendingSessions.length === 0 ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#0f172a" }}>All Clear</div>
            <div style={{ fontSize: 13, color: "var(--neutral-400)" }}>No pending dispatches</div>
          </div>
        ) : (
          <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
            {pendingSessions.map((session, idx) => (
              <BillCard
                key={session.sessionId}
                session={session}
                index={idx}
                isSelected={selectedSessionId === session.sessionId}
                onOpen={() => openWorkstation(session.sessionId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
