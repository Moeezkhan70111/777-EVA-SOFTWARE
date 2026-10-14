import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { BCartonGeneratorPage } from "./BCartonGeneratorPage";
import { NotificationsProvider } from "../state/NotificationsContext";
import { bCartonQuantityProblem, bCartonRange, isBCartonBatch } from "../features/products/bCartonLabels";

// B CARTON LABELS — an article, a size and a count. The colour is never asked for: a B carton
// holds mixed colours, so its identity carries MIX and its sticker prints a B (migration 074).

/** What the carton label template was asked to print, so the B mark and the ids can be read back. */
interface PrintedCall {
  identity: { article: string; color: string; size: string; grade?: string | null };
  ids: string[];
}

const printWindow = vi.fn((_opts: PrintedCall) => true);
vi.mock("../utils/qrLabels", () => ({
  openCartonLabelPrintWindow: (opts: PrintedCall) => printWindow(opts),
}));

function setupDesktop(api: Record<string, unknown>) {
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });
}

const EVR9 = {
  id: "as-evr9",
  articleSizeId: "as-evr9",
  article: "EVR9",
  color: "",
  size: "7/10",
  colors: [],
  description: null,
  costPrice: 300,
  sellingPrice: 550,
  mainGroupId: null,
  groupId: null,
  articleSeriesId: null,
  status: "ACTIVE",
  createdAt: "2024-01-01",
  updatedAt: "2024-01-01",
};

const batch = (overrides: Record<string, unknown> = {}) => ({
  id: "batch-1",
  articleSizeId: "as-evr9",
  article: "EVR9",
  color: "MIX",
  size: "7/10",
  startSequence: 1,
  endSequence: 3,
  quantity: 3,
  createdAt: "2026-10-13T09:00:00.000Z",
  createdBy: "STORE",
  requestedBy: null,
  grade: "B" as const,
  ...overrides,
});

const codes = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `EVR9_MIX_7/10_00000${index + 1}`,
    batchId: "batch-1",
    article: "EVR9",
    color: "MIX",
    size: "7/10",
    sequence: index + 1,
    status: "GENERATED",
    createdAt: "2026-10-13T09:00:00.000Z",
    productVariantId: null,
  }));

function baseApi(overrides: Record<string, unknown> = {}) {
  return {
    listProducts: vi.fn().mockResolvedValue({ rows: [EVR9], total: 1, page: 1, pageSize: 1000 }),
    listQrBatches: vi.fn().mockResolvedValue([]),
    listQrCodesForBatch: vi.fn().mockResolvedValue(codes(3)),
    getQrSequenceState: vi.fn().mockResolvedValue({
      article: "EVR9",
      size: "7/10",
      color: "MIX",
      lastSequence: 0,
      nextSequence: 1,
    }),
    generateQrBatch: vi.fn().mockResolvedValue({ accepted: true, batch: batch(), qrCodes: codes(3) }),
    ...overrides,
  };
}

/** The machine chosen above the tabs — every run is generated for one (Phase 1.1). */
const MACHINE = {
  id: "m-1",
  machineCode: "M-001",
  name: "MACHINE 1",
  sectionId: "ws-1",
  sectionName: "PACKING",
  sortOrder: 1,
  status: "ACTIVE",
  contractorPartyId: "p-aslam",
  contractorName: "ASLAM",
  packingContractorPartyId: "p-babar",
  packingContractorName: "BABAR",
};

const renderPage = () =>
  render(
    <NotificationsProvider>
      <BCartonGeneratorPage machine={MACHINE} username="STORE" />
    </NotificationsProvider>
  );

const chooseArticle = async () => {
  await userEvent.click(await screen.findByLabelText("Article and size"));
  await userEvent.click(await screen.findByText("EVR9 / 7/10"));
};

describe("B Carton Labels", () => {
  beforeEach(() => {
    printWindow.mockClear();
  });

  it("asks only for the article, the size and how many — never a colour", async () => {
    setupDesktop(baseApi());
    renderPage();

    expect(await screen.findByLabelText("Article and size")).toBeInTheDocument();
    expect(screen.getByLabelText("Labels to print")).toBeInTheDocument();
    expect(screen.queryByLabelText(/colour$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/prints a big B instead of a colour/i)).toBeInTheDocument();
  });

  it("shows the exact identities it will register before anything is generated", async () => {
    setupDesktop(baseApi());
    renderPage();

    await chooseArticle();
    await userEvent.type(screen.getByLabelText("Labels to print"), "3");

    expect(await screen.findByText("EVR9_MIX_7/10_000001")).toBeInTheDocument();
    expect(screen.getByText("EVR9_MIX_7/10_000003")).toBeInTheDocument();
    expect(screen.getByText(/First B carton run/i)).toBeInTheDocument();
  });

  it("registers the run as MIX, grade B, and prints it with the B mark", async () => {
    const api = baseApi();
    setupDesktop(api);
    renderPage();

    await chooseArticle();
    await userEvent.type(screen.getByLabelText("Labels to print"), "3");
    await userEvent.click(screen.getByRole("button", { name: /Generate 3 labels/i }));

    await waitFor(() => expect(api.generateQrBatch).toHaveBeenCalledTimes(1));
    expect(api.generateQrBatch).toHaveBeenCalledWith({
      machineId: "m-1",
      articleSizeId: "as-evr9",
      color: "MIX",
      quantity: 3,
      createdBy: "STORE",
      grade: "B",
    });

    // The labels go straight to the printer, as a B run of this article and size.
    await waitFor(() => expect(printWindow).toHaveBeenCalledTimes(1));
    const printed = printWindow.mock.calls[0][0];
    expect(printed.identity).toEqual({ article: "EVR9", color: "MIX", size: "7/10", grade: "B" });
    expect(printed.ids).toHaveLength(3);
  });

  it("refuses a quantity the registry would refuse, before sending it", async () => {
    const api = baseApi();
    setupDesktop(api);
    renderPage();

    await chooseArticle();
    const field = screen.getByLabelText("Labels to print");
    await userEvent.type(field, "0");
    expect(await screen.findByRole("alert")).toHaveTextContent("At least 1 label.");

    await userEvent.clear(field);
    await userEvent.type(field, "20000");
    expect(await screen.findByRole("alert")).toHaveTextContent("At most 10,000 labels in one run.");
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
    expect(api.generateQrBatch).not.toHaveBeenCalled();
  });

  // The refusal itself goes to the notification host, which App mounts — what this pins is that a
  // refused run prints nothing, claims nothing, and leaves the quantity typed to try again.
  it("prints nothing and claims nothing when the run is refused", async () => {
    const api = baseApi({
      generateQrBatch: vi.fn().mockResolvedValue({ accepted: false, reason: "Color is required." }),
    });
    setupDesktop(api);
    renderPage();

    await chooseArticle();
    await userEvent.type(screen.getByLabelText("Labels to print"), "2");
    await userEvent.click(screen.getByRole("button", { name: /Generate 2 labels/i }));

    await waitFor(() => expect(api.generateQrBatch).toHaveBeenCalledTimes(1));
    expect(printWindow).not.toHaveBeenCalled();
    expect(screen.queryByText("B carton labels registered")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Labels to print")).toHaveValue("2");
  });

  it("lists only B runs, and reprints one with the same codes", async () => {
    const api = baseApi({
      listQrBatches: vi.fn().mockResolvedValue([
        batch(),
        batch({ id: "batch-2", color: "BLACK", grade: null, article: "SK6" }),
      ]),
    });
    setupDesktop(api);
    renderPage();

    expect(await screen.findByRole("button", { name: /Print the B labels for EVR9 7\/10 again/i })).toBeInTheDocument();
    expect(screen.queryByText("SK6")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Print the B labels for EVR9 7\/10 again/i }));
    await waitFor(() => expect(printWindow).toHaveBeenCalledTimes(1));
    expect(api.generateQrBatch).not.toHaveBeenCalled();
    expect(api.listQrCodesForBatch).toHaveBeenCalledWith("batch-1");
  });

  it("explains an empty Product Master instead of showing a dead form", async () => {
    setupDesktop(baseApi({ listProducts: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 1000 }) }));
    renderPage();

    expect(await screen.findByText("No articles in the Product Master")).toBeInTheDocument();
    expect(screen.queryByLabelText("Labels to print")).not.toBeInTheDocument();
  });

  it("offers Retry when the articles cannot be loaded", async () => {
    const listProducts = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({
      rows: [EVR9],
      total: 1,
      page: 1,
      pageSize: 1000,
    });
    setupDesktop(baseApi({ listProducts }));
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /retry/i }));
    expect(await screen.findByLabelText("Article and size")).toBeInTheDocument();
  });
});

describe("bCartonLabels helpers", () => {
  const sequence = { article: "EVR9", size: "7/10", color: "MIX", lastSequence: 12, nextSequence: 13 };

  it("accepts a whole count within the registry's own ceiling", () => {
    expect(bCartonQuantityProblem("")).toBe(null);
    expect(bCartonQuantityProblem("24")).toBe(null);
    expect(bCartonQuantityProblem("2.5")).toBe("Enter a whole number.");
    expect(bCartonQuantityProblem("-1")).toBe("At least 1 label.");
    expect(bCartonQuantityProblem("10001")).toBe("At most 10,000 labels in one run.");
  });

  it("builds the range from where the sequence actually stands", () => {
    const range = bCartonRange(sequence, "3");
    expect(range).toEqual({
      quantity: 3,
      first: "EVR9_MIX_7/10_000013",
      last: "EVR9_MIX_7/10_000015",
      isFirstEver: false,
      alreadyGenerated: 12,
    });
  });

  it("says no range at all while the form cannot name one", () => {
    expect(bCartonRange(null, "3")).toBe(null);
    expect(bCartonRange(sequence, "")).toBe(null);
    expect(bCartonRange(sequence, "0")).toBe(null);
  });

  it("counts a run as B only when it is both MIX and grade B", () => {
    expect(isBCartonBatch(batch())).toBe(true);
    expect(isBCartonBatch(batch({ grade: null }))).toBe(false);
    expect(isBCartonBatch(batch({ color: "BLACK" }))).toBe(false);
  });
});
