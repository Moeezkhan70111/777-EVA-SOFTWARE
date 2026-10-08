import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StoreHomePage } from "./StoreHomePage";
import { StoreOperatorScreen } from "./StoreOperatorScreen";

// Store Station asks one question and offers two jobs. It must never touch stock — the only
// observable effect is navigation.

const renderPage = () => {
  const onNavigate = vi.fn();
  render(<StoreHomePage onNavigate={onNavigate} />);
  return { onNavigate };
};

describe("StoreHomePage", () => {
  it("offers exactly two jobs: Move In and Move Out", () => {
    renderPage();
    const group = screen.getByRole("group", { name: "What is your job today?" });
    expect(group.querySelectorAll("button")).toHaveLength(2);
    expect(screen.getByTestId("store-operator-in")).toHaveTextContent("Move In");
    expect(screen.getByTestId("store-operator-in")).toHaveTextContent("Goods coming into the store");
    expect(screen.getByTestId("store-operator-out")).toHaveTextContent("Move Out");
    expect(screen.getByTestId("store-operator-out")).toHaveTextContent("Goods going out of the store");
  });

  it("opens the chosen job's screen on click", () => {
    const { onNavigate } = renderPage();
    fireEvent.click(screen.getByTestId("store-operator-in"));
    expect(onNavigate).toHaveBeenLastCalledWith("store-in-operator");
    fireEvent.click(screen.getByTestId("store-operator-out"));
    expect(onNavigate).toHaveBeenLastCalledWith("store-out-operator");
  });

  it("picks a job with the 1 and 2 keys", () => {
    const { onNavigate } = renderPage();
    fireEvent.keyDown(window, { key: "1" });
    expect(onNavigate).toHaveBeenLastCalledWith("store-in-operator");
    fireEvent.keyDown(window, { key: "2" });
    expect(onNavigate).toHaveBeenLastCalledWith("store-out-operator");
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });

  it("focuses Move In on arrival and moves between cards with the arrow keys", () => {
    renderPage();
    expect(document.activeElement).toBe(screen.getByTestId("store-operator-in"));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByTestId("store-operator-out"));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByTestId("store-operator-in"));
  });

  it("ignores the shortcut keys while the operator is typing", () => {
    const { onNavigate } = renderPage();
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "1" });
    expect(onNavigate).not.toHaveBeenCalled();
    input.remove();
  });
});

describe("StoreOperatorScreen", () => {
  it("names the job and leads back to Store Station", () => {
    const onBack = vi.fn();
    render(<StoreOperatorScreen direction="out" onBack={onBack} />);
    expect(screen.getByRole("heading", { name: "Move Out" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Change job/ }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
