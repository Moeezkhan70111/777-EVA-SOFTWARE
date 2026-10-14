import React, { useCallback, useState } from "react";
import { copy } from "../../config/copy";
import type { MachineRecord } from "../../types/desktopApi";
import { ScanPanel } from "../scanStation/scanStation";
import { useScanBox } from "../scanStation/useScanBox";
import { useMachines } from "../machineProgram/useCartonProgram";
import { MachineSelect } from "./MachineSelect";
import { UpperIssuesPanel } from "./UpperIssuesPanel";
import { UpperSummaryCard } from "./UpperSummaryCard";
import { useUpperIssues, useUpperSummary } from "./useUpperData";
import { useUpperIssue } from "./useUpperIssue";

// MOVE OUT — choose the machine, then scan:
//
//   Machine [ MACHINE 1 ▾ ]   Issuing to MACHINE 1
//   ┌ scan station ─────────────────┐  ┌ Upper Out Details ─────────────────────┐
//   │ ISSUED · SK6 · 7/10 · RED     │  │ Upper QR  Article Size Colour Qty  …   │
//   │ [ Enter or scan upper ][Enter]│  │                                       │
//   └───────────────────────────────┘  └───────────────────────────────────────┘
//   ┌ Summary: this session · today to this machine · upper stock in store ┐
//
// Nothing can be issued until a machine is chosen: the box stays shut and says SELECT MACHINE (and
// the main process refuses a scan without one anyway). Every issue is recorded at once, so there is
// never an unsaved state to lose when the machine changes — the select only waits while a scan is
// being recorded, so that scan keeps the machine it was made for.

const text = copy.upperMoveOut;

export const MoveOutSection: React.FC = () => {
  const machines = useMachines(text.machinesFailed);
  const [machine, setMachine] = useState<MachineRecord | null>(null);
  const machineId = machine?.id ?? null;
  const issues = useUpperIssues(machineId, text.detailsFailed);
  const summary = useUpperSummary(machineId, text.summaryFailed);
  const reloadIssues = issues.reload;
  const reloadSummary = summary.reload;
  const onChanged = useCallback(() => {
    void reloadIssues();
    void reloadSummary();
  }, [reloadIssues, reloadSummary]);
  const issuing = useUpperIssue(machine, onChanged);
  const box = useScanBox({ armed: Boolean(machine), onScan: issuing.scan, refocusKey: issuing.feedback.seq, autoSubmit: "scanner-burst" });

  return (
    <div className="um-move-out">
      <div className="um-machine-bar">
        <MachineSelect machines={machines} selectedId={machineId} onSelect={setMachine} locked={issuing.busy} />
        {machine ? <span className="badge badge-navy um-issuing-to" aria-live="polite">{text.issuingTo(machine.name)}</span> : null}
      </div>

      <div className="rp-body">
        <div className="um-left">
          <div
            className="ssn ssn--embedded rp-station"
            onClick={(event) => {
              const target = event.target as HTMLElement | null;
              if (machine && target && !target.closest("button, a, input, select, textarea, [role='dialog']")) box.focusScanner();
            }}
          >
            <ScanPanel
              feedback={issuing.feedback}
              inputRef={box.inputRef}
              inputVal={box.inputVal}
              onInputChange={box.setInputVal}
              onKeyDown={box.onKeyDown}
              onFocusScanner={box.focusScanner}
              disabled={!machine}
              disabledHint={text.placeholderNoMachine}
              onSubmit={box.submit}
              submitLabel={text.enter}
              placeholder={text.placeholder}
              dockHint={text.dockHint}
            />
            {issuing.busy ? <p className="rp-busy" role="status">{text.busy}</p> : null}
          </div>
          <UpperSummaryCard summary={summary} />
        </div>
        <UpperIssuesPanel machineName={machine?.name ?? null} issues={issues} />
      </div>
    </div>
  );
};
