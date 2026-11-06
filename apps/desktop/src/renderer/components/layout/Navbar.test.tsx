import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { Navbar } from "./Navbar";
import { CLOSE_DELAY_MS, OPEN_DELAY_MS } from "../../features/navigation/useSidebarRail";
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

// The rail is slim (pictures only) until hovered, focused from the keyboard, or pinned open.
describe("Navbar rail", () => {
  const railBox = () => document.querySelector(".navbar") as HTMLElement;
  const panel = () => document.querySelector(".navbar-panel") as HTMLElement;
  const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts slim, and carries neither the bell nor the profile", () => {
    renderNavbar(ADMIN);
    expect(railBox()).not.toHaveClass("is-expanded");
    expect(screen.queryByRole("button", { name: "Notifications" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "User Profile" })).not.toBeInTheDocument();
  });

  it("takes the list back to the top when it closes, so the slim icons are not left cut off", () => {
    renderNavbar(ADMIN);
    const list = screen.getByRole("navigation", { name: /main navigation/i });
    fireEvent.mouseEnter(panel());
    wait(OPEN_DELAY_MS);
    list.scrollTop = 300;

    fireEvent.mouseLeave(panel());
    wait(CLOSE_DELAY_MS);
    expect(list.scrollTop).toBe(0);
  });

  it("opens when the pointer rests on it and closes when it leaves; a quick pass does nothing", () => {
    renderNavbar(ADMIN);
    fireEvent.mouseEnter(panel());
    wait(OPEN_DELAY_MS - 50);
    fireEvent.mouseLeave(panel());
    wait(OPEN_DELAY_MS);
    expect(railBox()).not.toHaveClass("is-expanded");

    fireEvent.mouseEnter(panel());
    wait(OPEN_DELAY_MS);
    expect(railBox()).toHaveClass("is-expanded");
    // Moving down the list and back in before the close delay keeps it open.
    fireEvent.mouseLeave(panel());
    wait(CLOSE_DELAY_MS - 50);
    fireEvent.mouseEnter(panel());
    wait(CLOSE_DELAY_MS);
    expect(railBox()).toHaveClass("is-expanded");

    fireEvent.mouseLeave(panel());
    wait(CLOSE_DELAY_MS);
    expect(railBox()).not.toHaveClass("is-expanded");
  });

  it("stays open once pinned, and this computer remembers it", () => {
    const { unmount } = render(<Navbar current="home" onSelect={vi.fn()} appVersion="v1.0.0" onBackup={vi.fn()} user={ADMIN} />);
    const pin = screen.getByRole("button", { name: "Keep sidebar open" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(pin);
    expect(pin).toHaveAttribute("aria-pressed", "true");
    expect(railBox()).toHaveClass("is-pinned", "is-expanded");

    fireEvent.mouseLeave(panel());
    wait(CLOSE_DELAY_MS);
    expect(railBox()).toHaveClass("is-expanded");

    unmount();
    renderNavbar(ADMIN);
    expect(railBox()).toHaveClass("is-pinned", "is-expanded");
    fireEvent.click(screen.getByRole("button", { name: "Keep sidebar open" }));
    expect(railBox()).not.toHaveClass("is-expanded");
  });

  it("names a picture beside the slim rail, and not once the rail is open", () => {
    renderNavbar(ADMIN);
    fireEvent.mouseOver(within(panel()).getByRole("button", { name: "Billing" }));
    expect(document.querySelector(".rail-tooltip")).toHaveTextContent("Billing");

    fireEvent.mouseEnter(panel());
    wait(OPEN_DELAY_MS);
    expect(document.querySelector(".rail-tooltip")).not.toBeInTheDocument();
  });

  it("keeps Backup and the version in its foot", () => {
    const onBackup = vi.fn();
    render(<Navbar current="home" onSelect={vi.fn()} appVersion="v1.0.0" onBackup={onBackup} user={ADMIN} />);
    fireEvent.click(screen.getByRole("button", { name: "Backup" }));
    expect(onBackup).toHaveBeenCalled();
    expect(screen.getByText("v1.0.0")).toBeInTheDocument();
  });
});
