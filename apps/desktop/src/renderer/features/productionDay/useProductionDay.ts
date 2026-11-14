import { useCallback, useState } from "react";
import type { ProductionDayMark, ProductionDayView } from "@erp/domain";
import { copy } from "../../config/copy";
import { useDataChanged } from "../../hooks/useDataChanged";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { usePolledRead, type PolledRead } from "../../hooks/usePolledRead";
import { DATA_KIND } from "../../../shared/dataChange";
import { toIsoDate } from "../../utils/dates";
import { parseDayReply, parseMarkReply } from "./productionDayReply";

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
