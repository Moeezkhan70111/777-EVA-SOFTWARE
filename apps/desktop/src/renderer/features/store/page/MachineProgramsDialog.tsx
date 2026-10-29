import React from "react";
import { copy } from "../../../config/copy";
import { Modal } from "../../../components/shared/Modal";
import { StateView } from "../../../components/shared/StateView";
import { formatDate } from "../../../utils/dates";
import { useOpenPrograms } from "../../machineProgram/useCartonProgram";
import { ProgramLookupField } from "../programOut/ProgramLookupField";

// MACHINE PROGRAMS (0.3.9) — the header button's pick-list, in place of the full-width program bar
// both store pages had. Every program still open, to choose from, and the same lookup box the bar
// was, so a program sheet can still be scanned or its number typed. Nothing is decided here: opening
// a program is the main process resolving it, exactly as from the bar.
//
// Carton labels start a program, so the Carton QR Generator is reached from here too (owner, 0.3.9).

const text = copy.storePage.programs;

interface MachineProgramsDialogProps {
  /** Resolves a program number, a sheet scan or a program id; the dialog closes once one opens. */
  onOpen: (lookup: string) => void;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  /** Absent when this account may not open the Carton QR Generator. */
  onOpenCartonQr?: () => void;
}

export const MachineProgramsDialog: React.FC<MachineProgramsDialogProps> = ({ onOpen, busy, error, onClose, onOpenCartonQr }) => {
  const open = useOpenPrograms(text.failed);
  return (
    <Modal
      title={text.title}
      subtitle={text.subtitle}
      onClose={onClose}
      wide
      footer={
        onOpenCartonQr ? (
          <button type="button" className="btn btn-secondary" onClick={onOpenCartonQr}>
            {text.cartonQr}
          </button>
        ) : null
      }
    >
      <ProgramLookupField onOpen={onOpen} busy={busy} error={error} />
      <h3 className="section-label">{text.listTitle}</h3>
      {open.loading && open.rows.length === 0 ? <StateView kind="loading" compact message={text.loading} /> : null}
      {open.error ? <StateView kind="error" compact message={open.error} onRetry={() => void open.reload()} /> : null}
      {!open.loading && !open.error && open.rows.length === 0 ? <StateView kind="empty" compact title={text.empty} /> : null}
      {open.rows.length > 0 ? (
        <ul className="mp-open-list">
          {open.rows.map((program) => (
            <li key={program.programId} className="mp-open-row">
              <strong>{program.code}</strong>
              <span>{program.machineName}</span>
              <span>{formatDate(program.programDate)}</span>
              <span>{program.contractorName}</span>
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => onOpen(program.programId)}>
                {text.openFor(program.code)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </Modal>
  );
};
