import React, { useEffect, useMemo, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { InventoryRow } from "../types/desktopApi";
import { ExportModal } from "../components/shared/ExportModal";
import { StateView } from "../components/shared/StateView";
import { getColorHex } from "../components/shared/ColorSwatch";
import { useNotifications } from "../state/NotificationsContext";
import { copy } from "../config/copy";
import { openPrintDocument } from "../platform/print";
import { downloadCsv, exportFileName } from "../utils/exportFile";
import { formatDate } from "../utils/dates";
import { formatDozens } from "../app/format";
import { escapeHtml } from "../utils/html";

const SearchIcon = () => (
  <svg className="search-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
  </svg>
);

const FilterIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="stock-control-icon">
    <path d="M3 5h14M5.5 10h9M8 15h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);

const ExportIcon = () => (
  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="stock-control-icon">
    <path d="M10 3v9m0-9 3.2 3.2M10 3 6.8 6.2M4 11.5V16h12v-4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const MoreIcon = () => (
  <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="stock-more-icon">
    <circle cx="5" cy="10" r="1.5" />
    <circle cx="10" cy="10" r="1.5" />
    <circle cx="15" cy="10" r="1.5" />
  </svg>
);

const money = (value: number) =>
  new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", maximumFractionDigits: 0 }).format(value || 0);

interface GroupedInventoryRow extends InventoryRow {
  colors: string[];
}

function groupInventoryByArticleAndSize(rows: InventoryRow[]): GroupedInventoryRow[] {
  const groups = new Map<string, GroupedInventoryRow>();

  for (const row of rows) {
    const key = `${row.article}\u0000${row.size}`;
    const existing = groups.get(key);
    if (existing) {
      existing.quantity += row.quantity;
      existing.stockValue += row.stockValue;
      existing.potentialRevenue += row.potentialRevenue;
      existing.profitPotential += row.profitPotential;
      if (row.color && !existing.colors.includes(row.color)) existing.colors.push(row.color);
      continue;
    }

    groups.set(key, {
      ...row,
      colors: row.color ? [row.color] : [],
    });
  }

  return [...groups.values()].sort((a, b) => a.article.localeCompare(b.article) || a.size.localeCompare(b.size));
}

export const StockPage = () => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [search, setSearch] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [productFilter, setProductFilter] = useState("");
  const [articleFilter, setArticleFilter] = useState("");
  const [colorFilter, setColorFilter] = useState("");
  const [sizeFilter, setSizeFilter] = useState("");
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [showExport, setShowExport] = useState(false);
  const [articleImages, setArticleImages] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setRows(await api.listInventory(""));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : copy.states.loadFailedBody);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const uniqueArticles = [...new Set(rows.map((row) => row.article).filter(Boolean))];
    if (!uniqueArticles.length) return;

    void (async () => {
      const nextImages: Record<string, string> = {};
      for (const article of uniqueArticles) {
        try {
          const image = await api.getProductImage(article);
          if (image) nextImages[article] = image;
        } catch {
          // ignore and keep the placeholder state
        }
      }
      setArticleImages((prev) => ({ ...prev, ...nextImages }));
    })();
  }, [api, rows]);

  const filtered = useMemo(() => {
    const terms = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return rows.filter((row) => {
      const haystack = `${row.article} ${row.color} ${row.size}`.toLowerCase();
      return terms.every((term) => haystack.includes(term))
        && (!productFilter || row.article === productFilter)
        && (!articleFilter || row.article === articleFilter)
        && (!colorFilter || row.color === colorFilter)
        && (!sizeFilter || row.size === sizeFilter);
    });
  }, [rows, search, productFilter, articleFilter, colorFilter, sizeFilter]);

  const groupedRows = useMemo(() => groupInventoryByArticleAndSize(filtered), [filtered]);
  const totalStockScans = useMemo(() => groupedRows.reduce((sum, row) => sum + row.quantity, 0), [groupedRows]);
  const totalArticles = useMemo(() => new Set(groupedRows.map((row) => row.article)).size, [groupedRows]);
  const totalColors = useMemo(() => new Set(filtered.map((row) => row.color)).size, [filtered]);
  const inventoryValue = useMemo(() => groupedRows.reduce((sum, row) => sum + row.stockValue, 0), [groupedRows]);

  const paginatedRows = useMemo(() => {
    const start = (page - 1) * rowsPerPage;
    return groupedRows.slice(start, start + rowsPerPage);
  }, [groupedRows, page, rowsPerPage]);

  const totalPages = Math.max(1, Math.ceil(groupedRows.length / rowsPerPage));

  useEffect(() => {
    setPage(1);
  }, [search, rowsPerPage, productFilter, articleFilter, colorFilter, sizeFilter]);

  const startIndex = groupedRows.length === 0 ? 0 : (page - 1) * rowsPerPage + 1;
  const endIndex = Math.min(page * rowsPerPage, groupedRows.length);

  const activeFilterCount = [productFilter, articleFilter, colorFilter, sizeFilter].filter(Boolean).length;

  const handleExport = (format: "pdf" | "excel", exportRows: InventoryRow[]) => {
    const date = formatDate(new Date());
    if (format === "pdf") {
      const e = escapeHtml;
      const tableRows = exportRows
        .map((row) => `<tr><td>${e(row.article)}</td><td>${e(row.color)}</td><td>${e(row.size)}</td><td>${e(row.quantity)}</td><td>${e(money(row.stockValue))}</td></tr>`)
        .join("");
      const html = `<!DOCTYPE html><html><head><title>${e(copy.reports.stockReport)} — ${e(date)}</title><style>body{font-family:Arial,sans-serif;padding:32px;color:#111}table{border-collapse:collapse;width:100%}td,th{padding:8px;border-bottom:1px solid #ddd;text-align:left}</style></head><body><h1>777 Manufacturing — ${e(copy.reports.stockReport)}</h1><p>Generated: ${e(date)}</p><table><thead><tr><th>Article</th><th>Color</th><th>Size</th><th>Qty</th><th>Value</th></tr></thead><tbody>${tableRows}</tbody></table></body></html>`;
      if (!openPrintDocument(html).opened) {
        push("error", copy.toast.popupBlocked, copy.common.popupBlocked);
        return;
      }
    } else {
      downloadCsv(exportFileName("stock"), {
        preamble: [`777 Manufacturing — ${copy.reports.stockReport}`, `Generated: ${date}`],
        headers: ["Article", "Color", "Size", "Quantity", "Stock Value"],
        rows: exportRows.map((row) => [row.article, row.color, row.size, row.quantity, row.stockValue]),
      });
    }

    setShowExport(false);
    push("success", `${format === "pdf" ? "PDF" : "Excel"} export ready`);
  };

  return (
    <div className="stock-page">
      <header className="stock-page-header">
        <div>
          <h1 className="page-title">Current Stock</h1>
          <p className="page-sub">Real-time overview of available inventory</p>
        </div>

        <div className="stock-header-controls">
          <div className="search-wrap stock-search-wrap">
            <SearchIcon />
            <input
              type="search"
              aria-label="Search stock"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search product, article, color, size..."
            />
          </div>

          <button type="button" className={`btn btn-secondary stock-btn${activeFilterCount ? " is-active" : ""}`} onClick={() => setFiltersOpen((open) => !open)}>
            <FilterIcon />
            Filters{activeFilterCount > 0 && <span className="stock-filter-count">{activeFilterCount}</span>}
          </button>
          <button type="button" className="btn btn-primary stock-btn" onClick={() => setShowExport(true)}>
            <ExportIcon />{copy.actions.export}</button>
        </div>

        {filtersOpen && (
          <div className="stock-filter-panel">
            <label>{copy.columns.product}<select value={productFilter} onChange={(event) => setProductFilter(event.target.value)}><option value="">All products</option>{[...new Set(rows.map((row) => row.article))].sort().map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label>{copy.columns.article}<select value={articleFilter} onChange={(event) => setArticleFilter(event.target.value)}><option value="">{copy.filters.allArticles}</option>{[...new Set(rows.map((row) => row.article))].sort().map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label>{copy.columns.color}<select value={colorFilter} onChange={(event) => setColorFilter(event.target.value)}><option value="">All colors</option>{[...new Set(rows.map((row) => row.color))].sort().map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label>{copy.columns.size}<select value={sizeFilter} onChange={(event) => setSizeFilter(event.target.value)}><option value="">All sizes</option>{[...new Set(rows.map((row) => row.size))].sort().map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            {activeFilterCount > 0 && <button type="button" className="btn btn-ghost btn-sm stock-clear-filters" onClick={() => { setProductFilter(""); setArticleFilter(""); setColorFilter(""); setSizeFilter(""); }}>Clear filters</button>}
          </div>
        )}
      </header>

      <section className="kpi-grid stock-kpi-grid">
        <div className="kpi-card accent">
          <div className="kpi-icon-box navy">
            <span>◫</span>
          </div>
          <div className="kpi-metric-row">
            <div className="kpi-label">Total Stock (Dozens)</div>
            <div className="kpi-value">{formatDozens(totalStockScans)}</div>
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-icon-box purple">
            <span>◌</span>
          </div>
          <div className="kpi-metric-row">
            <div className="kpi-label">Total Articles</div>
            <div className="kpi-value">{totalArticles}</div>
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-icon-box amber">
            <span>◍</span>
          </div>
          <div className="kpi-metric-row">
            <div className="kpi-label">Total Colors</div>
            <div className="kpi-value">{totalColors}</div>
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-icon-box green">
            <span>Rs</span>
          </div>
          <div className="kpi-metric-row">
            <div className="kpi-label">Inventory Value (Rs)</div>
            <div className="kpi-value">{money(inventoryValue)}</div>
          </div>
        </div>
      </section>

      <section className="stock-table-panel">
        <table className="stock-product-table">
          <thead>
            <tr>
              <th className="stock-col-product">{copy.columns.product}</th>
              <th className="stock-col-article">{copy.columns.article}</th>
              <th className="stock-col-colors">Colors</th>
              <th className="stock-col-size">{copy.columns.size}</th>
              <th className="stock-col-dozens">Dozens</th>
              <th className="stock-col-value">Value (Rs)</th>
              <th className="stock-col-action"> </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7}><StateView kind="loading" compact /></td>
              </tr>
            ) : loadError ? (
              <tr>
                <td colSpan={7}><StateView kind="error" compact message={loadError} onRetry={() => void load()} /></td>
              </tr>
            ) : paginatedRows.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <StateView
                    kind="empty"
                    compact
                    title={rows.length === 0 ? copy.stock.emptyTitle : copy.stock.noMatch}
                    hint={rows.length === 0 ? copy.stock.emptyHint : undefined}
                  />
                </td>
              </tr>
            ) : (
              paginatedRows.map((row) => (
                <tr key={`${row.article}-${row.size}-${row.color}`} className="stock-row">
                  <td className="stock-col-product">
                    <div className="stock-product-cell">
                      <div className="stock-product-image-wrap">
                        {articleImages[row.article] ? (
                          <img src={articleImages[row.article]} alt={`${row.article} product image`} className="stock-product-image" />
                        ) : (
                          <div className="stock-product-placeholder">{row.article.slice(0, 2).toUpperCase() || "P"}</div>
                        )}
                      </div>
                      <div className="stock-product-meta">
                        <div className="stock-product-name">{row.article}</div>
                        <div className="stock-product-collection">Men&apos;s Collection</div>
                      </div>
                    </div>
                  </td>
                  <td className="stock-col-article">{row.article}</td>
                  <td className="stock-col-colors">
                    <div className="stock-color-row">
                      {row.colors.slice(0, 2).map((color) => (
                        <span
                          key={`${row.article}-${row.size}-${color}`}
                          className="stock-color-swatch"
                          style={{ background: getColorHex(color) }}
                          title={color}
                        />
                      ))}
                      {row.colors.length > 2 && <span className="stock-color-plus">+{row.colors.length - 2}</span>}
                    </div>
                  </td>
                  <td className="stock-col-size">{row.size}</td>
                  <td className="stock-col-dozens">
                    <span className="stock-dozens-value">{formatDozens(row.quantity)}</span>
                  </td>
                  <td className="stock-col-value">{money(row.stockValue)}</td>
                  <td className="stock-col-action">
                    <button type="button" className="stock-row-menu" aria-label="More actions">
                      <MoreIcon />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        <div className="stock-pagination-row">
          <span className="stock-pagination-info">
            Showing {groupedRows.length === 0 ? 0 : startIndex} to {endIndex} of {groupedRows.length} items
          </span>

          <div className="stock-pagination-controls">
            <button type="button" className="stock-page-button" disabled={page === 1} onClick={() => setPage((value) => Math.max(1, value - 1))} aria-label="Previous page">
              ‹
            </button>
            {Array.from({ length: Math.min(5, totalPages) }, (_, index) => {
              const pageNumber = index + 1;
              return (
                <button
                  key={pageNumber}
                  type="button"
                  className={`stock-page-button ${pageNumber === page ? "is-active" : ""}`}
                  aria-current={pageNumber === page ? "page" : undefined}
                  aria-label={`Page ${pageNumber}`}
                  onClick={() => setPage(pageNumber)}
                >
                  {pageNumber}
                </button>
              );
            })}
            <button type="button" className="stock-page-button" disabled={page === totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))} aria-label="Next page">
              ›
            </button>
          </div>

          <div className="stock-per-page">
            <label htmlFor="stock-rows-per-page">Rows per page</label>
            <select id="stock-rows-per-page" value={rowsPerPage} onChange={(event) => setRowsPerPage(Number(event.target.value))}>
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
            </select>
          </div>
        </div>
      </section>

      {showExport && (
        <ExportModal
          title="Export Current Stock"
          subtitle="Choose the inventory scope and format for your export."
          rows={rows}
          filteredRows={filtered}
          onExport={handleExport}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  );
};
