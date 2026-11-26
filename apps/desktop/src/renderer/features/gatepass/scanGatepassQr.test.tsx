import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GatepassNavigator } from "./GatepassNavigator";
import { VoucherNavigator } from "../billing/VoucherNavigator";

// The QR printed on a sale voucher, scanned into either No. box (owner, 26 Nov 2026): the scanner types the code and
// presses Enter, and that gatepass opens instead of a number being looked up. A typed number still goes as before.

const ID = "3f2b9c1e-8a4d-4c55-9e1f-2a7b6c0d9e11";
const scan = (input: HTMLElement, value: string) => {
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
};

describe("scanning a bill's gatepass QR into a No. box", () => {
  it("opens the gatepass from the Gatepass page's number box", () => {
    const onGo = vi.fn();
    const onScanGatepass = vi.fn();
    render(<GatepassNavigator current={42} latest={57} busy={false} onGo={onGo} onNew={() => undefined} onScanGatepass={onScanGatepass} />);
    const input = screen.getByTestId("gatepass-number-input");
    scan(input, `GPQR_${ID}`);
    expect(onScanGatepass).toHaveBeenCalledWith(ID);
    expect(onGo).not.toHaveBeenCalled();
    expect(input).toHaveValue("42");
    scan(input, "12");
    expect(onGo).toHaveBeenCalledWith(12);
  });

  it("opens the gatepass from the Sale Voucher page's number box", () => {
    const onGo = vi.fn();
    const onScanGatepass = vi.fn();
    render(<VoucherNavigator canPrev canNext busy={false} onPrev={() => undefined} onNext={() => undefined} onGo={onGo} onScanGatepass={onScanGatepass} />);
    const input = screen.getByTestId("voucher-number-input");
    scan(input, `GPQR_${ID}`);
    expect(onScanGatepass).toHaveBeenCalledWith(ID);
    expect(onGo).not.toHaveBeenCalled();
    expect(input).toHaveValue("");
    scan(input, "45");
    expect(onGo).toHaveBeenCalledWith("45");
  });
});
