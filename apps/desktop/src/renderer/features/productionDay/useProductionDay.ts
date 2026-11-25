import { useCallback, useEffect, useState } from "react";
import type { ProductionDayMark, ProductionDayView } from "@erp/domain";
import { copy } from "../../config/copy";
import { useDataChanged } from "../../hooks/useDataChanged";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { usePolledRead, type PolledRead } from "../../hooks/usePolledRead";
import { DATA_KIND } from "../../../shared/dataChange";
import { toIsoDate } from "../../utils/dates";
import { parseDayReply, parseMarkReply } from "./productionDayReply";
import { weekDates, type WeekDay } from "./dayInsights";

// The production day's reads (docs/48), kept current (usePolledRead): on open, every POLL_MS while the window is
// visible, and at once when sync brings carton data from another computer (a completed day travels as CARTONS).
// Today is read from the clock on each read, so a screen left open past midnight moves on to the new day.

const POLL_MS = 30_000;
const CHANGES = [DATA_KIND.CARTONS] as const;
const text = copy.productionDay;

/** Whether today is marked complete: Carton Stock's status box, the Manual Production page's strip. */
export const useTodayMark = (): PolledRead<{ date: string; mark: ProductionDayMark | null }> => {
  const api = useDesktopApi();
  const read = useCallback(async () => {
    const date = toIsoDate();
    const parsed = parseMarkReply(await api.getProductionDayMark({ date }), text.unknown);
    return parsed.ok ? { accepted: true as const, value: { date, mark: parsed.value } } : { accepted: false as const, reason: parsed.reason };
  }, [api]);
  const polled = usePolledRead(read, { intervalMs: POLL_MS, failed: text.unknown });
  useDataChanged(CHANGES, () => void polled.reload());
  return polled;
};

/** One day's production, per machine and together: the Daily Production page. */
export const useProductionDay = (): PolledRead<ProductionDayView> & { date: string; setDate: (date: string) => void } => {
  const api = useDesktopApi();
  const [date, setDate] = useState(() => toIsoDate());
  const read = useCallback(async () => {
    const parsed = parseDayReply(await api.getProductionDay({ date }), text.failed);
    return parsed.ok ? { accepted: true as const, value: parsed.value } : { accepted: false as const, reason: parsed.reason };
  }, [api, date]);
  const polled = usePolledRead(read, { intervalMs: POLL_MS, failed: text.failed });
  useDataChanged(CHANGES, () => void polled.reload());
  return { ...polled, date, setDate };
};

/**
 * The seven days ending on `endDate`, each one's total and whether it was completed: the week strip on the Daily
 * Production page (owner, 25 Nov 2026). Read again when the day shown changes (`refresh`: its total) and when sync
 * brings carton data, so the strip follows the day. A day that cannot be read shows no figure; nothing else waits on it.
 */
export const useProductionWeek = (endDate: string, refresh: number | null): { days: WeekDay[]; loading: boolean } => {
  const api = useDesktopApi();
  const [days, setDays] = useState<WeekDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [reads, setReads] = useState(0);
  useDataChanged(CHANGES, () => setReads((count) => count + 1));
  useEffect(() => {
    let current = true;
    setLoading(true);
    void Promise.all(weekDates(endDate).map(async (date): Promise<WeekDay> => {
      try {
        const parsed = parseDayReply(await api.getProductionDay({ date }), text.failed);
        return parsed.ok ? { date, cartons: parsed.value.totalCartons, complete: parsed.value.completed !== null } : { date, cartons: null, complete: false };
      } catch {
        return { date, cartons: null, complete: false };
      }
    })).then((week) => {
      if (!current) return;
      setDays(week);
      setLoading(false);
    });
    return () => { current = false; };
  }, [api, endDate, refresh, reads]);
  return { days, loading };
};
