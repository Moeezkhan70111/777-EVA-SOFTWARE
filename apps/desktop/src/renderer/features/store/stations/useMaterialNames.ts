import { useCallback, useEffect, useState } from "react";
import { useDesktopApi } from "../../../hooks/useDesktopApi";
import { categoryPath, type CategoryRow } from "../../rawMaterial/rawMaterial";
import { splitMaterialName, type MaterialName } from "./materialName";

/**
 * Splits material names by the store's category paths (materialName.ts). The categories are read
 * once; until they arrive, or if they cannot be read, a name is still shown whole, with middle dots —
 * a scan is never held up for them.
 */
export const useMaterialNames = (): ((displayName: string) => MaterialName) => {
  const api = useDesktopApi();
  const [paths, setPaths] = useState<string[]>([]);

  useEffect(() => {
    if (typeof api.listInventoryCategories !== "function") return;
    let cancelled = false;
    api
      .listInventoryCategories()
      .then((rows) => {
        if (!cancelled) setPaths((rows as CategoryRow[]).map(categoryPath).filter(Boolean));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  return useCallback((displayName: string) => splitMaterialName(displayName, paths), [paths]);
};
