import React, { useEffect } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The desk's promise: the scanner on the right is opened once and stays open while the
// operator switches the left half between the new-material form and the label generator.
// The halves themselves are the existing implementations, so they are stood in for here and
// only the desk's own behaviour is tested.

const scanner = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

vi.mock("../../pages/RawMaterialInputPage", () => ({
  RawMaterialInputPage: ({ embedded }: { embedded?: boolean }) => {
    useEffect(() => {
      scanner.mounts += 1;
      return () => {
        scanner.unmounts += 1;
      };
    }, []);
    return <div data-testid="scanner">{embedded ? "embedded scanner" : "scanner"}</div>;
  },
}));
vi.mock("../rawMaterial/NewMaterialModal", () => ({
  NewMaterialModal: () => <div data-testid="material-form">new material form</div>,
}));
vi.mock("../rawMaterial/LabelsTab", () => ({
  LabelsTab: () => <div data-testid="labels">label generator</div>,
}));
vi.mock("../rawMaterial/useRawMaterialLookups", () => ({
  useRawMaterialLookups: () => ({
    categories: [{ id: "c1" }],
    units: [],
    configByItem: new Map(),
    sections: [],
    loading: false,
    error: null,
    reload: async () => {},
  }),
}));

import { MoveInDeskPage } from "./MoveInDeskPage";

const ALL = { stock: true, labels: true };

describe("MoveInDeskPage", () => {
  it("keeps the scanner open while the left half switches between the form and the labels", () => {
    scanner.mounts = 0;
    scanner.unmounts = 0;
    const onNavigate = vi.fn();
    const { rerender } = render(<MoveInDeskPage pane="material" token="t" access={ALL} onNavigate={onNavigate} />);

    expect(screen.getByTestId("material-form")).toBeInTheDocument();
    expect(screen.getByTestId("scanner")).toHaveTextContent("embedded scanner");

    fireEvent.click(screen.getByRole("button", { name: /Raw Material QR/ }));
    expect(onNavigate).toHaveBeenCalledWith("store-in-qr-generator");
    rerender(<MoveInDeskPage pane="labels" token="t" access={ALL} onNavigate={onNavigate} />);
    expect(screen.getByTestId("labels")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Add New Material/ }));
    expect(onNavigate).toHaveBeenCalledWith("store-in-new-material");
    rerender(<MoveInDeskPage pane="material" token="t" access={ALL} onNavigate={onNavigate} />);

    expect(scanner.mounts).toBe(1);
    expect(scanner.unmounts).toBe(0);
  });

  it("disables the half this operator has no permission for", () => {
    render(<MoveInDeskPage pane="material" token="t" access={{ stock: true, labels: false }} onNavigate={vi.fn()} />);
    expect((screen.getByRole("button", { name: /Raw Material QR/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("goes back to the Move In cards", () => {
    const onNavigate = vi.fn();
    render(<MoveInDeskPage pane="labels" token="t" access={ALL} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: /^Move In$/ }));
    expect(onNavigate).toHaveBeenCalledWith("store-in-operator");
  });
});
