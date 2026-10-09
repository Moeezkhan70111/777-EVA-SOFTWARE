import React from "react";
import { copy } from "../../config/copy";
import { RawMaterialOutputPage } from "../../pages/RawMaterialOutputPage";
import { HandMovePanel } from "./HandMovePanel";
import { ScanInIcon, StockIcon } from "./StoreIcons";

// STORE OUT — one page for everything that leaves the store.
//
//   ┌ Move Out ───────────────────────────────────────────────────────────┐
//   │ ✋ Move Out by Hand               │ ⌁ Scan Out                       │
//   │ for loose stock with no label     │ the Raw Material Output station  │
//   └───────────────────────────────────┴──────────────────────────────────┘
//
// Two ways out, side by side, because the store uses both in the same breath: the labelled
// packets are scanned, and the nawaar cut off a roll is typed. Neither is a step of the other,
// so neither is behind a tab.
//
// The scan station on the right is the existing Raw Material Output page, embedded. Nothing
// here scans, converts or moves stock by itself.

interface StoreOutPageProps {
  token: string;
  username?: string;
  onBack: () => void;
}

export const StoreOutPage: React.FC<StoreOutPageProps> = ({ token, username, onBack }) => {
  void username;
  return (
    <div className="si-page mo-page">
      <header className="si-head">
        <span className="si-head-mark si-head-mark--out" aria-hidden="true">
          <StockIcon />
        </span>
        <div>
          <h1 className="si-title">{copy.moveOut.title}</h1>
          <p className="si-sub">{copy.moveOut.line}</p>
        </div>
        <button type="button" className="mo-back" onClick={onBack}>
          {copy.store.changeJob}
        </button>
      </header>

      <div className="si-body">
        <section className="si-main mo-main" aria-label={copy.moveOut.manualTitle}>
          <header className="mo-pane-head">
            <span className="si-scan-mark" aria-hidden="true">
              <StockIcon />
            </span>
            <div>
              <h2 className="si-scan-title">{copy.moveOut.manualTitle}</h2>
              <p className="si-scan-line">{copy.moveOut.manualLine}</p>
            </div>
          </header>
          <HandMovePanel direction="OUT" token={token} />
        </section>

        <aside className="si-scan mo-scan" aria-label={copy.moveOut.scanTitle}>
          <header className="si-scan-head">
            <span className="si-scan-mark" aria-hidden="true">
              <ScanInIcon />
            </span>
            <div>
              <h2 className="si-scan-title">{copy.moveOut.scanTitle}</h2>
              <p className="si-scan-line">{copy.moveOut.scanLine}</p>
            </div>
          </header>
          {/* Never keyed: a manual move changes stock, not this station's open session, and
              remounting it would throw that session away mid-delivery. */}
          <RawMaterialOutputPage token={token} embedded />
        </aside>
      </div>
    </div>
  );
};
