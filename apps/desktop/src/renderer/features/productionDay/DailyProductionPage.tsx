import React, { useEffect, useState } from "react";
import type { ProductionDayView } from "@erp/domain";
import { KpiCard } from "../../components/dashboard/KpiCard";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { useElementWidth } from "../../hooks/useElementWidth";
import { BENTO_GAP_PX, bentoLayout } from "../../utils/bentoLayout";
import { formatLongDate, formatShortWeekday, shiftIsoDate, toIsoDate } from "../../utils/dates";
import { dozenFigure } from "../cartonStock/CartonMatrix";
import { CartonMatrixList } from "../cartonStock/CartonMatrixList";
import { changeFromDayBefore, topArticle, type WeekDay } from "./dayInsights";
import { ALL_MACHINES, MachinePicker } from "./MachinePicker";
import { ProductionPdfButton } from "./ProductionPdfButton";
import { ProductionStatusBox } from "./ProductionStatusBox";
import { useProductionDay, useProductionWeek } from "./useProductionDay";
import { useProductionPdf } from "./useProductionPdf";
import { WeekStrip } from "./WeekStrip";

// DAILY PRODUCTION, FOR ANYONE WHO MAY SEE IT (owner, 14 Nov 2026), and the UI/UX pass (25 Nov 2026: "too boring"):
//
//   [‹] [ 25 Nov 2026 ] [›] [Today]   Wednesday, 25 November 2026          [ ✓ Production added ] [ ⬇ Export PDF ]
//   THE LAST 7 DAYS   ▁ ▃ ▅ ▂ ▇ ▆ █   each day a button: its dozens, a bar against the week's best, ✓ when added
//   [ TOTAL 39 dozen  ↑ 8 on Tue ] [ TOP ARTICLE SK46 · 16 dozen · 41% ] [ All machines ][ MACHINE 1 ▬▬ 59% ] …
//   the articles, as a bento grid of Size × Colour cards (CartonMatrix), every row filled edge to edge
//
// It only shows: every figure is the main process's (productionDayView), voided entries left out. The week, the
// change from the day before, the top article and the machines' shares are plain sums of those figures
// (dayInsights.ts). It follows the day as it is saved, and as completed days and entries arrive from other computers.

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

/** The total, and how it compares with the day before (in words, with an arrow). */
const TotalTile: React.FC<{ day: ProductionDayView; week: readonly WeekDay[] }> = ({ day, week }) => {
  const change = changeFromDayBefore(week, day.date);
  const before = formatShortWeekday(shiftIsoDate(day.date, -1));
  const sub = change === null ? text.dayFacts(day.articles.length, day.machines.length)
    : change === 0 ? text.sameAsDay(before)
      : text.vsDay(`${change > 0 ? "↑ +" : "↓ −"}${dozenFigure(Math.abs(change))}`, before);
  return <KpiCard className="cs-summary cs-summary--hero pd-kpi" label={text.kpiDozens} value={dozenFigure(day.totalCartons)} sub={sub} />;
};

const TopArticleTile: React.FC<{ day: ProductionDayView }> = ({ day }) => {
  const top = topArticle(day);
  if (!top) return null;
  return (
    <div className="pd-tile">
      <span className="pd-tile-label">{text.topArticle}</span>
      <strong className="pd-tile-value">{top.article}</strong>
      <span className="pd-tile-sub">{text.machineDozens(dozenFigure(top.cartons))} · {text.topArticleShare(top.share)}</span>
    </div>
  );
};

/** The articles as a bento grid: each card as wide as its colours need, every row filled (bentoLayout). */
const ArticleBento: React.FC<{ articles: ProductionDayView["articles"] }> = ({ articles }) => {
  const [gridRef, width] = useElementWidth<HTMLDivElement>();
  const spans = bentoLayout(articles.map((article) => article.colours.length), width, BENTO_GAP_PX);
  return (
    <div ref={gridRef} className="pd-articles">
      {articles.map((article, index) => (
        <div key={article.key} className="pd-article-cell" style={{ gridColumn: `span ${String(spans[index] ?? 12)}` }}>
          <CartonMatrixList articles={[article]} tableLabel={text.tableLabel} />
        </div>
      ))}
    </div>
  );
};

export const DailyProductionPage: React.FC<DailyProductionPageProps> = ({ onRecordProduction }) => {
  const day = useProductionDay();
  const isToday = day.date === toIsoDate();
  const shown = day.value && day.value.date === day.date ? day.value : null;
  const week = useProductionWeek(day.date, shown?.totalCartons ?? null);
  const pdf = useProductionPdf();
  const [view, setView] = useState<string>(ALL_MACHINES);
  useEffect(() => { setView(ALL_MACHINES); }, [day.date]);
  const machine = shown?.machines.find((item) => item.machineName === view);
  const active = machine ? view : ALL_MACHINES;

  const body = () => {
    if (day.error && !shown) return <StateView kind="error" title={text.failed} message={day.error} onRetry={() => void day.reload()} />;
    if (!shown) return <StateView kind="loading" message={text.loading} />;
    if (shown.machines.length === 0) {
      const action = isToday && onRecordProduction ? { label: text.recordProduction, onClick: onRecordProduction } : undefined;
      return <StateView kind="empty" title={text.emptyTitle} hint={isToday ? text.emptyHintToday : text.emptyHintPast} action={action} />;
    }
    return (
      <>
        <div className="pd-overview">
          <TotalTile day={shown} week={week.days} />
          <TopArticleTile day={shown} />
          <MachinePicker day={shown} active={active} onSelect={setView} />
        </div>
        <div role="tabpanel" aria-labelledby={`tab-${active}`} className="pd-panel">
          <ArticleBento articles={machine ? machine.articles : shown.articles} />
        </div>
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
          <div className="pd-head-actions">
            <ProductionStatusBox mark={shown?.completed ?? null} loading={!shown && !day.error} error={shown ? null : day.error} eyebrow={isToday ? undefined : text.dayStatusLabel(formatLongDate(day.date))} />
            {/* The PDF is of what is shown: the whole day under All machines, or the machine chosen. */}
            {shown && shown.machines.length > 0 ? <ProductionPdfButton day={shown} machineName={machine ? machine.machineName : null} pdf={pdf} /> : null}
          </div>
        </div>
        <WeekStrip days={week.days} loading={week.loading} selected={day.date} onSelect={day.setDate} />
        {body()}
      </div>
    </div>
  );
};
