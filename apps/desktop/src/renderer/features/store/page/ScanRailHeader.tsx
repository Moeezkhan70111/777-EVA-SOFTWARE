import React from "react";
import { copy } from "../../../config/copy";
import { ScanInIcon } from "../StoreIcons";

// The head of a Store page scan rail (Receiving's Scan Material, Issuing's Scan Out): its mark, its
// name with a pill beside it saying whether a scan would land now — Ready while a session is open,
// Not Ready until one is — where given, one line on what it does, and on the right whatever the rail puts there
// (Print receipt, while a session is open). The pill says it in words; the dot only repeats it.

interface ScanRailHeaderProps {
  title: string;
  /** One line under the name on what the rail does. Left out on Move in (1 Nov 2026). */
  line?: string;
  /** A session is open, so the scanner's box is armed. */
  ready: boolean;
  /** Shown on the right of the head. */
  actions?: React.ReactNode;
}

export const ScanRailHeader: React.FC<ScanRailHeaderProps> = ({ title, line, ready, actions }) => (
  <header className="si-scan-head">
    <span className="si-scan-mark" aria-hidden="true">
      <ScanInIcon />
    </span>
    <div className="si-scan-text">
      <div className="si-scan-title-row">
        <h2 className="si-scan-title">{title}</h2>
        <span className={`si-scan-state${ready ? " si-scan-state--ready" : ""}`} role="status">
          <span className="si-scan-state-dot" aria-hidden="true" />
          {ready ? copy.store.railReady : copy.store.railNotReady}
        </span>
      </div>
      {line ? <p className="si-scan-line">{line}</p> : null}
    </div>
    {actions ? <div className="si-scan-actions">{actions}</div> : null}
  </header>
);
