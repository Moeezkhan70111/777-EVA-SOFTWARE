import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QrJourneyPage, formatDuration } from "./QrJourneyPage";
import { NotificationsProvider } from "../state/NotificationsContext";
import type { QrJourney, QrJourneyStep, QrSearchRow } from "../types/desktopApi";

// The page is a read-only trace over what the database answers. The fake backend below
// returns the exact path the user described — in, out, in, out, dispatched, returned,
// back into the store — and the page must show every hop of it, in order.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const T0 = Date.UTC(2026, 8, 10, 9, 0, 0);
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function step(
  index: number,
  kind: QrJourneyStep["kind"],
  offsetMs: number,
  fromStatus: string | null,
  toStatus: string,
  fromPlace: QrJourneyStep["fromPlace"],
  toPlace: QrJourneyStep["toPlace"],
  extra: Partial<QrJourneyStep> = {}
): QrJourneyStep {
  return {
    index,
    id: `s${index}`,
    kind,
    eventType: kind === "REGISTERED" || kind === "VOID" ? null : kind.startsWith("STORE_") ? "MOVED" : kind,
    occurredAt: at(offsetMs),
    fromStatus,
    toStatus,
    fromPlace,
    toPlace,
    actor: null,
    deviceId: "desktop-main",
    workstation: "Production Line 01",
    factory: "777 Manufacturing",
    note: null,
    syncStatus: "PENDING",
    sinceMs: null,
    ...extra,
  };
}

const RAW_STEPS: QrJourneyStep[] = [
  step(1, "REGISTERED", 0, null, "REGISTERED", null, null, { deviceId: null, workstation: null, factory: null, syncStatus: null }),
  step(2, "PRODUCED", 2 * HOUR, "REGISTERED", "PRODUCED", null, "FACTORY"),
  step(3, "STORE_ENTRY", 2 * HOUR + 30 * MIN, "PRODUCED", "WAREHOUSE", "FACTORY", "WAREHOUSE", { actor: "store-op" }),
  step(4, "STORE_EXIT", 1 * DAY, "WAREHOUSE", "TO_GATE", "WAREHOUSE", "GATE", { actor: "store-op" }),
  step(5, "STORE_ENTRY", 1 * DAY + 3 * HOUR, "TO_GATE", "WAREHOUSE", "GATE", "WAREHOUSE", { actor: "store-op" }),
  step(6, "STORE_EXIT", 2 * DAY, "WAREHOUSE", "TO_GATE", "WAREHOUSE", "GATE", { actor: "gate-op" }),
  step(7, "DISPATCHED", 2 * DAY + 2 * HOUR, "TO_GATE", "DISPATCHED", "GATE", "CUSTOMER"),
  step(8, "RETURNED", 9 * DAY, "DISPATCHED", "RETURNED", "CUSTOMER", "FACTORY"),
  step(9, "STORE_ENTRY", 9 * DAY + 45 * MIN, "RETURNED", "WAREHOUSE", "FACTORY", "WAREHOUSE", { actor: "store-op" }),
];
const STEPS: QrJourneyStep[] = RAW_STEPS.map((s, i) => ({
  ...s,
  sinceMs: i === 0 ? null : new Date(s.occurredAt).getTime() - new Date(RAW_STEPS[i - 1].occurredAt).getTime(),
}));

const JOURNEY: QrJourney = {
  qrId: "SK6_RED_7/10_000037",
  article: "SK6",
  color: "RED",
  size: "7/10",
  serial: "000037",
  stage: "WAREHOUSE",
  currentStatus: "WAREHOUSE",
  currentPlace: "WAREHOUSE",
  registeredAt: at(0),
  batchId: "batch-1",
  firstScannedAt: at(2 * HOUR),
  lastActivityAt: at(9 * DAY + 45 * MIN),
  steps: STEPS,
  counts: { REGISTERED: 1, PRODUCED: 1, STORE_ENTRY: 3, STORE_EXIT: 2, DISPATCHED: 1, RETURNED: 1 },
  dwellMs: { REGISTERED: 2 * HOUR, PRODUCED: 30 * MIN, WAREHOUSE: 3 * DAY, TO_GATE: 5 * HOUR, DISPATCHED: 7 * DAY, RETURNED: 45 * MIN },
  asOf: at(12 * DAY),
};

const FRESH: QrJourney = {
  qrId: "SK6_RED_7/10_000040",
  article: "SK6",
  color: "RED",
  size: "7/10",
  serial: "000040",
  stage: "REGISTERED",
  currentStatus: null,
  currentPlace: null,
  registeredAt: at(0),
  batchId: "batch-1",
  firstScannedAt: null,
  lastActivityAt: at(0),
  steps: [STEPS[0]],
  counts: { REGISTERED: 1 },
  dwellMs: { REGISTERED: 12 * DAY },
  asOf: at(12 * DAY),
};

function installBackend(journeys: Record<string, QrJourney>) {
  const api = {
    getQrJourney: vi.fn(async (qrId: string) => journeys[qrId.toUpperCase()] ?? null),
    searchQrCodes: vi.fn(async (q: string): Promise<QrSearchRow[]> =>
      Object.values(journeys)
        .filter((j) => j.qrId.replace(/[_/]/g, " ").includes(q.toUpperCase().replace(/[_/]/g, " ")))
        .map((j) => ({ qrId: j.qrId, article: j.article, color: j.color, size: j.size, sequence: Number(j.serial), batchId: j.batchId ?? "", registeredAt: j.registeredAt ?? "", stage: j.stage, lastActivityAt: j.lastActivityAt ?? "" }))
    ),
    getQrDetail: vi.fn(async (qrId: string) => ({
      qrId,
      article: "SK6",
      color: "RED",
      size: "7/10",
      serial: qrId.slice(-6),
      stage: "WAREHOUSE",
      productVariantId: "pv-1",
      sellingPrice: 550,
      stockOnHand: 12,
      registry: { status: "GENERATED", registeredAt: at(0), voidReason: null, voidedAt: null, voidedBy: null },
      batch: null,
      lifecycle: { currentStatus: "WAREHOUSE", locationType: "WAREHOUSE", locationId: "factory-777", firstScannedAt: at(2 * HOUR), updatedAt: at(9 * DAY) },
      events: [{ id: "e1", eventType: "PRODUCED", subType: null, occurredAt: at(2 * HOUR), factory: "777", workstation: "Line 1", operator: null, deviceId: "d", note: null, syncStatus: "PENDING" }],
    })),
  };
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });
  return api;
}

const renderPage = () =>
  render(
    <NotificationsProvider>
      <QrJourneyPage username="admin" />
    </NotificationsProvider>
  );

/** Types a code and presses Enter — what a handheld scanner does. */
const trace = (code: string) => {
  const input = screen.getByLabelText("Trace QR");
  fireEvent.change(input, { target: { value: code } });
  fireEvent.submit(input.closest("form")!);
};

describe("QrJourneyPage", () => {
  // Real timers, like QR Management's own lookup tests: the 250 ms suggestion debounce is
  // well inside findBy*'s window, and the drawer's QR render is happier without faked clocks.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens with the lookup focused and an explanation of what the page traces", () => {
    installBackend({});
    renderPage();
    expect(screen.getByRole("heading", { name: "QR Journey" })).toBeInTheDocument();
    expect(screen.getByLabelText("Trace QR")).toHaveFocus();
    expect(screen.getByText("Trace a code's whole path")).toBeInTheDocument();
    expect(screen.queryByLabelText("Journey")).not.toBeInTheDocument();
  });

  it("shows the whole path — in, out, in, out, dispatched, returned, back in — hop by hop and in one line", async () => {
    const api = installBackend({ [JOURNEY.qrId]: JOURNEY });
    renderPage();

    trace("SK6_RED_7/10_000037");
    await waitFor(() => expect(screen.getByTestId("journey-code")).toHaveTextContent("SK6_RED_7/10_000037"));
    expect(api.getQrJourney).toHaveBeenCalledWith("SK6_RED_7/10_000037");

    // Where it stands now.
    expect(screen.getByTestId("journey-product")).toHaveTextContent("SK6 · RED · 7/10");
    expect(within(screen.getByLabelText("Current status")).getByText("In Store")).toBeInTheDocument();
    expect(screen.getByTestId("journey-place")).toHaveTextContent("at Store");
    expect(screen.getByTestId("journey-hops")).toHaveTextContent("9");

    // The path in one line, every status in order, last one current.
    const path = screen.getByLabelText("Path");
    expect(within(path).getAllByRole("listitem").map((li) => li.querySelector(".qrj-path-label")?.textContent)).toEqual([
      "Generated",
      "Production",
      "In Store",
      "To Gate",
      "In Store",
      "To Gate",
      "Dispatched",
      "Returned",
      "In Store",
    ]);
    expect(within(path).getAllByRole("listitem")[8]).toHaveClass("is-current");

    // Every hop spelled out, oldest first, with its transition, who and elapsed time.
    const steps = screen.getAllByTestId("journey-step");
    expect(steps).toHaveLength(9);
    expect(steps[0]).toHaveTextContent("Generated");
    expect(steps[0]).toHaveTextContent("QR Generator");
    expect(steps[2]).toHaveTextContent("Moved in to store");
    expect(steps[2]).toHaveTextContent("Store — Move In");
    expect(within(steps[2]).getByLabelText("Status change")).toHaveTextContent("Production / Stock→In Store");
    expect(steps[2]).toHaveTextContent("Factory floor → Store");
    expect(steps[2]).toHaveTextContent("by store-op");
    expect(steps[2]).toHaveTextContent("+30 min");
    expect(steps[3]).toHaveTextContent("Moved out to gate");
    expect(within(steps[3]).getByLabelText("Status change")).toHaveTextContent("In Store→To Gate");
    expect(steps[5]).toHaveTextContent("by gate-op");
    expect(steps[6]).toHaveTextContent("Dispatched");
    expect(within(steps[6]).getByLabelText("Status change")).toHaveTextContent("To Gate→Dispatched");
    expect(steps[6]).toHaveTextContent("Gate → With customer");
    expect(steps[7]).toHaveTextContent("Returned");
    expect(steps[7]).toHaveTextContent("+6 d 22 h");
    expect(steps[8]).toHaveTextContent("Moved in to store");
    expect(within(steps[8]).getByLabelText("Status change")).toHaveTextContent("Returned→In Store");
    expect(steps[8]).toHaveClass("is-current");

    // Tallies and time spent, from the same answer.
    const counts = screen.getByLabelText("Hops by kind");
    expect(counts).toHaveTextContent("3× Moved in");
    expect(counts).toHaveTextContent("2× Moved out");
    expect(counts).toHaveTextContent("1× Dispatched");
    expect(counts).toHaveTextContent("1× Returned");
    const dwell = screen.getByLabelText("Time spent");
    expect(dwell).toHaveTextContent("In Store");
    expect(dwell).toHaveTextContent("3 d");
    expect(dwell).toHaveTextContent("Dispatched");
    expect(dwell).toHaveTextContent("7 d");

    // The lookup is cleared and ready for the next code.
    expect(screen.getByLabelText("Trace QR")).toHaveValue("");
  });

  it("a generated-only code has a one-hop journey and says so", async () => {
    installBackend({ [FRESH.qrId]: FRESH });
    renderPage();
    trace("SK6_RED_7/10_000040");
    await waitFor(() => expect(screen.getByTestId("journey-code")).toHaveTextContent("SK6_RED_7/10_000040"));
    expect(screen.getByTestId("journey-hops")).toHaveTextContent("1");
    expect(screen.getByTestId("journey-place")).toHaveTextContent("no physical unit yet");
    expect(screen.getAllByTestId("journey-step")).toHaveLength(1);
    expect(screen.getByLabelText("Hops by kind")).toHaveTextContent("Only generated so far");
  });

  it("reports QR NOT FOUND for an unknown code and keeps the last journey on screen", async () => {
    installBackend({ [JOURNEY.qrId]: JOURNEY });
    renderPage();
    trace("SK6_RED_7/10_000037");
    await waitFor(() => expect(screen.getByTestId("journey-code")).toHaveTextContent("SK6_RED_7/10_000037"));

    trace("SK6_RED_7/10_999999");
    expect(await screen.findByRole("alert")).toHaveTextContent("QR NOT FOUND");
    expect(screen.getByRole("alert")).toHaveTextContent("SK6_RED_7/10_999999");
    expect(screen.getByTestId("journey-code")).toHaveTextContent("SK6_RED_7/10_000037");
  });

  it("suggests matches while typing and traces one on click; recently traced codes can be reopened", async () => {
    installBackend({ [JOURNEY.qrId]: JOURNEY, [FRESH.qrId]: FRESH });
    renderPage();

    fireEvent.change(screen.getByLabelText("Trace QR"), { target: { value: "SK6 RED" } });
    const listbox = await screen.findByRole("listbox", { name: "Matching codes" });
    expect(within(listbox).getAllByRole("option")).toHaveLength(2);
    fireEvent.click(within(listbox).getByText("SK6_RED_7/10_000040"));
    await waitFor(() => expect(screen.getByTestId("journey-code")).toHaveTextContent("SK6_RED_7/10_000040"));

    trace("SK6_RED_7/10_000037");
    await waitFor(() => expect(screen.getByTestId("journey-code")).toHaveTextContent("SK6_RED_7/10_000037"));

    const recent = screen.getByLabelText("Recently traced");
    expect(within(recent).getAllByRole("button").map((b) => b.textContent)).toEqual(["SK6_RED_7/10_000037", "SK6_RED_7/10_000040"]);
    fireEvent.click(within(recent).getByText("SK6_RED_7/10_000040"));
    await waitFor(() => expect(screen.getByTestId("journey-code")).toHaveTextContent("SK6_RED_7/10_000040"));
  });

  it("opens the QR Management detail drawer read-only for the traced code", async () => {
    const api = installBackend({ [JOURNEY.qrId]: JOURNEY });
    renderPage();
    trace("SK6_RED_7/10_000037");
    await waitFor(() => expect(screen.getByTestId("journey-code")).toHaveTextContent("SK6_RED_7/10_000037"));

    fireEvent.click(screen.getByRole("button", { name: "Full details" }));
    const dialog = await screen.findByRole("dialog");
    expect(api.getQrDetail).toHaveBeenCalledWith("SK6_RED_7/10_000037");
    await waitFor(() => expect(within(dialog).getByText("Production scan (+IN)")).toBeInTheDocument());
    expect(within(dialog).queryByRole("button", { name: /mark damaged/i })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Trace QR")).toHaveFocus();
  });
});

describe("formatDuration", () => {
  it("reads like a story, not a stopwatch", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(20_000)).toBe("< 1 min");
    expect(formatDuration(3 * MIN)).toBe("3 min");
    expect(formatDuration(2 * HOUR + 15 * MIN)).toBe("2 h 15 min");
    expect(formatDuration(2 * HOUR)).toBe("2 h");
    expect(formatDuration(4 * DAY + 6 * HOUR + 59 * MIN)).toBe("4 d 6 h");
    expect(formatDuration(15 * DAY)).toBe("15 d");
  });
});
