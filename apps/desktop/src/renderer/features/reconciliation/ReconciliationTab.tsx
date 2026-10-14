import React, { useEffect, useState } from "react";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { toIsoDate } from "../../utils/dates";
import { ReportDayPicker } from "../store/dailyReport/ReportDayPicker";
import { ReconciliationTable } from "./ReconciliationTable";
import { useProgramReconciliation, useReconcilablePrograms } from "./useReconciliation";

// RECONCILIATION — the QR Generator's last tab (Phase 4):
//
//   Reconciliation
//   Day [‹][14/10/2026][›]   Machine program [ MP-000001 · MACHINE 1 ▾ ]
//   ( the program's Upper Out against its Production Received — ReconciliationTable )
//
// Opened from a machine program (Machine Program's Start Reconciliation), it shows that program. Opened
// from Receive Production, or as a tab with nothing chosen yet, it asks for the day and the program
// first — it never picks one on its own. The chosen program lives in the workspace, so leaving the tab
// and coming back keeps it.

const text = copy.reconciliation;

interface ReconciliationTabProps {
  programId: string | null;
  onProgramChange: (programId: string | null) => void;
}

export const ReconciliationTab: React.FC<ReconciliationTabProps> = ({ programId, onProgramChange }) => {
  const [date, setDate] = useState(toIsoDate());
  const programs = useReconcilablePrograms(date, text.programsFailed);
  const reconciliation = useProgramReconciliation(programId, text.failed);
  const shownDate = reconciliation.value?.program.programDate ?? null;

  // A program opened from elsewhere brings its own day into the picker.
  useEffect(() => {
    if (shownDate) setDate(shownDate);
  }, [shownDate]);

  const changeDay = (day: string) => {
    setDate(day);
    onProgramChange(null);
  };

  const body = () => {
    if (!programId) return <StateView kind="empty" title={text.chooseTitle} hint={text.chooseHint} />;
    if (reconciliation.loading && !reconciliation.value) return <StateView kind="loading" message={text.loading} />;
    if (reconciliation.error && !reconciliation.value) {
      return <StateView kind="error" message={reconciliation.error} onRetry={() => void reconciliation.reload()} />;
    }
    return reconciliation.value ? <ReconciliationTable reconciliation={reconciliation.value} /> : null;
  };

  const rows = programs.value ?? [];
  const status = programs.loading && !programs.value ? text.programsLoading : programs.error ? text.programsFailed : rows.length === 0 ? text.noPrograms : null;

  return (
    <div className="rp-tab rc-tab">
      <header className="rp-head">
        <div>
          <h2 className="rp-title">{text.title}</h2>
          <p className="rp-subtitle">{text.subtitle}</p>
        </div>
      </header>

      <div className="rc-choose">
        <ReportDayPicker date={date} onChange={changeDay} onRefresh={() => void Promise.all([programs.reload(), reconciliation.reload()])} busy={programs.loading || reconciliation.loading} />
        <div className="um-machine">
          <label className="um-machine-label" htmlFor="rc-program-select">{text.programLabel}</label>
          <select
            id="rc-program-select"
            className="form-input um-machine-select"
            value={programId && rows.some((program) => program.programId === programId) ? programId : ""}
            disabled={rows.length === 0}
            onChange={(event) => onProgramChange(event.target.value || null)}
          >
            <option value="">{text.chooseProgram}</option>
            {rows.map((program) => (
              <option key={program.programId} value={program.programId}>{`${program.code} · ${program.machineName}`}</option>
            ))}
          </select>
          {status ? <span className="um-machine-status" role="status">{status}</span> : null}
        </div>
      </div>

      {reconciliation.stale ? <p className="rp-stale" role="status">⚠ {text.offline}</p> : null}
      {body()}
    </div>
  );
};
