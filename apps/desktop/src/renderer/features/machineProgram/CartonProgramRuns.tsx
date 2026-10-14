import React from "react";
import { formatQuantityInDozens } from "@erp/domain";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import type { CartonProgramLine } from "../../types/desktopApi";
import { formatDateTime } from "../../utils/dates";
import { useProgramRuns } from "./useCartonProgram";

// The generation runs behind one program line, opened under it:
//
//   SK6_BLACKGREY_7/10_000011 → …_000016    6 cartons · 3 DZN    13 Oct 2026 10:42 · by admin
//   SK6_BLACKGREY_7/10_000001 → …_000010   10 cartons · 5 DZN    13 Oct 2026 09:05 · by admin
//
// The line adds them up; each run stays listed so a carton can always be traced to the run that
// registered it.

const text = copy.cartonProgram;

interface CartonProgramRunsProps {
  programId: string;
  line: CartonProgramLine;
  id: string;
}

export const CartonProgramRuns: React.FC<CartonProgramRunsProps> = ({ programId, line, id }) => {
  const runs = useProgramRuns(programId, line, text.runsFailed);

  if (runs.loading) return <StateView kind="loading" compact message={text.runsLoading} />;
  if (runs.error) return <StateView kind="error" compact message={runs.error} onRetry={() => void runs.reload()} />;

  return (
    <ul className="cp-runs" id={id} aria-label={text.runRange}>
      {runs.rows.map((run) => (
        <li key={run.id} className="cp-run">
          <span className="cp-run-range">
            <code>{run.firstQrId}</code>
            <span className="qr-range-sep" aria-hidden="true">→</span>
            <code>{run.lastQrId}</code>
          </span>
          <span className="cp-run-count">
            {text.cartons(run.cartons)} · {formatQuantityInDozens(run.cartons)}
            {run.voidedCartons > 0 ? <span className="cp-voided"> · {text.voided(run.voidedCartons)}</span> : null}
          </span>
          <span className="cp-run-when">
            {formatDateTime(run.createdAt)}
            {run.createdBy ? ` · ${text.runBy(run.createdBy)}` : ""}
            {run.requestedBy ? ` · ${text.runFor(run.requestedBy)}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
};
