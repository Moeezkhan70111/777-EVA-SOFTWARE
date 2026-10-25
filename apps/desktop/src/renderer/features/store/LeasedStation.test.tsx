import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { QrJourney, WriteLeaseStatus } from "../../types/desktopApi";
import { readOnlyReason } from "../../components/shared/ReadOnlyNotice";
import { LeasedStation } from "./LeasedStation";
import { lookupFeedback } from "./PacketLookup";

// The store's scan stations on a READER (docs/37 section W): the holder gets the station, a reader
// gets why it is read-only and a lookup instead, and an answer that cannot be read hides nothing --
// the main process refuses the write itself (leaseGuard.ts).

const STORE_HELD_ELSEWHERE: WriteLeaseStatus = {
  domain: "RAW_MATERIAL_STORE", canWrite: false, reason: "HELD_ELSEWHERE", holderLabel: "Store PC -- Aslam",
};

const withLeases = (getWriteLeases: () => Promise<WriteLeaseStatus[]>) =>
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api: { getWriteLeases: vi.fn(getWriteLeases) } },
    configurable: true,
  });

const renderStation = () =>
  render(
    <LeasedStation domain="RAW_MATERIAL_STORE" reader={(status) => <div>reader station: {status?.holderLabel}</div>}>
      <div>receiving station</div>
    </LeasedStation>
  );

describe("LeasedStation", () => {
  it("shows the station where this computer writes the store", async () => {
    withLeases(async () => [{ domain: "RAW_MATERIAL_STORE", canWrite: true, reason: null, holderLabel: null }]);
    renderStation();
    expect(await screen.findByText("receiving station")).toBeTruthy();
    expect(screen.queryByText(/reader station/)).toBeNull();
  });

  it("gives a reader its own station instead, never the receiving one", async () => {
    withLeases(async () => [STORE_HELD_ELSEWHERE]);
    renderStation();
    expect(await screen.findByText("reader station: Store PC -- Aslam")).toBeTruthy();
    expect(screen.queryByText("receiving station")).toBeNull();
  });

  it("waits while asking, so a reader never sees the station for a moment", () => {
    withLeases(() => new Promise(() => undefined));
    renderStation();
    expect(screen.queryByText("receiving station")).toBeNull();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("hides nothing when the answer cannot be read: the main process still decides", async () => {
    withLeases(async () => {
      throw new Error("unreadable");
    });
    renderStation();
    expect(await screen.findByText("receiving station")).toBeTruthy();
  });

  it("without a reader station, a reader sees why in words", async () => {
    withLeases(async () => [STORE_HELD_ELSEWHERE]);
    render(
      <LeasedStation domain="RAW_MATERIAL_STORE">
        <div>hand move form</div>
      </LeasedStation>
    );
    expect(await screen.findByText(/The raw material store is written on Store PC -- Aslam only/)).toBeTruthy();
    expect(screen.queryByText("hand move form")).toBeNull();
  });
});

describe("the read-only reasons", () => {
  it("names who writes it, and says what to do otherwise", () => {
    const base = { domain: "MASTER_DATA" as const, canWrite: false, holderLabel: null };
    expect(readOnlyReason({ ...base, reason: "NOT_HELD" })).toMatch(/No computer may write master data/);
    expect(readOnlyReason({ ...base, reason: "CATCHING_UP" })).toMatch(/still catching up/);
    expect(readOnlyReason({ ...base, reason: "NO_LEASE_INFO" })).toMatch(/Run Sync Now once while online/);
    expect(readOnlyReason({ ...base, canWrite: true, reason: null })).toBeNull();
  });
});

describe("the packet lookup", () => {
  const journey = {
    qrId: "RM-000123", kind: "RAW_MATERIAL", article: "NAWAAR — 5 SOOTAR — BLACK", supplierName: "Al-Madina Traders",
    stageLabel: "Issued to PACKING", stage: "ISSUED", currentStatus: "ISSUED", lastActivityAt: "2026-10-25T05:00:00.000Z",
  } as unknown as QrJourney;

  it("says where a packet is, and from whom it came", () => {
    const shown = lookupFeedback("RM-000123", journey, 3);
    expect(shown.tone).toBe("success");
    expect(shown.title).toBe("Issued to PACKING");
    expect(shown.result?.product).toBe("NAWAAR — 5 SOOTAR — BLACK");
    expect(shown.result?.facts?.find((fact) => fact.label === "Supplier")?.value).toBe("Al-Madina Traders");
    expect(shown.seq).toBe(3);
  });

  it("says plainly when the packet is not known here", () => {
    const shown = lookupFeedback("RM-999999", null, 4);
    expect(shown.tone).toBe("warn");
    expect(shown.message).toBe("No packet RM-999999 is known on this computer.");
  });
});
