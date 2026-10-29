import React, { useState } from "react";
import { copy } from "../../../config/copy";
import { SearchableCombobox } from "../../../components/shared/SearchableCombobox";
import { StateView } from "../../../components/shared/StateView";
import { quantityTotalLine } from "../../rawMaterial/storeVoucher";
import { LastScans, ScanCount } from "../stations/ScanCount";
import { ScanZone } from "../stations/ScanZone";
import type { IssuingStation } from "../stations/useIssuingStation";
import { EndStep, ScanCapture, SessionFooter, WhoStrip, useTyping } from "./RailParts";

// SCAN OUT — the Issuing rail, in three zones (0.3.9):
//
//   1  WHO      GOING TO the locked party, and its type                  (orange strip)
//   2  THE SCAN accepted / refused / waiting — waiting asks "Who is this material for?" with the
//               party picker (type shown against each) and Start issuing; the count; the last three
//   3  FOOTER   the session's number and total, Type a code, End session — or, waiting, the last
//               session closed here with Reprint

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

/** Waiting: the last session this computer closed, to reprint its slip. */
const LastSessionFooter: React.FC<{ station: IssuingStation }> = ({ station }) => (
  <footer className="sp-foot" aria-label={copy.storeStation.lastBatch}>
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

const IssuingFooter: React.FC<{ station: IssuingStation; typing: boolean; onToggleTyping: () => void }> = ({ station, typing, onToggleTyping }) => {
  const [ending, setEnding] = useState(false);
  const { session, summary } = station;
  if (!session || !station.locked) return <LastSessionFooter station={station} />;
  const quantity = summary && summary.byMaterial.length > 0 ? quantityTotalLine(summary.byMaterial) : "—";
  if (ending) {
    return (
      <EndStep
        code={session.code}
        packets={copy.storeStation.packets(summary?.totalPackets ?? 0)}
        quantity={quantity}
        canPrint={Boolean(summary && summary.totalPackets > 0)}
        onPrint={station.print}
        onEnd={() => void station.endSession().then(() => setEnding(false))}
        onKeep={() => setEnding(false)}
      />
    );
  }
  return <SessionFooter line={copy.storeScan.sessionLine(session.code, quantity)} typing={typing} onToggleTyping={onToggleTyping} onEnd={() => setEnding(true)} />;
};

export const ScanOutRail: React.FC<{ station: IssuingStation; hidden: boolean }> = ({ station, hidden }) => {
  const { typing, toggle } = useTyping(station.scanBox);
  const who = station.lockedParty ?? station.chosenParty;
  return (
    <aside className="sp-rail" aria-label={copy.storePage.scanOut} hidden={hidden}>
      <WhoStrip mode="out" label={copy.storeScan.goingTo} name={who?.partyName ?? null} partyType={who?.partyType} />
      {station.sessionError ? (
        <div className="sp-rail-scan">
          <StateView kind="error" compact message={station.sessionError} onRetry={() => void station.reloadSession()} />
        </div>
      ) : (
        <div className="sp-rail-scan">
          <ScanZone mode="out" outcome={station.outcome} state={station.state} doneWord={copy.storeScan.issued} notDoneWord={copy.storeScan.notIssued}>
            {station.locked ? null : <StartIssuing station={station} />}
          </ScanZone>
          {station.locked ? (
            <>
              <ScanCount count={station.summary?.totalPackets ?? 0} label={copy.storeScan.packetsIssued} unchanged={station.outcome.kind === "refused"} />
              <LastScans rows={station.rows} />
            </>
          ) : null}
          <ScanCapture scanBox={station.scanBox} canScan={station.locked} hint={station.state.line} typing={typing} />
        </div>
      )}
      <IssuingFooter station={station} typing={typing} onToggleTyping={toggle} />
    </aside>
  );
};
