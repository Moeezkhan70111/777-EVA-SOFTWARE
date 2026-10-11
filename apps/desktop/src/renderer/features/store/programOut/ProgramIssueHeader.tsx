import React from "react";
import { copy } from "../../../config/copy";
import { formatDate } from "../../../utils/dates";
import type { MachineProgramRecord } from "../../../types/desktopApi";
import { programShift, programStatusLabel, programStatusTone } from "./programOut";

// The head of the Machine Program Issue screen: what this program IS, in one strip.
//
//   ← Machine Program Issue  ● Program Ready
//   📄 Program #  ⚙ Machine  📅 Date  👤 Contractor  📦 Packing  🕐 Shift Time
//
// The same seven facts the printed sheet carries, in the same order, so the paper in the
// operator's hand and the screen in front of them read identically. The STATUS is the one
// difference: on paper it is a cell in the strip, here it is a pill beside the title, because
// on screen it changes as the operator works and belongs where the eye already is.
//
// Every icon is decorative (`aria-hidden`); the label beside it is what is read (R18).

const DocIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm0 2.5L17.5 8H14V4.5zM8 13h8v1.6H8V13zm0 3.4h8V18H8v-1.6z" />
  </svg>
);
const GearIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8zm8.9 4.9.2-1.5-.2-1.5 1.8-1.4-1.8-3.1-2.2.7a7.6 7.6 0 0 0-2.6-1.5L15.7 3h-3.6l-.4 2.2a7.6 7.6 0 0 0-2.6 1.5l-2.2-.7-1.8 3.1L6.9 10.5l-.2 1.5.2 1.5-1.8 1.4 1.8 3.1 2.2-.7a7.6 7.6 0 0 0 2.6 1.5l.4 2.2h3.6l.4-2.2a7.6 7.6 0 0 0 2.6-1.5l2.2.7 1.8-3.1-1.8-1.4z" />
  </svg>
);
const CalendarIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M7 2v2H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2H7zm12 7v10H5V9h14zM7.5 11v2h2v-2h-2zm4.5 0v2h2v-2h-2zm4.5 0v2h2v-2h-2z" />
  </svg>
);
const PersonIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 12a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4zm0 2c-4 0-7.5 2.1-7.5 4.7V21h15v-2.3C19.5 16.1 16 14 12 14z" />
  </svg>
);
const BoxIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2 3 7v10l9 5 9-5V7l-9-5zm0 2.3 6.4 3.6L12 11.5 5.6 7.9 12 4.3zM5 9.6l6 3.4v6.7l-6-3.3V9.6zm8 10.1V13l6-3.4v6.8l-6 3.3z" />
  </svg>
);
const ClockIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm-1 2v6.6l5 2.9 1-1.7-4-2.3V6h-2z" />
  </svg>
);

const MetaCell: React.FC<{ icon: React.ReactNode; label: string; value: string }> = ({ icon, label, value }) => (
  <div className="mpi-meta-cell">
    <span className="mpi-meta-icon" aria-hidden="true">
      {icon}
    </span>
    <div className="mpi-meta-words">
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  </div>
);

interface ProgramIssueHeaderProps {
  program: MachineProgramRecord;
  /** "Machine Program Issue" on Store Out, "Machine Program" where it is only read. */
  title: string;
  /** The ← button's accessible name: where it goes back to. */
  backLabel: string;
  onBack: () => void;
  /** Leaves the station for the job chooser. Omitted where there is no job to change. */
  onChangeJob?: () => void;
}

export const ProgramIssueHeader: React.FC<ProgramIssueHeaderProps> = ({ program, title, backLabel, onBack, onChangeJob }) => (
  <header className="mpi-head">
    <div className="mpi-title-row">
      <button type="button" className="mpi-back" onClick={onBack} aria-label={backLabel}>
        <span aria-hidden="true">←</span>
      </button>
      <h1 className="mpi-title">{title}</h1>
      {/* A dot AND the word: the state never depends on the colour alone. */}
      <span className={`mpi-pill mpi-pill--${programStatusTone(program.displayStatus)}`}>
        <span className="mpi-pill-dot" aria-hidden="true" />
        {programStatusLabel(program.displayStatus)}
      </span>
      {onChangeJob ? (
        <button type="button" className="mpi-change-job" onClick={onChangeJob}>
          {copy.store.changeJob}
        </button>
      ) : null}
    </div>

    <dl className="mpi-meta">
      <MetaCell icon={<DocIcon />} label={copy.machineProgram.printProgramNo} value={program.code} />
      <MetaCell icon={<GearIcon />} label={copy.machineProgram.machineLabel} value={program.machineName} />
      <MetaCell icon={<CalendarIcon />} label={copy.columns.date} value={formatDate(program.programDate)} />
      <MetaCell icon={<PersonIcon />} label={copy.machineProgram.contractor} value={program.contractorName} />
      <MetaCell
        icon={<BoxIcon />}
        label={copy.machineProgram.printPacking}
        value={program.packingContractorName ?? copy.machineProgram.noPackingContractorYet}
      />
      <MetaCell icon={<ClockIcon />} label={copy.machineProgram.shiftTime} value={programShift(program)} />
    </dl>
  </header>
);
