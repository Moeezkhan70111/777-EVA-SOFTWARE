import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionMenu } from "./ActionMenu";

// Escape closes an open menu and goes no further: the app's "Escape goes back" listens on the window, and pressing
// Escape to close a menu took the whole page away with it (Customer Ledger, 24 Nov 2026).

describe("ActionMenu", () => {
  const onWindow = vi.fn();
  afterEach(() => { window.removeEventListener("keydown", onWindow); onWindow.mockReset(); });

  it("closes on Escape without the key reaching the window", () => {
    window.addEventListener("keydown", onWindow);
    render(<ActionMenu label="Download" groups={[{ label: "Ledger", items: [{ id: "x", label: "Download Excel", onSelect: vi.fn() }] }]} />);
    fireEvent.click(screen.getByRole("button", { name: /Download/ }));
    expect(screen.getByRole("menuitem", { name: "Download Excel" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menuitem", { name: "Download Excel" })).toBeNull();
    expect(onWindow).not.toHaveBeenCalled();
  });

  it("lets Escape through when it is closed, so the page's own Escape still works", () => {
    window.addEventListener("keydown", onWindow);
    render(<ActionMenu label="Download" groups={[{ label: "Ledger", items: [{ id: "x", label: "Download Excel", onSelect: vi.fn() }] }]} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onWindow).toHaveBeenCalledTimes(1);
  });
});
