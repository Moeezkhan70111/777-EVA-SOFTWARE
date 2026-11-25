import { describe, expect, it } from "vitest";
import { buildProductionDay } from "@erp/domain";
import { barHeights, changeFromDayBefore, shareOf, topArticle, weekDates } from "./dayInsights";

describe("what a day's production says", () => {
  it("the week is the seven days ending on the day shown, oldest first", () => {
    expect(weekDates("2026-11-25")).toEqual(["2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25"]);
  });

  it("draws each day against the week's best day, and an empty week flat", () => {
    const week = [{ date: "a", cartons: 40, complete: true }, { date: "b", cartons: 10, complete: false }, { date: "c", cartons: null, complete: false }];
    expect(barHeights(week)).toEqual([100, 25, 0]);
    expect(barHeights([{ date: "a", cartons: 0, complete: false }])).toEqual([0]);
  });

  it("compares with the day before only when both are known", () => {
    const week = [{ date: "2026-11-24", cartons: 30, complete: true }, { date: "2026-11-25", cartons: 38, complete: false }];
    expect(changeFromDayBefore(week, "2026-11-25")).toBe(8);
    expect(changeFromDayBefore(week, "2026-11-24")).toBeNull();
    expect(changeFromDayBefore([{ date: "2026-11-24", cartons: null, complete: false }, ...week.slice(1)], "2026-11-25")).toBeNull();
  });

  it("names the top article and its share of the day; an empty day has none", () => {
    const day = buildProductionDay("2026-11-25", [
      { machineName: "MACHINE 1", article: "SK6", size: "7/10", color: "RED", cartons: 30, entries: 1 },
      { machineName: "MACHINE 2", article: "SK12", size: "4/6", color: "BLUE", cartons: 10, entries: 1 },
    ], null);
    expect(topArticle(day)).toEqual({ article: "SK6", cartons: 30, share: 75 });
    expect(topArticle(buildProductionDay("2026-11-25", [], null))).toBeNull();
    expect(shareOf(5, 0)).toBe(0);
  });
});
