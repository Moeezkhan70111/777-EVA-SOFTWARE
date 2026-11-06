import type { StationScanRow, StationTallyGroup } from "../scanStation/scanStation";
import { materialNameParts } from "./rawMaterial";

// A raw material session as the Store page's rail lists it (1 Nov 2026), for Move in and Move out
// alike: each packet as a recent line, and the session's per-material totals grouped by category.
// The totals themselves are the data layer's (byMaterial): this only sorts them into groups, splits
// each name the way the material pickers do, and counts a group's packets.

/** One material's total in a session, as both session summaries give it. */
export interface SessionMaterialTotal {
  itemDisplayName: string;
  categoryLabel?: string;
  packets: number;
  quantity: number;
  unitCode: string;
}

/** One packet of a session, as both session summaries give it. */
export interface SessionPacket {
  qrId: string;
  itemDisplayName: string;
  categoryLabel?: string;
  quantity: number;
  unitCode: string;
}

/**
 * One packet as a recent line: SK19 (bold) · BROWN · 8/13 · its sub-category as the tag · QR ·
 * what the packet moved. `at` is when it moved; `badge` is what the full-screen table says.
 */
export const materialScanRow = (scan: SessionPacket, at: string, badge: string): StationScanRow => {
  const category = scan.categoryLabel ?? "";
  const [name, ...rest] = materialNameParts(scan.itemDisplayName, category);
  const amount = `${scan.quantity} ${scan.unitCode}`.trim();
  return {
    key: `${scan.qrId}|${at}`,
    qrId: scan.qrId,
    product: `${scan.itemDisplayName} · ${amount}`,
    at,
    badge,
    name: name ?? scan.itemDisplayName,
    detail: rest.join(" · ") || undefined,
    tag: category.split(" — ").pop() || undefined,
    amount,
  };
};

/** "UPPER — LADIES" → "UPPER · LADIES"; a material with no category goes under `noCategory`. */
const groupLabel = (categoryLabel: string, noCategory: string): string =>
  categoryLabel ? categoryLabel.split(" — ").join(" · ") : noCategory;

export const sessionGroups = (byMaterial: readonly SessionMaterialTotal[], noCategory: string): StationTallyGroup[] => {
  const groups = new Map<string, StationTallyGroup>();
  for (const material of byMaterial) {
    const category = material.categoryLabel ?? "";
    const [name, ...rest] = materialNameParts(material.itemDisplayName, category);
    const group = groups.get(category) ?? { key: category || "-", label: groupLabel(category, noCategory), count: 0, lines: [] };
    group.count += material.packets;
    group.lines.push({
      key: `${material.itemDisplayName}|${material.unitCode}`,
      name: name ?? material.itemDisplayName,
      detail: rest.join(" · ") || undefined,
      count: material.packets,
      amount: `${material.quantity} ${material.unitCode}`.trim(),
    });
    groups.set(category, group);
  }
  return [...groups.entries()].sort(byCategoryName).map(([, group]) => group);
};

/** Categories in name order; a material with no category last. */
const byCategoryName = ([a]: [string, StationTallyGroup], [b]: [string, StationTallyGroup]): number => {
  if (a === b) return 0;
  if (a === "") return 1;
  if (b === "") return -1;
  return a.localeCompare(b);
};
