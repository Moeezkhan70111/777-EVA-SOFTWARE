import React from "react";
import type { AppRoute } from "../app/routes";
import { SearchableCombobox } from "../components/shared/SearchableCombobox";
import { PartyTypeBadge } from "../features/parties/PartyTypeBadge";
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
import { useReceivingStation } from "../features/store/stations/useReceivingStation";

// Raw Material Input — receiving a supplier's delivery into the store, full-screen.
//
// The same station as Store Move In and Move Out: same chrome, same scan panel, same
// session card, same recent table (features/scanStation). What it does is the receiving station
// (useReceivingStation), the same one the Store page's Scan in rail draws: receiving is a
// supplier-at-a-time job, so the session is opened against a party and every packet is checked
// against it.
//
// A carton and a raw material packet never share a scanner: this screen turns a carton
// away, and the carton screens turn a packet away with a pointer here.

const RECENT_LIMIT = 12;

interface RawMaterialInputPageProps {
  /** Session token; the main process authorises every receipt call with it. */
  token: string;
  username?: string;
  /** Returns to where the operator came from. Hidden when not provided. */
  onBack?: () => void;
  onNavigate?: (route: AppRoute) => void;
  /**
   * Shown as the right half of the Move In desk, beside the new-material form or the label
   * generator. Same station and the same session — only the layout stacks to fit the pane.
   */
  embedded?: boolean;
}

export const RawMaterialInputPage: React.FC<RawMaterialInputPageProps> = ({ token, username, onBack, onNavigate, embedded = false }) => {
  const station = useReceivingStation({ token, username, active: true });
  const scannerConnected = useScannerConnected();
  const { session, summary, open, busy, scanBox } = station;
  // On the desk there is no room for empty cards: the session tally and the recent list
  // appear once there is a session to show. The full-screen station keeps its fixed layout.
  const showSessionDetails = !embedded || session !== null;

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

      {/* Embedded on the Store In page the pane above already says what this is, so the
          station drops its own title rather than saying it twice. */}
      <StationToolbar
        eyebrow={embedded ? undefined : "Store Station · Raw Material"}
        title={embedded ? undefined : "Raw Material Input"}
        onBack={onBack}
        scannerPill={scannerConnected ? { text: "Scanner ready", color: "#16a34a" } : { text: "Keyboard input", color: "#94a3b8" }}
      >
        {open ? (
          <>
            {/* The party this session receives from, and what it is. */}
            <PartyTypeBadge partyType={station.sessionSupplier?.partyType} />
            <button type="button" className="ssn-btn" onClick={() => void station.endSession()} disabled={busy}>
              End session
            </button>
            <button type="button" className="ssn-btn" onClick={station.print} disabled={!summary}>
              Print receipt
            </button>
          </>
        ) : (
          <>
            <div className="ssn-supplier-pick">
              <SearchableCombobox
                value={station.partyId}
                options={station.supplierOptions}
                onChange={station.setPartyId}
                placeholder={station.supplierOptions.length === 0 ? "No suppliers yet" : "Choose supplier…"}
              />
            </div>
            <PartyTypeBadge partyType={station.suppliers.find((party) => party.id === station.partyId)?.partyType} />
            <button type="button" className="ssn-btn" onClick={() => void station.startSession()} disabled={busy || !station.partyId}>
              <PlusIcon />
              Start session
            </button>
            {summary && summary.totalPackets > 0 ? (
              <button type="button" className="ssn-btn ssn-btn--ghost" onClick={station.print}>
                Print last receipt
              </button>
            ) : null}
          </>
        )}
        {onNavigate ? (
          <button
            type="button"
            className="ssn-btn ssn-btn--ghost"
            onClick={() => onNavigate("raw-material")}
            title="Set what one packet of each material holds"
          >
            Raw Material
          </button>
        ) : null}
      </StationToolbar>

      <div className="ssn-workspace">
        {station.loadError ? (
          <StationBlocked title="Raw Material Input is not available" message={station.loadError} onRetry={() => void station.reload()} />
        ) : (
          <>
            <ScanPanel
              feedback={station.panelFeedback}
              inputRef={scanBox.inputRef}
              inputVal={scanBox.inputVal}
              onInputChange={scanBox.setInputVal}
              onKeyDown={scanBox.onKeyDown}
              onFocusScanner={scanBox.focusScanner}
              disabled={!open}
              disabledHint={station.state.line}
            />
            {showSessionDetails && (
              <aside className="ssn-side">
                <SessionCard
                  code={session?.code ?? null}
                  meta={
                    session
                      ? `${session.partyName} · started ${formatDateTime(session.startedAt)}${session.startedBy ? ` · ${session.startedBy}` : ""}`
                      : "No session open. Choose a supplier above."
                  }
                  tallies={(summary?.byMaterial ?? []).map((row) => ({
                    key: row.itemDisplayName,
                    label: row.itemDisplayName,
                    count: row.packets,
                    countLabel: `${row.packets} · ${row.quantity} ${row.unitCode}`,
                  }))}
                  total={summary?.totalPackets ?? 0}
                  totalNoun="packets"
                  groupNoun="Materials"
                  subhead="By material"
                  emptyLabel="Nothing received yet."
                />
                {/* On the desk the scan panel and the recent list already show the last packet. */}
                {embedded ? null : <LastScanCard title="Last received" row={station.rows[0] ?? null} />}
              </aside>
            )}
          </>
        )}
      </div>

      {!station.loadError && showSessionDetails && (
        <RecentScansCard
          title="Recently received"
          note={`Last ${RECENT_LIMIT} in this session`}
          emptyLabel="No packets received in this session yet."
          rows={station.rows}
        />
      )}
    </div>
  );
};
