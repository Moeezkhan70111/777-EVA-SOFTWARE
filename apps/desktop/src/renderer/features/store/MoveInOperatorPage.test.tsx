import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MoveInOperatorPage } from "./MoveInOperatorPage";

// The Move In operator's home is a set of action cards. Adding a material is a Stock-permission
// action, so without it the card stays visible but disabled and says why in words.

const ALL = { stock: true, labels: true, settings: true };

describe("MoveInOperatorPage", () => {
  it("offers six cards, three to a row: material, QR, scanner, stock, receipts and setup", () => {
    const onNavigate = vi.fn();
    render(<MoveInOperatorPage onNavigate={onNavigate} access={ALL} />);
    const routes: Array<[string, string]> = [
      ["store-action-new-material", "store-in-new-material"],
      ["store-action-qr-generator", "store-in-qr-generator"],
      ["store-action-scanner", "store-in-scanner"],
      ["store-action-stock", "store-in-stock"],
      ["store-action-receipts", "store-in-receipts"],
      ["store-action-setup", "store-in-setup"],
    ];
    for (const [testId, route] of routes) {
      fireEvent.click(screen.getByTestId(testId));
      expect(onNavigate).toHaveBeenLastCalledWith(route);
    }
  });

  it("locks Setup, with the reason, for an operator without Settings access", () => {
    render(<MoveInOperatorPage onNavigate={vi.fn()} access={{ stock: true, labels: true, settings: false }} />);
    const setup = screen.getByTestId("store-action-setup") as HTMLButtonElement;
    expect(setup.disabled).toBe(true);
    expect(setup).toHaveTextContent("Ask an admin for Raw Material Setup access");
  });

  it("shows the Add New Material card, which opens the new-material page — and no logo", () => {
    const onNavigate = vi.fn();
    render(<MoveInOperatorPage onNavigate={onNavigate} access={ALL} />);

    expect(screen.queryByRole("img", { name: "777 SEVEN" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Move In" })).toBeInTheDocument();

    const card = screen.getByTestId("store-action-new-material");
    expect(card).toHaveTextContent("Add New Material");
    fireEvent.click(card);
    expect(onNavigate).toHaveBeenCalledWith("store-in-new-material");
  });

  it("keeps the card visible but disabled, with the reason, for an operator without Stock access", () => {
    const onNavigate = vi.fn();
    render(<MoveInOperatorPage onNavigate={onNavigate} access={{ stock: false, labels: true, settings: true }} />);

    const card = screen.getByTestId("store-action-new-material") as HTMLButtonElement;
    expect(card.disabled).toBe(true);
    expect(card).toHaveTextContent("Ask an admin for Stock access");
    fireEvent.click(card);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("offers the Raw Material QR card beside it, locked without QR Generator access", () => {
    const onNavigate = vi.fn();
    const { rerender } = render(<MoveInOperatorPage onNavigate={onNavigate} access={ALL} />);
    fireEvent.click(screen.getByTestId("store-action-qr-generator"));
    expect(onNavigate).toHaveBeenCalledWith("store-in-qr-generator");

    rerender(<MoveInOperatorPage onNavigate={onNavigate} access={{ stock: true, labels: false, settings: true }} />);
    const card = screen.getByTestId("store-action-qr-generator") as HTMLButtonElement;
    expect(card.disabled).toBe(true);
    expect(card).toHaveTextContent("Ask an admin for QR Generator access");
  });

  it("Change job leads back to Store Station", () => {
    const onNavigate = vi.fn();
    render(<MoveInOperatorPage onNavigate={onNavigate} access={ALL} />);
    fireEvent.click(screen.getByRole("button", { name: /Change job/ }));
    expect(onNavigate).toHaveBeenCalledWith("store-home");
  });
});
