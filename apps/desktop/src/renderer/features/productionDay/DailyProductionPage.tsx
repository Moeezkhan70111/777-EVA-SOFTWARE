import React, { useState } from "react";
import type { ProductionDayView } from "@erp/domain";
import { KpiCard } from "../../components/dashboard/KpiCard";
import { StateView } from "../../components/shared/StateView";
import { TabStrip, type TabStripItem } from "../../components/shared/TabStrip";
import { copy } from "../../config/copy";
import { formatLongDate, shiftIsoDate, toIsoDate } from "../../utils/dates";
import { dozenFigure } from "../cartonStock/CartonMatrix";
import { CartonMatrixList } from "../cartonStock/CartonMatrixList";
import { ProductionPdfButton } from "./ProductionPdfButton";
import { ProductionStatusBox } from "./ProductionStatusBox";
import { useProductionDay } from "./useProductionDay";
import { useProductionPdf } from "./useProductionPdf";

// DAILY PRODUCTION, FOR ANYONE WHO MAY SEE IT (owner, 14 Nov 2026): what was saved on the Manual Production page for
// one day, clearly.
//
//   [‹] [ 14 Nov 2026 ] [›] [Today]                                         [ ✓ Production added ]
//   [ TOTAL 120.5 DOZEN ] [ CARTONS 241 ] [ MACHINES 3 ] [ ENTRIES 18 ]
//   [ All machines ] [ MACHINE 1 · 40 ] [ MACHINE 2 · 60.5 ] [ MACHINE 3 · 20 ]
//   one card per article: sizes down, colours across, totals per size, per colour and the article's (CartonMatrix)
//
// It only shows: every figure is the main process's (productionDayView), voided entries left out. It follows the
// day as it is saved, and as completed days and entries arrive from other computers.

const text = copy.productionDay;
const ALL = "all";

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

const Figures: React.FC<{ day: ProductionDayView }> = ({ day }) => (
  <div className="pd-kpis">
    <KpiCard className="cs-summary pd-kpi pd-kpi--main" label={text.kpiDozens} value={dozenFigure(day.totalCartons)} />
    <KpiCard className="cs-summary pd-kpi" label={text.kpiCartons} value={day.totalCartons.toLocaleString()} />
    <KpiCard className="cs-summary pd-kpi" label={text.kpiMachines} value={day.machines.length} />
    <KpiCard className="cs-summary pd-kpi" label={text.kpiEntries} value={day.entries.toLocaleString()} />
  </div>
);

const Production: React.FC<{ day: ProductionDayView }> = ({ day }) => {
  const [view, setView] = useState<string>(ALL);
  const pdf = useProductionPdf();
  const machine = day.machines.find((item) => item.machineName === view);
  const tabs: TabStripItem<string>[] = [
    { id: ALL, label: text.allMachines },
    ...day.machines.map((item) => ({ id: item.machineName, label: text.machineTab(item.machineName, dozenFigure(item.cartons)) })),
  ];
  return (
    <>
      {/* The PDF is of what is shown: the whole day under All machines, or the machine chosen. */}
      <div className="pd-tabs-row">
        <TabStrip items={tabs} active={machine ? view : ALL} onSelect={setView} label={text.viewsLabel} className="pd-tabs" />
        <ProductionPdfButton day={day} machineName={machine ? machine.machineName : null} pdf={pdf} />
      </div>
      <div role="tabpanel" aria-labelledby={`tab-${machine ? view : ALL}`} className="pd-panel">
        {machine ? <p className="pd-machine-line">{text.machineSummary(machine.machineName, dozenFigure(machine.cartons), machine.entries)}</p> : null}
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
      <>
        <Figures day={shown} />
        <Production key={shown.date} day={shown} />
      </>
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
          <ProductionStatusBox mark={shown?.completed ?? null} loading={!shown && !day.error} error={shown ? null : day.error} compact={!isToday} eyebrow={isToday ? text.statusLabel : text.dayStatusLabel(formatLongDate(day.date))} />
        </div>
        {body()}
        <p className="pd-foot-note">{text.scanNote}</p>
      </div>
    </div>
  );
};
