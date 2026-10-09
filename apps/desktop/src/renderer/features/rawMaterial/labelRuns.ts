import type { RawMaterialMovementConfigRow } from "../../types/desktopApi";
import { asText, formatQuantity, itemCategoryLabel, packName, type InventoryItemRow } from "./rawMaterial";

// The materials queued for one press of Print in the QR generator, and the arithmetic the
// screen shows for them.
//
//   Code   Name              Packets  Qty per packet  Total qty  Labels
//   RM-12  SK6 · BROWN       10       5 DOZEN         50 DOZEN   10
//   RM-12  SK6 · BROWN       5        4 DOZEN         20 DOZEN   5
//
// One label goes on one packet, so LABELS always equals PACKETS — both are shown because the
// operator counts stickers and the storekeeper counts packets, and they must agree.
//
// The same material may be queued twice: one delivery arrives 5 DOZEN to a packet and the next
// 4, and each label has to carry what its own packet holds. That is why a row is keyed by
// itself rather than by the material, and why what a packet holds is typed per row and never
// read back from the material's setup.
//
// Nothing here registers or prints anything — these are the shapes and the checks the generator
// applies before it asks the data layer to reserve a serial range.

/** The most labels one material may be given in a single run. */
export const MAX_RUN_LABELS = 10000;

/** One material queued for a label run. Both figures are held as typed. */
export interface LabelRun {
  /** Unique per ROW: the same material may be queued more than once. */
  key: string;
  itemId: string;
  /** The material's code — the short thing an operator recognises it by. */
  code: string;
  /** What tells this material apart, without the category prefix. */
  name: string;
  categoryLabel: string;
  subCategory: string;
  /** The unit the material's stock is counted in. Empty when it has none set yet. */
  unitCode: string;
  /** What this material's container is called — PACKET, BAG, ROLL … */
  packName: string;
  /** How many packets, and so how many labels. */
  packets: string;
  /** What ONE packet of this run holds, in `unitCode`. */
  perPacket: string;
}

export const newLabelRun = (
  item: InventoryItemRow,
  config: RawMaterialMovementConfigRow | undefined,
  key: string
): LabelRun => ({
  key,
  itemId: String(item.id),
  code: asText(item.item_code),
  name: materialShortName(item),
  categoryLabel: itemCategoryLabel(item),
  subCategory: asText(item.sub_category_name),
  unitCode: asText(item.unit_code) || asText(config?.stockUnitCode),
  packName: packName(config),
  packets: "",
  perPacket: "",
});

/**
 * A material's name with the category prefix taken off: "SK19 · BROWN · 8/13" rather than
 * "RAGZINE — RAGZINE UPPER — SK19 — BROWN — 8/13". The category has its own column.
 */
export const materialShortName = (item: InventoryItemRow): string => {
  const name = asText(item.display_name);
  const prefix = itemCategoryLabel(item);
  const distinguishing = prefix && name.startsWith(`${prefix} — `) ? name.slice(prefix.length + 3) : name;
  return distinguishing.split(" — ").join(" · ") || name;
};

const number = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text));

/** What one row comes to. Null figures where the row is not filled in enough to say. */
export interface LabelRunFigures {
  packets: number;
  perPacket: number;
  /** packets × what one packet holds, in the material's stock unit. */
  totalQuantity: number | null;
  /** One label per packet. */
  labels: number | null;
}

export const runFigures = (run: LabelRun): LabelRunFigures => {
  const packets = number(run.packets);
  const perPacket = number(run.perPacket);
  const bothKnown = Number.isFinite(packets) && Number.isFinite(perPacket);
  return {
    packets,
    perPacket,
    totalQuantity: bothKnown ? Number((packets * perPacket).toFixed(3)) : null,
    labels: Number.isFinite(packets) ? packets : null,
  };
};

/** "50 DOZEN", or a dash while the row is still being filled in. */
export const totalQuantityLabel = (run: LabelRun): string => {
  const { totalQuantity } = runFigures(run);
  if (totalQuantity == null) return "—";
  return `${formatQuantity(totalQuantity)}${run.unitCode ? ` ${run.unitCode}` : ""}`;
};

/**
 * Why a row cannot be printed yet, in the operator's words — or null when it can.
 *
 * The same rules the single-material generator applied, now per row. They are a courtesy: the
 * data layer checks the run again when it reserves the serial range.
 */
export const runProblem = (run: LabelRun): string | null => {
  if (!run.unitCode) return "This material has no stock unit yet. Set it on Stock before printing labels.";
  if (run.perPacket.trim() === "" || run.packets.trim() === "") return null;
  const { packets, perPacket } = runFigures(run);
  if (!Number.isFinite(perPacket) || perPacket <= 0) return `Type what one ${run.packName} holds — a number above 0.`;
  if (!Number.isFinite(packets) || !Number.isInteger(packets)) return "How many packets must be a whole number.";
  if (packets <= 0) return "At least 1 packet.";
  if (packets > MAX_RUN_LABELS) return `At most ${MAX_RUN_LABELS.toLocaleString()} labels per material.`;
  return null;
};

/** Whether a row is completely filled in and valid — the test Print applies to every row. */
export const runIsReady = (run: LabelRun): boolean =>
  run.packets.trim() !== "" && run.perPacket.trim() !== "" && runProblem(run) === null;

export interface LabelRunTotals {
  /** How many rows are queued — the same material twice counts twice. */
  articles: number;
  packets: number;
  labels: number;
}

export const labelRunTotals = (runs: readonly LabelRun[]): LabelRunTotals => {
  const packets = runs.reduce((total, run) => {
    const { packets: count } = runFigures(run);
    return total + (Number.isFinite(count) ? count : 0);
  }, 0);
  return { articles: runs.length, packets, labels: packets };
};
