import React, { useCallback, useState } from "react";
import type { AppRoute } from "../../../app/routes";
import { copy } from "../../../config/copy";
import { useRawMaterialLookups } from "../../rawMaterial/useRawMaterialLookups";
import { SCAN_STATION_CSS } from "../../scanStation/scanStation";
import { useIssuingStation } from "../stations/useIssuingStation";
import { useReceivingStation } from "../stations/useReceivingStation";
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

// THE STORE PAGE (0.3.9) — Receiving and Issuing on one page, in place of Store Station, Store In
// and Store Out.
//
//   Store                                        [Machine programs] [Daily report]
//   Raw material in and out
//   [ Receiving · Session open · 12 packets ][ Issuing · Nothing started ]     (keys 1 and 2)
//   ┌ the active mode's work area ─────────────────┬ its scan rail, ~380px ┐
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
  /** A machine program to open on arrival, from a notification or the Machine Program page. */
  initialProgramId?: string;
  onInitialProgramConsumed?: () => void;
}

export const StorePage: React.FC<StorePageProps> = (props) => {
  const { mode, token, username, isAdmin, access, onModeChange, onNavigate } = props;
  const [issueSessionId, setIssueSessionId] = useState<string | null>(null);
  const programs = useStoreProgram({ token, issueSessionId, initialProgramId: props.initialProgramId, onInitialProgramConsumed: props.onInitialProgramConsumed });
  const receiving = useReceivingStation({ token, username, active: mode === "receiving" && !programs.isOpen });
  const issuing = useIssuingStation({
    token,
    username,
    active: mode === "issuing" && !programs.isOpen,
    onSessionChange: setIssueSessionId,
    onMachineProgramScan: programs.openProgram,
  });
  const lookups = useRawMaterialLookups();
  const [reportOpen, setReportOpen] = useState<Record<StoreMode, boolean>>({ receiving: false, issuing: false });
  useModeKeys(onModeChange);

  const closeReport = useCallback((which: StoreMode) => setReportOpen((open) => ({ ...open, [which]: false })), []);
  // Receipts → Continue opened the full-screen station; here the open session is already on the rail.
  const navigate = useCallback((route: AppRoute) => (route === "raw-material-input" ? onModeChange("receiving") : onNavigate(route)), [onModeChange, onNavigate]);
  const shared = { token, username, isAdmin, access, lookups, onNavigate: navigate };
  const issuingKey = `${issuing.session?.id ?? ""}|${issuing.session?.status ?? ""}|${issuing.summary?.totalPackets ?? 0}`;
  const showing = (which: StoreMode) => mode === which && !programs.isOpen;

  return (
    <div className="sp-page">
      <style>{SCAN_STATION_CSS}</style>
      <header className="sp-head">
        <div className="sp-head-text">
          <h1 className="sp-title">{copy.storePage.title}</h1>
          <p className="sp-sub">{copy.storePage.subtitle}</p>
        </div>
        <div className="sp-head-actions">
          <button type="button" className="btn btn-secondary" aria-haspopup="dialog" onClick={programs.openDialog}>
            {copy.storePage.machinePrograms}
          </button>
          <button type="button" className="btn btn-secondary" aria-pressed={reportOpen[mode]} onClick={() => setReportOpen((open) => ({ ...open, [mode]: !open[mode] }))}>
            {copy.storePage.dailyReport}
          </button>
        </div>
      </header>

      <ModeSwitch
        mode={mode}
        receiving={{ open: receiving.open, packets: receiving.summary?.totalPackets ?? 0 }}
        issuing={{ open: issuing.session?.status === "OPEN", packets: issuing.summary?.totalPackets ?? 0 }}
        onSelect={onModeChange}
      />

      <div className="sp-body">
        <div hidden={!showing("receiving")} className="sp-work-slot">
          <ReceivingWorkArea {...shared} reportOpen={reportOpen.receiving} onCloseReport={() => closeReport("receiving")} />
        </div>
        <div hidden={!showing("issuing")} className="sp-work-slot">
          <IssuingWorkArea
            {...shared}
            reportOpen={reportOpen.issuing}
            onCloseReport={() => closeReport("issuing")}
            sessionKey={issuingKey}
            onReprint={(sessionId) => void issuing.reprint(sessionId)}
          />
        </div>
        {programs.isOpen ? <ProgramWork store={programs} mode={mode} /> : null}
        <ScanInRail station={receiving} hidden={!showing("receiving")} />
        <ScanOutRail station={issuing} hidden={!showing("issuing")} />
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
