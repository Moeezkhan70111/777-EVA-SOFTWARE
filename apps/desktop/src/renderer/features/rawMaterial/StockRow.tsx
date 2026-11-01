import React from "react";
import { quantityInBaseUnit } from "@erp/domain";
import type { ItemUnitLadderStep, RawMaterialMovementConfigRow, SyncWaitingEntry } from "../../types/desktopApi";
import { copy } from "../../config/copy";
import { formatWholeMoney } from "../../app/format";
import { IncompleteRowMark } from "../sync/IncompleteMaterials";
import { packCountLabel, packetsInStore, type InventoryItemRow } from "./rawMaterial";
import { stockNameParts } from "./stockGroups";

// One material on the Stock tab (1 Nov 2026): its name — what leads, then the rest in its category's
// colour — its code and cost, what the storekeeper counts on the shelf in large figures, the same
// stock measured out beside it in grey when that says something more, and View details. A material
// with nothing in store says "Out of stock" in words beside its name.

interface StockRowProps {
  item: InventoryItemRow;
  config: RawMaterialMovementConfigRow | undefined;
  /** The material's own chain of units, so the measured total can be said in the smallest one. */
  ladder: ItemUnitLadderStep[];
  awaiting: boolean;
  incomplete: SyncWaitingEntry | undefined;
  onOpen: () => void;
}

/** 4800 → "4,800"; up to three decimals, as the stock is kept. */
const figure = (value: number): string => value.toLocaleString("en-US", { maximumFractionDigits: 3 });

interface Amount {
  value: string;
  unit: string;
}

/**
 * What the storekeeper counts on the shelf: labelled packets, counted one by one because each holds
 * what its own label says. No packets (opening stock only) shows the measured balance instead.
 */
const onShelf = (item: InventoryItemRow, config: RawMaterialMovementConfigRow | undefined): Amount => {
  const packs = packetsInStore(config);
  if (packs == null) return { value: figure(Number(item.quantity_on_hand ?? 0)), unit: String(item.unit_code ?? "") };
  const [, ...noun] = packCountLabel(packs, config).split(" ");
  return { value: figure(packs), unit: noun.join(" ") };
};

/**
 * The same stock, measured out. A material with its own chain of units is said in the smallest one —
 * 16 RULE of a nawaar whose rule is 975 inches is 15,600 INCH — because that is the floor's figure.
 */
const measured = (item: InventoryItemRow, ladder: ItemUnitLadderStep[]): Amount => {
  const onHand = Number(item.quantity_on_hand ?? 0);
  const unitCode = String(item.unit_code ?? "");
  const steps = ladder.map((step) => ({ fromUnit: step.fromUnit, toUnit: step.toUnit, factor: step.factor }));
  const total = quantityInBaseUnit(steps, unitCode, onHand);
  return total ? { value: figure(total.quantity), unit: total.unit } : { value: figure(onHand), unit: unitCode };
};

const Figure: React.FC<{ amount: Amount; tone: "main" | "muted"; label: string }> = ({ amount, tone, label }) => (
  <div className={`rm-stock-figure rm-stock-figure--${tone}`} aria-label={`${label}: ${amount.value} ${amount.unit}`}>
    <strong>{amount.value}</strong>
    <span>{amount.unit}</span>
  </div>
);

/** The same figure twice says nothing: the total is shown only when it differs from what is on the shelf. */
const sameAmount = (a: Amount, b: Amount): boolean => a.value === b.value && a.unit === b.unit;

export const StockRow: React.FC<StockRowProps> = ({ item, config, ladder, awaiting, incomplete, onOpen }) => {
  const { lead, rest } = stockNameParts(item);
  const cost = item.cost_price != null ? copy.rawMaterialStock.cost(formatWholeMoney(Number(item.cost_price))) : null;
  const empty = Number(item.quantity_on_hand ?? 0) <= 0;
  const shelf = onShelf(item, config);
  const total = measured(item, ladder);
  return (
    // Named in full, category and all: on screen the group heading says the category instead.
    <li className={`rm-stock-row${empty ? " rm-stock-row--empty" : ""}`} aria-label={String(item.display_name ?? "")}>
      <div className="rm-stock-name-block">
        <div className="rm-stock-name-line">
          <button type="button" className="rm-stock-name" onClick={onOpen}>
            {lead}
            {rest ? <span className="rm-stock-name-rest"> — {rest}</span> : null}
          </button>
          {empty ? <span className="rm-stock-out">{copy.rawMaterialStock.outOfStock}</span> : null}
        </div>
        <span className="rm-stock-meta">
          <span className="rm-stock-code">{String(item.item_code ?? "")}</span>
          {cost ? <span className="rm-stock-cost">{cost}</span> : null}
        </span>
        {/* Said in words, not by colour alone: a disabled row is in the list only because "Show
            disabled" is on, and it is not in use. */}
        {String(item.status ?? "ACTIVE") === "INACTIVE" ? <span className="rm-awaiting">⚠ {copy.removal.disabledBadge}</span> : null}
        {awaiting ? <span className="rm-awaiting">⏳ {copy.rawMaterialStock.correctionWaiting}</span> : null}
        <IncompleteRowMark entry={incomplete} />
      </div>
      <Figure amount={shelf} tone="main" label={copy.rawMaterialStock.inStore} />
      {sameAmount(shelf, total) ? <span className="rm-stock-figure-none" aria-hidden="true" /> : <Figure amount={total} tone="muted" label={copy.rawMaterialStock.totalQty} />}
      <button type="button" className="rm-stock-open" onClick={onOpen}>
        {copy.rawMaterialStock.viewDetails}
      </button>
    </li>
  );
};
