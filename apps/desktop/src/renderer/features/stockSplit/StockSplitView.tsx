import React, { useRef, useState } from "react";
import { SplitHandle, splitWidth, useSplitFraction } from "../../components/shared/SplitHandle";
import { copy } from "../../config/copy";
import { withViewTransition } from "../../utils/withViewTransition";

// UPPER STOCK BESIDE CARTON STOCK, AND THE OTHER WAY ROUND (owner, 25 Nov 2026): one button on each page opens the
// other page beside it, split by the same draggable divider as the Store page, so the two can be read together.
//
//   [ Search … ]  [ Series ▾ ]  [ ⇆ Show Carton Stock beside ]   (closed: the button sits in the page's own toolbar,
//                                                                  with the other controls: one row, not two)
//
//   ┌ Upper Stock ───────────────┐┃┌ CARTON STOCK ─────── ✕ ┐  (open: each side scrolls on its own;
//   │ …                          │┃│ …                        │   drag ┃ or use the arrow keys to resize)
//   └────────────────────────────┘┃└──────────────────────────┘
//
// Recognition over recall: no switching pages and remembering figures. Fitts: the close button sits on the pane it
// closes. Whether it is open and how wide is remembered on this computer: a convenience, nothing depends on it.
// The companion is null when this user may not open the other page: then there is no button at all.
// docs/56: an opacity fade only (a transform would trap the pickers' fixed dropdowns), interruptible, reduced-motion
// respected in theme.css; on a narrow screen the two stack instead of splitting.

const text = copy.stockSplit;
const SPLIT = { min: 0.3, max: 0.7, default: 0.45, minPx: 360, otherMinPx: 360 } as const;

interface StockSplitViewProps {
  /** Names the open/closed and width memory: one per page. */
  storageKey: string;
  /** The page, given the open/close button to place in its own toolbar (null when there is no other page to open). */
  main: (toggle: React.ReactNode | null) => React.ReactNode;
  /** The other stock page, or null when this user may not open it. */
  companion: React.ReactNode | null;
  companionLabel: string;
  /** WHICH IS WHICH (owner, 26 Nov 2026): side by side, each half is named, with its own icon and its own colour. */
  mainLabel: string;
  mainIcon: React.ReactNode;
  companionIcon: React.ReactNode;
  /** The pages' colours (theme.css [data-page-tone]): Upper Stock purple, Carton Stock blue. */
  mainTone: string;
  companionTone: string;
}

const readOpen = (key: string): boolean => { try { return window.localStorage.getItem(key) === "1"; } catch { return false; } };
const saveOpen = (key: string, open: boolean) => { try { window.localStorage.setItem(key, open ? "1" : "0"); } catch { /* this visit only */ } };

const SplitIcon: React.FC = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" /><path d="M10 3.5v13" />
  </svg>
);

/** A half's name over it: its icon in its colour, then its name. */
const PaneTitle: React.FC<{ icon: React.ReactNode; label: string }> = ({ icon, label }) => (
  <h2 className="stock-pane-title"><span className="stock-pane-icon" aria-hidden="true">{icon}</span>{label}</h2>
);

export const StockSplitView: React.FC<StockSplitViewProps> = (props) => {
  const { storageKey, main, companion, companionLabel } = props;
  const openKey = `${storageKey}.open`;
  const [open, setOpen] = useState(() => companion !== null && readOpen(openKey));
  const [fraction, setFraction] = useSplitFraction(`${storageKey}.width`, SPLIT.min, SPLIT.max);
  const bodyRef = useRef<HTMLDivElement>(null);
  const shown = open && companion !== null;
  const toggle = (next: boolean) => withViewTransition(() => { setOpen(next); saveOpen(openKey, next); });
  const toggleButton = companion === null ? null : (
    <button type="button" className="btn btn-secondary stock-split-toggle" aria-pressed={shown} onClick={() => toggle(!shown)}>
      <SplitIcon /> {shown ? text.hide(companionLabel) : text.show(companionLabel)}
    </button>
  );
  const style = fraction === null ? undefined : ({ ["--stock-split-width"]: splitWidth(fraction, SPLIT.minPx, SPLIT.otherMinPx) } as React.CSSProperties);

  return (
    <div className={shown ? "stock-split is-open" : "stock-split"} ref={bodyRef} style={style}>
      <div className="stock-split-main stock-pane" data-page-tone={shown ? props.mainTone : undefined}>
        {shown ? <header className="stock-pane-head"><PaneTitle icon={props.mainIcon} label={props.mainLabel} /></header> : null}
        {main(toggleButton)}
      </div>
      {shown ? (
        <>
          <SplitHandle label={text.resize} containerRef={bodyRef} fraction={fraction} defaultFraction={SPLIT.default}
            min={SPLIT.min} max={SPLIT.max} onChange={setFraction} className="stock-split-handle" />
          <section className="stock-split-companion stock-pane" aria-label={companionLabel} data-page-tone={props.companionTone}>
            <header className="stock-split-companion-head stock-pane-head">
              <PaneTitle icon={props.companionIcon} label={companionLabel} />
              <button type="button" className="stock-split-close" aria-label={text.hide(companionLabel)} onClick={() => toggle(false)}>✕</button>
            </header>
            <div className="stock-split-companion-body">{companion}</div>
          </section>
        </>
      ) : null}
    </div>
  );
};
