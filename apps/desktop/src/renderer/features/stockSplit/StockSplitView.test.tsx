import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StockSplitView } from "./StockSplitView";

const renderSplit = (companion: React.ReactNode | null = <p>carton matrices</p>) =>
  render(
    <StockSplitView storageKey="test-split" companion={companion} companionLabel="Carton Stock"
      mainLabel="Upper Stock" mainIcon={<svg />} mainTone="upper" companionIcon={<svg />} companionTone="carton"
      main={(toggle) => <div><div data-testid="page-toolbar">{toggle}</div><p>upper matrices</p></div>} />
  );

describe("StockSplitView: the other stock page beside this one", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(cleanup);

  it("opens the other page beside, with a divider, and closes it from the pane's own button", () => {
    renderSplit();
    expect(screen.queryByText("carton matrices")).toBeNull();
    // The button sits in the page's own toolbar, not on a row of its own (docs/56, 26 Nov 2026).
    expect(screen.getByTestId("page-toolbar")).toContainElement(screen.getByRole("button", { name: "Show Carton Stock beside" }));
    fireEvent.click(screen.getByRole("button", { name: "Show Carton Stock beside" }));
    const pane = screen.getByRole("region", { name: "Carton Stock" });
    expect(pane.textContent).toContain("carton matrices");
    expect(screen.getByText("upper matrices")).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize the two stock views" })).toBeInTheDocument();
    // Which is which (owner, 26 Nov 2026): both halves named, each in its own page's colour.
    expect(screen.getByRole("heading", { name: "Upper Stock" }).closest("[data-page-tone]")).toHaveAttribute("data-page-tone", "upper");
    expect(screen.getByRole("heading", { name: "Carton Stock" }).closest("[data-page-tone]")).toHaveAttribute("data-page-tone", "carton");
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
