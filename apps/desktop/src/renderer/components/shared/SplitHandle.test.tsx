// The draggable divider (SplitHandle.tsx): it resizes by pointer and by keyboard, keeps to its
// limits, remembers the width on this computer, and never takes the scanner's focus on a press.

import React, { useRef } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SplitHandle, splitWidth, useSplitFraction } from "./SplitHandle";

const KEY = "test.split";

// jsdom has no PointerEvent, so a pointer event would arrive without its clientX. A mouse event with a
// pointerId stands in for it.
beforeAll(() => {
  if (typeof window.PointerEvent === "undefined") {
    class PointerEventStandIn extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    Object.defineProperty(window, "PointerEvent", { value: PointerEventStandIn, configurable: true });
  }
});

const Split: React.FC = () => {
  const ref = useRef<HTMLDivElement>(null);
  const [fraction, setFraction] = useSplitFraction(KEY, 0.2, 0.6);
  return (
    <div ref={ref} data-testid="box">
      <input aria-label="Scanner input" />
      <SplitHandle label="Resize the scan panel" containerRef={ref} fraction={fraction} defaultFraction={0.3} min={0.2} max={0.6} onChange={setFraction} />
      <output data-testid="fraction">{fraction === null ? "default" : fraction.toFixed(2)}</output>
    </div>
  );
};

const handle = () => screen.getByRole("separator", { name: "Resize the scan panel" });
const shown = () => screen.getByTestId("fraction").textContent;

/** The container as the browser would measure it: 1000px wide, from 0 to 1000. */
const sizeBox = () => {
  screen.getByTestId("box").getBoundingClientRect = () => ({ left: 0, right: 1000, width: 1000, top: 0, bottom: 600, height: 600, x: 0, y: 0, toJSON: () => ({}) });
};

describe("SplitHandle", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it("is a vertical separator with its value, and starts at the page's default", () => {
    render(<Split />);
    expect(handle()).toHaveAttribute("aria-orientation", "vertical");
    expect(handle()).toHaveAttribute("aria-valuenow", "30");
    expect(shown()).toBe("default");
  });

  it("follows a drag: the pane is what lies right of the pointer, kept within its limits", () => {
    render(<Split />);
    sizeBox();
    fireEvent.pointerDown(handle(), { pointerId: 1, clientX: 700 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 650 });
    expect(shown()).toBe("0.35");
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 100 });
    expect(shown()).toBe("0.60");
    fireEvent.pointerUp(handle(), { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 900 });
    expect(shown()).toBe("0.60");
  });

  it("never takes the scanner's focus on a press", () => {
    render(<Split />);
    const box = screen.getByLabelText("Scanner input");
    box.focus();
    const press = fireEvent.pointerDown(handle(), { pointerId: 1, clientX: 700 });
    expect(press).toBe(false);
    expect(box).toHaveFocus();
  });

  it("resizes by keyboard, and Enter or a double-click puts the default back", () => {
    render(<Split />);
    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    expect(shown()).toBe("0.32");
    fireEvent.keyDown(handle(), { key: "End" });
    expect(shown()).toBe("0.20");
    fireEvent.keyDown(handle(), { key: "Enter" });
    expect(shown()).toBe("default");
    fireEvent.keyDown(handle(), { key: "Home" });
    fireEvent.doubleClick(handle());
    expect(shown()).toBe("default");
  });

  it("remembers the width on this computer, and ignores a stored value out of range", () => {
    const { unmount } = render(<Split />);
    fireEvent.keyDown(handle(), { key: "Home" });
    unmount();
    render(<Split />);
    expect(shown()).toBe("0.60");
    expect(handle()).toHaveAttribute("aria-valuenow", "60");

    window.localStorage.setItem(KEY, "5");
    render(<Split />);
    expect(screen.getAllByTestId("fraction").at(-1)?.textContent).toBe("default");
  });

  it("turns a share into a width that leaves both panes usable", () => {
    expect(splitWidth(0.35, 300, 420)).toBe("clamp(300px, 35.00%, calc(100% - 420px))");
  });
});
