import React, { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import type { InventoryStockEventRow, ItemUnitLadder, RawMaterialMovementConfigRow, WorkSection } from "../../types/desktopApi";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { formatDateTime } from "../../utils/dates";
import { formatWholeMoney } from "../../app/format";
import { StockUnitPicker } from "./StockUnitPicker";
import { StockCorrectionPanel } from "./StockCorrectionPanel";
import { DeleteMaterialSection } from "./DeleteMaterialSection";
import { MoveMaterialSection } from "./MoveMaterialSection";
import { UnitLadderSection } from "./UnitLadderSection";
import { downloadCsv, exportFileName } from "../../utils/exportFile";
import { buildMovementSheet } from "./rawMaterialExports";
import { colorValueInUrdu } from "../../utils/urdu";
import {
  STOCK_EVENT_LABELS,
  formatQuantity,
  isColorFieldLabel,
  itemCategoryLabel,
  packCountLabel,
  packetsInStore,
  type CategoryRow,
  type InventoryItemRow,
} from "./rawMaterial";

// Everything about one material, beside the list it was found in. This replaces the trips to
// "Raw Material Packing" (a whole page) and answers a question that had no screen at all:
// how did this material get to the quantity it is showing?
//
// The history is read from inventory_stock_events — the ledger every writer of
// inventory_stock_balances appends to in the same transaction. Nothing here recalculates a
// balance; it only reads and formats what the data layer holds.

const HISTORY_LIMIT = 25;

interface MaterialDrawerProps {
  item: InventoryItemRow;
  config: RawMaterialMovementConfigRow | undefined;
  units: Array<Record<string, unknown>>;
  sections: WorkSection[];
  /** Administrators approve corrections; everyone else sends them for approval. */
  isAdmin: boolean;
  /** The whole tree, so this material can be filed somewhere else. */
  categories: CategoryRow[];
  onClose: () => void;
  /** Re-reads the list after stock, price, packing or route changed. */
  onChanged: () => Promise<void>;
  /** Re-reads packing/route lookups. */
  onLookupsChanged: () => Promise<void>;
  /** Opens the Labels tab with this material already chosen. */
  onGenerateLabels: (itemId: string) => void;
}

export const MaterialDrawer: React.FC<MaterialDrawerProps> = ({
  item,
  config,
  units,
  sections,
  isAdmin,
  categories,
  onClose,
  onChanged,
  onLookupsChanged,
  onGenerateLabels,
}) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const id = String(item.id);

  // This material's own ladder of units. The drawer holds it because two sections speak in
  // those units — the correction box takes a count in them, and the ladder section edits them
  // — and both must be looking at the same chain.
  const [ladder, setLadder] = useState<ItemUnitLadder | null>(null);
  const loadLadder = useCallback(async () => {
    const result = await api.getInventoryItemUnitLadder(id);
    setLadder(result.accepted ? (result.ladder ?? null) : null);
  }, [api, id]);
  useEffect(() => {
    void loadLadder();
  }, [loadLadder]);
  const displayName = String(item.display_name);
  const attributes = Array.isArray(item.values) ? (item.values as Array<Record<string, unknown>>) : [];
  const categoryName = itemCategoryLabel(item);

  const [events, setEvents] = useState<InventoryStockEventRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [price, setPrice] = useState(item.cost_price == null ? "" : String(item.cost_price));
  const [savingPrice, setSavingPrice] = useState(false);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      setEvents(await api.listInventoryStockEvents(id, HISTORY_LIMIT));
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : copy.states.loadFailedBody);
    } finally {
      setHistoryLoading(false);
    }
  }, [api, id]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [onClose]);

  const savePrice = async () => {
    setSavingPrice(true);
    try {
      const result = await api.updateInventoryItemPrice(id, price.trim() === "" ? null : Number(price));
      if (!result.accepted) {
        push("error", "Price not changed", result.reason ?? "The cost price could not be updated.");
        return;
      }
      push("success", "Cost price updated", displayName);
      await onChanged();
    } finally {
      setSavingPrice(false);
    }
  };

  const onHand = Number(item.quantity_on_hand ?? 0);
  const packs = packetsInStore(config);
  // Nothing recorded in this material's unit yet, so it can still be set or corrected. The data
  // layer checks the same thing (balance, movements, labels) and refuses otherwise.
  const unitStillOpen = !item.unit_code || (onHand === 0 && !historyLoading && events.length === 0);

  return createPortal(
    <div
      className="member-modal-backdrop qrm-drawer-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside className="qrm-drawer rm-drawer" role="dialog" aria-modal="true" aria-label={`${displayName} details`}>
        <div className="qrm-drawer-head">
          <div className="qrm-drawer-title-wrap">
            <span className="section-label">{categoryName || "Raw material"}</span>
            <h2 className="rm-drawer-title">{displayName}</h2>
            <span className="cell-mono rm-drawer-code">{String(item.item_code)}</span>
          </div>
          <button type="button" className="member-modal-close" aria-label={copy.common.close} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="rm-drawer-body">
          {/* ── Stock unit, while it can still be set ───────────────── */}
          {unitStillOpen ? (
            <section className="rm-drawer-section">
              {!item.unit_code ? (
                <p className="qr-error">⚠ No stock unit yet — set it before receiving or printing labels.</p>
              ) : null}
              <StockUnitPicker
                itemId={id}
                displayName={displayName}
                units={units}
                currentUnitId={item.default_unit_id ? String(item.default_unit_id) : null}
                onSaved={async () => {
                  await Promise.all([onChanged(), onLookupsChanged()]);
                }}
              />
            </section>
          ) : null}

          {/* ── Stock on hand + adjust ─────────────────────────────── */}
          <section className="rm-drawer-section">
            <div className="rm-drawer-stock">
              <div>
                <span className="section-label">In store</span>
                {packs == null ? (
                  <strong className="rm-drawer-qty">
                    {formatQuantity(onHand)}
                    <span className="rm-stock-unit">{String(item.unit_code ?? "")}</span>
                  </strong>
                ) : (
                  <>
                    <strong className="rm-drawer-qty">{packCountLabel(packs, config)}</strong>
                    <span className="rm-drawer-qty-sub">
                      that is {formatQuantity(onHand)} {String(item.unit_code ?? "")}
                    </span>
                  </>
                )}
              </div>
              <div>
                <span className="section-label">Cost price</span>
                <div className="rm-drawer-price">
                  <input
                    className="form-input"
                    type="number"
                    step="any"
                    aria-label={`Cost price for ${displayName}`}
                    value={price}
                    placeholder="—"
                    onChange={(event) => setPrice(event.target.value)}
                  />
                  <button type="button" className="btn btn-secondary btn-sm" disabled={savingPrice} onClick={() => void savePrice()}>
                    {savingPrice ? "Saving…" : copy.common.save}
                  </button>
                </div>
              </div>
            </div>

            <StockCorrectionPanel
              itemId={id}
              displayName={displayName}
              unitCode={String(item.unit_code ?? "")}
              isAdmin={isAdmin}
              ladder={ladder}
              onStockChanged={async () => {
                await Promise.all([onChanged(), loadHistory()]);
              }}
            />
          </section>

          {/* ── Attributes ─────────────────────────────────────────── */}
          <section className="rm-drawer-section">
            <h3 className="rm-drawer-heading">What tells it apart</h3>
            {attributes.length === 0 ? (
              <p className="field-help">This material has no attributes.</p>
            ) : (
              <dl className="rm-attr-list">
                {attributes.map((value) => {
                  // The exact Urdu this material's label prints: a manual correction if one
                  // was entered, otherwise the same automatic translation materialLabelAttributes uses.
                  const englishValue = String(value.text_value ?? value.number_value ?? "");
                  const urdu = isColorFieldLabel(String(value.label))
                    ? value.text_value_urdu
                      ? String(value.text_value_urdu)
                      : colorValueInUrdu(englishValue)
                    : "";
                  return (
                    <div key={String(value.field_key)} className="rm-attr-row">
                      <dt>{String(value.label)}</dt>
                      <dd>
                        {String(value.text_value ?? value.number_value ?? "—")}
                        {urdu ? <span className="rm-attr-urdu" dir="rtl" lang="ur"> · {urdu}</span> : null}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            )}
            <p className="field-help">
              These make up the material's identity, so they cannot be edited — a different combination is a different material.
            </p>
          </section>

          {/* ── Labels ─────────────────────────────────────────────── */}
          <section className="rm-drawer-section">
            <h3 className="rm-drawer-heading">Labels</h3>
            <p className="field-help">
              Set the pack above before printing labels — one label goes on one pack, and is stamped with what it holds.
            </p>
            <button type="button" className="btn btn-secondary" onClick={() => onGenerateLabels(id)}>
              Generate labels for this material →
            </button>
          </section>

          {/* ── Movement history ───────────────────────────────────── */}
          <section className="rm-drawer-section">
            <div className="rm-drawer-heading-row">
              <h3 className="rm-drawer-heading">Movement history</h3>
              {events.length > 0 ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => downloadCsv(exportFileName(`movements-${String(item.item_code ?? "material")}`), buildMovementSheet(item, events))}
                >
                  Export (Excel)
                </button>
              ) : null}
            </div>
            {historyLoading ? (
              <StateView kind="loading" compact message="Loading movements…" />
            ) : historyError ? (
              <StateView kind="error" compact message={historyError} onRetry={() => void loadHistory()} />
            ) : events.length === 0 ? (
              <StateView
                kind="empty"
                compact
                title="No movements yet"
                hint="Stock moves when a packet is scanned in or out, or when a count is corrected."
              />
            ) : (
              <table className="data-table rm-history-table">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">What</th>
                    <th scope="col" className="rm-num">Change</th>
                    <th scope="col">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.id}>
                      <td>{formatDateTime(event.createdAt)}</td>
                      <td>{STOCK_EVENT_LABELS[event.eventType] ?? event.eventType}</td>
                      <td className="rm-num">
                        <span className={event.quantity < 0 ? "rm-qty-out" : "rm-qty-in"}>
                          {event.quantity > 0 ? "+" : ""}
                          {formatQuantity(event.quantity)}
                        </span>
                        <span className="rm-stock-unit">{event.unitCode ?? ""}</span>
                      </td>
                      <td className="rm-history-note">
                        {event.note ?? "—"}
                        {event.createdBy ? <span className="rm-history-by">{event.createdBy}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {events.length >= HISTORY_LIMIT ? (
              <p className="field-help">Showing the last {HISTORY_LIMIT} movements.</p>
            ) : null}
          </section>

          <UnitLadderSection
            itemId={id}
            units={units}
            onHand={onHand}
            onChanged={async () => {
              await loadLadder();
              await onChanged();
            }}
          />

          <MoveMaterialSection
            itemId={id}
            displayName={String(item.display_name ?? "")}
            categoryId={String(item.category_id ?? "")}
            categories={categories}
            onChanged={onChanged}
          />

          <DeleteMaterialSection
            itemId={id}
            displayName={String(item.display_name ?? "")}
            disabled={String(item.status ?? "ACTIVE") === "INACTIVE"}
            isAdmin={isAdmin}
            onDeleted={onClose}
            onChanged={onChanged}
          />

          {item.cost_price != null ? (
            <p className="field-help rm-drawer-footnote">
              Stock at cost: Rs. {formatWholeMoney(onHand * Number(item.cost_price))}
            </p>
          ) : null}
        </div>
      </aside>
    </div>,
    document.body
  );
};
