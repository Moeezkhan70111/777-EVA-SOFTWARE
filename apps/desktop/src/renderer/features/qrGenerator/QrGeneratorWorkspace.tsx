import React, { useState } from "react";
import type { AppRoute } from "../../app/routes";
import { TabStrip, type TabStripItem } from "../../components/shared/TabStrip";
import { copy } from "../../config/copy";
import { BCartonGeneratorPage } from "../../pages/BCartonGeneratorPage";
import { QrGeneratorPage } from "../../pages/QrGeneratorPage";
import type { MachineRecord } from "../../types/desktopApi";
import { MachinePicker } from "../machineProgram/MachinePicker";
import { useMachines } from "../machineProgram/useCartonProgram";
import { ReceiveProductionTab } from "../receiveProduction/ReceiveProductionTab";
import { UpperMoveOutTab } from "../upperMoveOut/UpperMoveOutTab";

// QR GENERATOR — carton QRs and B carton labels, for one machine:
//
//   QR Generator
//   [ Carton QR ] [ B-Carton Labels ] [ Receive Production ] [ Upper Move Out ]
//   ┌ MACHINE ─ The cartons are added to this machine's program for today. ───────┐
//   │ [● MACHINE 1  ASLAM · BABAR] [  MACHINE 2  ASLAM · KHAN]                     │
//   └──────────────────────────────────────────────────────────────────────────────┘
//   ( the Carton QR generator, or the B-Carton Labels generator )
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

export type QrWorkspaceTab = "cartons" | "b-cartons" | "receive" | "upper";

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
}

export const QrGeneratorWorkspace: React.FC<QrGeneratorWorkspaceProps> = ({ username, initialTab = "cartons", onNavigate, onSetUpMachines, canReceiveProduction = false, canUpperMoveOut = false }) => {
  const offered = (wanted: QrWorkspaceTab) => (wanted === "receive" ? canReceiveProduction : wanted === "upper" ? canUpperMoveOut : true);
  const [tab, setTab] = useState<QrWorkspaceTab>(offered(initialTab) ? initialTab : "cartons");
  const [machine, setMachine] = useState<MachineRecord | null>(null);
  const machines = useMachines(copy.machinePicker.failed);
  const tabs: TabStripItem<QrWorkspaceTab>[] = [
    { id: "cartons", label: text.tabCartons },
    { id: "b-cartons", label: text.tabBCartons },
    ...(canReceiveProduction ? [{ id: "receive" as const, label: text.tabReceive }] : []),
    ...(canUpperMoveOut ? [{ id: "upper" as const, label: text.tabUpperOut }] : []),
  ];
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
        {tab === "receive" ? <ReceiveProductionTab /> : null}
        {tab === "upper" ? <UpperMoveOutTab /> : null}
        {tab === "b-cartons" ? <BCartonGeneratorPage username={username} machine={machine} embedded /> : null}
        {tab === "cartons" ? <QrGeneratorPage username={username} machine={machine} onNavigate={onNavigate} embedded /> : null}
      </div>
    </div>
  );
};
