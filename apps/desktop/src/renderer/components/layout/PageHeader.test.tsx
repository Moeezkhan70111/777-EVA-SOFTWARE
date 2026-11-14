import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PageHeader } from "./PageHeader";

// One header for every screen: the logo, the page's name as the page's one heading, the actions.

describe("PageHeader", () => {
  it("draws the logo, the title and the actions, in that order on one line", () => {
    render(<PageHeader title="Current Stock" actions={<button type="button">Bell</button>} />);
    const header = screen.getByRole("banner");
    const parts = Array.from(header.children);

    expect(parts[0]).toContainElement(within(header).getByRole("img", { name: "777 SEVEN" }));
    expect(parts[1]).toBe(within(header).getByRole("heading", { level: 1, name: "Current Stock" }));
    expect(parts[2]).toContainElement(within(header).getByRole("button", { name: "Bell" }));
  });

  // Owner, 14 Nov 2026: a way back to the Dashboard on every page but the Dashboard itself.
  it("offers a Dashboard button beside the logo when it is given one, and none otherwise", () => {
    const onDashboard = vi.fn();
    const { unmount } = render(<PageHeader title="Carton Stock" onDashboard={onDashboard} />);
    const header = screen.getByRole("banner");
    expect(header.children[0]).toContainElement(within(header).getByRole("button", { name: "Dashboard" }));
    fireEvent.click(within(header).getByRole("button", { name: "Dashboard" }));
    expect(onDashboard).toHaveBeenCalledTimes(1);
    unmount();
    render(<PageHeader title="Dashboard" />);
    expect(screen.queryByRole("button", { name: "Dashboard" })).toBeNull();
  });

  it("keeps the right-hand column when there is nothing to put in it, so the title stays centred", () => {
    render(<PageHeader title="Store" />);
    expect(screen.getByRole("banner").children).toHaveLength(3);
  });
});
