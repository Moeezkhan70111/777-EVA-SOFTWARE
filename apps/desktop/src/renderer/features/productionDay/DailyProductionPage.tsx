import React, { useState } from "react";
import type { ProductionDayView } from "@erp/domain";
import { KpiCard } from "../../components/dashboard/KpiCard";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { formatLongDate, shiftIsoDate, toIsoDate } from "../../utils/dates";
import { dozenFigure } from "../cartonStock/CartonMatrix";
import { CartonMatrixList } from "../cartonStock/CartonMatrixList";
import { ALL_MACHINES, MachinePicker } from "./MachinePicker";
import { ProductionPdfButton } from "./ProductionPdfButton";
import { ProductionStatusBox } from "./ProductionStatusBox";
import { useProductionDay } from "./useProductionDay";
import { useProductionPdf } from "./useProductionPdf";

// DAILY PRODUCTION, FOR ANYONE WHO MAY SEE IT (owner, 14 Nov 2026): what was saved on the Manual Production page for
// one day, clearly.
//
//   [‹] [ 14 Nov 2026 ] [›] [Today]                                         [ ✓ Production added ]
//   [ TOTAL 120.5 DOZEN ] [ All machines 120.5 ✓ ] [ MACHINE 1 40 › ] [ MACHINE 2 60.5 › ]   (MachinePicker)
//                                                                                        [ ⬇ Export PDF ]
//   one card per article: sizes down, colours across, totals per size, per colour and the article's (CartonMatrix)
//
// It only shows: every figure is the main process's (productionDayView), voided entries left out. It follows the
// day as it is saved, and as completed days and entries arrive from other computers.

const text = copy.productionDay;

interface DailyProductionPageProps {
  /** Opens the Manual Production page; absent when this user may not record production. */
  onRecordProduction?: () => void;
}

const DayPicker: React.FC<{ date: string; onChange: (date: string) => void }> = ({ date, onChange }) => {
  const today = toIsoDate();
  return (
    <div className="pd-day-picker">
      <button type="button" className="btn btn-secondary pd-day-step" aria-label={text.previousDay} onClick={() => onChange(shiftIsoDate(date, -1))}>‹</button>
      <label className="pd-day-field">
        <span className="sr-only">{text.dateLabel}</span>
        <input type="date" className="form-input" value={date} max={today} onChange={(event) => { if (event.target.value) onChange(event.target.value); }} />
      </label>
      <button type="button" className="btn btn-secondary pd-day-step" aria-label={text.nextDay} disabled={date >= today} onClick={() => onChange(shiftIsoDate(date, 1))}>›</button>
      <button type="button" className="btn btn-secondary" disabled={date === today} onClick={() => onChange(today)}>{text.today}</button>
    </div>
  );
};

const Production: React.FC<{ day: ProductionDayView }> = ({ day }) => {
  const [view, setView] = useState<string>(ALL_MACHINES);
  const pdf = useProductionPdf();
  const machine = day.machines.find((item) => item.machineName === view);
  const active = machine ? view : ALL_MACHINES;
  return (
    <>
      <div className="pd-kpis">
        <KpiCard className="cs-summary cs-summary--hero pd-kpi" label={text.kpiDozens} value={dozenFigure(day.totalCartons)} />
        <MachinePicker day={day} active={active} onSelect={setView} />
      </div>
      <div role="tabpanel" aria-labelledby={`tab-${active}`} className="pd-panel">
        {/* The PDF is of what is shown: the whole day under All machines, or the machine chosen. */}
        <div className="pd-tabs-row">
          <ProductionPdfButton day={day} machineName={machine ? machine.machineName : null} pdf={pdf} />
        </div>
        <CartonMatrixList articles={machine ? machine.articles : day.articles} tableLabel={text.tableLabel} />
      </div>
    </>
  );
};

export const DailyProductionPage: React.FC<DailyProductionPageProps> = ({ onRecordProduction }) => {
  const day = useProductionDay();
  const isToday = day.date === toIsoDate();
  const shown = day.value && day.value.date === day.date ? day.value : null;

  const body = () => {
    if (day.error && !shown) return <StateView kind="error" title={text.failed} message={day.error} onRetry={() => void day.reload()} />;
    if (!shown) return <StateView kind="loading" message={text.loading} />;
    if (shown.machines.length === 0) {
      const action = isToday && onRecordProduction ? { label: text.recordProduction, onClick: onRecordProduction } : undefined;
      return <StateView kind="empty" title={text.emptyTitle} hint={isToday ? text.emptyHintToday : text.emptyHintPast} action={action} />;
    }
    return (
      <Production key={shown.date} day={shown} />
    );
  };

  return (
    <div className="page-stack carton-stock-page pd-page">
      <div className="cs-panel pd-panel-main">
        <div className="pd-head">
          <div className="pd-head-day">
            <DayPicker date={day.date} onChange={day.setDate} />
            <span className="pd-day-name">{formatLongDate(day.date)}</span>
          </div>
          <ProductionStatusBox mark={shown?.completed ?? null} loading={!shown && !day.error} error={shown ? null : day.error} eyebrow={isToday ? undefined : text.dayStatusLabel(formatLongDate(day.date))} />
        </div>
        {body()}
      </div>
    </div>
  );
};
