import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { Navbar } from "./Navbar";
import type { AuthUser } from "../../types/desktopApi";

// The sidebar lists Home and then exactly the pages the user's role has been given, as rows
// under their section — the same cards Home shows.

const makeUser = (overrides: Partial<AuthUser>): AuthUser => ({
  id: "u-1",
  username: "aslam",
  role: "USER",
  accessStatus: "APPROVED",
  permissions: [],
  lastLoginAt: null,
  ...overrides,
});

const ADMIN = makeUser({ id: "admin-1", username: "admin", role: "ADMIN" });

const renderNavbar = (user: AuthUser, current: React.ComponentProps<typeof Navbar>["current"] = "home") => {
  const onSelect = vi.fn();
  render(
    <Navbar
      current={current}
      onSelect={onSelect}
      appVersion="1.0.0"
      onBackup={vi.fn()}
      user={user}
      onProfile={vi.fn()}
      onChangePassword={vi.fn()}
      onLogout={vi.fn()}
    />
  );
  return { onSelect, rail: screen.getByRole("navigation", { name: /main navigation/i }) };
};

describe("Navbar sidebar", () => {
  it("starts with Dashboard, which opens the card dashboard", () => {
    const { onSelect, rail } = renderNavbar(ADMIN, "stock");
    fireEvent.click(within(rail).getByRole("button", { name: /^Dashboard$/ }));
    expect(onSelect).toHaveBeenCalledWith("home");
  });

  it("shows an administrator every section, and a row opens its page", () => {
    const { onSelect, rail } = renderNavbar(ADMIN);
    for (const section of ["Overview", "Scanning", "Munshi", "Gatepass", "Inventory", "Setup", "Billing", "System"]) {
      expect(within(rail).getByRole("button", { name: section })).toBeInTheDocument();
    }
    // The Store section heading and its Store page row share the name; the heading is the one that folds.
    expect(within(rail).getAllByRole("button", { name: "Store" }).filter((button) => button.hasAttribute("aria-expanded"))).toHaveLength(1);

    fireEvent.click(within(rail).getByRole("button", { name: "Return Scanning" }));
    expect(onSelect).toHaveBeenCalledWith("live-return");
    // The carton rows say cartons (0.3.9), so Store and Move In never mean two things.
    fireEvent.click(within(rail).getByRole("button", { name: "Carton Move In" }));
    expect(onSelect).toHaveBeenCalledWith("store-scanning");
    fireEvent.click(within(rail).getByRole("button", { name: "Carton Move Out" }));
    expect(onSelect).toHaveBeenCalledWith("store-move-out");
    fireEvent.click(within(rail).getByRole("button", { name: "Supplier Ledger" }));
    expect(onSelect).toHaveBeenCalledWith("supplier-ledger");
  });

  it("lists only the pages a role was given — not the rest of their section", () => {
    const { rail } = renderNavbar(makeUser({ permissions: ["live-production"] }));
    expect(within(rail).getByRole("button", { name: "Live Production" })).toBeInTheDocument();
    expect(within(rail).queryByRole("button", { name: "Live Dispatch" })).not.toBeInTheDocument();
    expect(within(rail).queryByRole("button", { name: "Store" })).not.toBeInTheDocument();
    expect(within(rail).queryByRole("button", { name: "Setup" })).not.toBeInTheDocument();
  });

  describe("for a store operator", () => {
    const storeOp = makeUser({ username: "store-op", permissions: ["store-scanning", "stock"] });
    const rowNames = (rail: HTMLElement) => within(rail).getAllByRole("button").map((button) => button.textContent);

    it("holds one row, Store — Receiving and Issuing are the page's own switch (0.3.9)", () => {
      const { onSelect, rail } = renderNavbar(storeOp, "store-receiving");
      expect(rowNames(rail)).toEqual(["Store"]);
      expect(within(rail).getByRole("button", { name: "Store" })).toHaveAttribute("aria-current", "page");
      fireEvent.click(within(rail).getByRole("button", { name: "Store" }));
      expect(onSelect).toHaveBeenCalledWith("store-receiving");
    });

    it("marks Store in either mode", () => {
      const { rail } = renderNavbar(storeOp, "store-issuing");
      expect(within(rail).getByRole("button", { name: "Store" })).toHaveAttribute("aria-current", "page");
    });

    it("leaves Store unmarked on a page reached from Home", () => {
      const { rail } = renderNavbar(storeOp, "stock");
      expect(within(rail).getByRole("button", { name: "Store" })).not.toHaveAttribute("aria-current");
    });
  });

  it("shows only Dashboard to a role with nothing assigned", () => {
    const { rail } = renderNavbar(makeUser({ permissions: [] }));
    expect(within(rail).getAllByRole("button")).toHaveLength(1);
    expect(within(rail).getByRole("button", { name: /^Dashboard$/ })).toBeInTheDocument();
  });

  it("folds a section's rows away from its heading and back", () => {
    const { rail } = renderNavbar(ADMIN);
    const heading = within(rail).getByRole("button", { name: "Inventory" });
    expect(heading).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "false");
    expect(within(rail).queryByRole("button", { name: "Daily Production" })).not.toBeInTheDocument();

    fireEvent.click(heading);
    expect(within(rail).getByRole("button", { name: "Daily Production" })).toBeInTheDocument();
  });

  it("shows Machine Program as a page of its own, not under Inventory", () => {
    const { onSelect, rail } = renderNavbar(ADMIN);
    const machineProgram = within(rail).getByRole("button", { name: "Machine Program" });
    expect(machineProgram).toHaveClass("nav-top-btn");
    expect(machineProgram).not.toHaveAttribute("aria-expanded");

    // Folding Inventory away leaves Machine Program where it is.
    fireEvent.click(within(rail).getByRole("button", { name: "Inventory" }));
    fireEvent.click(within(rail).getByRole("button", { name: "Machine Program" }));
    expect(onSelect).toHaveBeenCalledWith("machine-program");
  });

  it("gives a planner with only Machine Program just that page", () => {
    const { rail } = renderNavbar(makeUser({ permissions: ["machine-program"] }), "machine-program");
    expect(within(rail).getAllByRole("button").map((button) => button.textContent)).toEqual(["Dashboard", "Machine Program"]);
    expect(within(rail).getByRole("button", { name: "Machine Program" })).toHaveAttribute("aria-current", "page");
  });

  it("marks the open page, including the Store page in either mode", () => {
    const { rail } = renderNavbar(ADMIN, "store-issuing");
    // The Store section heading and its Store row share the name; the row is the one marked.
    const marked = within(rail).getAllByRole("button", { name: "Store" }).filter((button) => button.getAttribute("aria-current") === "page");
    expect(marked).toHaveLength(1);
    expect(within(rail).getByRole("button", { name: "Carton Move In" })).not.toHaveAttribute("aria-current");
  });
});

describe("Navbar notifications panel", () => {
  const openPanel = () => {
    renderNavbar(ADMIN);
    fireEvent.click(screen.getByRole("button", { name: "Access requests" }));
    expect(screen.getByText("Notifications")).toBeInTheDocument();
  };

  it("closes when the user clicks anywhere else on the screen", () => {
    openPanel();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("Notifications")).not.toBeInTheDocument();
  });

  it("closes on Escape", () => {
    openPanel();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Notifications")).not.toBeInTheDocument();
  });

  it("stays open for a click inside it, and the bell still toggles it shut", () => {
    openPanel();
    fireEvent.mouseDown(screen.getByText("Notifications"));
    expect(screen.getByText("Notifications")).toBeInTheDocument();

    const bell = screen.getByRole("button", { name: "Access requests" });
    fireEvent.mouseDown(bell);
    fireEvent.click(bell);
    expect(screen.queryByText("Notifications")).not.toBeInTheDocument();
  });
});
