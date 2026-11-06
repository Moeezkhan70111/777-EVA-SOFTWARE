import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { PageHeader } from "./PageHeader";

// One header for every screen: the logo, the page's name as the page's one heading, the actions.

describe("PageHeader", () => {
  it("draws the logo, the title and the actions, in that order on one line", () => {
    render(<PageHeader title="Current Stock" actions={<button type="button">Bell</button>} />);
    const header = screen.getByRole("banner");
    const parts = Array.from(header.children);

    expect(parts[0]).toBe(within(header).getByRole("img", { name: "777 SEVEN" }));
    expect(parts[1]).toBe(within(header).getByRole("heading", { level: 1, name: "Current Stock" }));
    expect(parts[2]).toContainElement(within(header).getByRole("button", { name: "Bell" }));
  });

  it("keeps the right-hand column when there is nothing to put in it, so the title stays centred", () => {
    render(<PageHeader title="Store" />);
    expect(screen.getByRole("banner").children).toHaveLength(3);
  });
});
