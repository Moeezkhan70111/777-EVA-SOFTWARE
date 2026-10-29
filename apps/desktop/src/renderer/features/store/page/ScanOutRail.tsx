import React from "react";
import { copy } from "../../../config/copy";
import { SearchableCombobox } from "../../../components/shared/SearchableCombobox";
import { StateView } from "../../../components/shared/StateView";
import { PartyTypeBadge } from "../../parties/PartyTypeBadge";
import { LastScanCard } from "../../scanStation/scanStation";
import { LockedParty } from "../stations/LockedParty";
import type { IssuingStation } from "../stations/useIssuingStation";
import { RailScanBlock } from "./RailScanBlock";
import { RailSessionCard } from "./RailSessionCard";

// SCAN OUT — the Issuing mode's rail:
//
//   Scan out                     (orange)
//   Not scanning yet / Ready / Scanning, and the scanner's box
//   who it is going to (type shown against each), Start issuing, the last session · Reprint slip
//   — once a session starts: the locked party, its badge and the session card (0.3.8), the last
//     scan, End session · Print slip

const PartyPick: React.FC<{ station: IssuingStation }> = ({ station }) => (
  <>
    <section className="sp-rail-section">
      {station.partiesError ? (
        <StateView kind="error" compact message={station.partiesError} onRetry={() => void station.reloadParties()} />
      ) : (
        <>
          <SearchableCombobox
            dropdown
            value={station.partyId}
            options={station.partyOptions}
            placeholder={station.partyOptions.length === 0 ? copy.moveOut.noScanParties : copy.moveOut.chooseScanParty}
            emptyLabel={copy.moveOut.noScanPartyMatch}
            ariaLabel={copy.moveOut.scanPartyStep}
            onChange={station.choosePartyId}
          />
          <PartyTypeBadge partyType={station.chosenParty?.partyType} />
        </>
      )}
      <div className="sp-rail-actions">
        <button type="button" className="btn btn-primary" onClick={() => void station.startSession()} disabled={!station.partyId}>
          {copy.storeStation.startIssuing}
        </button>
      </div>
    </section>
    <section className="sp-rail-section" aria-label={copy.storeStation.lastSession}>
      <span className="section-label">{copy.storeStation.lastSession}</span>
      {station.lastSession ? (
        <div className="sp-last-session">
          <span>
            <strong>{station.lastSession.session.code}</strong> · {station.lastSession.partyName ?? copy.storePage.issuedToday.noParty} ·{" "}
            {copy.storeStation.packets(station.lastSession.packets)}
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void station.reprintLast()}>
            {copy.storeStation.reprintSlip}
          </button>
        </div>
      ) : (
        <p className="field-help">{copy.storeStation.noLastSession}</p>
      )}
    </section>
  </>
);

const LockedSession: React.FC<{ station: IssuingStation }> = ({ station }) => {
  const { session, summary } = station;
  if (!session) return null;
  return (
    <>
      <section className="sp-rail-section">
        <LockedParty party={station.lockedParty} />
        <RailSessionCard
          code={session.code}
          packets={summary?.totalPackets ?? 0}
          byMaterial={summary?.byMaterial ?? []}
          countLabel={copy.storePage.issued}
        />
      </section>
      <section className="sp-rail-section">
        <LastScanCard title={copy.storeStation.lastScan} row={station.rows[0] ?? null} />
      </section>
      <section className="sp-rail-section">
        <div className="sp-rail-actions">
          <button type="button" className="btn btn-secondary" onClick={() => void station.endSession()}>
            {copy.storeStation.endSession}
          </button>
          <button type="button" className="btn btn-secondary" onClick={station.print} disabled={!summary || summary.totalPackets === 0}>
            {copy.storeStation.printSlip}
          </button>
        </div>
      </section>
    </>
  );
};

export const ScanOutRail: React.FC<{ station: IssuingStation; hidden: boolean }> = ({ station, hidden }) => (
  <aside className="sp-rail" aria-label={copy.storePage.scanOut} hidden={hidden}>
    <header className="sp-rail-head sp-rail-head--out">
      <h2 className="sp-rail-title">{copy.storePage.scanOut}</h2>
      <p className="sp-rail-line">{copy.storePage.scanOutLine}</p>
    </header>
    {station.sessionError ? (
      <section className="sp-rail-section">
        <StateView kind="error" compact message={station.sessionError} onRetry={() => void station.reloadSession()} />
      </section>
    ) : (
      <>
        <RailScanBlock state={station.state} feedback={station.feedback} scanBox={station.scanBox} />
        {station.locked ? <LockedSession station={station} /> : <PartyPick station={station} />}
      </>
    )}
  </aside>
);
