import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTodayFollowingDate } from "./useTodayFollowingDate";

// Owner, 24 Nov 2026: a ledger left open overnight kept yesterday as its "to" date, so today's vouchers showed only
// after a refresh. The date follows the business day (Asia/Karachi) until another is picked.

afterEach(() => { vi.useRealTimers(); });

describe("useTodayFollowingDate", () => {
  it("moves on to the new day by itself while nobody has picked a date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T18:58:00Z")); // 23:58 in Karachi
    const { result } = renderHook(() => useTodayFollowingDate());
    expect(result.current[0]).toBe("2026-11-24");
    act(() => { vi.advanceTimersByTime(3 * 60_000); }); // 00:01 the next day
    expect(result.current[0]).toBe("2026-11-25");
  });

  it("keeps a picked day, and follows the calendar again once today is picked", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T18:58:00Z"));
    const { result } = renderHook(() => useTodayFollowingDate());
    act(() => { result.current[1]("2026-11-20"); });
    act(() => { vi.advanceTimersByTime(3 * 60_000); });
    expect(result.current[0]).toBe("2026-11-20");
    act(() => { result.current[1]("2026-11-25"); }); // today, picked again
    act(() => { vi.advanceTimersByTime(24 * 60 * 60_000); });
    expect(result.current[0]).toBe("2026-11-26");
  });
});
