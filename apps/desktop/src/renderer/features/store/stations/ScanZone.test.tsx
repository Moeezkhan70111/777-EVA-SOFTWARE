import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScanZone } from "./ScanZone";
import { BeforeThat, CountRow, beforeThat } from "./ScanCount";
import type { ScanState } from "./scanState";

// THE SCAN ZONE (0.3.9): one answer, in one of three states. Each must say which it is in words and
// an icon, never by colour alone, so it reads in greyscale.

const SCANNING: ScanState = { kind: "scanning", title: "Scan the next packet", line: "Each packet is counted as received from SHEHZAD RUBBER." };
const IDLE: ScanState = { kind: "idle", title: "Whose delivery is this?", line: "Choose the supplier, then press Start scanning." };

const zone = (outcome: React.ComponentProps<typeof ScanZone>["outcome"], state: ScanState = SCANNING) =>
  render(<ScanZone mode="in" outcome={outcome} state={state} doneWord="Received" notDoneWord="Not received" />);

describe("ScanZone", () => {
  it("accepted: the band, then the category line, the headline, how much and the packet, in that order", () => {
    zone({
      kind: "accepted",
      seq: 1,
      material: { category: "Upper · Rubber upper", name: "SK52 · BLACK BLUE · 8/10" },
      quantity: "2 DOZ",
      code: "RM_SHEHZAD_SK52_000012",
      note: null,
    });
    const block = screen.getByTestId("scan-zone");
    expect(block).toHaveAttribute("data-state", "accepted");
    expect(screen.getByTestId("scan-state")).toHaveClass("sz-band");
    expect(block.textContent).toBe("ReceivedUpper · Rubber upperSK52 · BLACK BLUE · 8/102 DOZRM_SHEHZAD_SK52_000012");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refused: an alert that says Not received, why, the packet, what happened and what to do", () => {
    zone({
      kind: "refused",
      seq: 2,
      reason: "This packet is already in",
      code: "RM_SHEHZAD_DANARED_000012",
      happened: "You scanned it at 10:42, as packet 12 of this session.",
      todo: "Put it aside and scan the next one.",
    });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("data-state", "refused");
    expect(alert.textContent).toBe(
      "Not receivedThis packet is already inRM_SHEHZAD_DANARED_000012You scanned it at 10:42, as packet 12 of this session.Put it aside and scan the next one."
    );
  });

  it("waiting: the question to answer, and whatever helps answer it", () => {
    render(
      <ScanZone mode="out" outcome={{ kind: "waiting", seq: 0 }} state={IDLE} doneWord="Issued" notDoneWord="Not issued">
        <button type="button">Start scanning</button>
      </ScanZone>
    );
    expect(screen.getByTestId("scan-state")).toHaveTextContent("Whose delivery is this?");
    expect(screen.getByText("Choose the supplier, then press Start scanning.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start scanning" })).toBeInTheDocument();
  });

  it("waits whenever the station cannot take a scan, whatever the last answer was", () => {
    zone({ kind: "accepted", seq: 3, material: { category: null, name: "DANA" }, quantity: null, code: null, note: null }, IDLE);
    expect(screen.getByTestId("scan-zone")).toHaveAttribute("data-state", "waiting");
  });
});

describe("CountRow and Before that", () => {
  it("is one row: the number, what it counts, and the quantity total", () => {
    const { rerender } = render(<CountRow count={12} quantity="300 KG" unchanged={false} />);
    expect(screen.getByTestId("scan-count")).toHaveTextContent("12packets in this batch300 KG");
    rerender(<CountRow count={1} quantity="25 KG" unchanged={false} />);
    expect(screen.getByTestId("scan-count")).toHaveTextContent("1packet in this batch25 KG");
    rerender(<CountRow count={12} quantity="300 KG" unchanged />);
    expect(screen.getByTestId("scan-count")).toHaveTextContent("12packets in this batch — unchanged300 KG");
  });

  const row = (n: number) => ({ key: `k${n}`, qrId: `RM_${n}`, product: `DANA · ${n} KG`, at: "2026-10-30T05:00:00.000Z", badge: "In Store" });
  const rows = [row(5), row(4), row(3), row(2), row(1)];

  it("after an accepted scan, leaves out the packet just scanned and lists the three before it", () => {
    const accepted = { kind: "accepted" as const, seq: 1, material: { category: null, name: "DANA" }, quantity: null, code: "RM_5", note: null };
    expect(beforeThat(rows, accepted).map((r) => r.qrId)).toEqual(["RM_4", "RM_3", "RM_2"]);
  });

  it("after a refusal nothing was added, so it lists the newest three", () => {
    const refused = { kind: "refused" as const, seq: 2, reason: "x", code: "RM_4", happened: null, todo: "y" };
    expect(beforeThat(rows, refused).map((r) => r.qrId)).toEqual(["RM_5", "RM_4", "RM_3"]);
  });

  it("lists code then what it was", () => {
    render(<BeforeThat rows={[row(4), row(3)]} />);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["RM_4DANA · 4 KG", "RM_3DANA · 3 KG"]);
  });
});
