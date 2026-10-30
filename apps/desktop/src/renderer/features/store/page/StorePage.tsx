import React, { useCallback, useState } from "react";
import type { AppRoute } from "../../../app/routes";
import { copy } from "../../../config/copy";
import { useRawMaterialLookups } from "../../rawMaterial/useRawMaterialLookups";
import { SCAN_STATION_CSS } from "../../scanStation/scanStation";
import { IssuingWorkArea } from "./IssuingWorkArea";
import { MachineProgramsDialog } from "./MachineProgramsDialog";
import { ModeSwitch } from "./ModeSwitch";
import { ProgramRail, ProgramWork } from "./ProgramSlot";
import { ReceivingWorkArea } from "./ReceivingWorkArea";
import { ScanInRail } from "./ScanInRail";
import { ScanOutRail } from "./ScanOutRail";
import type { StoreAccess, StoreMode } from "./storeTabs";
import { useModeKeys } from "./useModeKeys";
import { useStoreProgram } from "./useStoreProgram";
import { NO_SESSION, type StationStatus } from "./stationStatus";

// THE STORE PAGE (0.3.9) — Receiving and Issuing on one page, in place of Store Station, Store In
// and Store Out.
//
//   Store
//   Raw material in and out
//   [ Receiving · Session open · 12 packets ][ Issuing · Nothing started ]     (keys 1 and 2)
//   ┌ the active mode's work area ─────────────────┬ its scan rail, ~380px ┐
//
// 0.4.1: the Daily report is each mode's last tab, and the Machine programs button is hidden. Its
// dialog stays: showMachinePrograms puts the button back. A program still opens from a scanned
// program sheet on Scan Out, and from a notification.
//
// BOTH STATIONS LIVE HERE, for as long as the page does: each keeps its session whichever mode is on
// screen, and the switch shows both. Both rails stay mounted; the inactive one is hidden and its scan
// box disarmed (the stations' `active`), so a scan can only land in the mode being looked at.
//
// AN OPEN MACHINE PROGRAM takes the work area and the rail (ProgramSlot). Both stations stay mounted
// and disarmed meanwhile: the program's own scanner is the one box listening.

interface StorePageProps {
  mode: StoreMode;
  token: string;
  username?: string;
  isAdmin: boolean;
  access: StoreAccess;
  onModeChange: (mode: StoreMode) => void;
  onNavigate: (route: AppRoute) => void;
  /** Absent when this account may not open the Carton QR Generator. */
  onOpenCartonQr?: () => void;
  /** Shows the Machine programs button (hidden since 0.4.1). */
  showMachinePrograms?: boolean;
  /** A machine program to open on arrival, from a notification or the Machine Program page. */
  initialProgramId?: string;
  onInitialProgramConsumed?: () => void;
}

export const StorePage: React.FC<StorePageProps> = (props) => {
  const { mode, token, username, isAdmin, access, onModeChange, onNavigate } = props;
  // Each panel reports where its session stands; the switch shows both, and program batches ride
  // Issuing's open session onto its slip.
  const [receivingStatus, setReceivingStatus] = useState<StationStatus>(NO_SESSION);
  const [issuingStatus, setIssuingStatus] = useState<StationStatus>(NO_SESSION);
  const programs = useStoreProgram({ token, issueSessionId: issuingStatus.sessionId, initialProgramId: props.initialProgramId, onInitialProgramConsumed: props.onInitialProgramConsumed });
  // A panel may take the scanner's focus only while its mode is on screen and nothing else has the
  // page — a machine program, or the pick-list. When that ends, it takes the focus back by itself.
  const free = !programs.isOpen && !programs.dialogOpen;
  const lookups = useRawMaterialLookups();
  useModeKeys(onModeChange);

  // Receipts → Continue opened the full-screen station; here the open session is already on the rail.
  const navigate = useCallback((route: AppRoute) => (route === "raw-material-input" ? onModeChange("receiving") : onNavigate(route)), [onModeChange, onNavigate]);
  const shared = { token, username, isAdmin, access, lookups, onNavigate: navigate };
  const issuingKey = `${issuingStatus.sessionId ?? ""}|${issuingStatus.open}|${issuingStatus.packets}`;
  const showing = (which: StoreMode) => mode === which && !programs.isOpen;

  return (
    <div className="sp-page">
      <style>{SCAN_STATION_CSS}</style>
      <header className="sp-head">
        <div className="sp-head-text">
          <h1 className="sp-title">{copy.storePage.title}</h1>
          <p className="sp-sub">{copy.storePage.subtitle}</p>
        </div>
        {props.showMachinePrograms ? (
          <div className="sp-head-actions">
            <button type="button" className="btn btn-secondary" aria-haspopup="dialog" onClick={programs.openDialog}>
              {copy.storePage.machinePrograms}
            </button>
          </div>
        ) : null}
      </header>

      <ModeSwitch
        mode={mode}
        receiving={receivingStatus}
        issuing={issuingStatus}
        onSelect={onModeChange}
      />

      <div className="sp-body">
        <div hidden={!showing("receiving")} className="sp-work-slot">
          <ReceivingWorkArea {...shared} />
        </div>
        <div hidden={!showing("issuing")} className="sp-work-slot">
          <IssuingWorkArea {...shared} sessionKey={issuingKey} />
        </div>
        {programs.isOpen ? <ProgramWork store={programs} mode={mode} /> : null}
        <ScanInRail token={token} username={username} hidden={!showing("receiving")} active={mode === "receiving" && free} onStatus={setReceivingStatus} />
        <ScanOutRail
          token={token}
          username={username}
          hidden={!showing("issuing")}
          active={mode === "issuing" && free}
          onStatus={setIssuingStatus}
          onMachineProgramScan={programs.openProgram}
        />
        {programs.isOpen ? <ProgramRail store={programs} mode={mode} token={token} /> : null}
      </div>

      {programs.dialogOpen ? (
        <MachineProgramsDialog
          onOpen={programs.openProgram}
          busy={programs.program.loading}
          error={programs.program.error}
          onClose={programs.closeDialog}
          onOpenCartonQr={props.onOpenCartonQr}
        />
      ) : null}
    </div>
  );
};
