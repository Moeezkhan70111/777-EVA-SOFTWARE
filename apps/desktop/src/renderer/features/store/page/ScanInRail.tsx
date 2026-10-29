import React, { useState } from "react";
import { copy } from "../../../config/copy";
import { SearchableCombobox } from "../../../components/shared/SearchableCombobox";
import { StateView } from "../../../components/shared/StateView";
import { quantityTotalLine } from "../../rawMaterial/storeVoucher";
import { BeforeThat, CountRow, beforeThat } from "../stations/ScanCount";
import { ScanZone } from "../stations/ScanZone";
import type { ReceivingStation } from "../stations/useReceivingStation";
import { BatchFooter, EndStep, RailScanInput, WhoStrip } from "./RailParts";

// THE RECEIVING RAIL (0.3.9). An operator scans, hears the beep, glances up for half a second, and
// needs one answer: did it take, and was it the right packet.
//
//   FROM the supplier, and its type
//   the scanner's box, always visible, holding the focus
//   the scan: accepted / refused / waiting
//   the count, one row · BEFORE THAT, the three packets before
//   the batch's number · End batch

const StartReceiving: React.FC<{ station: ReceivingStation }> = ({ station }) => (
  <div className="sz-start">
    <SearchableCombobox
      dropdown
      value={station.partyId}
      options={station.supplierOptions}
      onChange={(next) => {
        station.setPartyId(next);
        station.scanBox.focusScanner();
      }}
      ariaLabel={copy.storePage.supplier}
      placeholder={station.supplierOptions.length === 0 ? copy.storePage.noSuppliers : copy.storePage.chooseSupplier}
    />
    <button type="button" className="btn btn-primary sz-start-btn" onClick={() => void station.startSession()} disabled={station.busy || !station.partyId}>
      {copy.storeStation.startScanning}
    </button>
  </div>
);

const ReceivingFooter: React.FC<{ station: ReceivingStation; quantity: string }> = ({ station, quantity }) => {
  const [ending, setEnding] = useState(false);
  const { session, summary } = station;
  if (!session || !station.open) return null;
  if (!ending) return <BatchFooter code={session.code} onEnd={() => setEnding(true)} />;
  return (
    <EndStep
      code={session.code}
      packets={copy.storeStation.packets(summary?.totalPackets ?? 0)}
      quantity={quantity}
      canPrint={Boolean(summary)}
      onPrint={station.print}
      onEnd={() => void station.endSession().then(() => setEnding(false))}
      onKeep={() => {
        setEnding(false);
        setTimeout(station.scanBox.focusScanner, 0);
      }}
    />
  );
};

export const ScanInRail: React.FC<{ station: ReceivingStation; hidden: boolean }> = ({ station, hidden }) => {
  const supplier = station.suppliers.find((party) => party.id === (station.session?.partyId ?? station.partyId));
  const { summary } = station;
  const quantity = summary && summary.byMaterial.length > 0 ? quantityTotalLine(summary.byMaterial) : "—";
  return (
    <aside className="sp-rail" aria-label={copy.storePage.scanIn} hidden={hidden}>
      <WhoStrip mode="in" label={copy.storeScan.from} name={station.session?.partyName ?? supplier?.partyName ?? null} partyType={supplier?.partyType} />
      <RailScanInput scanBox={station.scanBox} canScan={station.open} notReady={copy.storeScan.receivingNotReady} />
      <div className="sp-rail-scan">
        {station.loadError ? (
          <StateView kind="error" compact message={station.loadError} onRetry={() => void station.reload()} />
        ) : (
          <>
            <ScanZone mode="in" outcome={station.outcome} state={station.state} doneWord={copy.storeScan.received} notDoneWord={copy.storeScan.notReceived}>
              {station.open ? null : <StartReceiving station={station} />}
            </ScanZone>
            {station.open ? (
              <>
                <CountRow count={summary?.totalPackets ?? 0} quantity={quantity} unchanged={station.outcome.kind === "refused"} />
                <BeforeThat rows={beforeThat(station.rows, station.outcome)} />
              </>
            ) : null}
          </>
        )}
      </div>
      <ReceivingFooter station={station} quantity={quantity} />
    </aside>
  );
};
