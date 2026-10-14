import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HomePage } from "./HomePage";
import type { AuthUser } from "../../types/desktopApi";

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
    render(<HomePage user={user([])} onNavigate={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("No pages assigned yet");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("shows a tile for each assigned page, grouped by section", () => {
    render(<HomePage user={user(["stock", "sale-voucher-form", "customer-ledger"])} onNavigate={vi.fn()} />);
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

  it("opens the page behind a tile", () => {
    const onNavigate = vi.fn();
    render(<HomePage user={user(["live-dispatch"])} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: /Live Dispatch/ }));
    expect(onNavigate).toHaveBeenCalledWith("live-dispatch");
  });

  it("draws Machine Program as the large dashboard card, with its artwork, and opens it", () => {
    const onNavigate = vi.fn();
    render(<HomePage user={user(["machine-program", "stock"])} onNavigate={onNavigate} />);

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

  it("is titled with the user's role, with no sub-text", () => {
    render(<HomePage user={{ ...user(["gatepass"]), roleName: "Munshi" }} onNavigate={vi.fn()} />);
    const title = screen.getByRole("heading", { level: 1 });
    expect(title).toHaveTextContent(/^Munshi$/);
    expect(title.parentElement?.children).toHaveLength(1);
  });

  it("falls back to Administrator for an admin without a role, and Dashboard for anyone else", () => {
    const { unmount } = render(<HomePage user={user([], "ADMIN")} onNavigate={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^Administrator$/);
    unmount();
    render(<HomePage user={user(["stock"])} onNavigate={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^Dashboard$/);
  });

  it("writes every card name in normal case, its last word in the accent", () => {
    render(<HomePage user={user(["machine-program", "gatepass"])} onNavigate={vi.fn()} />);
    const titles = Array.from(document.querySelectorAll(".feature-card-title"));
    expect(titles.map((title) => title.textContent)).toEqual(["Machine Program", "Create Gatepass", "Gatepass List"]);
    expect(titles.map((title) => title.querySelector(".feature-card-title-accent")?.textContent)).toEqual(["Program", "Gatepass", "List"]);
  });

  it("puts no heading over the large cards — each card names its page", () => {
    render(<HomePage user={user(["machine-program", "stock"])} onNavigate={vi.fn()} />);
    expect(screen.queryByRole("heading", { name: "Machine Program" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Inventory" })).toBeInTheDocument();
  });

  it("puts Create Gatepass and Gatepass List next to Machine Program, in green", () => {
    const onNavigate = vi.fn();
    render(<HomePage user={user(["machine-program", "gatepass"])} onNavigate={onNavigate} />);

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
