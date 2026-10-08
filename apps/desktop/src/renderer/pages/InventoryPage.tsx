import React, { useEffect, useMemo, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { InventoryRow } from "../types/desktopApi";
import { money } from "../app/format";
import { copy } from "../config/copy";

const PAGE_SIZE = 20;

const SORT_OPTS: Array<{ value: keyof InventoryRow; label: string }> = [
  { value: "article",         label: copy.columns.article },
  { value: "color",           label: copy.columns.color },
  { value: "size",            label: copy.columns.size },
  { value: "quantity",        label: copy.columns.quantity },
  { value: "stockValue",      label: "Stock Value" },
  { value: "profitPotential", label: "Profit Potential" },
];

export const InventoryPage = () => {
  const api = useDesktopApi();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<keyof InventoryRow>("quantity");
  const [desc, setDesc] = useState(true);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<InventoryRow[]>([]);

  const load = async () => setRows(await api.listInventory(search));
  useEffect(() => { void load(); }, []);

  const filtered = useMemo(() => {
    return [...rows].sort((a, b) => {
      const av = a[sort], bv = b[sort];
      if (typeof av === "number" && typeof bv === "number") return desc ? bv - av : av - bv;
      return desc ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv));
    });
  }, [rows, sort, desc]);

  const pageRows  = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  return (
    <div className="stack">
      {/* Toolbar */}
      <div className="toolbar">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void load()}
          placeholder="Search by article, color, size…"
          style={{ minWidth: 220 }}
        />
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>{copy.actions.search}</button>
        <div className="toolbar-sep" />
        <span className="text-muted text-small" style={{ marginRight: 4 }}>Sort by</span>
        <select value={String(sort)} onChange={(e) => setSort(e.target.value as keyof InventoryRow)}>
          {SORT_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setDesc((v) => !v)}
          title="Toggle sort direction"
        >
          {desc ? "↓ Desc" : "↑ Asc"}
        </button>
        <span className="flex-1" />
        <span className="text-muted text-small">{filtered.length} items</span>
      </div>

      {/* Table */}
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>{copy.columns.article}</th>
              <th>{copy.columns.color}</th>
              <th>{copy.columns.size}</th>
              <th>{copy.columns.qty}</th>
              <th>Cost</th>
              <th>Selling</th>
              <th>Stock Value</th>
              <th>Potential Rev.</th>
              <th>Profit Potential</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr><td colSpan={9} className="empty-state">No inventory data</td></tr>
            ) : pageRows.map((r) => (
              <tr key={r.productId}>
                <td><strong>{r.article}</strong></td>
                <td>{r.color}</td>
                <td><span className="tag">{r.size}</span></td>
                <td><strong>{r.quantity.toLocaleString()}</strong></td>
                <td className="text-muted">{money(r.costPrice)}</td>
                <td className="text-muted">{money(r.sellingPrice)}</td>
                <td>{money(r.stockValue)}</td>
                <td>{money(r.potentialRevenue)}</td>
                <td style={{ color: r.profitPotential > 0 ? "var(--ok)" : "inherit" }}>
                  {money(r.profitPotential)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pager */}
      <div className="pager">
        <span className="pager-info">
          Page {page} of {pageCount} · {filtered.length} total
        </span>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          ← Prev
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={page >= pageCount}
          onClick={() => setPage((p) => p + 1)}
        >
          Next →
        </button>
      </div>
    </div>
  );
};
