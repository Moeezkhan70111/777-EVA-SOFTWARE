import React, { useCallback, useState } from "react";
import { copy } from "../../../config/copy";
import { RawMaterialOutputPage } from "../../../pages/RawMaterialOutputPage";
import { ScanRailHeader } from "./ScanRailHeader";
import type { StationStatus } from "./stationStatus";

// ISSUING's scan panel — Scan Out (0.3.7, with the 0.3.8 party badges and the party-locked session;
// 1 Nov 2026 look, as Move in): Ready / Not Ready beside its name, the party, READY TO SCAN with
// Start session inside it, then the party, End session and the session card once one is open, with
// Print slip in the head. A machine program sheet scanned into it opens the program; its open
// session is what a program batch rides onto the same slip.

interface ScanOutRailProps {
  token: string;
  username?: string;
  hidden: boolean;
  active: boolean;
  /** Where its session stands, as it last reported it. */
  status: StationStatus;
  onStatus: (status: StationStatus) => void;
  onMachineProgramScan: (code: string) => void;
}

export const ScanOutRail: React.FC<ScanOutRailProps> = ({ token, username, hidden, active, status, onStatus, onMachineProgramScan }) => {
  // The station's own print action, while it has a slip to print; it prints, the head shows the button.
  const [printSlip, setPrintSlip] = useState<(() => void) | null>(null);
  // Wrapped, because handing setState a function would run it as an updater instead of storing it.
  const onPrintSlip = useCallback((print: (() => void) | null) => setPrintSlip(() => print), []);

  return (
    <aside className="sp-rail sp-rail--out si-scan mo-scan" aria-label={copy.moveOut.scanTitle} hidden={hidden}>
      <ScanRailHeader
        title={copy.moveOut.scanTitle}
        ready={status.open}
        actions={
          printSlip ? (
            <button type="button" className="btn btn-primary si-scan-print" onClick={printSlip}>
              {copy.store.printReceipt}
            </button>
          ) : null
        }
      />
      <RawMaterialOutputPage
        token={token}
        username={username}
        embedded
        active={active}
        onStatus={onStatus}
        onMachineProgramScan={onMachineProgramScan}
        onPrintSlip={onPrintSlip}
      />
    </aside>
  );
};
