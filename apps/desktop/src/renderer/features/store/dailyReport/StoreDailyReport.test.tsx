import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { STORE_MOVEMENT_SOURCE, buildStoreDailyReport, type StoreDayCartonEntry, type StoreDayMaterialEntry } from "@erp/domain";
import { shiftIsoDate, toIsoDate } from "../../../utils/dates";
import { StoreDailyReport } from "./StoreDailyReport";

// The store's daily report screen: it shows what the main process counted, in its four states,
// and asks again for the day the operator picks.

const TODAY = toIsoDate();

const scan: StoreDayMaterialEntry = {
  kind: "MATERIAL", id: "s1", source: STORE_MOVEMENT_SOURCE.SCAN, at: `${TODAY}T09:15:00.000Z`,
  itemId: "dana", itemDisplayName: "DANA EVA BLACK", quantity: 25, unitCode: "KG", qrId: "RMQ-000123",
  partyName: "ABC TRADERS", sectionName: null, programCode: null, note: null, actor: "aslam",
};
const typed: StoreDayMaterialEntry = {
  ...scan, id: "t1", source: STORE_MOVEMENT_SOURCE.MANUAL, itemId: "nawaar", itemDisplayName: "NAWAAR 5 SOOTAR",
  quantity: 700, unitCode: "INCH", qrId: null, partyName: "ABC TRADERS", note: "Manual move in — 700 INCH",
};
const carton: StoreDayCartonEntry = {
  kind: "CARTON", id: "c1", source: STORE_MOVEMENT_SOURCE.CARTON, at: `${TODAY}T10:00:00.000Z`,
  qrId: "SK6_BLACK_7/10_000001", article: "SK6", color: "BLACK", size: "7/10", programCode: "MP-000012", actor: "aslam",
};

const reportFor = (date: string, materials: StoreDayMaterialEntry[], cartons: StoreDayCartonEntry[] = []) =>
  buildStoreDailyReport({ date, direction: "IN", materials, cartons });

function installApi(getStoreDailyReport: ReturnType<typeof vi.fn>) {
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api: { getStoreDailyReport } },
    configurable: true,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("Store daily report", () => {
  it("shows today's movements: a figure per kind, the totals and every row", async () => {
    const read = vi.fn(async ({ date }: { date: string }) => ({ accepted: true, report: reportFor(date, [scan, typed], [carton]) }));
    installApi(read);
    render(<StoreDailyReport direction="IN" token="t-1" />);

    const summary = await screen.findByRole("list", { name: "The day by kind of movement" });
    expect(read).toHaveBeenCalledWith({ date: TODAY, direction: "IN", token: "t-1" });
    expect(within(summary).getByText("Movements").nextSibling).toHaveTextContent("3");
    expect(within(summary).getByText("Scanned packets")).toBeInTheDocument();
    expect(within(summary).getByText("By hand")).toBeInTheDocument();

    const materials = screen.getByRole("region", { name: "Raw material" });
    expect(within(materials).getByText("700 INCH")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Cartons" })).getByText("SK6")).toBeInTheDocument();

    const rows = within(screen.getByRole("region", { name: "Every movement" })).getAllByRole("row");
    // Newest first: the carton at 10:00, then the two at 09:15.
    expect(rows[1]).toHaveTextContent("Carton");
    expect(rows[1]).toHaveTextContent("For MP-000012");
    expect(screen.getByText("From ABC TRADERS · RMQ-000123")).toBeInTheDocument();
  });

  it("asks again for the day before, and says when nothing moved", async () => {
    const read = vi.fn(async ({ date }: { date: string }) => ({ accepted: true, report: reportFor(date, date === TODAY ? [scan] : []) }));
    installApi(read);
    render(<StoreDailyReport direction="IN" token="t-1" />);
    await screen.findByRole("region", { name: "Every movement" });
    expect(screen.getByRole("button", { name: "Next day" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Previous day" }));

    expect(await screen.findByText("Nothing came into the store on this day")).toBeInTheDocument();
    expect(read).toHaveBeenLastCalledWith({ date: shiftIsoDate(TODAY, -1), direction: "IN", token: "t-1" });
  });

  it("explains a failed read and retries it", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ accepted: false, reason: "Your account does not have Store Scanning access." })
      .mockResolvedValueOnce({ accepted: true, report: reportFor(TODAY, [scan]) });
    installApi(read);
    render(<StoreDailyReport direction="OUT" token="t-1" />);

    expect(await screen.findByText("Your account does not have Store Scanning access.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("region", { name: "Every movement" })).toBeInTheDocument();
  });

  it("opens a busy day on its latest page and grows on request", async () => {
    const many = Array.from({ length: 130 }, (_, index) => ({ ...scan, id: `s${index}`, at: `${TODAY}T08:${String(index % 60).padStart(2, "0")}:00.000Z` }));
    installApi(vi.fn(async () => ({ accepted: true, report: reportFor(TODAY, many) })));
    render(<StoreDailyReport direction="IN" token="t-1" />);

    expect(await screen.findByText("Showing the latest 100 of 130 movements.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.queryByText(/Showing the latest/)).not.toBeInTheDocument();
  });
});
