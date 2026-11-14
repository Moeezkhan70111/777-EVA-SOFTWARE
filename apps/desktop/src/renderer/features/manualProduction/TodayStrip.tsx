import React, { useState } from "react";
import type { ProductionDayMark } from "@erp/domain";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import type { PolledRead } from "../../hooks/usePolledRead";
import { leaseRefusalText } from "../../../shared/leaseRefusal";
import { formatLongDate } from "../../utils/dates";
import { parseCompleteReply } from "../productionDay/productionDayReply";
import { ProductionStatusBox } from "../productionDay/ProductionStatusBox";
import { dozensText } from "./manualProductionDraft";

// TODAY, ACROSS THE TOP OF THE PAGE: what is saved so far, whether the day is complete, and "Complete today's
// production" (owner, 14 Nov 2026). Completing asks first, and is refused here while lines are still waiting in
// the list: they would be left out of a day that says it is all in. The main process refuses a day with nothing
// saved, and decides which day "today" is.

const text = copy.manualProductionPage;

interface TodayStripProps {
  today: PolledRead<{ date: string; mark: ProductionDayMark | null }>;
  savedCartons: number | null;
  savedEntries: number;
  unsavedLines: number;
  onOpenDaily?: () => void;
}

/** Why the day cannot be completed yet, or null. Lines still in the list would be left out of it. */
const whyNotYet = (unsavedLines: number, savedCartons: number | null): string | null => {
  if (unsavedLines > 0) return text.completeUnsaved(unsavedLines);
  if (!savedCartons) return text.completeNothing;
  return null;
};

export const TodayStrip: React.FC<TodayStripProps> = ({ today, savedCartons, savedEntries, unsavedLines, onOpenDaily }) => {
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
    <section className="mnp-today" aria-label={text.todayLabel}>
      <div className="mnp-today-figures">
        <span className="mnp-today-label">{text.todayLabel}{date ? ` · ${formatLongDate(date)}` : ""}</span>
        <strong className="mnp-today-value">{savedCartons === null ? copy.common.none : text.todaySaved(dozensText(savedCartons), savedEntries)}</strong>
        {onOpenDaily ? <button type="button" className="btn btn-ghost btn-sm mnp-today-link" onClick={onOpenDaily}>{text.openDaily} →</button> : null}
      </div>
      <ProductionStatusBox mark={mark} loading={today.loading} error={today.error} />
      {mark ? null : (
        <div className="mnp-complete">
          <button type="button" className="btn btn-success mnp-complete-btn" disabled={blocked !== null || today.loading} onClick={() => setConfirming(true)}
            aria-describedby={blocked ? "mnp-complete-why" : undefined}>
            ✓ {text.completeButton}
          </button>
          {blocked ? <span id="mnp-complete-why" className="mnp-note">{blocked}</span> : null}
        </div>
      )}
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
