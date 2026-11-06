import React, { useCallback, useState } from "react";
import { copy } from "../../../config/copy";
import { RawMaterialInputPage } from "../../../pages/RawMaterialInputPage";
import { ScanRailHeader } from "./ScanRailHeader";
import type { StationStatus } from "./stationStatus";

// RECEIVING's scan panel — Scan Material, the same as Scan Out in layout and in its box structure,
// which is what lets the station scroll inside the rail (6 Nov 2026): Ready / Not Ready beside its
// name, the supplier, READY TO SCAN with Start session inside it, then the party, End session and the
// session card once one is open, with Print receipt in the head. The Store page keeps it mounted
// whichever mode is on screen, so its session is never lost.

interface ScanInRailProps {
  token: string;
  username?: string;
  hidden: boolean;
  /** Its mode is on screen and nothing else has the page: it may take the scanner's focus. */
  active: boolean;
  /** Where its session stands, as it last reported it. */
  status: StationStatus;
  onStatus: (status: StationStatus) => void;
}

export const ScanInRail: React.FC<ScanInRailProps> = ({ token, username, hidden, active, status, onStatus }) => {
  // The station's own print action, while it has a receipt to print; it prints, the head shows the button.
  const [printReceipt, setPrintReceipt] = useState<(() => void) | null>(null);
  // Wrapped, because handing setState a function would run it as an updater instead of storing it.
  const onPrintReceipt = useCallback((print: (() => void) | null) => setPrintReceipt(() => print), []);

  return (
    <aside className="sp-rail sp-rail--in si-scan" aria-label={copy.store.scanMaterialTitle} hidden={hidden}>
      <ScanRailHeader
        title={copy.store.scanMaterialTitle}
        ready={status.open}
        actions={
          printReceipt ? (
            <button type="button" className="btn btn-primary si-scan-print" onClick={printReceipt}>
              {copy.store.printReceipt}
            </button>
          ) : null
        }
      />
      <RawMaterialInputPage token={token} username={username} embedded active={active} onStatus={onStatus} onPrintReceipt={onPrintReceipt} />
    </aside>
  );
};
