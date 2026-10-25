// A wait is never silent (owner decision 2026-10-25). These hold the words and the three places
// they appear: the stock row, the stock screen's notice, and the app-wide notice.
//
// Assertions are about WORDS, not classes: a mark that is only amber does not tell anyone which
// row is incomplete (R18).

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SyncWaiting, SyncWaitingEntry } from "../../types/desktopApi";
import { appNotice, describeWait, incompleteMaterials, isSyncWaiting, stockNotice } from "./syncWaiting";
import { IncompleteMaterials, IncompleteRowMark } from "./IncompleteMaterials";
import { SyncWaitingNotice } from "./SyncWaitingNotice";

const HOUR = 3_600_000;

const entry = (over: Partial<SyncWaitingEntry> = {}): SyncWaitingEntry => ({
  dedupeKey: "INVENTORY_ITEM:i-1:2",
  aggregateType: "INVENTORY_ITEM",
  aggregateId: "i-1",
  name: "NAWAAR — 5 SOOTAR — BLACK",
  cause: { kind: "MISSING", record: "INVENTORY_CATEGORY", id: "c-17" },
  since: "2026-10-23T00:00:00.000Z",
  ageMs: 2 * HOUR,
  tier: "STUCK",
  itemId: "i-1",
  itemHere: true,
  ...over,
});

const summary = (entries: SyncWaitingEntry[]): SyncWaiting => ({
  entries,
  waiting: entries.filter((item) => item.tier === "WAITING").length,
  stuck: entries.filter((item) => item.tier === "STUCK").length,
  stale: entries.filter((item) => item.tier === "STALE").length,
  oldestSince: entries[0]?.since ?? null,
  unsentMarks: 0,
  deadLetters: 0,
});

afterEach(() => {
  delete (window as unknown as { desktop?: unknown }).desktop;
  vi.restoreAllMocks();
});

describe("the words", () => {
  it("says what waits, for what, and for how long", () => {
    expect(describeWait(entry())).toEqual({
      subject: "Material NAWAAR — 5 SOOTAR — BLACK",
      waitingFor: "a category that has not reached this computer (c-17)",
      duration: "2 hours",
    });
    expect(describeWait(entry({ name: null, cause: { kind: "DISPLACED", columns: ["party_name"] }, aggregateType: "PARTY", aggregateId: "p-a" })).subject).toBe("Party p-a");
  });

  it("takes only a well-formed answer from the main process", () => {
    expect(isSyncWaiting(summary([entry()]))).toBe(true);
    expect(isSyncWaiting({ entries: [{ dedupeKey: 1 }], waiting: 0, stuck: 0, stale: 0, unsentMarks: 0, deadLetters: 0 })).toBe(false);
    expect(isSyncWaiting(null)).toBe(false);
  });
});

describe("the stock screen", () => {
  it("marks each incomplete row, under an hour too, with what it waits for read out", () => {
    const incomplete = incompleteMaterials(summary([entry({ tier: "WAITING", ageMs: 5 * 60_000 })]));
    render(<IncompleteRowMark entry={incomplete.get("i-1")} />);
    expect(screen.getByText(/Still arriving/)).toBeTruthy();
    expect(screen.getByText(/waiting for a category that has not reached this computer \(c-17\), for 5 minutes/)).toBeTruthy();
  });

  it("marks nothing on a row that waits for nothing", () => {
    const { container } = render(<IncompleteRowMark entry={undefined} />);
    expect(container.textContent).toBe("");
  });

  it("keeps a notice above the table only once a wait has lasted", () => {
    expect(stockNotice(incompleteMaterials(summary([entry({ tier: "WAITING" })])))).toBeNull();
    const lasting = incompleteMaterials(summary([entry({ ageMs: 2 * 86_400_000, tier: "STALE" }), entry({ dedupeKey: "k2", itemId: "i-2" })]));
    expect(stockNotice(lasting)).toBe(
      "Stock on this computer is incomplete: 2 materials are waiting for records that have not arrived, the oldest for 2 days. Details on Health."
    );
  });

  it("lists the materials that are not on this computer at all, which the table cannot show", () => {
    const incomplete = incompleteMaterials(summary([entry({ itemHere: false, tier: "WAITING" })]));
    render(<IncompleteMaterials incomplete={incomplete} />);
    expect(screen.getByText("Not on this computer yet")).toBeTruthy();
    expect(screen.getByText("Material NAWAAR — 5 SOOTAR — BLACK")).toBeTruthy();
  });
});

describe("the app-wide notice", () => {
  it("is silent under an hour, a warning over an hour, an error over a day", () => {
    expect(appNotice(summary([entry({ tier: "WAITING" })]))).toBeNull();
    expect(appNotice(summary([entry()]))?.level).toBe("STUCK");
    expect(appNotice(summary([entry(), entry({ dedupeKey: "k2", tier: "STALE", ageMs: 30 * HOUR })]))?.level).toBe("STALE");
  });

  it("stays dismissed for the waits it was shown for, and comes back for a new one", async () => {
    const current = summary([entry({ tier: "STALE", ageMs: 30 * HOUR })]);
    const getSyncWaiting = vi.fn(() => Promise.resolve({ accepted: true, value: current }));
    (window as unknown as { desktop: unknown }).desktop = { api: { getSyncWaiting } };
    const onOpenHealth = vi.fn();
    render(<SyncWaitingNotice onOpenHealth={onOpenHealth} />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Open Health" }));
    expect(onOpenHealth).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a dismissal is keyed to the waits shown: the same ones stay dismissed, a new one or a worse tier does not", () => {
    const stuck = entry();
    const shown = appNotice(summary([stuck]))?.signature;
    expect(appNotice(summary([{ ...stuck, ageMs: 3 * HOUR }]))?.signature).toBe(shown);
    expect(appNotice(summary([stuck, entry({ dedupeKey: "k2" })]))?.signature).not.toBe(shown);
    expect(appNotice(summary([{ ...stuck, tier: "STALE", ageMs: 30 * HOUR }]))?.signature).not.toBe(shown);
  });
});
