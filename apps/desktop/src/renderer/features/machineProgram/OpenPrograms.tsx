import React, { useState } from "react";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import { formatDate } from "../../utils/dates";
import type { OpenMachineProgram } from "../../types/desktopApi";
import { DeleteProgramDialog } from "./DeleteProgramDialog";
import { useOpenPrograms } from "./useCartonProgram";
import type { StoreMode } from "../store/page/storeTabs";

// OPEN PROGRAMS — every machine program still open, whatever its date.
//
//   Open in Store (0.3.9): Receiving reads it and scans its cartons back, Issuing issues against it —
//                           for whoever works the store.
//   Delete (0.3.8):        administrators only, for a program that can never honestly be completed
//                           (nothing came back, or never will).
//
// The day list
// below shows only programs with carton runs, so a program with none is found only here.

const text = copy.cartonProgram;

interface OpenProgramsProps {
  /** Administrators only: offers Delete. The main process checks again. */
  canDelete: boolean;
  /** Opens a program on the Store page; absent when this user cannot open it. */
  onOpenInStore?: (programId: string, mode: StoreMode) => void;
  /** A program was deleted: the day list may have changed too. */
  onDeleted: () => void;
}

export const OpenPrograms: React.FC<OpenProgramsProps> = ({ canDelete, onOpenInStore, onDeleted }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const open = useOpenPrograms(text.openProgramsFailed);
  const [deleting, setDeleting] = useState<OpenMachineProgram | null>(null);

  const remove = async (program: OpenMachineProgram, reason: string): Promise<string | null> => {
    try {
      const result = await api.deleteMachineProgram(program.programId, reason);
      if (!result.accepted) return result.reason ?? text.deleteFailed;
    } catch {
      return text.deleteFailed;
    }
    setDeleting(null);
    push("success", text.deleteDone(program.code), reason);
    await open.reload();
    onDeleted();
    return null;
  };

  return (
    <section className="mp-section" aria-labelledby="mp-open-title">
      <h2 id="mp-open-title" className="section-label">{text.openProgramsTitle}</h2>
      <p className="mp-subtitle">{text.openProgramsLine}</p>
      {open.loading && open.rows.length === 0 ? <StateView kind="loading" compact message={text.openProgramsLoading} /> : null}
      {open.error ? <StateView kind="error" compact message={open.error} onRetry={() => void open.reload()} /> : null}
      {!open.loading && !open.error && open.rows.length === 0 ? <StateView kind="empty" compact title={text.openProgramsEmpty} /> : null}
      {open.rows.length > 0 ? (
        <ul className="mp-open-list">
          {open.rows.map((program) => (
            <li key={program.programId} className="mp-open-row">
              <strong>{program.code}</strong>
              <span>{program.machineName}</span>
              <span>{formatDate(program.programDate)}</span>
              <span>{program.contractorName}</span>
              {onOpenInStore ? (
                <span className="mp-open-actions" role="group" aria-label={text.openInStore}>
                  <button type="button" className="btn btn-secondary btn-sm" aria-label={text.openInReceivingFor(program.code)} onClick={() => onOpenInStore(program.programId, "receiving")}>
                    {text.openInReceiving}
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" aria-label={text.openInIssuingFor(program.code)} onClick={() => onOpenInStore(program.programId, "issuing")}>
                    {text.openInIssuing}
                  </button>
                </span>
              ) : null}
              {canDelete ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  aria-label={text.deleteProgramFor(program.code)}
                  onClick={() => setDeleting(program)}
                >
                  {text.deleteProgram}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {deleting ? (
        <DeleteProgramDialog program={deleting} onDelete={(reason) => remove(deleting, reason)} onClose={() => setDeleting(null)} />
      ) : null}
    </section>
  );
};
