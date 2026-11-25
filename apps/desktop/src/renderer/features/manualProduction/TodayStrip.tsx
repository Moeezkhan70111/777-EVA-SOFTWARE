import React, { useState } from "react";
import type { ProductionDayMark } from "@erp/domain";
import { KpiCard } from "../../components/dashboard/KpiCard";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import type { PolledRead } from "../../hooks/usePolledRead";
import { leaseRefusalText } from "../../../shared/leaseRefusal";
import { formatDayMonth, formatLongDate } from "../../utils/dates";
import { parseCompleteReply } from "../productionDay/productionDayReply";
import { ProductionStatusBox } from "../productionDay/ProductionStatusBox";
import type { DayProgress } from "./dayProgress";
import { dozensText } from "./manualProductionDraft";

// TODAY, ACROSS THE TOP OF THE PAGE, as three tiles in the Dashboard cards' look (owner, 25 Nov 2026: "too cluttered",
// so the same row as Carton Stock):
//
//   ┌ SAVED TODAY · 25 Nov ┐ ┌ MACHINES IN ──────── 1 / 3 ┐ ┌ [ ✓ Complete today's production ] ┐
//   │ 12 dozen  (blue)     │ │ ███████░░░░░░░             │ │  why not yet, or Production added │
//   └ 4 entries ───────────┘ └ Still to add: MACHINE 2 ───┘ └ Open Daily Production → ──────────┘
//
// Completing asks first, and is refused here while lines are still waiting in the list: they would be left out of a
// day that says it is all in. The main process refuses a day with nothing saved, and decides which day "today" is.
// The button keeps its id, so the list below can bring the operator back to it once every machine is in.

const text = copy.manualProductionPage;

interface TodayStripProps {
  today: PolledRead<{ date: string; mark: ProductionDayMark | null }>;
  savedCartons: number | null;
  savedEntries: number;
  unsavedLines: number;
  onOpenDaily?: () => void;
  /** Which machines have production saved today; null until both are read. */
  progress: DayProgress | null;
}

export const COMPLETE_BUTTON_ID = "mnp-complete-btn";

/** Daily Production's mark: three bars, as on its week strip. */
const ChartIcon: React.FC = () => (
  <span className="mnp-daily-link-icon" aria-hidden="true">
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 16V10M10 16V5M16 16v-8M3 17h14" /></svg>
  </span>
);

/** Why the day cannot be completed yet, or null. Lines still in the list would be left out of it. */
const whyNotYet = (unsavedLines: number, savedCartons: number | null): string | null => {
  if (unsavedLines > 0) return text.completeUnsaved(unsavedLines);
  if (!savedCartons) return text.completeNothing;
  return null;
};

const MachinesTile: React.FC<{ progress: DayProgress | null }> = ({ progress }) => {
  const total = progress ? progress.done.length + progress.missing.length : 0;
  const done = progress?.done.length ?? 0;
  const figure = text.progressFigure(done, total);
  return (
    <div className="mnp-tile mnp-machines-tile">
      <span className="mnp-tile-label">{text.progressLabel}</span>
      <strong className="mnp-tile-value">{done} / {total}</strong>
      <div className="mnp-progress-meter" role="meter" aria-label={text.progressLabel} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-valuetext={figure}>
        <span style={{ inlineSize: `${String(total ? Math.round((done / total) * 100) : 0)}%` }} />
      </div>
      {progress && total > 0 ? (
        <small className={progress.missing.length === 0 ? "mnp-progress-note is-done" : "mnp-progress-note"}>
          {progress.missing.length === 0 ? text.progressAllIn : text.progressMissing(progress.missing.map((machine) => machine.name).join(", "))}
        </small>
      ) : null}
    </div>
  );
};

export const TodayStrip: React.FC<TodayStripProps> = ({ today, savedCartons, savedEntries, unsavedLines, onOpenDaily, progress }) => {
  const api = useDesktopApi();
  const [confirming, setConfirming] = useState(false);
  const mark = today.value?.mark ?? null;
  const date = today.value?.date ?? "";
  const blocked = whyNotYet(unsavedLines, savedCartons);

  const complete = async (): Promise<string | null> => {
    try {
      const parsed = parseCompleteReply(await api.completeProductionDay(), text.completeUnreachable);
      if (!parsed.ok) return parsed.reason;
      await today.reload();
      return null;
    } catch (error) {
      return leaseRefusalText(error) ?? text.completeUnreachable;
    }
  };

  return (
    <section className="mnp-overview" aria-label={text.todayLabel}>
      <KpiCard className="cs-summary cs-summary--hero" label={text.savedTodayLabel(date ? formatDayMonth(date) : "")}
        value={savedCartons === null ? copy.common.none : text.savedTodayValue(dozensText(savedCartons))} sub={text.savedTodayEntries(savedEntries)} />
      <MachinesTile progress={progress} />
      <div className="mnp-tile mnp-complete-tile">
        {mark ? <ProductionStatusBox variant="card" mark={mark} loading={today.loading} error={today.error} /> : (
          <>
            <button type="button" id={COMPLETE_BUTTON_ID} className="btn btn-success mnp-complete-btn" disabled={blocked !== null || today.loading} onClick={() => setConfirming(true)}
              aria-describedby={blocked ? "mnp-complete-why" : undefined}>
              ✓ {text.completeButton}
            </button>
            {blocked ? <span id="mnp-complete-why" className="mnp-note">{blocked}</span> : null}
          </>
        )}
        {onOpenDaily ? (
          <button type="button" className="mnp-daily-link" onClick={onOpenDaily}>
            <ChartIcon />
            <span>{text.openDaily}</span>
            <span className="mnp-daily-link-arrow" aria-hidden="true">→</span>
          </button>
        ) : null}
      </div>
      {confirming ? (
        <ConfirmDialog
          title={text.completeTitle}
          facts={[
            { label: text.factDate, value: formatLongDate(date) },
            { label: text.factSavedToday, value: text.todaySaved(dozensText(savedCartons ?? 0), savedEntries) },
          ]}
          explain={text.completeExplain}
          warning={text.completeWarning}
          confirmLabel={text.completeButton}
          busyLabel={text.completing}
          tone="primary"
          onConfirm={complete}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </section>
  );
};
