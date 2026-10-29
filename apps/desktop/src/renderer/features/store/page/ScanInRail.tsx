import React from "react";
import { copy } from "../../../config/copy";
import { SearchableCombobox } from "../../../components/shared/SearchableCombobox";
import { StateView } from "../../../components/shared/StateView";
import { PartyTypeBadge } from "../../parties/PartyTypeBadge";
import { LastScanCard } from "../../scanStation/scanStation";
import type { ReceivingStation } from "../stations/useReceivingStation";
import { RailScanBlock } from "./RailScanBlock";
import { RailSessionCard } from "./RailSessionCard";

// SCAN IN — the Receiving mode's rail, always on screen beside its work area:
//
//   Scan in                      (teal)
//   Not scanning yet / Ready / Scanning, and the scanner's box
//   the session: supplier + type, RMI number, packets and quantity   — or the supplier to start one
//   the last scan
//   End session · Print slip

const SupplierPick: React.FC<{ station: ReceivingStation }> = ({ station }) => (
  <section className="sp-rail-section">
    <SearchableCombobox
      dropdown
      value={station.partyId}
      options={station.supplierOptions}
      onChange={station.setPartyId}
      ariaLabel={copy.storePage.supplier}
      placeholder={station.supplierOptions.length === 0 ? copy.storePage.noSuppliers : copy.storePage.chooseSupplier}
    />
    <PartyTypeBadge partyType={station.suppliers.find((party) => party.id === station.partyId)?.partyType} />
    <div className="sp-rail-actions">
      <button type="button" className="btn btn-primary" onClick={() => void station.startSession()} disabled={station.busy || !station.partyId}>
        {copy.storeStation.startSession}
      </button>
    </div>
  </section>
);

const OpenSession: React.FC<{ station: ReceivingStation }> = ({ station }) => {
  const { session, summary } = station;
  if (!session) return null;
  return (
    <>
      <section className="sp-rail-section">
        <RailSessionCard
          party={{ name: session.partyName, type: station.sessionSupplier?.partyType }}
          code={session.code}
          packets={summary?.totalPackets ?? 0}
          byMaterial={summary?.byMaterial ?? []}
          countLabel={copy.storePage.received}
        />
      </section>
      <section className="sp-rail-section">
        <LastScanCard title={copy.storeStation.lastScan} row={station.rows[0] ?? null} />
      </section>
      <section className="sp-rail-section">
        <div className="sp-rail-actions">
          <button type="button" className="btn btn-secondary" onClick={() => void station.endSession()} disabled={station.busy}>
            {copy.storeStation.endSession}
          </button>
          <button type="button" className="btn btn-secondary" onClick={station.print} disabled={!summary}>
            {copy.storeStation.printSlip}
          </button>
        </div>
      </section>
    </>
  );
};

export const ScanInRail: React.FC<{ station: ReceivingStation; hidden: boolean }> = ({ station, hidden }) => (
  <aside className="sp-rail" aria-label={copy.storePage.scanIn} hidden={hidden}>
    <header className="sp-rail-head sp-rail-head--in">
      <h2 className="sp-rail-title">{copy.storePage.scanIn}</h2>
      <p className="sp-rail-line">{copy.storePage.scanInLine}</p>
    </header>
    {station.loadError ? (
      <section className="sp-rail-section">
        <StateView kind="error" compact message={station.loadError} onRetry={() => void station.reload()} />
      </section>
    ) : (
      <>
        <RailScanBlock state={station.state} feedback={station.feedback} scanBox={station.scanBox} />
        {station.open ? <OpenSession station={station} /> : <SupplierPick station={station} />}
      </>
    )}
  </aside>
);
