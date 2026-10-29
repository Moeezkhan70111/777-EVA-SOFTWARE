import React, { useState } from "react";
import { copy } from "../../../config/copy";
import { SearchableCombobox } from "../../../components/shared/SearchableCombobox";
import { StateView } from "../../../components/shared/StateView";
import { quantityTotalLine } from "../../rawMaterial/storeVoucher";
import { BeforeThat, CountRow, beforeThat } from "../stations/ScanCount";
import { ScanZone } from "../stations/ScanZone";
import type { IssuingStation } from "../stations/useIssuingStation";
import { BatchFooter, EndStep, RailScanInput, WhoStrip } from "./RailParts";

// THE ISSUING RAIL (0.3.9):
//
//   GOING TO the locked party, and its type
//   the scanner's box, always visible, holding the focus
//   the scan — waiting asks "Who is this material for?" with the picker (type against each) and
//     Start scanning
//   the count, one row · BEFORE THAT
//   the batch's number · End batch — or, waiting, LAST BATCH with Reprint

const StartIssuing: React.FC<{ station: IssuingStation }> = ({ station }) => (
  <div className="sz-start">
    {station.partiesError ? (
      <StateView kind="error" compact message={station.partiesError} onRetry={() => void station.reloadParties()} />
    ) : (
      <SearchableCombobox
        dropdown
        value={station.partyId}
        options={station.partyOptions}
        placeholder={station.partyOptions.length === 0 ? copy.moveOut.noScanParties : copy.moveOut.chooseScanParty}
        emptyLabel={copy.moveOut.noScanPartyMatch}
        ariaLabel={copy.moveOut.scanPartyStep}
        onChange={station.choosePartyId}
      />
    )}
    <button type="button" className="btn btn-primary sz-start-btn" onClick={() => void station.startSession()} disabled={!station.partyId}>
      {copy.storeStation.startScanning}
    </button>
  </div>
);

/** Waiting: the last batch this computer closed, to reprint its slip. */
const LastBatchFooter: React.FC<{ station: IssuingStation }> = ({ station }) => (
  <footer className="sp-foot" aria-label={copy.storeStation.lastBatch}>
    <span className="sp-marker">{copy.storeScan.lastBatch}</span>
    {station.lastSession ? (
      <>
        <span className="sp-foot-line">
          {station.lastSession.session.code} · {station.lastSession.partyName ?? copy.storePage.issuedToday.noParty} ·{" "}
          {copy.storeStation.packets(station.lastSession.packets)}
        </span>
        <button type="button" className="btn btn-secondary" onClick={() => void station.reprintLast()}>
          {copy.storeStation.reprintSlip}
        </button>
      </>
    ) : (
      <span className="sp-foot-line">{copy.storeStation.noLastBatch}</span>
    )}
  </footer>
);

const IssuingFooter: React.FC<{ station: IssuingStation; quantity: string }> = ({ station, quantity }) => {
  const [ending, setEnding] = useState(false);
  const { session, summary } = station;
  if (!session || !station.locked) return <LastBatchFooter station={station} />;
  if (!ending) return <BatchFooter code={session.code} onEnd={() => setEnding(true)} />;
  return (
    <EndStep
      code={session.code}
      packets={copy.storeStation.packets(summary?.totalPackets ?? 0)}
      quantity={quantity}
      canPrint={Boolean(summary && summary.totalPackets > 0)}
      onPrint={station.print}
      onEnd={() => void station.endSession().then(() => setEnding(false))}
      onKeep={() => {
        setEnding(false);
        setTimeout(station.scanBox.focusScanner, 0);
      }}
    />
  );
};

export const ScanOutRail: React.FC<{ station: IssuingStation; hidden: boolean }> = ({ station, hidden }) => {
  const who = station.lockedParty ?? station.chosenParty;
  const { summary } = station;
  const quantity = summary && summary.byMaterial.length > 0 ? quantityTotalLine(summary.byMaterial) : "—";
  return (
    <aside className="sp-rail" aria-label={copy.storePage.scanOut} hidden={hidden}>
      <WhoStrip mode="out" label={copy.storeScan.goingTo} name={who?.partyName ?? null} partyType={who?.partyType} />
      <RailScanInput scanBox={station.scanBox} canScan={station.locked} notReady={copy.storeScan.issuingNotReady} />
      <div className="sp-rail-scan">
        {station.sessionError ? (
          <StateView kind="error" compact message={station.sessionError} onRetry={() => void station.reloadSession()} />
        ) : (
          <>
            <ScanZone mode="out" outcome={station.outcome} state={station.state} doneWord={copy.storeScan.issued} notDoneWord={copy.storeScan.notIssued}>
              {station.locked ? null : <StartIssuing station={station} />}
            </ScanZone>
            {station.locked ? (
              <>
                <CountRow count={summary?.totalPackets ?? 0} quantity={quantity} unchanged={station.outcome.kind === "refused"} />
                <BeforeThat rows={beforeThat(station.rows, station.outcome)} />
              </>
            ) : null}
          </>
        )}
      </div>
      <IssuingFooter station={station} quantity={quantity} />
    </aside>
  );
};
