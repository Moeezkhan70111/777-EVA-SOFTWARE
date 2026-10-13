import type { StoreDailyReport, StoreDirection } from "@erp/domain";
import { useDesktopApi } from "../../../hooks/useDesktopApi";
import { useLoaded, type Loaded } from "../../../hooks/useLoaded";

// The daily report's one read. The main process gathers the day and counts it (@erp/domain
// storeDailyReport.ts); nothing is added up here.

export const useStoreDailyReport = (token: string, direction: StoreDirection, date: string): Loaded<StoreDailyReport | null> => {
  const api = useDesktopApi();
  return useLoaded(
    `store-daily-report:${direction}:${date}`,
    date ? () => api.getStoreDailyReport({ date, direction, token: token || undefined }) : null,
    (answer) => answer.report ?? null,
    null
  );
};
