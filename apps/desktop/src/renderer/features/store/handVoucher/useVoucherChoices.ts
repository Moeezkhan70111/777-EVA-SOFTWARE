import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STORE_DIRECTION, isRawMaterialIssuePartyType, isRawMaterialReceiptPartyType, type StoreDirection } from "@erp/domain";
import { useDesktopApi } from "../../../hooks/useDesktopApi";
import type { Party, RawMaterialHandMoveOptions } from "../../../types/desktopApi";
import { copy } from "../../../config/copy";
import { partyOption } from "../../parties/partyOption";
import { materialPickerOption, type InventoryItemRow } from "../../rawMaterial/rawMaterial";

// What a store hand voucher can be written with: its parties (suppliers moving in, suppliers and contractors moving
// out), the raw materials, and — read once per material, the
// first time a line names it — the units that material is counted in. Every figure is the data layer's.

/** Who a voucher of this direction may name. */
const partyFits = (direction: StoreDirection) => (direction === STORE_DIRECTION.OUT ? isRawMaterialIssuePartyType : isRawMaterialReceiptPartyType);

export const useVoucherChoices = (token: string, direction: StoreDirection) => {
  const api = useDesktopApi();
  const [items, setItems] = useState<InventoryItemRow[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [units, setUnits] = useState<ReadonlyMap<string, RawMaterialHandMoveOptions>>(new Map());
  const asked = useRef(new Set<string>());

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [materials, partyPage] = await Promise.all([api.listInventoryItems({}), api.listParties({ pageSize: 1000 })]);
      setItems(materials);
      setParties(partyPage.rows.filter((party) => partyFits(direction)(party.partyType)));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : copy.states.loadFailedBody);
    } finally {
      setLoading(false);
    }
  }, [api, direction]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Reads a material's units the first time it is needed. Resolves with them, or undefined when unreadable. */
  const loadUnits = useCallback(
    async (itemId: string): Promise<RawMaterialHandMoveOptions | undefined> => {
      if (!itemId || asked.current.has(itemId)) return units.get(itemId);
      asked.current.add(itemId);
      try {
        // Read for this direction: moving out, it says what is in the store and whether labelled packets block it.
        const options = await api.getRawMaterialHandMoveOptions(itemId, direction, { token });
        if (options) setUnits((current) => new Map(current).set(itemId, options));
        return options ?? undefined;
      } catch {
        asked.current.delete(itemId);
        return undefined;
      }
    },
    [api, direction, token, units]
  );

  const itemOptions = useMemo(() => items.filter((item) => item.id && item.display_name).map(materialPickerOption), [items]);
  const partyOptions = useMemo(() => parties.map(partyOption), [parties]);
  const optionsFor = useCallback((itemId: string) => units.get(itemId), [units]);

  return { loading, loadError, reload, itemOptions, partyOptions, parties, optionsFor, loadUnits };
};

export type VoucherChoices = ReturnType<typeof useVoucherChoices>;
