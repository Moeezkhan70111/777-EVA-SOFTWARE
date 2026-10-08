import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { Navbar } from "./Navbar";

describe("Navbar Navigation Layout", () => {
  const defaultProps = {
    current: "dashboard" as const,
    onSelect: vi.fn(),
    appVersion: "1.0.0",
    onBackup: vi.fn(),
    user: {
      id: "admin-1",
      username: "admin",
      role: "ADMIN" as const,
    },
    onProfile: vi.fn(),
    onChangePassword: vi.fn(),
    onLogout: vi.fn(),
  };

  it("renders Scanning dropdown with Live Production, Live Dispatch, and Return Scanning", () => {
    const onSelect = vi.fn();
    render(<Navbar {...defaultProps} onSelect={onSelect} />);

    const scanningBtn = screen.getByRole("button", { name: /^Scanning/i });
    expect(scanningBtn).toBeInTheDocument();

    fireEvent.click(scanningBtn);

    expect(screen.getByRole("button", { name: /Live Production/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Live Dispatch/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Return Scanning/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Return Scanning/i }));
    expect(onSelect).toHaveBeenCalledWith("live-return");
  });

  it("renders Store as its own top-level dropdown — Store Station, Move In and Move Out — not inside Inventory", () => {
    const onSelect = vi.fn();
    render(<Navbar {...defaultProps} onSelect={onSelect} />);

    const storeBtn = screen.getByRole("button", { name: /^Store$/i });
    expect(storeBtn).toHaveClass("nav-top-btn");

    fireEvent.click(storeBtn);
    expect(screen.getByRole("button", { name: /Store Station/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Move In/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Move Out/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Store Station/i }));
    expect(onSelect).toHaveBeenCalledWith("store-home");

    fireEvent.click(storeBtn);
    fireEvent.click(screen.getByRole("button", { name: /Move In/i }));
    expect(onSelect).toHaveBeenCalledWith("store-scanning");

    fireEvent.click(storeBtn);
    fireEvent.click(screen.getByRole("button", { name: /Move Out/i }));
    expect(onSelect).toHaveBeenCalledWith("store-move-out");

    // Nothing under Inventory belongs to the store.
    fireEvent.click(screen.getByRole("button", { name: /^Inventory/i }));
    const inventoryItems = screen.getAllByRole("button", { name: /Stock|Production|Dispatch|Return|Raw Material/i });
    expect(inventoryItems.some((el) => /Store|Move In|Move Out/i.test(el.textContent ?? ""))).toBe(false);
  });

  it("hides Store from a user without the store-scanning permission", () => {
    render(
      <Navbar
        {...defaultProps}
        user={{ id: "u-1", username: "aslam", role: "USER" }}
        permissions={["live-production"]}
      />
    );
    expect(screen.queryByRole("button", { name: /^Store$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Scanning/i })).toBeInTheDocument();
  });

  it("shows Store to a store operator with only that permission", () => {
    render(
      <Navbar
        {...defaultProps}
        user={{ id: "u-2", username: "store-op", role: "USER" }}
        permissions={["store-scanning"]}
      />
    );
    const storeBtn = screen.getByRole("button", { name: /^Store$/i });
    expect(storeBtn).toBeInTheDocument();
    fireEvent.click(storeBtn);
    expect(screen.getByRole("button", { name: /Store Station/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Move In/i })).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: /^Setup/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Settings/i })).not.toBeInTheDocument();
  });

  it("renders Inventory dropdown with Stock, Operations, and Activity History sections", () => {
    const onSelect = vi.fn();
    render(<Navbar {...defaultProps} onSelect={onSelect} />);

    const inventoryBtn = screen.getByRole("button", { name: /^Inventory/i });
    expect(inventoryBtn).toBeInTheDocument();

    fireEvent.click(inventoryBtn);

    // Section headers
    expect(screen.getByText("Stock")).toBeInTheDocument();
    expect(screen.getByText("Operations")).toBeInTheDocument();
    expect(screen.getByText("Activity History")).toBeInTheDocument();

    // Stock items
    expect(screen.getByRole("button", { name: /Current Stock/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Stock History/i })).toBeInTheDocument();

    // Operations items
    expect(screen.getByRole("button", { name: /Daily Production/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Daily Dispatch/i })).toBeInTheDocument();

    // Activity History items
    expect(screen.getByRole("button", { name: /Production History/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Dispatch History/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Return History/i })).toBeInTheDocument();

    // Test selection of Daily Dispatch
    fireEvent.click(screen.getByRole("button", { name: /Daily Dispatch/i }));
    expect(onSelect).toHaveBeenCalledWith("daily-dispatch");

    // Test selection of Stock History
    fireEvent.click(inventoryBtn);
    fireEvent.click(screen.getByRole("button", { name: /Stock History/i }));
    expect(onSelect).toHaveBeenCalledWith("history");

    // Test selection of Production History
    fireEvent.click(inventoryBtn);
    fireEvent.click(screen.getByRole("button", { name: /Production History/i }));
    expect(onSelect).toHaveBeenCalledWith("production-history");
  });

  // The flyout is portalled to <body>, so the pointer leaves the rail on its way across and
  // a press inside the panel counts as a click outside the rail. Both used to shut the panel
  // before a row could be reached, which is the whole journey this walks through.
  it("keeps a section's flyout open while the pointer travels onto it, and lets a row be clicked", () => {
    vi.useFakeTimers();
    try {
      const onSelect = vi.fn();
      render(<Navbar {...defaultProps} onSelect={onSelect} />);

      const inventoryBtn = screen.getByRole("button", { name: /^Inventory/i });
      const section = inventoryBtn.parentElement!;

      fireEvent.mouseEnter(section);
      const row = screen.getByRole("button", { name: /Machine Program/i });
      const panel = row.closest(".nav-dropdown")!;

      // Pointer crosses off the rail row and onto the panel beside it.
      fireEvent.mouseLeave(section);
      fireEvent.mouseEnter(panel);
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(
        screen.getByRole("button", { name: /Machine Program/i }),
      ).toBeInTheDocument();

      // The press itself must not dismiss the panel before the click lands.
      fireEvent.mouseDown(row);
      expect(
        screen.getByRole("button", { name: /Machine Program/i }),
      ).toBeInTheDocument();

      fireEvent.click(row);
      expect(onSelect).toHaveBeenCalledWith("machine-program");
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the flyout once the pointer leaves both the section and its panel", () => {
    vi.useFakeTimers();
    try {
      render(<Navbar {...defaultProps} />);

      const section = screen
        .getByRole("button", { name: /^Inventory/i })
        .parentElement!;
      fireEvent.mouseEnter(section);
      const panel = screen
        .getByRole("button", { name: /Machine Program/i })
        .closest(".nav-dropdown")!;

      fireEvent.mouseLeave(section);
      fireEvent.mouseEnter(panel);
      fireEvent.mouseLeave(panel);
      act(() => {
        vi.advanceTimersByTime(2000);
      });

      expect(
        screen.queryByRole("button", { name: /Machine Program/i }),
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

