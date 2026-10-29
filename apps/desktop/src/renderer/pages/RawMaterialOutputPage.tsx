import React from "react";
import { PartyTypeBadge } from "../features/parties/PartyTypeBadge";
import { SearchableCombobox } from "../components/shared/SearchableCombobox";
import { StateView } from "../components/shared/StateView";
import { StepHeading } from "../components/shared/StepHeading";
import type { AppRoute } from "../app/routes";
import { copy } from "../config/copy";
import { formatDateTime } from "../utils/dates";
import {
  LastScanCard,
  PlusIcon,
  RecentScansCard,
  SCAN_STATION_CSS,
  ScanPanel,
  SessionCard,
  StationBlocked,
  StationToolbar,
} from "../features/scanStation/scanStation";
import { useScannerConnected } from "../features/scanStation/useScannerConnected";
import { LockedParty } from "../features/store/stations/LockedParty";
import { useIssuingStation, type IssuingStation } from "../features/store/stations/useIssuingStation";

// Raw Material Output — issuing packets out of the store, full-screen.
//
// The mirror of Raw Material Input, on the same station (features/scanStation). What it does is the
// issuing station (useIssuingStation), the same one the Store page's Scan out rail draws: choose who
// the packets are going to — a supplier or a contractor — press Start issuing, and the session is
// locked to that party until it is ended (0.3.8).
//
// Finished cartons leave the store on Store Move Out; a carton scanned here is turned away.

const RECENT_LIMIT = 12;

interface RawMaterialOutputPageProps {
  /** Session token; the main process authorises every issue call with it. */
  token: string;
  username?: string;
  onBack?: () => void;
  /** Offers the Raw Material workspace from the toolbar. */
  onNavigate?: (route: AppRoute) => void;
  /** Set when the station is a pane of the Store Out page rather than the whole screen. */
  embedded?: boolean;
  /**
   * Reports this terminal's open issue session as it opens or closes, so Store Out can put a
   * Machine Program batch on the same session — and therefore the same printed issue slip — as
   * everything else that left the store here.
   */
  onSessionChange?: (sessionId: string | null) => void;
  /**
   * Handed a MACHINE PROGRAM code scanned into this station's box — MP-000012.
   *
   * This station keeps the keyboard focus whenever its session is open, so the program sheet's
   * QR lands here however carefully the page above arms its own lookup. Rather than refusing it
   * as "not a raw material QR", the station passes it up to whoever owns the program lookup.
   * Only the unmistakable MP form is passed on; a bare number is a mis-scan, not a program.
   */
  onMachineProgramScan?: (code: string) => void;
}

/** Step 1: who the packets go to — the picker, or the party the running session is locked to. */
const PartyStep: React.FC<{ station: IssuingStation }> = ({ station }) => (
  <section className="qr-step">
    <StepHeading index={1} done={Boolean(station.partyId)} title={copy.moveOut.scanPartyStep} />
    <div className="qr-step-body">
      {station.partiesError ? (
        <StateView kind="error" compact message={station.partiesError} onRetry={() => void station.reloadParties()} />
      ) : station.locked ? (
        <LockedParty party={station.lockedParty} />
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
          <p className="field-help">{copy.moveOut.scanPartyHelp}</p>
        </>
      )}
    </div>
  </section>
);

export const RawMaterialOutputPage: React.FC<RawMaterialOutputPageProps> = ({
  token,
  username,
  onBack,
  onNavigate,
  embedded = false,
  onSessionChange,
  onMachineProgramScan,
}) => {
  const station = useIssuingStation({ token, username, active: true, onSessionChange, onMachineProgramScan });
  const scannerConnected = useScannerConnected();
  const { session, summary, locked, scanBox } = station;
  const blocked = Boolean(station.sessionError);

  return (
    <div
      className={`ssn${embedded ? " ssn--embedded" : ""}`}
      onClick={(e) => {
        // Clicking empty space is never an action; it just hands focus back to the scanner.
        const target = e.target as HTMLElement | null;
        if (target && !target.closest("button, a, input, select, textarea, [role='dialog'], tr.ssn-recent-row")) {
          scanBox.focusScanner();
        }
      }}
    >
      <style>{SCAN_STATION_CSS}</style>

      {/* Embedded on the Store Out page the pane above already names the station. */}
      <StationToolbar
        eyebrow={embedded ? undefined : "Store Station · Raw Material"}
        title={embedded ? undefined : "Raw Material Output"}
        onBack={onBack}
        scannerPill={scannerConnected ? { text: "Scanner ready", color: "#16a34a" } : { text: "Keyboard input", color: "#94a3b8" }}
      >
        <button type="button" className="ssn-btn" onClick={() => void station.startSession()} disabled={locked || !station.partyId}>
          <PlusIcon />
          {copy.storeStation.startIssuing}
        </button>
        <button type="button" className="ssn-btn" onClick={() => void station.endSession()} disabled={!locked}>
          {copy.storeStation.endSession}
        </button>
        <button type="button" className="ssn-btn" onClick={station.print} disabled={!summary || summary.totalPackets === 0}>
          {copy.storeStation.printSlip}
        </button>
        {onNavigate ? (
          <button
            type="button"
            className="ssn-btn ssn-btn--ghost"
            onClick={() => onNavigate("raw-material")}
            title="Set where each material goes when it leaves the store"
          >
            Raw Material
          </button>
        ) : null}
      </StationToolbar>

      {!blocked && <PartyStep station={station} />}

      <div className="ssn-workspace">
        {blocked ? (
          <StationBlocked title="Raw Material Output is not available" message={station.sessionError ?? ""} onRetry={() => void station.reloadSession()} />
        ) : (
          <>
            <ScanPanel
              feedback={station.panelFeedback}
              inputRef={scanBox.inputRef}
              inputVal={scanBox.inputVal}
              onInputChange={scanBox.setInputVal}
              onKeyDown={scanBox.onKeyDown}
              onFocusScanner={scanBox.focusScanner}
              disabled={!locked}
              disabledHint={station.state.line}
            />
            <aside className="ssn-side">
              <SessionCard
                code={session?.code ?? null}
                meta={
                  session
                    ? `Started ${formatDateTime(session.startedAt)}${session.startedBy ? ` · ${session.startedBy}` : ""}`
                    : copy.moveOut.scanStartHint
                }
                tallies={(summary?.bySection ?? []).map((section) => ({
                  key: section.sectionName,
                  label: section.sectionName,
                  count: section.packets,
                }))}
                total={summary?.totalPackets ?? 0}
                totalNoun="packets"
                totalLabel="Issued"
                groupNoun="Destinations"
                subhead="By destination"
                emptyLabel="Nothing issued yet."
              />
              <LastScanCard title="Last issued" row={station.rows[0] ?? null} />
            </aside>
          </>
        )}
      </div>

      {!blocked && (
        <RecentScansCard
          title="Recently issued"
          note={`Last ${RECENT_LIMIT} in this session`}
          emptyLabel="No packets issued in this session yet."
          rows={station.rows}
        />
      )}
    </div>
  );
};
