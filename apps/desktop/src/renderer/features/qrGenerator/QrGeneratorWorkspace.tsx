import React, { useState } from "react";
import type { AppRoute } from "../../app/routes";
import { TabStrip, type TabStripItem } from "../../components/shared/TabStrip";
import { copy } from "../../config/copy";
import { BCartonGeneratorPage } from "../../pages/BCartonGeneratorPage";
import { QrGeneratorPage } from "../../pages/QrGeneratorPage";
import type { MachineRecord } from "../../types/desktopApi";
import { MachinePicker } from "../machineProgram/MachinePicker";
import { MachineProgramPage } from "../machineProgram/MachineProgramPage";
import { useMachines } from "../machineProgram/useCartonProgram";
import { ReceiveProductionTab } from "../receiveProduction/ReceiveProductionTab";
import { ReconciliationTab } from "../reconciliation/ReconciliationTab";
import { UpperMoveOutTab } from "../upperMoveOut/UpperMoveOutTab";

// QR GENERATOR — carton QRs and B carton labels, for one machine:
//
//   QR Generator
//   [ Machine Program ] [ Carton QR ] [ B-Carton Labels ] [ Receive Production ] [ Upper Move Out ] [ Reconciliation ]
//   ┌ MACHINE ─ The cartons are added to this machine's program for today. ───────┐
//   │ [● MACHINE 1  ASLAM · BABAR] [  MACHINE 2  ASLAM · KHAN]                     │
//   └──────────────────────────────────────────────────────────────────────────────┘
//   ( the Carton QR generator, or the B-Carton Labels generator )
//
// Machine Program comes first (owner, 2026-10-14) — the existing Machine Program page itself, so the
// machines and today's programs are one tab away from generating. It opens on it when this user may
// see it. A machine added there is in the generators' picker straight away.
//
// The machine is chosen once, above the two generator tabs, and stays chosen when the tab changes —
// both generators send it, and their run joins that machine's program for the day. Each tab is the
// existing generator page itself, embedded; switching tabs only mounts the other one.
//
// The third tab, Receive Production (Phase 2), records cartons already generated as produced. It
// asks for no machine — the carton's QR already belongs to its program — and is only offered to
// users who may record production.
//
// The fourth, Upper Move Out (Phase 3), issues upper packets out of the store to a machine it chooses
// itself (every machine in service, not only those ready to generate), so the generators' picker is
// not shown on it either. Offered to users who may use Raw Material Output.
//
// The last, Reconciliation (Phase 4), sets a program's Upper Out against its Production Received. The
// program is chosen there, or brought by Start Reconciliation on a Machine Program card; Receive
// Production's Start Reconciliation opens it to choose one. The choice is kept here, so leaving the tab
// and coming back keeps it. Offered with the Machine Program, whose permission its reads sit behind.

export type QrWorkspaceTab = "program" | "cartons" | "b-cartons" | "receive" | "upper" | "reconcile";

const text = copy.qrWorkspace;

interface QrGeneratorWorkspaceProps {
  username?: string;
  initialTab?: QrWorkspaceTab;
  onNavigate: (route: AppRoute) => void;
  /** Opens the Machine Program to set machines up; absent when this user cannot. */
  onSetUpMachines?: () => void;
  /** Whether this user may record production (the Live Production permission). */
  canReceiveProduction?: boolean;
  /** Whether this user may issue raw material out of the store (Raw Material Output). */
  canUpperMoveOut?: boolean;
  /** Whether this user may open the Machine Program. */
  canMachineProgram?: boolean;
  /** The program Reconciliation opens on — Start Reconciliation on the Machine Program page. */
  reconcileProgramId?: string | null;
}

export const QrGeneratorWorkspace: React.FC<QrGeneratorWorkspaceProps> = ({ username, initialTab, onNavigate, onSetUpMachines, canReceiveProduction = false, canUpperMoveOut = false, canMachineProgram = false, reconcileProgramId = null }) => {
  const tabs: TabStripItem<QrWorkspaceTab>[] = [
    ...(canMachineProgram ? [{ id: "program" as const, label: text.tabProgram }] : []),
    { id: "cartons", label: text.tabCartons },
    { id: "b-cartons", label: text.tabBCartons },
    ...(canReceiveProduction ? [{ id: "receive" as const, label: text.tabReceive }] : []),
    ...(canUpperMoveOut ? [{ id: "upper" as const, label: text.tabUpperOut }] : []),
    ...(canMachineProgram ? [{ id: "reconcile" as const, label: text.tabReconcile }] : []),
  ];
  // A deep link opens its own tab when this user has it; otherwise the first tab.
  const [tab, setTab] = useState<QrWorkspaceTab>(tabs.some((item) => item.id === initialTab) && initialTab ? initialTab : tabs[0].id);
  const [machine, setMachine] = useState<MachineRecord | null>(null);
  const [reconcileId, setReconcileId] = useState<string | null>(reconcileProgramId);
  const machines = useMachines(copy.machinePicker.failed);
  const startReconciliation = canMachineProgram
    ? (programId: string | null) => {
        setReconcileId(programId);
        setTab("reconcile");
      }
    : undefined;
  const generating = tab === "cartons" || tab === "b-cartons";

  return (
    <div className="page qrw-page">
      <div className="page-header">
        <h1>{text.title}</h1>
      </div>
      <TabStrip items={tabs} active={tab} onSelect={setTab} label={text.tabsLabel} />
      {!generating ? null : (
        <MachinePicker machines={machines} selectedId={machine?.id ?? null} onSelect={setMachine} onSetUpMachines={onSetUpMachines} />
      )}
      <div role="tabpanel" aria-labelledby={`tab-${tab}`} className="qrw-panel">
        {tab === "program" ? (
          <MachineProgramPage
            embedded
            onOpenQrGenerator={() => setTab("cartons")}
            onMachinesChanged={() => void machines.reload()}
            onStartReconciliation={startReconciliation}
          />
        ) : null}
        {tab === "receive" ? <ReceiveProductionTab onStartReconciliation={startReconciliation ? () => startReconciliation(null) : undefined} /> : null}
        {tab === "reconcile" ? <ReconciliationTab programId={reconcileId} onProgramChange={setReconcileId} /> : null}
        {tab === "upper" ? <UpperMoveOutTab /> : null}
        {tab === "b-cartons" ? <BCartonGeneratorPage username={username} machine={machine} embedded /> : null}
        {tab === "cartons" ? <QrGeneratorPage username={username} machine={machine} onNavigate={onNavigate} embedded /> : null}
      </div>
    </div>
  );
};
