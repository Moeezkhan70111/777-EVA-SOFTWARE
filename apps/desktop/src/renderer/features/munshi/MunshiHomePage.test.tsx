import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PERMISSION } from "@erp/domain";
import { MunshiHomePage } from "./MunshiHomePage";
import { MUNSHI_FRAMED_ROUTES } from "./munshiCards";
import { routePermission } from "../auth/session";

// The Munshi's station: three cards, no navbar. A card the Munshi may not use stays visible
// but disabled and says why, so nobody wonders where a button went.

const ALL = { gatepass: true, stock: true };

describe("MunshiHomePage", () => {
  it("offers the three jobs in order: Create Gatepass, Raw Material Stock, Gatepass List", () => {
    const onNavigate = vi.fn();
    render(<MunshiHomePage onNavigate={onNavigate} access={ALL} />);

    const cards: Array<[string, string, string]> = [
      ["munshi-action-create-gatepass", "Create Gatepass", "gatepass"],
      ["munshi-action-raw-material-stock", "Raw Material Stock", "munshi-stock"],
      ["munshi-action-gatepass-list", "Gatepass List", "gatepass-list"],
    ];
    for (const [testId, label, route] of cards) {
      const card = screen.getByTestId(testId);
      expect(card).toHaveTextContent(label);
      fireEvent.click(card);
      expect(onNavigate).toHaveBeenLastCalledWith(route);
    }
    expect(onNavigate).toHaveBeenCalledTimes(3);
  });

  it("names the station and shows the logo", () => {
    render(<MunshiHomePage onNavigate={vi.fn()} access={ALL} />);
    expect(screen.getByRole("heading", { name: "Munshi" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "777 SEVEN" })).toBeInTheDocument();
  });

  it("locks both Gatepass cards, with the reason, without Gatepass access", () => {
    const onNavigate = vi.fn();
    render(<MunshiHomePage onNavigate={onNavigate} access={{ gatepass: false, stock: true }} />);

    for (const testId of ["munshi-action-create-gatepass", "munshi-action-gatepass-list"]) {
      const card = screen.getByTestId(testId) as HTMLButtonElement;
      expect(card.disabled).toBe(true);
      expect(card).toHaveTextContent("Ask an admin for Gatepass access");
      fireEvent.click(card);
    }
    expect(onNavigate).not.toHaveBeenCalled();

    // Stock is a separate permission, so that card still works.
    fireEvent.click(screen.getByTestId("munshi-action-raw-material-stock"));
    expect(onNavigate).toHaveBeenCalledWith("munshi-stock");
  });

  it("locks Raw Material Stock, with the reason, without Stock access", () => {
    const onNavigate = vi.fn();
    render(<MunshiHomePage onNavigate={onNavigate} access={{ gatepass: true, stock: false }} />);

    const card = screen.getByTestId("munshi-action-raw-material-stock") as HTMLButtonElement;
    expect(card.disabled).toBe(true);
    expect(card).toHaveTextContent("Ask an admin for Stock access");
    fireEvent.click(card);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("every card is a button with an accessible name", () => {
    render(<MunshiHomePage onNavigate={vi.fn()} access={ALL} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(3);
    for (const button of buttons) expect(button.textContent?.trim()).not.toBe("");
  });
});

describe("the Munshi station's permissions", () => {
  it("gates the station screen on the Munshi permission and Stock on Stock", () => {
    expect(routePermission["munshi-home"]).toBe(PERMISSION.MUNSHI);
    expect(routePermission["munshi-stock"]).toBe(PERMISSION.STOCK);
  });

  it("frames only the two Gatepass screens, which bring no station chrome of their own", () => {
    expect([...MUNSHI_FRAMED_ROUTES].sort()).toEqual(["gatepass", "gatepass-list"]);
    expect(MUNSHI_FRAMED_ROUTES.has("munshi-home")).toBe(false);
    expect(MUNSHI_FRAMED_ROUTES.has("munshi-stock")).toBe(false);
  });
});
