import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StockSplitView } from "./StockSplitView";

const renderSplit = (companion: React.ReactNode | null = <p>carton matrices</p>) =>
  render(<StockSplitView storageKey="test-split" main={<p>upper matrices</p>} companion={companion} companionLabel="Carton Stock" />);

describe("StockSplitView: the other stock page beside this one", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(cleanup);

  it("opens the other page beside, with a divider, and closes it from the pane's own button", () => {
    renderSplit();
    expect(screen.queryByText("carton matrices")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show Carton Stock beside" }));
    const pane = screen.getByRole("region", { name: "Carton Stock" });
    expect(pane.textContent).toContain("carton matrices");
    expect(screen.getByText("upper matrices")).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize the two stock views" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Close Carton Stock" })[1] as HTMLElement);
    expect(screen.queryByRole("region", { name: "Carton Stock" })).toBeNull();
  });

  it("remembers that it was open on this computer", () => {
    renderSplit();
    fireEvent.click(screen.getByRole("button", { name: "Show Carton Stock beside" }));
    cleanup();
    renderSplit();
    expect(screen.getByRole("region", { name: "Carton Stock" })).toBeInTheDocument();
  });

  it("offers nothing when this user may not open the other page", () => {
    window.localStorage.setItem("test-split.open", "1");
    renderSplit(null);
    expect(screen.queryByRole("button", { name: /beside/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "Carton Stock" })).toBeNull();
    expect(screen.getByText("upper matrices")).toBeInTheDocument();
  });
});
