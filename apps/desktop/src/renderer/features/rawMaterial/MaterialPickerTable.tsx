import React, { useMemo, useState } from "react";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { asText, itemCategoryLabel, type InventoryItemRow } from "./rawMaterial";
import { materialShortName } from "./labelRuns";

// SELECT MATERIAL — every raw material the store knows, filtered down to the one in front of
// the operator:
//
//   [ Search material… ]   Category [All ▾]   Sub-category [All ▾]
//   ☑  RM-12   SK6 · BROWN · 8/13   RAGZINE   RAGZINE UPPER   [ + Add ]
//
// The tick says whether a material is in the selection below; pressing it puts one row there
// or takes all of its rows away. + Add always appends ANOTHER row, because one delivery of the
// same material can arrive in two different packet sizes and each needs its own run.
//
// A store holds thousands of materials, so the list is filtered here and capped — the operator
// narrows it rather than scrolling it (R20).

/** The most rows drawn at once; the filters are how a longer list is reached. */
const VISIBLE_LIMIT = 200;

const ALL = "__all__";

interface MaterialPickerTableProps {
  items: InventoryItemRow[];
  /** Materials already in the selection, so the tick reflects it. */
  chosenItemIds: ReadonlySet<string>;
  onAdd: (item: InventoryItemRow) => void;
  onRemoveAll: (itemId: string) => void;
}

const matches = (item: InventoryItemRow, needle: string): boolean => {
  if (!needle) return true;
  const haystack = `${asText(item.display_name)} ${asText(item.item_code)}`.toLowerCase();
  return needle
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
};

export const MaterialPickerTable: React.FC<MaterialPickerTableProps> = ({ items, chosenItemIds, onAdd, onRemoveAll }) => {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState(ALL);
  const [subCategory, setSubCategory] = useState(ALL);

  const categories = useMemo(
    () => [...new Set(items.map((item) => asText(item.top_category_name) || asText(item.category_name)).filter(Boolean))].sort(),
    [items]
  );
  // Only the sub-categories of the chosen category, so the second filter can never contradict
  // the first and leave the table empty for no visible reason.
  const subCategories = useMemo(() => {
    const inScope = items.filter(
      (item) => category === ALL || (asText(item.top_category_name) || asText(item.category_name)) === category
    );
    return [...new Set(inScope.map((item) => asText(item.sub_category_name)).filter(Boolean))].sort();
  }, [items, category]);

  const shown = useMemo(
    () =>
      items.filter(
        (item) =>
          matches(item, search.trim()) &&
          (category === ALL || (asText(item.top_category_name) || asText(item.category_name)) === category) &&
          (subCategory === ALL || asText(item.sub_category_name) === subCategory)
      ),
    [items, search, category, subCategory]
  );

  return (
    <div className="qrp-picker">
      <div className="qrp-filters">
        <label className="qrp-filter qrp-filter--search">
          <span className="sr-only">{copy.labelPrint.searchMaterial}</span>
          <input
            type="search"
            className="form-input"
            placeholder={copy.labelPrint.searchMaterial}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="qrp-filter">
          <span className="input-label">{copy.columns.category}</span>
          <select
            className="form-input"
            value={category}
            onChange={(event) => {
              setCategory(event.target.value);
              setSubCategory(ALL);
            }}
          >
            <option value={ALL}>{copy.labelPrint.allFilter}</option>
            {categories.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="qrp-filter">
          <span className="input-label">{copy.labelPrint.subCategory}</span>
          <select className="form-input" value={subCategory} onChange={(event) => setSubCategory(event.target.value)}>
            <option value={ALL}>{copy.labelPrint.allFilter}</option>
            {subCategories.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {items.length === 0 ? (
        <StateView kind="empty" compact title={copy.labelPrint.noMaterialsTitle} hint={copy.labelPrint.noMaterialsHint} />
      ) : shown.length === 0 ? (
        <StateView kind="empty" compact title={copy.labelPrint.noMaterialMatch} />
      ) : (
        <>
          <div className="qrp-table-wrap">
            <table className="qrp-table">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">{copy.labelPrint.inSelection}</span>
                  </th>
                  <th scope="col">{copy.labelPrint.colCode}</th>
                  <th scope="col">{copy.columns.name}</th>
                  <th scope="col">{copy.columns.category}</th>
                  <th scope="col">{copy.labelPrint.subCategory}</th>
                  <th scope="col">{copy.labelPrint.colAction}</th>
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, VISIBLE_LIMIT).map((item) => {
                  const id = String(item.id);
                  const chosen = chosenItemIds.has(id);
                  const name = materialShortName(item);
                  return (
                    <tr key={id} className={chosen ? "is-chosen" : undefined}>
                      <td>
                        <input
                          type="checkbox"
                          checked={chosen}
                          aria-label={copy.labelPrint.toggleMaterial(name)}
                          onChange={() => (chosen ? onRemoveAll(id) : onAdd(item))}
                        />
                      </td>
                      <td className="qrp-code">{asText(item.item_code)}</td>
                      <td className="qrp-name">{name}</td>
                      <td>{asText(item.top_category_name) || asText(item.category_name)}</td>
                      <td>{asText(item.sub_category_name) || "—"}</td>
                      <td>
                        <button type="button" className="qrp-add" aria-label={copy.labelPrint.addMaterial(name)} onClick={() => onAdd(item)}>
                          <span aria-hidden="true">+</span> {copy.labelPrint.add}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {shown.length > VISIBLE_LIMIT ? (
            <p className="field-help">{copy.labelPrint.tooManyMaterials(VISIBLE_LIMIT, shown.length)}</p>
          ) : null}
        </>
      )}
    </div>
  );
};
