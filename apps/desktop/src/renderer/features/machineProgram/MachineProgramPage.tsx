import React, { useState } from "react";
import { copy } from "../../config/copy";
import { useNotifications } from "../../state/NotificationsContext";
import type { MachineRecord } from "../../types/desktopApi";
import { toIsoDate } from "../../utils/dates";
import { ReportDayPicker } from "../store/dailyReport/ReportDayPicker";
import { DayPrograms } from "./DayPrograms";
import { MachineCards } from "./MachineCards";
import { MachineDialog } from "./MachineDialog";
import { OpenPrograms } from "./OpenPrograms";
import type { StoreMode } from "../store/page/storeTabs";
import { useDayPrograms, useMachines } from "./useCartonProgram";

// MACHINE PROGRAM
//
//   Machine Program                                                   [ + Add Machine ]
//   One program per machine per day, made of the carton QRs generated for it.
//
//   MACHINES
//   ┌ MACHINE 1   M-001 ┐ ┌ MACHINE 2   M-002 ┐
//   │ ASLAM · BABAR     │ │ ASLAM · KHAN      │
//   └───────────────────┘ └───────────────────┘
//
//   PROGRAMS                                   [‹] [13/10/2026] [›] Today Refresh
//   ┌ MP-000123  MACHINE 1                                40 cartons · 20 DZN ┐
//   │ Article  Size  Colour  Carton QRs  Equivalent Dozens  Runs  Last generated │
//   └────────────────────────────────────────────────────────────────────────────┘
//
// Programs are never made here: a machine's program for the day opens with its first QR run in the
// QR Generator (or its B-Carton Labels tab). This page sets up the machines and reads the programs.

const text = copy.cartonProgram;

type Dialog = { kind: "add" } | { kind: "edit"; machine: MachineRecord } | null;

interface MachineProgramPageProps {
  /** Opens the QR Generator from the empty state; absent when this user cannot open it. */
  onOpenQrGenerator?: () => void;
  /** Shown as the QR Generator workspace's first tab: a tab-sized title instead of the page heading. */
  embedded?: boolean;
  /** A machine was added or its contractors changed — so a machine picker elsewhere can re-read. */
  onMachinesChanged?: () => void;
  /** Opens Reconciliation on one program; absent when this user cannot open it. */
  onStartReconciliation?: (programId: string) => void;
  /** An administrator also sees every open program, to delete (0.3.8). The main process checks it again. */
  isAdmin?: boolean;
  /** Opens a program on the Store page, in Receiving or Issuing. Absent when this user cannot open it. */
  onOpenInStore?: (programId: string, mode: StoreMode) => void;
}

export const MachineProgramPage: React.FC<MachineProgramPageProps> = ({ onOpenQrGenerator, embedded = false, onMachinesChanged, onStartReconciliation, isAdmin = false, onOpenInStore }) => {
  const { push } = useNotifications();
  const [date, setDate] = useState(toIsoDate());
  const [dialog, setDialog] = useState<Dialog>(null);
  const machines = useMachines(text.machinesFailed);
  const programs = useDayPrograms(date, text.programsFailed);

  const saved = (title: string, body: string) => {
    setDialog(null);
    push("success", title, body);
    void machines.reload();
    onMachinesChanged?.();
  };

  return (
    <div className="page mp-page">
      <div className={embedded ? "mp-header mp-header--embedded" : "page-header mp-header"}>
        <div>
          {embedded ? <h2 className="rp-title">{text.title}</h2> : <h1>{text.title}</h1>}
          <p className="mp-subtitle">{text.subtitle}</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: "add" })}>
          <span aria-hidden="true">+</span> {text.addMachine}
        </button>
      </div>

      <section className="mp-section" aria-labelledby="mp-machines-title">
        <h2 id="mp-machines-title" className="section-label">{text.machinesTitle}</h2>
        <MachineCards machines={machines} onAdd={() => setDialog({ kind: "add" })} onEdit={(machine) => setDialog({ kind: "edit", machine })} />
      </section>

      {isAdmin || onOpenInStore ? <OpenPrograms canDelete={isAdmin} onOpenInStore={onOpenInStore} onDeleted={() => void programs.reload()} /> : null}

      <section className="mp-section" aria-labelledby="mp-programs-title">
        <div className="mp-section-head">
          <h2 id="mp-programs-title" className="section-label">{text.programsTitle}</h2>
          <ReportDayPicker date={date} onChange={setDate} onRefresh={() => void programs.reload()} busy={programs.loading} />
        </div>
        <DayPrograms programs={programs} onOpenQrGenerator={onOpenQrGenerator} onStartReconciliation={onStartReconciliation} />
      </section>

      {dialog ? (
        <MachineDialog machine={dialog.kind === "edit" ? dialog.machine : undefined} onClose={() => setDialog(null)} onSaved={saved} />
      ) : null}
    </div>
  );
};
