import type React from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScanBox } from "./useScanBox";

// One scan is one submission, however the code arrives. A scanner that types the code AND sends
// Enter gives the box two ways to send it: the auto-submit timer and the Enter key. On a busy PC
// the timer can send and clear the box before React re-renders, and the Enter that follows is then
// handled by the PREVIOUS render's handler, which still saw the code. Found by the Machine Move
// Out test sending one scan twice under load (2026-10-25).

const enter = { key: "Enter", preventDefault: () => undefined } as unknown as React.KeyboardEvent<HTMLInputElement>;
const CODE = "RM_6_42_1";

describe("useScanBox — one scan, one submission", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("an Enter handled by the render before the auto-submit cleared the box sends nothing more", async () => {
    const onScan = vi.fn(async () => true);
    const { result } = renderHook(() => useScanBox({ armed: true, onScan, refocusKey: 0 }));

    act(() => result.current.setInputVal(CODE));
    // The handler as rendered with the code in the box — what a busy PC still delivers Enter to.
    const staleKeyDown = result.current.onKeyDown;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(onScan).toHaveBeenCalledTimes(1);

    await act(async () => {
      staleKeyDown(enter);
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan).toHaveBeenCalledWith(CODE);
  });

  it("Enter before the auto-submit sends the code once, and the timer does not send it again", async () => {
    const onScan = vi.fn(async () => true);
    const { result } = renderHook(() => useScanBox({ armed: true, onScan, refocusKey: 0 }));

    act(() => result.current.setInputVal(CODE));
    await act(async () => {
      result.current.onKeyDown(enter);
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(onScan).toHaveBeenCalledTimes(1);
    expect(result.current.inputVal).toBe("");
  });
});
