import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GatepassScanPage } from "./GatepassScanPage";
import type { GatepassScanProgress } from "../../types/desktopApi";

// THE STORE MOVE OUT DESK for a gatepass that issued cartons directly (docs/42 section 10.2): it asks
// only for the QR cartons, shows the issued ones apart, and never calls them scanned.

const progress = (status: GatepassScanProgress["status"], required: number, issued: number, scanned: number): GatepassScanProgress => {
  const remaining = required - issued - scanned;
  const line = {
    productVariantId: "v1", article: "SK6", color: "RED", size: "7/10", requiredCartons: required, issuedDirectlyCartons: issued,
    storeScannedCartons: scanned, storeRemainingCartons: remaining, dispatchedCartons: 0, dispatchRemainingCartons: required - issued,
  };
  return {
    gatepassId: "gp-1", code: "GP-000200", status, partyName: "MAMA CHAPPAL", voucherNumber: "501", dispatchSessionId: "s-1",
    lines: [line], requiredCartons: required, issuedDirectlyCartons: issued, storeScannedCartons: scanned, storeRemainingCartons: remaining,
    dispatchedCartons: 0, dispatchRemainingCartons: required - issued,
  };
};

function openDesk(answer: GatepassScanProgress) {
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api: { getGatepassScanProgress: vi.fn().mockResolvedValue(answer) } },
    configurable: true,
  });
  render(<GatepassScanPage gatepassId="gp-1" desk="STORE" token="t" username="store-op" onBack={vi.fn()} />);
}

describe("the Store Move Out desk", () => {
  it("a manual-only gatepass: nothing to scan, said so, and its cartons shown as issued", async () => {
    openDesk(progress("AT_GATE", 4, 4, 0));
    expect(await screen.findByText("All cartons issued — No Store Scan Required")).toBeInTheDocument();
    expect(screen.getByTestId("gatepass-issued-directly")).toHaveTextContent("2 DZN");
    expect(screen.queryByText(/Every carton is scanned/)).not.toBeInTheDocument();
  });

  it("a mixed gatepass: asks for the remaining QR cartons only, and counts scans against them", async () => {
    openDesk(progress("BILLED", 5, 2, 1));
    expect(await screen.findByText("2 cartons issued directly. Scan the remaining 2 QR cartons.")).toBeInTheDocument();
    expect(screen.getByTestId("gatepass-scanned")).toHaveTextContent("0.5 DZN");
    expect(screen.getByTestId("gatepass-scanned").parentElement).toHaveTextContent("of 1.5 DZN");
    expect(screen.getByTestId("gatepass-remaining")).toHaveTextContent("1 DZN");
  });

  it("a QR-only gatepass reads exactly as before", async () => {
    openDesk(progress("BILLED", 4, 0, 0));
    expect(await screen.findByText("Scan a carton for this Gatepass")).toBeInTheDocument();
    expect(screen.queryByTestId("gatepass-issued-directly")).not.toBeInTheDocument();
  });
});
