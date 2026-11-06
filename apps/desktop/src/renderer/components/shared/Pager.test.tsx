import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Pager, pageWindow } from "./Pager";

// The numbered pager shows every page of a short list, and of a long one the first, the last and
// the pages around the current one, with a gap where pages are left out.

describe("pageWindow", () => {
  it("shows every page of a short list", () => {
    expect(pageWindow(2, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("shows the first, the last and the pages around the current one of a long list", () => {
    expect(pageWindow(10, 20)).toEqual([1, "gap", 9, 10, 11, "gap", 20]);
    expect(pageWindow(1, 20)).toEqual([1, 2, "gap", 20]);
    expect(pageWindow(20, 20)).toEqual([1, "gap", 19, 20]);
  });
});

describe("Pager — numbered", () => {
  it("marks the current page, goes to a page pressed, and stops at the ends", () => {
    const onPage = vi.fn();
    render(<Pager page={1} pages={3} onPage={onPage} numbered />);
    expect(screen.getByRole("button", { name: "Page 1 of 3" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Page 3 of 3" }));
    expect(onPage).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onPage).toHaveBeenCalledWith(2);
  });
});
