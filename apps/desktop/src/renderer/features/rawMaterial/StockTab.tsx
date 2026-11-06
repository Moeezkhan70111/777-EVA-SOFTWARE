import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import type { RawMaterialMovementConfigRow, StockCorrectionRequest, WorkSection } from "../../types/desktopApi";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { AttributeField } from "./AttributeField";
import { MaterialDrawer } from "./MaterialDrawer";
import { NewMaterialModal } from "./NewMaterialModal";
import { ImportMaterialsModal } from "./ImportMaterialsModal";
import { ActionMenu } from "./ActionMenu";
import { useSyncWaiting } from "../sync/useSyncWaiting";
import { incompleteMaterials } from "../sync/syncWaiting";
import { IncompleteMaterials } from "../sync/IncompleteMaterials";
import { useDataChanged } from "../../hooks/useDataChanged";
import { DATA_KIND } from "../../../shared/dataChange";
import { downloadCsv, exportFileName } from "../../utils/exportFile";
import type { ItemUnitLadderStep } from "../../types/desktopApi";
import { openReport } from "../../utils/reportDocument";
import { buildMaterialsSheet, buildStockReport } from "./rawMaterialExports";
import { CategoryFilterBar } from "./CategoryFilterBar";
import { StockList } from "./StockList";
import { categoryCounts, groupStockPage, sortForStock } from "./stockGroups";
import { Pager } from "../../components/shared/Pager";
import {
  identityFields,
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
  /** A store operator: removes a material directly, as an administrator does. */
  canRemoveMaterial?: boolean;
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
  canRemoveMaterial,
  initialItemId,
  onInitialItemConsumed,
}) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [subCategoryId, setSubCategoryId] = useState("");
  const [attributeFilters, setAttributeFilters] = useState<Record<string, string>>({});
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

  /**
   * Reads the list and its totals. QUIET when data changed underneath an open screen: no loading
   * state, so the table, the page, the scroll position and an open drawer all stay where they are,
   * and the figures simply change. A quiet read that fails keeps what is shown.
   */
  const load = useCallback(async (quiet = false) => {
    if (!quiet) {
      setLoading(true);
      setError(null);
    }
    try {
      const attributes = Object.fromEntries(
        Object.entries(JSON.parse(attributeKey) as Record<string, string>).filter(([, value]) => value.trim() !== "")
      );
      // A sub-category narrows to itself; a parent alone means everything under it, which
      // the data layer resolves.
      const scopeId = subCategoryId || categoryId;
      const [itemRows, stockSummary] = await Promise.all([
        api.listInventoryItems({ search, categoryId: scopeId || undefined, attributes, status: showDisabled ? "ALL" : "ACTIVE" }),
        // The per-unit totals are no longer shown on screen, but the printed stock report carries them.
        api.queryInventoryStock({ search, categoryId: scopeId || undefined, attributes }),
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
      if (!quiet) setError(cause instanceof Error ? cause.message : copy.states.loadFailedBody);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [api, search, categoryId, subCategoryId, attributeKey, showDisabled]);

  useEffect(() => {
    void load();
  }, [load]);

  // Stock, materials or labels arriving from another computer: the same read, in place.
  useDataChanged([DATA_KIND.STOCK, DATA_KIND.MATERIALS, DATA_KIND.LABELS], () => void load(true));

  useEffect(() => {
    setPage(1);
  }, [search, categoryId, subCategoryId, attributeKey, awaitingOnly]);

  // Clicking a stock-correction notice in the bell opens that material straight away.
  useEffect(() => {
    if (!initialItemId) return;
    setOpenItemId(initialItemId);
    onInitialItemConsumed();
  }, [initialItemId, onInitialItemConsumed]);

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

  // Sorted so each category and sub-category sits together; counted across the whole list.
  const sorted = useMemo(() => sortForStock(visible), [visible]);
  const counts = useMemo(() => categoryCounts(visible), [visible]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageRows = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const openItem = openItemId ? items.find((item) => String(item.id) === openItemId) : undefined;

  const activeFilters =
    (categoryId ? 1 : 0) +
    (subCategoryId ? 1 : 0) +
    (awaitingOnly ? 1 : 0) +
    Object.values(attributeFilters).filter((value) => value.trim() !== "").length;

  // Choosing another category starts its sub-category and attribute filters afresh.
  const chooseCategory = (next: string) => {
    setCategoryId(next);
    setSubCategoryId("");
    setAttributeFilters({});
  };
  const chooseSubCategory = (next: string) => {
    setSubCategoryId(next);
    setAttributeFilters({});
  };

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

      {/* ── Categories, as buttons; a chosen one opens its sub-categories under it ── */}
      <CategoryFilterBar
        categories={categories}
        categoryId={categoryId}
        subCategoryId={subCategoryId}
        onCategory={chooseCategory}
        onSubCategory={chooseSubCategory}
      />

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
          {/* Grouped by category and sub-category; the groups carry on across pages. */}
          <StockList
            groups={groupStockPage(pageRows)}
            counts={counts}
            configByItem={configByItem}
            ladders={ladders}
            awaitingItemIds={awaitingItemIds}
            incomplete={incomplete}
            onOpen={setOpenItemId}
          />
          <footer className="rm-stock-foot">
            <span className="rm-stock-foot-count">
              {copy.rawMaterialStock.showing((page - 1) * PAGE_SIZE + 1, (page - 1) * PAGE_SIZE + pageRows.length, sorted.length)}
            </span>
            {pageCount > 1 ? <Pager page={page} pages={pageCount} onPage={setPage} numbered /> : null}
          </footer>
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
          canRemoveMaterial={canRemoveMaterial}
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
