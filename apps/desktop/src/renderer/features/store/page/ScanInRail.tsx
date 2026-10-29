import React, { useState } from "react";
import { copy } from "../../../config/copy";
import { SearchableCombobox } from "../../../components/shared/SearchableCombobox";
import { StateView } from "../../../components/shared/StateView";
import { quantityTotalLine } from "../../rawMaterial/storeVoucher";
import { LastScans, ScanCount } from "../stations/ScanCount";
import { ScanZone } from "../stations/ScanZone";
import type { ReceivingStation } from "../stations/useReceivingStation";
import { EndStep, ScanCapture, SessionFooter, WhoStrip, useTyping } from "./RailParts";

// SCAN IN — the Receiving rail, in three zones (0.3.9). An operator scans, hears the beep, glances
// up for half a second, and needs one answer: did it take, and was it the right packet.
//
//   1  WHO      FROM the supplier, and its type                          (teal strip)
//   2  THE SCAN accepted / refused / waiting; the count; the last three scans
//   3  FOOTER   the session's number and total, Type a code, End session (quiet)

const StartReceiving: React.FC<{ station: ReceivingStation }> = ({ station }) => (
  <div className="sz-start">
    <SearchableCombobox
      dropdown
      value={station.partyId}
      options={station.supplierOptions}
      onChange={station.setPartyId}
      ariaLabel={copy.storePage.supplier}
      placeholder={station.supplierOptions.length === 0 ? copy.storePage.noSuppliers : copy.storePage.chooseSupplier}
    />
    <button type="button" className="btn btn-primary sz-start-btn" onClick={() => void station.startSession()} disabled={station.busy || !station.partyId}>
      {copy.storeStation.startSession}
    </button>
  </div>
);

const ReceivingFooter: React.FC<{ station: ReceivingStation; typing: boolean; onToggleTyping: () => void }> = ({ station, typing, onToggleTyping }) => {
  const [ending, setEnding] = useState(false);
  const { session, summary } = station;
  if (!session || !station.open) return null;
  const quantity = summary && summary.byMaterial.length > 0 ? quantityTotalLine(summary.byMaterial) : "—";
  if (ending) {
    return (
      <EndStep
        code={session.code}
        packets={copy.storeStation.packets(summary?.totalPackets ?? 0)}
        quantity={quantity}
        canPrint={Boolean(summary)}
        onPrint={station.print}
        onEnd={() => void station.endSession().then(() => setEnding(false))}
        onKeep={() => setEnding(false)}
      />
    );
  }
  return <SessionFooter line={copy.storeScan.sessionLine(session.code, quantity)} typing={typing} onToggleTyping={onToggleTyping} onEnd={() => setEnding(true)} />;
};

export const ScanInRail: React.FC<{ station: ReceivingStation; hidden: boolean }> = ({ station, hidden }) => {
  const { typing, toggle } = useTyping(station.scanBox);
  const chosen = station.session?.partyName ?? station.suppliers.find((party) => party.id === station.partyId)?.partyName ?? null;
  const chosenType = station.sessionSupplier?.partyType ?? station.suppliers.find((party) => party.id === station.partyId)?.partyType;
  return (
    <aside className="sp-rail" aria-label={copy.storePage.scanIn} hidden={hidden}>
      <WhoStrip mode="in" label={copy.storeScan.from} name={chosen} partyType={chosenType} />
      {station.loadError ? (
        <div className="sp-rail-scan">
          <StateView kind="error" compact message={station.loadError} onRetry={() => void station.reload()} />
        </div>
      ) : (
        <div className="sp-rail-scan">
          <ScanZone mode="in" outcome={station.outcome} state={station.state} doneWord={copy.storeScan.received} notDoneWord={copy.storeScan.notReceived}>
            {station.open ? null : <StartReceiving station={station} />}
          </ScanZone>
          {station.open ? (
            <>
              <ScanCount count={station.summary?.totalPackets ?? 0} label={copy.storeScan.packetsReceived} unchanged={station.outcome.kind === "refused"} />
              <LastScans rows={station.rows} />
            </>
          ) : null}
          <ScanCapture scanBox={station.scanBox} canScan={station.open} hint={station.state.line} typing={typing} />
        </div>
      )}
      <ReceivingFooter station={station} typing={typing} onToggleTyping={toggle} />
    </aside>
  );
};
