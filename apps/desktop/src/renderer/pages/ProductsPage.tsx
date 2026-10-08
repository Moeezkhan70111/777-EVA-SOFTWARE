import React, { useEffect, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { ProductRow } from "../types/desktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { copy } from "../config/copy";
import { formatDateTime } from "../utils/dates";

interface ProductForm {
  article:      string;
  color:        string;
  size:         string;
  description:  string;
  costPrice:    string;
  sellingPrice: string;
}

const emptyForm: ProductForm = {
  article: "", color: "", size: "", description: "", costPrice: "", sellingPrice: "",
};

export const ProductsPage = () => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [rows, setRows]         = useState<ProductRow[]>([]);
  const [search, setSearch]     = useState("");
  const [status, setStatus]     = useState("ALL");
  const [form, setForm]         = useState<ProductForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = async () => {
    const res = await api.listProducts({ search, status, page: 1, pageSize: 100 });
    setRows(res.rows);
  };

  useEffect(() => { void load(); }, []);

  const field = (key: keyof ProductForm) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value })),
  });

  const save = async () => {
    const payload = {
      article:      form.article.trim(),
      color:        form.color.trim(),
      size:         form.size.trim(),
      description:  form.description || undefined,
      costPrice:    form.costPrice    ? Number(form.costPrice)    : undefined,
      sellingPrice: form.sellingPrice ? Number(form.sellingPrice) : undefined,
      status: "ACTIVE",
    };
    if (editingId) {
      await api.updateProduct(editingId, payload);
      push("success", "Product Updated", form.article);
    } else {
      await api.createProduct(payload);
      push("success", "Product Added", form.article);
    }
    setForm(emptyForm);
    setEditingId(null);
    await load();
  };

  const startEdit = (row: ProductRow) => {
    setEditingId(row.id);
    setForm({
      article:      row.article,
      color:        row.color,
      size:         row.size,
      description:  row.description ?? "",
      costPrice:    row.costPrice?.toString()    ?? "",
      sellingPrice: row.sellingPrice?.toString() ?? "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const cancel = () => { setForm(emptyForm); setEditingId(null); };

  const disable = async (row: ProductRow) => {
    await api.disableProduct(row.id);
    push("warning", "Product Disabled", `${row.article} ${row.color} ${row.size}`);
    await load();
  };

  return (
    <div className="stack">
      {/* Form */}
      <div className="form-card">
        <div className="form-card-title">
          {editingId ? `Editing Product` : "Add New Product"}
        </div>
        <div className="form-grid">
          <div className="input-group">
            <label className="input-label">Article *</label>
            <input {...field("article")} placeholder="e.g. SHIRT-01" />
          </div>
          <div className="input-group">
            <label className="input-label">Color *</label>
            <input {...field("color")} placeholder="e.g. Red" />
          </div>
          <div className="input-group">
            <label className="input-label">Size *</label>
            <input {...field("size")} placeholder="e.g. M" />
          </div>
          <div className="input-group">
            <label className="input-label">Cost Price</label>
            <input {...field("costPrice")} placeholder="0.00" type="number" min="0" step="0.01" />
          </div>
          <div className="input-group">
            <label className="input-label">Selling Price</label>
            <input {...field("sellingPrice")} placeholder="0.00" type="number" min="0" step="0.01" />
          </div>
          <div className="input-group">
            <label className="input-label">{copy.columns.description}</label>
            <input {...field("description")} placeholder="Optional notes" />
          </div>
        </div>
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={() => void save()}>
            {editingId ? "Save Changes" : "Add Product"}
          </button>
          {editingId && (
            <button type="button" className="btn btn-ghost" onClick={cancel}>{copy.common.cancel}</button>
          )}
        </div>
      </div>

      {/* Filter toolbar */}
      <div className="toolbar">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void load()}
          placeholder="Search products…"
          style={{ minWidth: 200 }}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="ALL">{copy.filters.allStatus}</option>
          <option value="ACTIVE">Active</option>
          <option value="DISABLED">Disabled</option>
        </select>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
          Filter
        </button>
        <span className="flex-1" />
        <span className="text-muted text-small">{rows.length} products</span>
      </div>

      {/* Table */}
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>{copy.columns.article}</th>
              <th>{copy.columns.color}</th>
              <th>{copy.columns.size}</th>
              <th>{copy.columns.status}</th>
              <th>Last Updated</th>
              <th>{copy.columns.actions}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={6} className="empty-state">No products found</td></tr>
            ) : rows.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.article}</strong></td>
                <td>{r.colors?.join(", ") || r.color || "-"}</td>
                <td><span className="tag">{r.size}</span></td>
                <td>
                  <span className={`badge ${r.status === "ACTIVE" ? "badge-ok" : "badge-muted"}`}>
                    {r.status.toLowerCase()}
                  </span>
                </td>
                <td className="text-muted text-small">
                  {formatDateTime(r.updatedAt)}
                </td>
                <td>
                  <div className="cell-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => startEdit(r)}
                    >{copy.actions.edit}</button>
                    {r.status === "ACTIVE" && (
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        onClick={() => void disable(r)}
                      >
                        Disable
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
