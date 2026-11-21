import { useCallback, useEffect, useState } from "react";
import { businessDayStartIso } from "@erp/domain";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import type { RawMaterialQrBatchRow } from "../../types/desktopApi";
import { copy } from "../../config/copy";
import { toIsoDate } from "../../utils/dates";

// The label runs the Labels tab lists under "Recent generations": the last few by default, and
// on "See all" every run registered today (Asia/Karachi), so a busy day's earlier runs can be
// found, reprinted or erased without going to QR Management.

const RECENT_HISTORY_LIMIT = 10;
/** A ceiling, not a page: no store registers anywhere near this many runs in one day. */
const TODAY_HISTORY_LIMIT = 1000;

export const useLabelRunHistory = () => {
  const api = useDesktopApi();
  const [recent, setRecent] = useState<RawMaterialQrBatchRow[]>([]);
  const [today, setToday] = useState<RawMaterialQrBatchRow[]>([]);
  const [showAllToday, setShowAllToday] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sinceIso = businessDayStartIso(toIsoDate());
      const [recentRows, todayRows] = await Promise.all([
        api.listRawMaterialQrBatches({ limit: RECENT_HISTORY_LIMIT }),
        sinceIso ? api.listRawMaterialQrBatches({ sinceIso, limit: TODAY_HISTORY_LIMIT }) : Promise.resolve([]),
      ]);
      setRecent(recentRows);
      setToday(todayRows);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : copy.states.loadFailedBody);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Both lists are newest first, so today's runs beyond the recent few are the only ones hidden.
  const hasMoreToday = today.length > recent.length;
  const showingToday = showAllToday && hasMoreToday;

  return {
    history: showingToday ? today : recent,
    todayCount: today.length,
    hasMoreToday,
    showingToday,
    setShowAllToday,
    loading,
    error,
    reload,
  };
};
