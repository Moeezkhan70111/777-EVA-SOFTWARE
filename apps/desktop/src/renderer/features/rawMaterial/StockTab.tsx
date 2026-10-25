import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import type { RawMaterialMovementConfigRow, StockCorrectionRequest, WorkSection } from "../../types/desktopApi";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { formatWholeMoney } from "../../app/format";
import { AttributeField } from "./AttributeField";
import { MaterialDrawer } from "./MaterialDrawer";
import { NewMaterialModal } from "./NewMaterialModal";
import { ImportMaterialsModal } from "./ImportMaterialsModal";
import { ActionMenu } from "./ActionMenu";
import { useSyncWaiting } from "../sync/useSyncWaiting";
import { incompleteMaterials } from "../sync/syncWaiting";
import { IncompleteMaterials, IncompleteRowMark } from "../sync/IncompleteMaterials";
import { downloadCsv, exportFileName } from "../../utils/exportFile";
import { quantityInBaseUnit } from "@erp/domain";
import type { ItemUnitLadderStep } from "../../types/desktopApi";
import { openReport } from "../../utils/reportDocument";
import { buildMaterialsSheet, buildStockReport } from "./rawMaterialExports";
import {
  formatQuantity,
  identityFields,
  categoryPath,
  descendantsOf,
  topCategories,
  packCountLabel,
  packetsInStore,
  type CategoryRow,
  type InventoryItemRow,
} from "./rawMaterial";

// The Raw Material workspace's home: every material, what is in store, and whether it is set
// up well enough to be scanned. The three screens it replaced (Stock, Add Raw Material,
// Packing) each held one third of this and made the operator navigate between them.
//
// Two columns the old Stock table carried are gone, not lost: display_name is built as
// "CATEGORY — ATTR — ATTR", so separate "Category" and "Attributes" columns were the first
// column printed again. Category survives as the filter it was really being used as, and the
// width goes to Packing and Route — the two facts that decide whether a material can move.

const PAGE_SIZE = 50;

interface StockTabProps {
  categories: CategoryRow[];
  units: Array<Record<string, unknown>>;
  configByItem: Map<string, RawMaterialMovementConfigRow>;
  sections: WorkSection[];
  lookupsLoading: boolean;
  onLookupsChanged: () => Promise<void>;
  onGenerateLabels: (itemId: string) => void;
  /** Administrators approve corrections; everyone else sends them for approval. */
  isAdmin: boolean;
  /** A material can be opened straight from a notification about it. */
  initialItemId?: string;
  onInitialItemConsumed: () => void;
}

interface StockSummary {
  itemCount: number;
  totalsByUnit: Array<{ unitId: string; unitCode: string; quantity: number }>;
  equivalent?: { unitId: string; unitCode: string; quantity: number };
}

export const StockTab: React.FC<StockTabProps> = ({
  categories,
  units,
  configByItem,
  sections,
  lookupsLoading,
  onLookupsChanged,
  onGenerateLabels,
  isAdmin,
  initialItemId,
  onInitialItemConsumed,
}) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [subCategoryId, setSubCategoryId] = useState("");
  const [attributeFilters, setAttributeFilters] = useState<Record<string, string>>({});
  const [equivalentUnitId, setEquivalentUnitId] = useState("");
  /** Disabled materials are hidden by default; without this they could not be reached at all. */
  const [showDisabled, setShowDisabled] = useState(false);
  /** Each material's own chain of units, so Total qty can say the balance in the smallest one. */
  const [ladders, setLadders] = useState<Record<string, ItemUnitLadderStep[]>>({});
  const [page, setPage] = useState(1);

  const [items, setItems] = useState<InventoryItemRow[]>([]);
  const [summary, setSummary] = useState<StockSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [pendingCorrections, setPendingCorrections] = useState<StockCorrectionRequest[]>([]);
  const [awaitingOnly, setAwaitingOnly] = useState(false);
  const [importing, setImporting] = useState(false);

  const attributeKey = JSON.stringify(attributeFilters);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const attributes = Object.fromEntries(
        Object.entries(JSON.parse(attributeKey) as Record<string, string>).filter(([, value]) => value.trim() !== "")
      );
      // A sub-category narrows to itself; a parent alone means everything under it, which
      // the data layer resolves.
      const scopeId = subCategoryId || categoryId;
      const [itemRows, stockSummary] = await Promise.all([
        api.listInventoryItems({ search, categoryId: scopeId || undefined, attributes, status: showDisabled ? "ALL" : "ACTIVE" }),
        api.queryInventoryStock({
          search,
          categoryId: scopeId || undefined,
          attributes,
          targetUnitId: equivalentUnitId || undefined,
        }),
      ]);
      setItems(itemRows);
      setSummary(stockSummary);
      // The chains only dress up the Total qty column, so a failure here must never cost the
      // operator the stock list itself.
      try {
        setLadders(await api.listInventoryItemUnitLadders());
      } catch {
        setLadders({});
      }
      setPendingCorrections(await api.listStockCorrectionRequests({ status: "PENDING" }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.states.loadFailedBody);
    } finally {
      setLoading(false);
    }
  }, [api, search, categoryId, subCategoryId, attributeKey, equivalentUnitId, showDisabled]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [search, categoryId, subCategoryId, attributeKey, awaitingOnly]);

  // Clicking a stock-correction notice in the bell opens that material straight away.
  useEffect(() => {
    if (!initialItemId) return;
    setOpenItemId(initialItemId);
    onInitialItemConsumed();
  }, [initialItemId, onInitialItemConsumed]);

  // Every level beneath the chosen category, not just its direct children: without this a
  // sub-sub-category such as ACCESSORY > TAG > RUBBER TAG could not be picked at all.
  const subCategories = useMemo(() => descendantsOf(categories, categoryId), [categories, categoryId]);
  // Attribute filters follow whichever level is selected: a sub-category's own attributes
  // include everything it inherits, so narrowing never loses a filter.
  const scopeCategory = categories.find((row) => String(row.id) === (subCategoryId || categoryId));
  const filterFields = useMemo(() => identityFields(scopeCategory), [scopeCategory]);

  // Materials incomplete on this computer because something sent here has not arrived.
  const { value: syncWaiting } = useSyncWaiting();
  const incomplete = useMemo(() => incompleteMaterials(syncWaiting), [syncWaiting]);

  const awaitingItemIds = useMemo(
    () => new Set(pendingCorrections.map((request) => request.itemId)),
    [pendingCorrections]
  );

  const visible = useMemo(() => {
    let rows = items;
    if (awaitingOnly) rows = rows.filter((item) => awaitingItemIds.has(String(item.id)));
    return rows;
  }, [items, awaitingOnly, awaitingItemIds]);

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageRows = visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const openItem = openItemId ? items.find((item) => String(item.id) === openItemId) : undefined;

  const activeFilters =
    (categoryId ? 1 : 0) +
    (subCategoryId ? 1 : 0) +
    (awaitingOnly ? 1 : 0) +
    Object.values(attributeFilters).filter((value) => value.trim() !== "").length;

  const clearFilters = () => {
    setCategoryId("");
    setSubCategoryId("");
    setAttributeFilters({});
    setAwaitingOnly(false);
  };

  // Export exactly what is on screen. A button that quietly exported more than the operator
  // had narrowed down would be the one thing they could not check.
  const appliedFilters = useMemo(() => {
    const applied: Array<{ label: string; value: string }> = [];
    if (search.trim()) applied.push({ label: "Search", value: search.trim() });
    if (categoryId) {
      const top = categories.find((row) => String(row.id) === categoryId);
      if (top) applied.push({ label: "Category", value: String(top.name) });
    }
    if (subCategoryId) {
      const sub = categories.find((row) => String(row.id) === subCategoryId);
      if (sub) applied.push({ label: "Sub-category", value: String(sub.name) });
    }
    for (const field of filterFields) {
      const value = attributeFilters[String(field.field_key)];
      if (value?.trim()) applied.push({ label: String(field.label), value });
    }
    if (awaitingOnly) applied.push({ label: "Showing", value: "Only materials with a correction waiting" });
    return applied;
  }, [search, categories, categoryId, subCategoryId, filterFields, attributeFilters, awaitingOnly]);

  const exportMaterials = () => {
    downloadCsv(
      exportFileName("raw-materials"),
      buildMaterialsSheet(visible, configByItem, categories, appliedFilters.map((filter) => `${filter.label}: ${filter.value}`))
    );
  };

  const printStockReport = () => {
    const shown = new Set(visible.map((item) => String(item.unit_code ?? "")));
    const totals = (summary?.totalsByUnit ?? []).filter((total) => shown.has(total.unitCode));
    if (!openReport(buildStockReport(visible, configByItem, appliedFilters, totals))) {
      push("error", copy.toast.popupBlocked, copy.common.popupBlocked);
    }
  };

  return (
    <>
      {/* ── Search and filters ───────────────────────────────────── */}
      <div className="rm-toolbar">
        <div className="search-wrap rm-search">
          <svg className="search-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path
              fillRule="evenodd"
              d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
              clipRule="evenodd"
            />
          </svg>
          <input
            value={search}
            aria-label="Search raw materials"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search a material, code or attribute…"
            autoFocus
          />
        </div>

        <div className="form-group rm-toolbar-field">
          <label className="input-label" htmlFor="rm-filter-category">
            Category
          </label>
          <select
            id="rm-filter-category"
            className="form-input"
            value={categoryId}
            onChange={(event) => {
              setCategoryId(event.target.value);
              setSubCategoryId("");
              setAttributeFilters({});
            }}
          >
            <option value="">All categories</option>
            {topCategories(categories).map((row) => (
              <option key={String(row.id)} value={String(row.id)}>
                {String(row.name)}
              </option>
            ))}
          </select>
        </div>

        {subCategories.length > 0 ? (
          <div className="form-group rm-toolbar-field">
            <label className="input-label" htmlFor="rm-filter-subcategory">
              Sub-category
            </label>
            <select
              id="rm-filter-subcategory"
              className="form-input"
              value={subCategoryId}
              onChange={(event) => {
                setSubCategoryId(event.target.value);
                setAttributeFilters({});
              }}
            >
              <option value="">All of {String(categories.find((row) => String(row.id) === categoryId)?.name ?? "")}</option>
              {subCategories.map((row) => (
                <option key={String(row.id)} value={String(row.id)}>
                  {/* The path below the chosen category, so three levels read as three. */}
                  {categoryPath(row)
                    .split(" — ")
                    .slice(1)
                    .join(" ▸ ")}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {filterFields.map((field) => (
          <div className="rm-toolbar-field" key={String(field.id)}>
            <AttributeField
              field={field}
              mode="filter"
              value={attributeFilters[String(field.field_key)] ?? ""}
              onChange={(fieldKey, value) => setAttributeFilters((current) => ({ ...current, [fieldKey]: value }))}
            />
          </div>
        ))}

        <div className="form-group rm-toolbar-field">
          <label className="input-label" htmlFor="rm-equivalent-unit">
            Show total as
          </label>
          <select
            id="rm-equivalent-unit"
            className="form-input"
            value={equivalentUnitId}
            onChange={(event) => setEquivalentUnitId(event.target.value)}
          >
            <option value="">No conversion</option>
            {units.map((unit) => (
              <option key={String(unit.id)} value={String(unit.id)}>
                {String(unit.name)} ({String(unit.code)})
              </option>
            ))}
          </select>
        </div>

        <div className="rm-toolbar-actions">
          <button
            type="button"
            className={`rm-chip${showDisabled ? " is-active" : ""}`}
            aria-pressed={showDisabled}
            data-testid="stock-show-disabled"
            onClick={() => setShowDisabled((value) => !value)}
          >
            {copy.removal.showDisabled}
          </button>
          {pendingCorrections.length > 0 ? (
            <button
              type="button"
              className={`rm-chip rm-chip--warn${awaitingOnly ? " is-active" : ""}`}
              aria-pressed={awaitingOnly}
              onClick={() => setAwaitingOnly((value) => !value)}
            >
              ⏳ {pendingCorrections.length} {isAdmin ? "to approve" : "awaiting approval"}
            </button>
          ) : null}
          {activeFilters > 0 ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}>
              Clear filters
            </button>
          ) : null}
          <ActionMenu
            label="Export / Import"
            groups={[
              {
                label: "Export",
                items: [
                  {
                    id: "materials-excel",
                    label: `Materials & stock (Excel) — ${visible.length}`,
                    hint: "Exactly what is on screen, with the filters applied",
                    onSelect: exportMaterials,
                    disabled: visible.length === 0,
                  },
                  {
                    id: "stock-report-pdf",
                    label: "Stock report (PDF)",
                    hint: "Printable page on the letterhead, with totals",
                    onSelect: printStockReport,
                  },
                ],
              },
              {
                label: "Import",
                items: [
                  {
                    id: "import-materials",
                    label: "Import materials from a spreadsheet…",
                    hint: "Creates new materials. Nothing is saved before you see a preview",
                    onSelect: () => setImporting(true),
                    disabled: categories.length === 0,
                  },
                ],
              },
            ]}
          />
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            + New Material
          </button>
        </div>
      </div>

      {/* ── Totals ───────────────────────────────────────────────── */}
      {summary && !error ? (
        <div className="rm-kpis">
          <div className="rm-kpi">
            <span className="rm-kpi-label">{copy.columns.items}</span>
            <strong className="rm-kpi-value">{summary.itemCount}</strong>
          </div>
          {summary.totalsByUnit.map((entry) => (
            <div className="rm-kpi" key={entry.unitId}>
              <span className="rm-kpi-label">{entry.unitCode}</span>
              <strong className="rm-kpi-value">{formatQuantity(entry.quantity)}</strong>
            </div>
          ))}
          {summary.equivalent ? (
            <div className="rm-kpi rm-kpi--eq">
              <span className="rm-kpi-label">≈ {summary.equivalent.unitCode}</span>
              <strong className="rm-kpi-value">{formatQuantity(summary.equivalent.quantity)}</strong>
            </div>
          ) : null}
        </div>
      ) : null}

      <IncompleteMaterials incomplete={incomplete} />

      {/* ── The list ─────────────────────────────────────────────── */}
      {loading || lookupsLoading ? (
        <StateView kind="loading" message="Loading raw materials…" />
      ) : error ? (
        <StateView kind="error" message={error} onRetry={() => void load()} />
      ) : visible.length === 0 ? (
        <StateView
          kind="empty"
          title={items.length === 0 ? "No raw materials yet" : "Nothing matches these filters"}
          hint={
            items.length === 0
              ? "Add the first one, then print its labels — each label says what its packet holds."
              : "Try a different search, or clear the filters."
          }
          action={
            items.length === 0
              ? { label: "+ New Material", onClick: () => setCreating(true) }
              : { label: "Clear filters", onClick: clearFilters }
          }
        />
      ) : (
        <>
          <div className="table-container">
            <table className="data-table rm-table">
              <thead>
                <tr>
                  <th scope="col">Material</th>
                  <th scope="col" className="rm-num">In store</th>
                  <th scope="col" className="rm-num">Total qty</th>
                  <th scope="col" className="rm-num">Cost</th>
                  <th scope="col" aria-label={copy.columns.actions} />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((item) => {
                  const id = String(item.id);
                  const config = configByItem.get(id);
                  const onHand = Number(item.quantity_on_hand ?? 0);
                  const packs = packetsInStore(config);
                  return (
                    <tr key={id}>
                      <td>
                        <button type="button" className="rm-name-btn" onClick={() => setOpenItemId(id)}>
                          {String(item.display_name)}
                        </button>
                        <span className="cell-mono rm-row-code">{String(item.item_code)}</span>
                        {/* Said in words, not by colour alone: a disabled row is in the list
                            only because "Show disabled" is on, and it is not in use. */}
                        {String(item.status ?? "ACTIVE") === "INACTIVE" ? (
                          <span className="rm-awaiting">⚠ {copy.removal.disabledBadge}</span>
                        ) : null}
                        {awaitingItemIds.has(id) ? <span className="rm-awaiting">⏳ Correction waiting</span> : null}
                        <IncompleteRowMark entry={incomplete.get(id)} />
                      </td>
                      {/* What the storekeeper counts on the shelf: labelled packets, counted
                          one by one because each holds what its own label says. No packets
                          (opening stock only) shows the measured balance instead. */}
                      <td className="rm-num">
                        {packs == null ? (
                          <>
                            <span className="rm-stock-qty">{formatQuantity(onHand)}</span>
                            <span className="rm-stock-unit">{String(item.unit_code ?? "")}</span>
                          </>
                        ) : (
                          <span className="rm-stock-qty">{packCountLabel(packs, config)}</span>
                        )}
                      </td>
                      {/* The same stock, measured out. A material with its own chain of units
                          is said in the smallest one — 16 RULE of a nawaar whose rule is 975
                          inches is 15,600 INCH — because that is the figure the floor works in.
                          Everything else reads as it always did. */}
                      <td className="rm-num">
                        {(() => {
                          const total = quantityInBaseUnit(
                            (ladders[id] ?? []).map((step) => ({
                              fromUnit: step.fromUnit,
                              toUnit: step.toUnit,
                              factor: step.factor,
                            })),
                            String(item.unit_code ?? ""),
                            onHand,
                          );
                          if (!total) {
                            return (
                              <>
                                <span className={packs == null ? "rm-muted" : "rm-stock-qty"}>{formatQuantity(onHand)}</span>
                                <span className="rm-stock-unit">{String(item.unit_code ?? "")}</span>
                              </>
                            );
                          }
                          return (
                            <>
                              <span className="rm-stock-qty">{formatQuantity(total.quantity)}</span>
                              <span className="rm-stock-unit">{total.unit}</span>
                            </>
                          );
                        })()}
                      </td>
                      <td className="rm-num">
                        {item.cost_price != null ? (
                          `Rs. ${formatWholeMoney(Number(item.cost_price))}`
                        ) : (
                          <span className="rm-muted">—</span>
                        )}
                      </td>
                      <td>
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => setOpenItemId(id)}>
                          Open
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {pageCount > 1 ? (
            <div className="pager">
              <span className="pager-info">
                Page {page} of {pageCount} · {visible.length} materials
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={page <= 1}
                onClick={() => setPage((value) => value - 1)}
              >
                ← Prev
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={page >= pageCount}
                onClick={() => setPage((value) => value + 1)}
              >
                Next →
              </button>
            </div>
          ) : null}
        </>
      )}

      {importing ? (
        <ImportMaterialsModal
          categories={categories}
          onClose={() => setImporting(false)}
          onImported={async () => {
            await Promise.all([load(), onLookupsChanged()]);
          }}
        />
      ) : null}

      {creating ? (
        <NewMaterialModal
          categories={categories}
          units={units}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            await Promise.all([load(), onLookupsChanged()]);
          }}
          onLookupsChanged={onLookupsChanged}
        />
      ) : null}

      {openItem ? (
        <MaterialDrawer
          item={openItem}
          config={configByItem.get(String(openItem.id))}
          units={units}
          sections={sections}
          categories={categories}
          onClose={() => setOpenItemId(null)}
          isAdmin={isAdmin}
          onChanged={load}
          onLookupsChanged={onLookupsChanged}
          onGenerateLabels={(id) => {
            setOpenItemId(null);
            onGenerateLabels(id);
          }}
        />
      ) : null}
    </>
  );
};
