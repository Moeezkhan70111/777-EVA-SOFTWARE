import React from "react";
import type { ItemUnitLadderStep, RawMaterialMovementConfigRow, SyncWaitingEntry } from "../../types/desktopApi";
import { copy } from "../../config/copy";
import { StockRow } from "./StockRow";
import type { CategoryCount, StockGroup } from "./stockGroups";

// The Stock tab's list (1 Nov 2026): each category under a coloured pill with what it holds, its
// sub-categories under small headings, and a row a material. The category's colour is one of a
// few from the stylesheet, chosen by its name, so a category keeps its colour whatever is filtered.

const TONES = 6;

/** The same category always gets the same one of the stylesheet's tones. */
const toneOf = (category: string): number => {
  let sum = 0;
  for (const char of category) sum += char.charCodeAt(0);
  return sum % TONES;
};

interface StockListProps {
  groups: StockGroup[];
  counts: Map<string, CategoryCount>;
  configByItem: Map<string, RawMaterialMovementConfigRow>;
  ladders: Record<string, ItemUnitLadderStep[]>;
  awaitingItemIds: Set<string>;
  incomplete: Map<string, SyncWaitingEntry>;
  onOpen: (itemId: string) => void;
}

export const StockList: React.FC<StockListProps> = ({ groups, counts, configByItem, ladders, awaitingItemIds, incomplete, onOpen }) => (
  <div className="rm-stock-groups">
    {/* What each column is, once at the top: the figures in the rows carry no words of their own. */}
    <div className="rm-stock-columns" aria-hidden="true">
      <span>{copy.rawMaterialStock.columnMaterial}</span>
      <span>{copy.rawMaterialStock.inStore}</span>
      <span>{copy.rawMaterialStock.columnTotal}</span>
      <span />
    </div>
    {groups.map((group) => {
      const count = counts.get(group.category);
      return (
        <section key={group.key} className={`rm-stock-group rm-cat-tone-${toneOf(group.category)}`} aria-label={group.category || copy.store.noCategory}>
          <header className="rm-stock-group-head">
            <h3 className="rm-stock-pill">{group.category || copy.store.noCategory}</h3>
            <span className="rm-stock-group-line" aria-hidden="true" />
            {count ? <span className="rm-stock-group-count">{copy.rawMaterialStock.groupCount(count.materials, count.inStock)}</span> : null}
          </header>
          {group.subGroups.map((sub) => (
            <div key={sub.key} className="rm-stock-sub">
              {sub.subCategory ? <h4 className="rm-stock-sub-head">↳ {sub.subCategory}</h4> : null}
              <ul className="rm-stock-rows">
                {sub.items.map((item) => {
                  const id = String(item.id);
                  return (
                    <StockRow
                      key={id}
                      item={item}
                      config={configByItem.get(id)}
                      ladder={ladders[id] ?? []}
                      awaiting={awaitingItemIds.has(id)}
                      incomplete={incomplete.get(id)}
                      onOpen={() => onOpen(id)}
                    />
                  );
                })}
              </ul>
            </div>
          ))}
        </section>
      );
    })}
  </div>
);
