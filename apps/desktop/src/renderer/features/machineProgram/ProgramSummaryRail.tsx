import React, { useState } from "react";
import { MACHINE_INJECTORS, formatShiftRange, type MachineShift } from "@erp/domain";
import type { MachineProgramRecord, MachineRecord } from "../../types/desktopApi";
import { ColorSwatch } from "../../components/shared/ColorSwatch";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog";
import { copy } from "../../config/copy";
import { formatLongDate } from "../../utils/dates";
import { ClockIcon, MachineIcon, PersonIcon, ProductionIcon } from "./MachineProgramIcons";
import { colourRuns, formatAmount, injectorRuns, injectorTotal, runColours } from "./machineProgram";
import type { ProgramWrites } from "./useProgramWrites";

// The right column: what the machine's day adds up to, and the one thing that can undo it.
//
//   PROGRAM SUMMARY
//   Injector 1                       Configured
//     ● BLACK sole
//       SK6 7/10 BROWN        10 DOZEN
//       SK6 7/10 NAVY         10 DOZEN
//     ● BROWN sole
//       SK12 1/6 BLUE         10 DOZEN
//   Total Production (Injector 1)    30 DOZEN
//   Injector 2                   Not configured
//   Total Production (Injector 2)     0 DOZEN
//
// One line per UPPER, under the sole it is moulded onto — not one line per sole colour. What the
// machine is making is an article, a size and an upper colour, and that is what the floor asks
// for; a colour on its own cannot be fetched from the store.
//   QUICK VIEW  machine · shift · contractor · total
//
// Every figure is the saved program's own. That a program reserves uppers and moves no stock is
// said where it matters — on the printed sheet, and in the delete dialog with what has already
// been scanned out, before anything is released.

interface ProgramSummaryRailProps {
  program: MachineProgramRecord | null;
  machine: MachineRecord | null;
  date: string;
  shift: MachineShift;
  writes: ProgramWrites;
  onChangeContractor: () => void;
}

export const ProgramSummaryRail: React.FC<ProgramSummaryRailProps> = ({
  program,
  machine,
  date,
  shift,
  writes,
  onChangeContractor,
}) => {
  const [confirming, setConfirming] = useState(false);

  return (
    <aside className="mpx-summary" aria-label={copy.machineProgram.programSummary}>
      <h2 className="mpx-rail-title">{copy.machineProgram.programSummary}</h2>

      {MACHINE_INJECTORS.map((injectorNo) => (
        <InjectorSummary key={injectorNo} injectorNo={injectorNo} program={program} />
      ))}

      <h3 className="mpx-summary-subtitle">{copy.machineProgram.quickView}</h3>
      <dl className="mpx-quick">
        <QuickFact icon={<MachineIcon />} label={copy.machineProgram.machineLabel} value={machine?.name ?? "—"} />
        <QuickFact icon={<ClockIcon />} label={copy.machineProgram.shiftTime} value={formatShiftRange(shift)} hint={formatLongDate(date)} />
        <QuickFact
          icon={<PersonIcon />}
          label={copy.machineProgram.machineContractor}
          value={machine?.contractorName ?? copy.machineProgram.noContractorYet}
          action={machine ? { label: copy.machineProgram.changeContractor, onClick: onChangeContractor } : undefined}
        />
        <QuickFact
          icon={<PersonIcon />}
          label={copy.machineProgram.packingContractor}
          value={machine?.packingContractorName ?? copy.machineProgram.noPackingContractorYet}
        />
        <QuickFact
          icon={<ProductionIcon />}
          label={copy.machineProgram.totalProduction}
          value={program ? formatAmount(program.totalQuantity, program.unitCode) : copy.machineProgram.programNotMade}
          strong
        />
      </dl>

      {program ? (
        <button type="button" className="btn btn-danger mpx-delete" onClick={() => setConfirming(true)}>
          {copy.machineProgram.deleteProgram}
        </button>
      ) : null}

      {program && confirming ? (
        <ConfirmDialog
          title={copy.machineProgram.deleteTitle}
          facts={[
            { label: copy.machineProgram.machineLabel, value: program.machineName },
            { label: copy.machineProgram.programDate, value: formatLongDate(program.programDate) },
            {
              label: copy.machineProgram.shiftTime,
              value: formatShiftRange({ startMinute: program.shiftStartMinute, endMinute: program.shiftEndMinute }),
            },
          ]}
          explain={copy.machineProgram.deleteExplain}
          warning={
            program.consumedQuantity > 0
              ? copy.machineProgram.deleteAlreadyTaken(formatAmount(program.consumedQuantity, program.unitCode))
              : null
          }
          confirmLabel={copy.machineProgram.deleteConfirm}
          onConfirm={async () => {
            const answer = await writes.deleteProgram(program.id);
            return answer.ok ? null : answer.reason;
          }}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </aside>
  );
};

/** One injector's soles and its total, or the words that say it has none. */
const InjectorSummary: React.FC<{ injectorNo: number; program: MachineProgramRecord | null }> = ({ injectorNo, program }) => {
  const runs = injectorRuns(program, injectorNo);
  const total = injectorTotal(runs);
  // An injector with nothing on it has no unit of its own; it is still counted in the machine's.
  const unitCode = total.unitCode ?? program?.unitCode ?? null;

  return (
    <section className="mpx-summary-injector">
      <header className="mpx-summary-injector-head">
        <h3 className="mpx-summary-injector-title">{copy.machineProgram.injector(injectorNo)}</h3>
        <span className={`mp-badge mp-badge--${runs.length > 0 ? "ok" : "muted"}`}>
          {runs.length > 0 ? copy.machineProgram.configured : copy.machineProgram.notConfigured}
        </span>
      </header>

      {runColours(runs).map((colour) => (
        <div key={colour} className="mpx-summary-sole">
          <p className="mpx-summary-sole-head">
            <ColorSwatch color={colour} className="mpx-summary-swatch" />
            {copy.machineProgram.soleLine(colour)}
          </p>
          <ul className="mpx-summary-lines">
            {colourRuns(runs, colour).flatMap((run) =>
              run.lines.map((line) => (
                <li key={line.id} className="mpx-summary-line">
                  <span className="mpx-summary-line-what">
                    {run.article} {run.size} <b>{line.upperColour}</b>
                  </span>
                  <span className="mpx-summary-line-qty">{formatAmount(line.quantity, line.unitCode)}</span>
                </li>
              ))
            )}
          </ul>
        </div>
      ))}

      <p className="mpx-summary-total">
        <span>
          {copy.machineProgram.totalProduction} <span className="mpx-summary-total-of">({copy.machineProgram.injector(injectorNo)})</span>
        </span>
        <b>{formatAmount(total.quantity, unitCode)}</b>
      </p>
    </section>
  );
};

const QuickFact: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  /** A second, smaller line under the value. */
  hint?: string;
  strong?: boolean;
  action?: { label: string; onClick: () => void };
}> = ({ icon, label, value, hint, strong, action }) => (
  <div className="mpx-quick-fact">
    <span className="mpx-quick-mark" aria-hidden="true">
      {icon}
    </span>
    <span className="mpx-quick-text">
      <dt>{label}</dt>
      <dd className={strong ? "is-strong" : undefined}>{value}</dd>
      {hint ? <dd className="mpx-quick-hint">{hint}</dd> : null}
      {action ? (
        <dd>
          <button type="button" className="mpx-quick-action" onClick={action.onClick}>
            {action.label}
          </button>
        </dd>
      ) : null}
    </span>
  </div>
);
