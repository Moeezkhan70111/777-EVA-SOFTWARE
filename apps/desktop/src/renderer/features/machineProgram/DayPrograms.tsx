import React from "react";
import { formatQuantityInDozens } from "@erp/domain";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import type { MachineDayProgram } from "../../types/desktopApi";
import { CartonProgramTable } from "./CartonProgramTable";
import type { LoadState } from "./useCartonProgram";

// A day's programs, one card per machine:
//
//   ┌──────────────────────────────────────────────────────────────────────────────┐
//   │ MP-000123   MACHINE 1                                   40 cartons   20 DZN │
//   │ Machine contractor ASLAM · Packing contractor BABAR                          │
//   │ Article  Size  Colour  Carton QRs  Equivalent Dozens  Runs  Last generated   │
//   └──────────────────────────────────────────────────────────────────────────────┘
//
// The contractors are the ones the program was opened with, which is what it is paid by — not
// necessarily who works the machine today.

const text = copy.cartonProgram;

const ProgramCard: React.FC<{ program: MachineDayProgram; onStartReconciliation?: (programId: string) => void }> = ({ program, onStartReconciliation }) => (
  <article className="mp-program" aria-labelledby={`mp-program-${program.programId}`}>
    <header className="mp-program-head">
      <div className="mp-program-identity">
        <span className="mp-program-code">{program.code}</span>
        <h3 id={`mp-program-${program.programId}`} className="mp-program-machine">{program.machineName}</h3>
      </div>
      <div className="mp-program-totals">
        <strong>{text.programCartons(program.cartons)}</strong>
        <span>{formatQuantityInDozens(program.cartons)}</span>
        {onStartReconciliation ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm mp-reconcile"
            aria-label={text.startReconciliationFor(program.code)}
            onClick={() => onStartReconciliation(program.programId)}
          >
            {text.startReconciliation}
          </button>
        ) : null}
      </div>
      <p className="mp-program-crew">
        <span>{text.machineContractor} <strong>{program.contractorName}</strong></span>
        <span>{text.packingContractor} <strong>{program.packingContractorName ?? text.notSet}</strong></span>
      </p>
    </header>
    <CartonProgramTable program={program} />
  </article>
);

interface DayProgramsProps {
  programs: LoadState<MachineDayProgram>;
  onOpenQrGenerator?: () => void;
  /** Opens Reconciliation on one program; absent when this user cannot open it. */
  onStartReconciliation?: (programId: string) => void;
}

export const DayPrograms: React.FC<DayProgramsProps> = ({ programs, onOpenQrGenerator, onStartReconciliation }) => {
  if (programs.loading && programs.rows.length === 0) return <StateView kind="loading" message={text.programsLoading} />;
  if (programs.error) return <StateView kind="error" message={programs.error} onRetry={() => void programs.reload()} />;
  if (programs.rows.length === 0) {
    return (
      <StateView
        kind="empty"
        title={text.noProgramsTitle}
        hint={text.noProgramsHint}
        action={onOpenQrGenerator ? { label: text.openQrGenerator, onClick: onOpenQrGenerator } : undefined}
      />
    );
  }

  return (
    <div className="mp-programs">
      {programs.rows.map((program) => (
        <ProgramCard key={program.programId} program={program} onStartReconciliation={onStartReconciliation} />
      ))}
    </div>
  );
};
