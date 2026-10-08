import { useCallback, useEffect, useMemo, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import type { RawMaterialMovementConfigRow, WorkSection } from "../../types/desktopApi";
import { copy } from "../../config/copy";
import type { CategoryRow } from "./rawMaterial";

// The lookups every Raw Material tab needs: categories (with their attribute fields), units,
// the per-material packing/route configuration and the destinations a packet can be issued to.
//
// Loaded once for the whole workspace instead of once per screen — the four pages this
// workspace replaced each fetched categories and units for themselves, and the Stock and
// Packing screens fetched the same rows twice within seconds of each other.

export interface RawMaterialLookups {
  categories: CategoryRow[];
  units: Array<Record<string, unknown>>;
  /** Packing and route per material, keyed by item id. */
  configByItem: Map<string, RawMaterialMovementConfigRow>;
  sections: WorkSection[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export const useRawMaterialLookups = (): RawMaterialLookups => {
  const api = useDesktopApi();
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [units, setUnits] = useState<Array<Record<string, unknown>>>([]);
  const [configRows, setConfigRows] = useState<RawMaterialMovementConfigRow[]>([]);
  const [sections, setSections] = useState<WorkSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [categoryRows, unitRows, movementRows, sectionRows] = await Promise.all([
        api.listInventoryCategories(),
        api.listInventoryUnits(),
        api.listRawMaterialMovementConfig(""),
        api.listWorkSections(),
      ]);
      setCategories(categoryRows as CategoryRow[]);
      setUnits(unitRows);
      setConfigRows(movementRows);
      setSections(sectionRows);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.states.loadFailedBody);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const configByItem = useMemo(
    () => new Map(configRows.map((row) => [row.itemId, row])),
    [configRows]
  );

  return { categories, units, configByItem, sections, loading, error, reload };
};
