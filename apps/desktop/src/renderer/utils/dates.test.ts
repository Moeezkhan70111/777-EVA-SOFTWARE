import { describe, expect, it } from "vitest";
import { formatClockTime, formatDashedDate } from "./dates";

describe("formatDashedDate", () => {
  it("prints a UTC-instant timestamp as DD-MM-YYYY in the business timezone", () => {
    // Midnight UTC on 2026-09-30 is still 2026-09-30 in Asia/Karachi (UTC+5).
    expect(formatDashedDate("2026-09-30T00:00:00.000Z")).toBe("30-09-2026");
  });

  it("falls back for an unparseable value", () => {
    expect(formatDashedDate(null)).toBe("—");
    expect(formatDashedDate(undefined)).toBe("—");
  });
});

describe("formatClockTime", () => {
  it("prints a zone-less local timestamp as a 12-hour clock with no leading zero", () => {
    expect(formatClockTime("2026-09-30T06:00:00.000")).toBe("6:00 AM");
    expect(formatClockTime("2026-09-30T18:05:00.000")).toBe("6:05 PM");
  });

  it("falls back for an unparseable value", () => {
    expect(formatClockTime(null)).toBe("—");
  });
});
