import React from "react";
import { copy } from "../../config/copy";
import { categoryPath, descendantsOf, topCategories, type CategoryRow } from "./rawMaterial";

// The Stock tab's category filter as buttons (1 Nov 2026): every category in one row, and once one
// is chosen, a second row with everything beneath it — sub-categories and their own, however deep
// (ACCESSORY ▸ TAG ▸ RUBBER TAG reads "TAG ▸ RUBBER TAG"). The chosen button says so with
// aria-pressed, not by colour alone.

interface CategoryFilterBarProps {
  categories: CategoryRow[];
  /** The chosen top-level category, or "" for all of them. */
  categoryId: string;
  /** The chosen level beneath it, or "" for all of the category. */
  subCategoryId: string;
  onCategory: (categoryId: string) => void;
  onSubCategory: (subCategoryId: string) => void;
}

/** A level beneath the chosen category, named by its path below it: "TAG ▸ RUBBER TAG". */
const levelLabel = (row: CategoryRow): string => categoryPath(row).split(" — ").slice(1).join(" ▸ ");

const FilterButton: React.FC<{ label: string; pressed: boolean; level: "category" | "sub"; onPress: () => void }> = ({
  label,
  pressed,
  level,
  onPress,
}) => (
  <button type="button" className={`rm-catbar-btn rm-catbar-btn--${level}`} aria-pressed={pressed} onClick={onPress}>
    {label}
  </button>
);

export const CategoryFilterBar: React.FC<CategoryFilterBarProps> = ({ categories, categoryId, subCategoryId, onCategory, onSubCategory }) => {
  const chosen = categories.find((row) => String(row.id) === categoryId);
  const beneath = categoryId ? descendantsOf(categories, categoryId) : [];

  return (
    <div className="rm-catbar">
      <div className="rm-catbar-row" role="group" aria-label={copy.rawMaterialStock.categoryFilter}>
        <FilterButton label={copy.rawMaterialStock.allCategories} pressed={categoryId === ""} level="category" onPress={() => onCategory("")} />
        {topCategories(categories).map((row) => (
          <FilterButton
            key={String(row.id)}
            label={String(row.name)}
            pressed={String(row.id) === categoryId}
            level="category"
            onPress={() => onCategory(String(row.id))}
          />
        ))}
      </div>
      {chosen && beneath.length > 0 ? (
        // Keyed by the category, so the row slides in afresh each time another is chosen.
        <div key={categoryId} className="rm-catbar-row rm-catbar-row--sub" role="group" aria-label={copy.rawMaterialStock.subCategoryFilter(String(chosen.name))}>
          <span className="rm-catbar-sub-mark" aria-hidden="true">↳</span>
          <FilterButton
            label={copy.rawMaterialStock.allOf(String(chosen.name))}
            pressed={subCategoryId === ""}
            level="sub"
            onPress={() => onSubCategory("")}
          />
          {beneath.map((row) => (
            <FilterButton
              key={String(row.id)}
              label={levelLabel(row)}
              pressed={String(row.id) === subCategoryId}
              level="sub"
              onPress={() => onSubCategory(String(row.id))}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};
