import React, { useState } from "react";
import type { StoreDailyReport as Report, StoreDirection } from "@erp/domain";
import { StateView } from "../../../components/shared/StateView";
import { copy } from "../../../config/copy";
import { toIsoDate } from "../../../utils/dates";
import { DaySummary } from "./DaySummary";
import { CartonTotals, MaterialTotals } from "./DayTotals";
import { MovementList } from "./MovementList";
import { ReportDayPicker } from "./ReportDayPicker";
import { directionText } from "./storeDailyReportView";
import { useStoreDailyReport } from "./useStoreDailyReport";

// The store's daily report — ONE component for both sides of the store. Store In shows it as a
// tab beside the scan station, Store Out as its own page; both are this.
//
//   [‹] [ 13/10/2026 ] [›]  Today  Refresh
//   Movements 18 · Scanned packets 12 · By hand 2 · Cartons 4
//   Raw material     material · packets · typed · quantity
//   Cartons          article · size · colour · cartons
//   Every movement   time · kind · what · quantity · details · by
//
// Read-only: it shows what the scan stations and the hand-move forms already recorded.

interface StoreDailyReportProps {
  direction: StoreDirection;
  token: string;
}

/** The report once it has loaded: empty, or the day in full. */
const ReportBody: React.FC<{ report: Report }> = ({ report }) => {
  const words = directionText(report.direction);
  if (report.entryCount === 0) return <StateView kind="empty" title={words.empty} hint={words.emptyHint} />;
  return (
    <>
      <DaySummary summary={report.summary} />
      {report.summary.byMaterial.length > 0 ? <MaterialTotals rows={report.summary.byMaterial} /> : null}
      {report.summary.byProduct.length > 0 ? <CartonTotals rows={report.summary.byProduct} /> : null}
      {/* Keyed by day, so a new day opens on its first page again. */}
      <MovementList key={report.date} entries={report.entries} total={report.entryCount} />
    </>
  );
};

export const StoreDailyReport: React.FC<StoreDailyReportProps> = ({ direction, token }) => {
  const [date, setDate] = useState(() => toIsoDate());
  const report = useStoreDailyReport(token, direction, date);

  const body = (): React.ReactNode => {
    if (report.loading) return <StateView kind="loading" message={copy.storeDailyReport.loading} />;
    if (report.error || !report.value) {
      return (
        <StateView
          kind="error"
          title={copy.storeDailyReport.loadFailed}
          message={report.error ?? undefined}
          onRetry={() => void report.reload()}
        />
      );
    }
    return <ReportBody report={report.value} />;
  };

  return (
    <div className="sdr">
      <ReportDayPicker date={date} onChange={setDate} onRefresh={() => void report.reload()} busy={report.loading} />
      {body()}
    </div>
  );
};
