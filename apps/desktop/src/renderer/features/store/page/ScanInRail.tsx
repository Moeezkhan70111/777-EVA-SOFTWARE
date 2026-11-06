import React from "react";
import { copy } from "../../../config/copy";
import { RawMaterialInputPage } from "../../../pages/RawMaterialInputPage";
import { ScanInIcon } from "../StoreIcons";
import type { StationStatus } from "./stationStatus";

// RECEIVING's scan panel — Scan Material, arranged exactly as Scan Out (6 Nov 2026), and the same box
// structure, which is what lets the station scroll inside the rail. The Store page keeps it mounted
// whichever mode is on screen, so its session is never lost.

interface ScanInRailProps {
  token: string;
  username?: string;
  hidden: boolean;
  /** Its mode is on screen and nothing else has the page: it may take the scanner's focus. */
  active: boolean;
  onStatus: (status: StationStatus) => void;
}

export const ScanInRail: React.FC<ScanInRailProps> = ({ token, username, hidden, active, onStatus }) => (
  <aside className="sp-rail si-scan" aria-label={copy.store.scanMaterialTitle} hidden={hidden}>
    <header className="si-scan-head">
      <span className="si-scan-mark" aria-hidden="true">
        <ScanInIcon />
      </span>
      <div>
        <h2 className="si-scan-title">{copy.store.scanMaterialTitle}</h2>
        <p className="si-scan-line">{copy.store.scanMaterialLine}</p>
      </div>
    </header>
    <RawMaterialInputPage token={token} username={username} embedded active={active} onStatus={onStatus} />
  </aside>
);
