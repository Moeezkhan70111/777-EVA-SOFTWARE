import React, { useMemo, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import type { WorkSection } from "../../types/desktopApi";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { Modal } from "./Modal";
import { CategoryAttributes } from "./CategoryAttributes";
import { AttributeLibrary } from "./AttributeLibrary";
import { MachinesPanel } from "./MachinesPanel";
import {
  COMMON_PACK_NAMES,
  PACK_NAME_FALLBACK,
  buildAttributeLibrary,
  categoryPackName,
  categoryPath,
  isSubCategory,
  subCategoriesOf,
  topCategories,
  type CategoryRow,
} from "./rawMaterial";
import { downloadCsv, exportFileName } from "../../utils/exportFile";
import { buildSetupSheet } from "./rawMaterialExports";

// Master data for raw material: what kinds of material exist (categories), what tells them
// apart (attributes), what they are counted in (units and conversions) and where they can be
// sent (destinations).
//
// This was "Inventory Categories" under Settings, which hid it from the people who use it —
// inventory_items are raw materials only (their codes are RM-000001), so this has always been
// raw material setup.

const emptyCategory = { name: "", description: "", packName: "" };

interface SetupTabProps {
  categories: CategoryRow[];
  units: Array<Record<string, unknown>>;
  sections: WorkSection[];
  loading: boolean;
  error: string | null;
  /** An administrator decides a category removal; everyone else asks for one. */
  isAdmin: boolean;
  onChanged: () => Promise<void>;
}

export const SetupTab: React.FC<SetupTabProps> = ({ categories, units, sections, loading, error, isAdmin, onChanged }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [selectedId, setSelectedId] = useState("");
  /** Set while creating a sub-category: the category the new one will sit under. */
  const [creatingUnder, setCreatingUnder] = useState<CategoryRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(emptyCategory);
  const [saving, setSaving] = useState(false);

  const selected = categories.find((row) => String(row.id) === selectedId) ?? categories[0];
  const library = useMemo(() => buildAttributeLibrary(categories), [categories]);

  const createCategory = async () => {
    if (!draft.name.trim()) return;
    setSaving(true);
    try {
      const result = await api.createInventoryCategory({
        ...draft,
        parentId: creatingUnder ? String(creatingUnder.id) : null,
      });
      if (!result.accepted) {
        push("error", "Category not created", result.reason ?? "The category could not be saved.");
        return;
      }
      push("success", creatingUnder ? "Sub-category created" : "Category created", draft.name);
      setCreating(false);
      setCreatingUnder(null);
      setDraft(emptyCategory);
      await onChanged();
      if (result.id) setSelectedId(String(result.id));
    } finally {
      setSaving(false);
    }
  };

  const renameCategory = async () => {
    if (!selected || !draft.name.trim()) return;
    setSaving(true);
    try {
      const result = await api.updateInventoryCategory(String(selected.id), draft);
      if (!result.accepted) {
        push("error", "Category not saved", result.reason ?? "The category could not be saved.");
        return;
      }
      push("success", "Category saved", draft.name);
      setRenaming(false);
      await onChanged();
    } finally {
      setSaving(false);
    }
  };

  // The category a sub-category being created or edited sits under — its container is the default.
  const parentForDraft = creating ? creatingUnder : renaming && selected?.parent_id ? categories.find((row) => String(row.id) === String(selected.parent_id)) : null;
  const inheritedPack = parentForDraft ? categoryPackName(parentForDraft, categories) ?? PACK_NAME_FALLBACK : PACK_NAME_FALLBACK;

  const categoryFields = (
    <>
      <div className="form-group">
        <label className="input-label" htmlFor="rm-cat-name">
          {copy.columns.name}
          <span className="required-mark"> *</span>
        </label>
        <input
          id="rm-cat-name"
          className="form-input"
          autoFocus
          placeholder="e.g. RUBBER UPPER"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value.toUpperCase() })}
        />
      </div>
      <div className="form-group">
        <label className="input-label" htmlFor="rm-cat-desc">
          {copy.columns.description}
        </label>
        <input
          id="rm-cat-desc"
          className="form-input"
          placeholder="Optional"
          value={draft.description}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </div>
      {/* What every material in this category arrives in — "One BAG holds…" on the labels,
          "3 BAGS" on the stock. A sub-category left blank follows the category above it. */}
      <div className="form-group">
        <label className="input-label" htmlFor="rm-cat-pack">
          Comes in
        </label>
        <input
          id="rm-cat-pack"
          className="form-input"
          list="rm-cat-pack-names"
          placeholder={parentForDraft ? `Same as ${String(parentForDraft.name)} — ${inheritedPack}` : `e.g. BAG, BOTTLE (blank = ${PACK_NAME_FALLBACK})`}
          value={draft.packName}
          onChange={(event) => setDraft({ ...draft, packName: event.target.value.toUpperCase() })}
        />
        <datalist id="rm-cat-pack-names">
          {COMMON_PACK_NAMES.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <span className="field-help">
          {parentForDraft
            ? `Leave blank to use ${inheritedPack}, like ${String(parentForDraft.name)}.`
            : "What one label goes on: a packet, a bag, a bottle…"}
        </span>
      </div>
    </>
  );

  if (loading) return <StateView kind="loading" message="Loading setup…" />;
  if (error) return <StateView kind="error" message={error} onRetry={() => void onChanged()} />;

  return (
    <div className="rm-setup">
      <div className="rm-setup-panels">
        <MachinesPanel sections={sections} />
      </div>

      <div className="rm-section-head rm-setup-head">
        <h2 className="rm-section-title">Categories &amp; attributes</h2>
        <span className="rm-section-note">What kinds of raw material exist, and what tells them apart.</span>
        {categories.length > 0 ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm rm-section-action"
            onClick={() => downloadCsv(exportFileName("raw-material-setup"), buildSetupSheet(categories))}
            title="A reference copy of the attribute model. Setup is changed here, never by uploading a file."
          >
            Export setup (Excel)
          </button>
        ) : null}
      </div>

      <div className="inv-cat-workspace3">
        <aside className="inv-cat-sidebar">
          <div className="inv-cat-sidebar-header">
            <span className="inv-cat-eyebrow">Categories</span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                setDraft(emptyCategory);
                setCreatingUnder(null);
                setCreating(true);
              }}
            >
              + New
            </button>
          </div>

          <nav className="inv-cat-category-nav" aria-label="Raw material categories">
            {categories.length === 0 ? (
              <div className="rm-muted inv-cat-lib-empty">No categories yet.</div>
            ) : (
              topCategories(categories).map((category) => (
                <div key={String(category.id)} className="inv-cat-nav-group">
                  <CategoryBranch
                    categories={categories}
                    category={category}
                    depth={0}
                    selectedId={String(selected?.id ?? "")}
                    onSelect={setSelectedId}
                    onAddSub={(parent) => {
                      setDraft(emptyCategory);
                      setCreatingUnder(parent);
                      setCreating(true);
                    }}
                  />
                </div>
              ))
            )}
          </nav>
        </aside>

        {selected ? (
          <CategoryAttributes
            category={selected}
            isAdmin={isAdmin}
            categories={categories}
            packName={categoryPackName(selected, categories) ?? PACK_NAME_FALLBACK}
            onChanged={onChanged}
            onRename={() => {
              setDraft({
                name: String(selected.name ?? ""),
                description: String(selected.description ?? ""),
                packName: String(selected.pack_name ?? ""),
              });
              setRenaming(true);
            }}
          />
        ) : (
          <div className="inv-cat-assigned-panel">
            <StateView
              kind="empty"
              title="No category selected"
              hint="Create a category — a kind of raw material, such as RUBBER UPPER — to start."
              action={{ label: "+ New category", onClick: () => { setDraft(emptyCategory); setCreatingUnder(null); setCreating(true); } }}
            />
          </div>
        )}

        <AttributeLibrary library={library} selectedCategory={selected} onChanged={onChanged} />
      </div>

      {creating ? (
        <Modal
          title={creatingUnder ? `New sub-category of ${String(creatingUnder.name)}` : "New category"}
          subtitle={
            creatingUnder
              ? `A kind of ${String(creatingUnder.name)}. It asks for everything ${String(creatingUnder.name)} asks for, plus whatever tells its own materials apart.`
              : "A kind of raw material, such as RUBBER UPPER. It can be given sub-categories afterwards."
          }
          onClose={() => {
            setCreating(false);
            setCreatingUnder(null);
          }}
          footer={
            <button type="button" className="btn btn-primary" disabled={saving || !draft.name.trim()} onClick={() => void createCategory()}>
              {saving ? "Saving…" : creatingUnder ? "Create sub-category" : "Create category"}
            </button>
          }
        >
          {categoryFields}
        </Modal>
      ) : null}

      {renaming ? (
        <Modal
          title={selected?.parent_id ? "Edit sub-category" : "Edit category"}
          onClose={() => setRenaming(false)}
          footer={
            <button type="button" className="btn btn-primary" disabled={saving || !draft.name.trim()} onClick={() => void renameCategory()}>
              {saving ? "Saving…" : copy.common.save}
            </button>
          }
        >
          {categoryFields}
        </Modal>
      ) : null}
    </div>
  );
};

/**
 * One category and everything beneath it, however deep. Each row offers "+ Sub", because a
 * category at any level can be given kinds of its own.
 */
const CategoryBranch: React.FC<{
  categories: CategoryRow[];
  category: CategoryRow;
  depth: number;
  selectedId: string;
  onSelect: (id: string) => void;
  onAddSub: (parent: CategoryRow) => void;
}> = ({ categories, category, depth, selectedId, onSelect, onAddSub }) => (
  <>
    <CategoryNavItem
      category={category}
      depth={depth}
      active={String(category.id) === selectedId}
      onSelect={() => onSelect(String(category.id))}
      onAddSub={() => onAddSub(category)}
    />
    {subCategoriesOf(categories, String(category.id)).map((child) => (
      <CategoryBranch
        key={String(child.id)}
        categories={categories}
        category={child}
        depth={depth + 1}
        selectedId={selectedId}
        onSelect={onSelect}
        onAddSub={onAddSub}
      />
    ))}
  </>
);

/** One row of the category tree, indented by how deep it sits. */
const CategoryNavItem: React.FC<{
  category: CategoryRow;
  depth: number;
  active: boolean;
  onSelect: () => void;
  onAddSub?: () => void;
}> = ({ category, depth, active, onSelect, onAddSub }) => (
  // How deep it sits drives the indent and the guide line, so a tree four levels deep still
  // reads as a tree. One CSS rule covers every level.
  <div
    className={`inv-cat-nav-row${depth > 0 ? " inv-cat-nav-row--sub" : ""}`}
    style={{ "--depth": depth } as React.CSSProperties}
  >
    <button
      type="button"
      className={`inv-cat-nav-item${active ? " inv-cat-nav-item--active" : ""}`}
      aria-current={active ? "true" : undefined}
      onClick={onSelect}
    >
      <span className="inv-cat-nav-name" title={String(category.name)}>{String(category.name)}</span>
      <span className="inv-cat-nav-count">{(category.fields ?? []).length}</span>
    </button>
    {onAddSub ? (
      <button
        type="button"
        className="inv-cat-nav-add-sub"
        title={`Add a sub-category of ${String(category.name)}`}
        aria-label={`Add a sub-category of ${String(category.name)}`}
        onClick={onAddSub}
      >
        + Sub
      </button>
    ) : null}
  </div>
);
