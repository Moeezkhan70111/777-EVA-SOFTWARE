import React from "react";
import { copy } from "../../../config/copy";
import { RawMaterialOutputPage } from "../../../pages/RawMaterialOutputPage";
import { ScanInIcon } from "../StoreIcons";
import type { StationStatus } from "./stationStatus";

// ISSUING's scan panel — Scan Out, exactly as Store Out had it (0.3.7, with the 0.3.8 party badges
// and the party-locked session): the party, New session / End session / Print slip, READY TO SCAN.
// A machine program sheet scanned into it opens the program; its open session is what a program
// batch rides onto the same slip.

interface ScanOutRailProps {
  token: string;
  username?: string;
  hidden: boolean;
  active: boolean;
  onStatus: (status: StationStatus) => void;
  onMachineProgramScan: (code: string) => void;
}

export const ScanOutRail: React.FC<ScanOutRailProps> = ({ token, username, hidden, active, onStatus, onMachineProgramScan }) => (
  <aside className="sp-rail si-scan mo-scan" aria-label={copy.moveOut.scanTitle} hidden={hidden}>
    <header className="si-scan-head">
      <span className="si-scan-mark" aria-hidden="true">
        <ScanInIcon />
      </span>
      <div>
        <h2 className="si-scan-title">{copy.moveOut.scanTitle}</h2>
        <p className="si-scan-line">{copy.moveOut.scanLine}</p>
      </div>
    </header>
    <RawMaterialOutputPage
      token={token}
      username={username}
      embedded
      active={active}
      onStatus={onStatus}
      onMachineProgramScan={onMachineProgramScan}
    />
  </aside>
);
