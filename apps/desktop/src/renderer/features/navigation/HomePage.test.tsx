import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HomePage } from "./HomePage";
import type { AuthUser } from "../../types/desktopApi";
import { LEDGER_ROUTES } from "../parties/ledgerVisibility";

const user = (permissions: string[], role: AuthUser["role"] = "USER"): AuthUser => ({
  id: "u-1",
  username: "aslam",
  role,
  accessStatus: "APPROVED",
  permissions,
  lastLoginAt: null,
});

describe("HomePage", () => {
  it("explains what to do when the role has nothing assigned", () => {
    render(<HomePage user={user([])} onNavigate={vi.fn()} listAllPages />);
    expect(screen.getByRole("status")).toHaveTextContent("No pages assigned yet");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("shows a tile for each assigned page, grouped by section", () => {
    render(<HomePage user={user(["stock", "sale-voucher-form", "customer-ledger"])} onNavigate={vi.fn()} listAllPages />);
    expect(screen.getByRole("heading", { name: "Inventory" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Billing" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Scanning" })).not.toBeInTheDocument();
    // Stock also opens the Raw Material workspace (routeAnyPermission), so it brings two tiles.
    expect(screen.getAllByRole("button").map((tile) => tile.querySelector("strong")?.textContent)).toEqual([
      "Current Stock",
      "Raw Material",
      "Sale Voucher",
      "Customer Ledger",
    ]);
  });

  it("leaves out the pages this computer does not offer, whatever the role: the ledgers off the Accounts holder", () => {
    render(<HomePage user={user(["sale-voucher-form", "customer-ledger", "supplier-balance"])} onNavigate={vi.fn()} hiddenRoutes={LEDGER_ROUTES} listAllPages />);
    expect(screen.getAllByRole("button").map((tile) => tile.querySelector("strong")?.textContent)).toEqual(["Sale Voucher"]);
  });

  it("opens the page behind a tile", () => {
    const onNavigate = vi.fn();
    render(<HomePage user={user(["live-dispatch"])} onNavigate={onNavigate} listAllPages />);
    fireEvent.click(screen.getByRole("button", { name: /Live Dispatch/ }));
    expect(onNavigate).toHaveBeenCalledWith("live-dispatch");
  });

  it("draws Machine Program as the large dashboard card, with its artwork, and opens it", () => {
    const onNavigate = vi.fn();
    render(<HomePage user={user(["machine-program", "stock"])} onNavigate={onNavigate} listAllPages />);

    const card = screen.getByRole("button", { name: /Machine Program/ });
    expect(card).toHaveClass("feature-card");
    // The last word is the accent; the description is still read out.
    expect(card.querySelector(".feature-card-title-accent")).toHaveTextContent("Program");
    expect(card).toHaveAccessibleName("Machine Program");
    expect(card).toHaveAccessibleDescription("Carton QRs generated, per item");
    // The artwork is decoration: present, but not read twice.
    const art = card.querySelector("img");
    expect(art).toHaveAttribute("src", "./assets/machines/machine.png");
    expect(art).toHaveAttribute("alt", "");

    // Pages without artwork keep the compact tile.
    expect(screen.getByRole("button", { name: /Current Stock/ })).toHaveClass("nav-tile");

    fireEvent.click(card);
    expect(onNavigate).toHaveBeenCalledWith("machine-program");
  });

  it("names the user's role, and leaves the page's title to the page header", () => {
    render(<HomePage user={{ ...user(["gatepass"]), roleName: "Munshi" }} onNavigate={vi.fn()} />);
    expect(screen.getByText("Munshi")).toHaveClass("nav-page-desk");
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  });

  it("falls back to Administrator for an admin without a role, and says nothing for anyone else", () => {
    const { unmount } = render(<HomePage user={user([], "ADMIN")} onNavigate={vi.fn()} />);
    expect(screen.getByText("Administrator")).toHaveClass("nav-page-desk");
    unmount();
    render(<HomePage user={user(["stock"])} onNavigate={vi.fn()} listAllPages />);
    expect(document.querySelector(".nav-page-desk")).not.toBeInTheDocument();
  });

  it("writes every card name in normal case, its last word in the accent", () => {
    render(<HomePage user={user(["machine-program", "gatepass"])} onNavigate={vi.fn()} listAllPages />);
    const titles = Array.from(document.querySelectorAll(".feature-card-title"));
    expect(titles.map((title) => title.textContent)).toEqual(["Machine Program", "Create Gatepass", "Gatepass List"]);
    expect(titles.map((title) => title.querySelector(".feature-card-title-accent")?.textContent)).toEqual(["Program", "Gatepass", "List"]);
  });

  it("puts no heading over the large cards — each card names its page", () => {
    render(<HomePage user={user(["machine-program", "stock"])} onNavigate={vi.fn()} listAllPages />);
    expect(screen.queryByRole("heading", { name: "Machine Program" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Inventory" })).toBeInTheDocument();
  });

  it("puts Create Gatepass and Gatepass List next to Machine Program, in green", () => {
    const onNavigate = vi.fn();
    render(<HomePage user={user(["machine-program", "gatepass"])} onNavigate={onNavigate} listAllPages />);

    const cards = document.querySelectorAll(".nav-page-grid--feature > .feature-card");
    expect(Array.from(cards).map((card) => card.querySelector(".feature-card-title")?.textContent)).toEqual([
      "Machine Program",
      "Create Gatepass",
      "Gatepass List",
    ]);

    const gatepass = screen.getByRole("button", { name: "Create Gatepass" });
    expect(gatepass).toHaveClass("feature-card--green");
    expect(gatepass.querySelector("img")).toHaveAttribute("src", "./assets/gatepass/create-gatepass.png");
    // Its artwork brings its own cloud and sparks, so the card draws none.
    expect(gatepass.querySelector(".feature-card-cloud")).toBeNull();
    expect(screen.getByRole("button", { name: "Machine Program" }).querySelector(".feature-card-cloud")).not.toBeNull();

    // Gatepass List: the vector artwork, with the card's own green cloud behind it.
    const list = screen.getByRole("button", { name: "Gatepass List" });
    expect(list).toHaveClass("feature-card--green");
    expect(list.querySelector("img")).toHaveAttribute("src", "./assets/gatepass/gatepass-list.svg");
    expect(list.querySelector(".feature-card-cloud")).not.toBeNull();
    // Every Gatepass page is a large card now, so the section needs no heading or tiles.
    expect(screen.queryByRole("heading", { name: "Gatepass" })).not.toBeInTheDocument();
    expect(document.querySelector(".nav-tile")).toBeNull();

    fireEvent.click(gatepass);
    expect(onNavigate).toHaveBeenCalledWith("gatepass");
  });

});

describe("HomePage — the Dashboard's own cards", () => {
  const cardNames = () => screen.queryAllByRole("button").map((card) => card.getAttribute("data-testid"));

  it("shows both stock cards to a profile holding both, and nothing else", () => {
    render(<HomePage user={user(["stock.upper.view", "stock.dana.view", "machine-program", "stock"])} onNavigate={vi.fn()} />);
    expect(cardNames()).toEqual(["nav-tile-upper-stock", "nav-tile-dana-stock"]);
  });

  it("shows only the card a profile may open", () => {
    const { unmount } = render(<HomePage user={user(["stock.upper.view"])} onNavigate={vi.fn()} />);
    expect(cardNames()).toEqual(["nav-tile-upper-stock"]);
    unmount();
    render(<HomePage user={user(["stock.dana.view"])} onNavigate={vi.fn()} />);
    expect(cardNames()).toEqual(["nav-tile-dana-stock"]);
  });

  it("points a profile with neither card at the sidebar, rather than showing a blank page", () => {
    render(<HomePage user={user(["stock", "gatepass"])} onNavigate={vi.fn()} />);
    expect(cardNames()).toEqual([]);
    expect(screen.getByRole("status")).toHaveTextContent("Your pages are in the sidebar");
  });

  it("shows an administrator both", () => {
    render(<HomePage user={user([], "ADMIN")} onNavigate={vi.fn()} />);
    expect(cardNames()).toEqual(["nav-tile-upper-stock", "nav-tile-dana-stock"]);
  });

  it("opens each card's own page, and names it", () => {
    const onNavigate = vi.fn();
    render(<HomePage user={user(["stock.upper.view", "stock.dana.view"])} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Upper Stock" }));
    expect(onNavigate).toHaveBeenLastCalledWith("upper-stock");
    fireEvent.click(screen.getByRole("button", { name: "Dana Stock" }));
    expect(onNavigate).toHaveBeenLastCalledWith("dana-stock");
    expect(screen.getByRole("button", { name: "Dana Stock" }).querySelector(".feature-card-badge svg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dana Stock" }).querySelector("img")).toHaveAttribute("src", "./assets/stock/dana-stock.png");
  });

  it("keeps every page within reach of a user with no sidebar", () => {
    render(<HomePage user={user(["stock.dana.view", "machine-program", "stock"])} onNavigate={vi.fn()} listAllPages />);
    expect(cardNames()).toEqual(["nav-tile-dana-stock", "nav-tile-machine-program", "nav-tile-stock", "nav-tile-raw-material"]);
  });
});
