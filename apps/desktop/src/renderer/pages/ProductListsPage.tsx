import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import { useNotifications } from "../state/NotificationsContext";
import type { ProductListEntry, ProductListKind } from "../types/desktopApi";
import { copy } from "../config/copy";

// Fields Management manages the values behind the Add / Edit Product dropdowns. Groups and
// series are their own records; articles and sizes are parts of Product Master entries,
// so changing one changes every product that carries it (and never one with QR codes).

interface ListMeta {
  kind: ProductListKind;
  label: string;
  singular: string;
  /** Whether new values can be added here (articles/sizes are created with a product). */
  canAdd: boolean;
  explain: string;
  deleteVerb: string;
}

const LISTS: ListMeta[] = [
  {
    kind: "article",
    label: "Articles",
    singular: "article",
    canAdd: false,
    explain: "An article exists through its products. Renaming changes every product with that article; deleting disables them all.",
    deleteVerb: "Disable products",
  },
  {
    kind: "size",
    label: "Sizes",
    singular: "size",
    canAdd: false,
    explain: "A size exists through its products. Renaming changes every product with that size; deleting disables them all.",
    deleteVerb: "Disable products",
  },
  { kind: "main-group", label: "Main Groups", singular: "main group", canAdd: true, explain: "Groups can be removed only while no product uses them.", deleteVerb: "Delete" },
  { kind: "product-group", label: "Product Groups", singular: "product group", canAdd: true, explain: "Groups can be removed only while no product or party discount rule uses them.", deleteVerb: "Delete" },
  { kind: "article-series", label: "Article Series", singular: "article series", canAdd: true, explain: "Series can be removed only while no product or party discount rule uses them.", deleteVerb: "Delete" },
  { kind: "product-type", label: "Product Types", singular: "product type", canAdd: true, explain: "Types can be removed only while no product uses them.", deleteVerb: "Delete" },
  // A sub group belongs to a product group, and this page has no group to add it under — it is
  // added from the product form, where the group is already chosen. Renaming and deleting
  // work here like any other list.
  {
    kind: "product-sub-group",
    label: "Product Sub Groups",
    singular: "product sub group",
    canAdd: false,
    explain: "A sub group is added from the Add Product page, under the product group it belongs to. It can be removed here only while no product uses it.",
    deleteVerb: "Delete",
  },
];

const listMeta = (kind: ProductListKind): ListMeta => LISTS.find((l) => l.kind === kind) ?? LISTS[0];

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

interface ProductListsPageProps {
  /** The logged-in operator; recorded on every rename / delete. */
  username?: string;
}

export const ProductListsPage: React.FC<ProductListsPageProps> = ({ username }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [kind, setKind] = useState<ProductListKind>("article");
  const [entries, setEntries] = useState<ProductListEntry[]>([]);
  const [counts, setCounts] = useState<Partial<Record<ProductListKind, number>>>({});
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ProductListEntry | null>(null);
  const [newName, setNewName] = useState("");

  const meta = listMeta(kind);

  const load = useCallback(
    async (which: ProductListKind) => {
      setLoading(true);
      try {
        if (typeof api.listProductListEntries !== "function") {
          throw new Error("This feature is not available in the running app yet — restart the app to load it.");
        }
        const rows = await api.listProductListEntries(which);
        setEntries(rows);
        setCounts((prev) => ({ ...prev, [which]: rows.length }));
      } catch (error) {
        setEntries([]);
        push("error", "Could not load list", error instanceof Error ? error.message : "");
      } finally {
        setLoading(false);
      }
    },
    [api, push],
  );

  useEffect(() => {
    setEditingId(null);
    setSearch("");
    setNewName("");
    void load(kind);
  }, [kind, load]);

  // Tab counts for every list, loaded once so the operator can see where the values are.
  useEffect(() => {
    if (typeof api.listProductListEntries !== "function") return;
    void (async () => {
      for (const list of LISTS) {
        try {
          const rows = await api.listProductListEntries(list.kind);
          setCounts((prev) => ({ ...prev, [list.kind]: rows.length }));
        } catch {
          /* the tab just shows no count */
        }
      }
    })();
  }, [api]);

  // Escape closes the delete modal instead of navigating to Dashboard.
  useEffect(() => {
    if (!confirmDelete && !editingId) return;
    const sentinel = document.createElement("div");
    sentinel.setAttribute("data-suppress-esc", "1");
    sentinel.style.display = "none";
    document.body.appendChild(sentinel);
    return () => sentinel.remove();
  }, [confirmDelete, editingId]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle ? entries.filter((e) => e.name.toLowerCase().includes(needle)) : entries;
  }, [entries, search]);

  const startRename = (entry: ProductListEntry) => {
    setEditingId(entry.id);
    setDraftName(entry.name);
  };

  const cancelRename = () => {
    setEditingId(null);
    setDraftName("");
  };

  const submitRename = async (entry: ProductListEntry) => {
    const next = draftName.trim().toUpperCase();
    if (!next || next === entry.name) {
      cancelRename();
      return;
    }
    setBusy(true);
    try {
      const result = await api.renameProductListEntry({ kind, id: entry.id, newName: next });
      if (!result.accepted) {
        push("error", copy.toast.renameFailed, result.reason ?? "");
        return;
      }
      const touched = result.affected ?? 0;
      push(
        "success",
        `Renamed to ${result.name ?? next}`,
        meta.canAdd ? entry.name : `${plural(touched, "record")} updated`,
      );
      cancelRename();
      await load(kind);
    } catch {
      push("error", copy.toast.renameFailed, "Something went wrong — nothing was changed");
    } finally {
      setBusy(false);
    }
  };

  const submitDelete = async () => {
    if (!confirmDelete) return;
    setBusy(true);
    try {
      const result = await api.deleteProductListEntry({ kind, id: confirmDelete.id, actor: username?.trim() || null });
      if (!result.accepted) {
        push("error", copy.toast.deleteFailed, result.reason ?? "");
        return;
      }
      push(
        "success",
        meta.canAdd ? `${confirmDelete.name} deleted` : `${confirmDelete.name} removed`,
        meta.canAdd ? "It no longer appears in the dropdown." : `${plural(confirmDelete.productCount, "product")} disabled`,
      );
      setConfirmDelete(null);
      await load(kind);
    } catch {
      push("error", copy.toast.deleteFailed, "Something went wrong — nothing was changed");
    } finally {
      setBusy(false);
    }
  };

  const submitAdd = async () => {
    const value = newName.trim().toUpperCase();
    if (!value) return;
    setBusy(true);
    try {
      const result =
        kind === "main-group"
          ? await api.createMainGroup({ groupName: value })
          : kind === "product-group"
            ? await api.createProductGroup({ groupName: value })
            : kind === "product-type"
              ? await api.createProductType({ name: value })
              : await api.createArticleSeries({ name: value });
      if (!result.accepted) {
        push("error", copy.toast.addFailed, result.reason ?? "");
        return;
      }
      push("success", `${value} added`, `New ${meta.singular}`);
      setNewName("");
      await load(kind);
    } catch {
      push("error", copy.toast.addFailed, "Something went wrong — nothing was changed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page product-lists-page">
      <div className="page-header">
        <div>
          <h1>Fields Management</h1>
          <p className="page-sub" style={{ margin: "4px 0 0" }}>
            The values offered in the Add / Edit Product dropdowns. Rename a typo or remove a value that should not be there.
          </p>
        </div>
      </div>

      <div className="plists-layout">
        <nav className="plists-tabs" aria-label="Lists">
          {LISTS.map((list) => (
            <button
              key={list.kind}
              type="button"
              className={`plists-tab${list.kind === kind ? " is-active" : ""}`}
              onClick={() => setKind(list.kind)}
              aria-current={list.kind === kind ? "page" : undefined}
            >
              <span>{list.label}</span>
              {counts[list.kind] !== undefined && <span className="plists-tab-count">{counts[list.kind]}</span>}
            </button>
          ))}
        </nav>

        <div className="card plists-card">
          <div className="card-header plists-head">
            <div>
              <h2 className="card-title">{meta.label}</h2>
              <p className="qrm-note">{meta.explain}</p>
            </div>
            <div className="plists-tools">
              <div className="search-wrap plists-search">
                <svg className="search-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path
                    fillRule="evenodd"
                    d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
                    clipRule="evenodd"
                  />
                </svg>
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${meta.label.toLowerCase()}…`} aria-label={`Search ${meta.label}`} />
              </div>
            </div>
          </div>

          {meta.canAdd && (
            <form
              className="plists-add"
              onSubmit={(e) => {
                e.preventDefault();
                void submitAdd();
              }}
            >
              <input
                type="text"
                className="form-input input-upper"
                value={newName}
                onChange={(e) => setNewName(e.target.value.toUpperCase())}
                placeholder={`New ${meta.singular} name`}
                aria-label={`New ${meta.singular}`}
                maxLength={80}
                autoComplete="off"
              />
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !newName.trim()}>
                Add {meta.singular}
              </button>
            </form>
          )}

          <div className="table-container">
            <table className="data-table plists-table">
              <thead>
                <tr>
                  <th>{meta.canAdd ? "Name" : meta.label.slice(0, -1)}</th>
                  <th>Used by</th>
                  {!meta.canAdd && <th>QR codes</th>}
                  <th aria-label={copy.columns.actions} />
                </tr>
              </thead>
              <tbody>
                {loading && entries.length === 0 && (
                  <tr>
                    <td colSpan={4} className="loading" style={{ textAlign: "center" }}>{copy.common.loading}</td>
                  </tr>
                )}
                {!loading && visible.length === 0 && (
                  <tr>
                    <td colSpan={4}>
                      <div className="empty-state">
                        <strong style={{ display: "block", marginBottom: 6 }}>
                          {search.trim() ? `No ${meta.label.toLowerCase()} match “${search.trim()}”` : `No ${meta.label.toLowerCase()} yet`}
                        </strong>
                        <span style={{ fontSize: "0.82rem" }}>
                          {meta.canAdd ? "Add one above, or from the + button on the Add / Edit Product page." : "Values appear here once a product is created with them."}
                        </span>
                      </div>
                    </td>
                  </tr>
                )}
                {visible.map((entry) => {
                  const editing = editingId === entry.id;
                  return (
                    <tr key={entry.id} className={editing ? "is-editing" : ""}>
                      <td className="plists-name-cell">
                        {editing ? (
                          <form
                            className="plists-rename"
                            onSubmit={(e) => {
                              e.preventDefault();
                              void submitRename(entry);
                            }}
                          >
                            <input
                              type="text"
                              className="form-input input-upper"
                              value={draftName}
                              onChange={(e) => setDraftName(e.target.value.toUpperCase())}
                              onKeyDown={(e) => {
                                if (e.key === "Escape") {
                                  e.stopPropagation();
                                  cancelRename();
                                }
                              }}
                              aria-label={`New name for ${entry.name}`}
                              maxLength={80}
                              autoComplete="off"
                              autoFocus
                            />
                            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !draftName.trim() || draftName.trim().toUpperCase() === entry.name}>{copy.common.save}</button>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={cancelRename} disabled={busy}>{copy.common.cancel}</button>
                          </form>
                        ) : (
                          <>
                            <strong>{entry.name}</strong>
                            {/* A sub group name is unique only within its group, so the group is said beside it. */}
                            {entry.parentName ? <span className="pl-parent">under {entry.parentName}</span> : null}
                          </>
                        )}
                      </td>
                      <td>
                        <span className={entry.productCount === 0 && entry.discountRuleCount === 0 ? "text-muted" : ""}>
                          {plural(entry.productCount, "product")}
                        </span>
                        {entry.discountRuleCount > 0 && <span className="text-muted"> · {plural(entry.discountRuleCount, "discount rule")}</span>}
                        {entry.disabledProductCount > 0 && <span className="text-muted"> · {entry.disabledProductCount} disabled</span>}
                      </td>
                      {!meta.canAdd && (
                        <td>
                          {entry.qrCount > 0 ? (
                            <span className="badge badge-warn" title={entry.renameBlockedReason ?? undefined}>
                              {entry.qrCount.toLocaleString()} generated
                            </span>
                          ) : (
                            <span className="text-muted">none</span>
                          )}
                        </td>
                      )}
                      <td className="plists-actions">
                        {!editing && (
                          <>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={busy || Boolean(entry.renameBlockedReason)}
                              title={entry.renameBlockedReason ?? `Rename ${entry.name}`}
                              onClick={() => startRename(entry)}
                            >
                              Rename
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm plists-delete"
                              disabled={busy || Boolean(entry.deleteBlockedReason)}
                              title={entry.deleteBlockedReason ?? `${meta.deleteVerb}: ${entry.name}`}
                              onClick={() => setConfirmDelete(entry)}
                            >{copy.actions.delete}</button>
                          </>
                        )}
                        {(entry.renameBlockedReason || entry.deleteBlockedReason) && !editing && (
                          <span className="plists-blocked" title={entry.renameBlockedReason ?? entry.deleteBlockedReason ?? ""}>
                            {entry.qrCount > 0 ? "Locked — QR codes exist" : "In use"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {confirmDelete && (
        <div
          className="member-modal-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setConfirmDelete(null);
          }}
        >
          <section className="member-modal product-add-modal" role="dialog" aria-modal="true" aria-labelledby="plists-delete-title">
            <div className="member-modal-header">
              <div className="member-modal-identity">
                <div>
                  <h2 id="plists-delete-title">{meta.canAdd ? `Delete ${meta.singular}` : `Remove ${meta.singular}`}</h2>
                </div>
              </div>
              <button type="button" className="member-modal-close" aria-label={copy.common.close} onClick={() => setConfirmDelete(null)} disabled={busy}>
                ×
              </button>
            </div>
            <p className="qrm-modal-body">
              {meta.canAdd
                ? `${confirmDelete.name} will no longer be offered in the ${meta.singular} dropdown. Nothing else refers to it.`
                : `${confirmDelete.name} will disappear from the dropdown because ${plural(confirmDelete.productCount, "product")} carrying it will be disabled — the same as Disable on the Product List, and reversible there.`}
            </p>
            <code className="qrm-modal-code">{confirmDelete.name}</code>
            <div className="member-modal-actions">
              <span />
              <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(null)} disabled={busy}>{copy.common.cancel}</button>
              <button type="button" className="btn btn-danger" onClick={() => void submitDelete()} disabled={busy}>
                {busy ? "Working…" : meta.deleteVerb}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
};
