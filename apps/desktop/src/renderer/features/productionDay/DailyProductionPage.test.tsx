import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildProductionDay, type ProductionDayLine } from "@erp/domain";
import { copy } from "../../config/copy";
import { shiftIsoDate, toIsoDate } from "../../utils/dates";
import { DailyProductionPage } from "./DailyProductionPage";

// DAILY PRODUCTION (docs/48): one day's saved production, clearly: the totals, every machine together or one at a time,
// each article as Size x Colour with its totals. Every figure is the main process's; the page only shows them.

const text = copy.productionDay;
const api = { getProductionDay: vi.fn() };

const line = (machineName: string, article: string, size: string, color: string, cartons: number): ProductionDayLine => ({ machineName, article, size, color, cartons, entries: 1 });
const DAY = [line("MACHINE 1", "SK6", "7/10", "RED", 20), line("MACHINE 1", "SK6", "4/6", "BLACK", 5), line("MACHINE 2", "SK12", "7/10", "RED", 6)];
const MARK = { date: toIsoDate(), completedAt: "2026-11-14T13:05:00.000Z", completedBy: "aslam", cartons: 31, entries: 3 };

const show = (onRecordProduction?: () => void) => render(<DailyProductionPage onRecordProduction={onRecordProduction} />);
const names = () => Array.from(document.querySelectorAll(".cs-article-name"), (heading) => heading.textContent);

beforeEach(() => {
  api.getProductionDay.mockReset().mockImplementation(async ({ date }: { date: string }) => ({ accepted: true, day: buildProductionDay(date, DAY, null) }));
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
});

describe("Daily Production", () => {
  it("opens on today: the totals, then every machine together, one card per article", async () => {
    show();
    expect(await screen.findByText(text.kpiDozens)).toBeInTheDocument();
    expect(api.getProductionDay).toHaveBeenCalledWith({ date: toIsoDate() });
    const figures = document.querySelector(".pd-kpis") as HTMLElement;
    expect(figures).toHaveTextContent(`${text.kpiDozens}15.5`);
    expect(figures).toHaveTextContent(`${text.kpiCartons}31`);
    expect(figures).toHaveTextContent(`${text.kpiMachines}2`);
    expect(figures).toHaveTextContent(`${text.kpiEntries}3`);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([text.allMachines, text.machineTab("MACHINE 1", "12.5"), text.machineTab("MACHINE 2", "3")]);
    expect(names()).toEqual(["SK6", "SK12"]);
    const sk6 = screen.getByRole("region", { name: text.tableLabel("SK6") });
    expect(within(sk6).getByRole("row", { name: "7/10 - 10 10" })).toBeInTheDocument();
    expect(within(sk6).getByRole("row", { name: "Total 2.5 10 12.5" })).toBeInTheDocument();
  });

  it("one machine at a time, with what it made", async () => {
    show();
    await userEvent.click(await screen.findByRole("tab", { name: text.machineTab("MACHINE 2", "3") }));
    expect(names()).toEqual(["SK12"]);
    expect(screen.getByText(text.machineSummary("MACHINE 2", "3", 1))).toBeInTheDocument();
  });

  it("says whether the day was completed", async () => {
    api.getProductionDay.mockResolvedValue({ accepted: true, day: buildProductionDay(toIsoDate(), DAY, MARK) });
    show();
    expect(await screen.findByText(copy.productionDay.added)).toBeInTheDocument();
  });

  it("goes back a day, and forward no further than today", async () => {
    show();
    await screen.findByText(text.kpiDozens);
    expect(screen.getByRole("button", { name: text.nextDay })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: text.previousDay }));
    await waitFor(() => expect(api.getProductionDay).toHaveBeenLastCalledWith({ date: shiftIsoDate(toIsoDate(), -1) }));
    expect(screen.getByRole("button", { name: text.nextDay })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: text.today }));
    await waitFor(() => expect(api.getProductionDay).toHaveBeenLastCalledWith({ date: toIsoDate() }));
  });

  it("an empty day says so, and today offers the way to record production", async () => {
    api.getProductionDay.mockImplementation(async ({ date }: { date: string }) => ({ accepted: true, day: buildProductionDay(date, [], null) }));
    const record = vi.fn();
    show(record);
    expect(await screen.findByText(text.emptyTitle)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: text.recordProduction }));
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("a failed or malformed read is a failure with a retry, never a blank or invented day", async () => {
    api.getProductionDay
      .mockResolvedValueOnce({ accepted: true, day: { date: toIsoDate(), totalCartons: "lots" } })
      .mockImplementation(async ({ date }: { date: string }) => ({ accepted: true, day: buildProductionDay(date, DAY, null) }));
    show();
    expect(await screen.findByText(text.failed)).toBeInTheDocument();
    expect(document.querySelector(".pd-kpis")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: copy.common.retry }));
    expect(await screen.findByText(text.kpiDozens)).toBeInTheDocument();
  });
});
