import React, { useMemo, useState } from "react";
import type { InventoryRow } from "../../types/desktopApi";
import { copy } from "../../config/copy";

export interface ExportModalProps {
  title: string;
  subtitle?: string;
  rows: InventoryRow[];
  filteredRows: InventoryRow[];
  onExport: (format: "pdf" | "excel", rows: InventoryRow[]) => void;
  onClose: () => void;
}

const SearchIcon = () => (
  <svg className="search-icon" viewBox="0 0 20 20" fill="currentColor">
    <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
  </svg>
);

export const ExportModal = ({
  title,
  subtitle,
  rows,
  filteredRows,
  onExport,
  onClose,
}: ExportModalProps) => {
  const [scope, setScope] = useState<"all" | "filtered" | "selected">(filteredRows.length < rows.length ? "filtered" : "all");
  const [format, setFormat] = useState<"pdf" | "excel">("excel");
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const visibleRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((row) => `${row.article} ${row.color} ${row.size}`.toLowerCase().includes(query));
  }, [rows, search]);
  const selectedRows = useMemo(() => rows.filter((row) => selectedIds.includes(row.productId)), [rows, selectedIds]);
  const exportRows = scope === "all" ? rows : scope === "filtered" ? filteredRows : selectedRows;
  const visibleIds = visibleRows.map((row) => row.productId);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));

  const toggleSelected = (id: string) => setSelectedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  const toggleVisible = () => setSelectedIds((current) => allVisibleSelected
    ? current.filter((id) => !visibleIds.includes(id))
    : [...new Set([...current, ...visibleIds])]);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal export-modal">
        <div className="modal-title">{title}</div>
        {subtitle && <div className="modal-sub">{subtitle}</div>}

        <div className="export-modal-section">
          <div className="modal-section-title">What to export</div>
          <div className="export-scope-grid">
            <button type="button" className={`export-scope-option${scope === "all" ? " selected" : ""}`} onClick={() => setScope("all")}><strong>All inventory</strong><span>{rows.length} items</span></button>
            <button type="button" className={`export-scope-option${scope === "filtered" ? " selected" : ""}`} onClick={() => setScope("filtered")}><strong>Current filtered</strong><span>{filteredRows.length} items</span></button>
            <button type="button" className={`export-scope-option${scope === "selected" ? " selected" : ""}`} onClick={() => setScope("selected")}><strong>Selected items</strong><span>{selectedRows.length} selected</span></button>
          </div>
        </div>

        <div className="export-modal-section">
          <div className="export-selection-header"><div className="modal-section-title">Select inventory</div><button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelectedIds([])} disabled={!selectedIds.length}>{copy.actions.clear}</button></div>
          <div className="search-wrap export-search-wrap"><SearchIcon /><input type="search" aria-label="Search inventory to export" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search product, article, color, size..." /></div>
          <div className="export-selection-toolbar"><button type="button" className="btn btn-secondary btn-sm" onClick={toggleVisible} disabled={!visibleRows.length}>{allVisibleSelected ? "Clear visible" : "Select all visible"}</button><span>{selectedRows.length} selected</span></div>
          <div className="export-item-list">
            {visibleRows.length === 0 ? <div className="export-item-empty">No matching inventory items.</div> : visibleRows.map((row) => (
              <label key={row.productId} className="export-item-row"><input type="checkbox" checked={selectedIds.includes(row.productId)} onChange={() => toggleSelected(row.productId)} /><span className="export-item-main"><strong>{row.article}</strong><span>{row.color} · {row.size}</span></span><span className="export-item-quantity">{row.quantity}</span></label>
            ))}
          </div>
        </div>

        <div className="export-format-row"><span className="modal-section-title">Format</span><div className="export-format-options"><label className={`export-format-option${format === "excel" ? " selected" : ""}`}><input type="radio" checked={format === "excel"} onChange={() => setFormat("excel")} /> Excel</label><label className={`export-format-option${format === "pdf" ? " selected" : ""}`}><input type="radio" checked={format === "pdf"} onChange={() => setFormat("pdf")} /> PDF</label></div></div>

        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>{copy.common.cancel}</button>
          <button type="button" className="btn btn-primary" disabled={!exportRows.length} onClick={() => onExport(format, exportRows)}>Export {exportRows.length} {exportRows.length === 1 ? "item" : "items"}</button>
        </div>
      </div>
    </div>
  );
};
