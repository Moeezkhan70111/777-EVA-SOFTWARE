import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QrGeneratorPage } from "./QrGeneratorPage";
import { NotificationsProvider } from "../state/NotificationsContext";

function setupDesktop(api: Record<string, unknown>) {
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });
}

const SK6 = {
  id: "as-sk6",
  articleSizeId: "as-sk6",
  article: "SK6",
  color: "",
  size: "7/10",
  colors: ["RED"],
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

function baseApi(overrides: Record<string, unknown> = {}) {
  return {
    listProducts: vi
      .fn()
      .mockResolvedValue({ rows: [SK6], total: 1, page: 1, pageSize: 1000 }),
    listQrColors: vi.fn().mockResolvedValue(["RED", "BLUE"]),
    listQrBatches: vi.fn().mockResolvedValue([]),
    listQrCodesForBatch: vi.fn().mockResolvedValue([]),
    getQrSequenceState: vi.fn().mockResolvedValue({
      article: "SK6",
      size: "7/10",
      color: "RED",
      lastSequence: 0,
      nextSequence: 1,
    }),
    generateQrBatch: vi.fn(),
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
      <QrGeneratorPage machine={MACHINE} />
    </NotificationsProvider>,
  );

// Product and Colour are dropdown-select-only comboboxes (same pattern as the Add/Edit
// Product page): focusing the input opens the menu, and the value is set only by picking
// an option — never by typing it directly.
const openCombobox = async (labelText: string) => {
  await userEvent.click(screen.getByLabelText(labelText));
};

const pickOption = async (optionName: string) => {
  const option = await screen.findByRole("option", { name: optionName });
  await userEvent.click(option);
};

const pickProduct = async () => {
  await openCombobox("Product");
  await pickOption("SK6 / 7/10");
};

const pickColor = async (name: string) => {
  await openCombobox("Colour");
  await pickOption(name);
};

describe("QR Generator", () => {
  it("only offers products that already exist in Product Master", async () => {
    setupDesktop(baseApi());
    renderPage();

    await openCombobox("Product");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "SK6 / 7/10" })).toBeInTheDocument(),
    );
    // There is no way to create a product from this page.
    expect(
      screen.queryByRole("button", {
        name: /add product|new product|create product/i,
      }),
    ).not.toBeInTheDocument();
  });

  it("walks the operator through the steps, gating each on the one before", async () => {
    setupDesktop(baseApi());
    renderPage();

    expect(screen.getByText(/select a product first/i)).toBeInTheDocument();

    await pickProduct();
    expect(screen.getByText(/choose a colour first/i)).toBeInTheDocument();

    await pickColor("RED");
    expect(screen.getByLabelText("Quantity")).toBeInTheDocument();
  });

  it("shows the exact serial range before the operator commits", async () => {
    const getQrSequenceState = vi.fn().mockResolvedValue({
      article: "SK6",
      size: "7/10",
      color: "RED",
      lastSequence: 500,
      nextSequence: 501,
    });
    setupDesktop(baseApi({ getQrSequenceState }));
    renderPage();

    await pickProduct();
    await pickColor("RED");
    await userEvent.type(screen.getByLabelText("Quantity"), "200");

    await waitFor(() =>
      expect(screen.getByText("SK6_RED_7/10_000501")).toBeInTheDocument(),
    );
    expect(screen.getByText("SK6_RED_7/10_000700")).toBeInTheDocument();
    expect(screen.getByText(/continues after 500 already generated/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generate 200 codes/i })).toBeEnabled();
  });

  it("generates a batch and confirms the exact registered range", async () => {
    const generateQrBatch = vi.fn().mockResolvedValue({
      accepted: true,
      batch: {
        id: "batch-1",
        articleSizeId: "as-sk6",
        article: "SK6",
        color: "RED",
        size: "7/10",
        startSequence: 1,
        endSequence: 3,
        quantity: 3,
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBy: null,
        requestedBy: null,
      },
      qrCodes: [1, 2, 3].map((n) => ({
        id: `SK6_RED_7/10_00000${n}`,
        batchId: "batch-1",
        article: "SK6",
        color: "RED",
        size: "7/10",
        sequence: n,
        status: "GENERATED",
        createdAt: "2026-01-01T00:00:00.000Z",
      })),
    });
    setupDesktop(baseApi({ generateQrBatch }));
    renderPage();

    await pickProduct();
    await pickColor("RED");
    await userEvent.type(screen.getByLabelText("Quantity"), "3");
    await userEvent.click(screen.getByRole("button", { name: /generate 3 codes/i }));

    await waitFor(() =>
      expect(generateQrBatch).toHaveBeenCalledWith({
        machineId: "m-1",
        articleSizeId: "as-sk6",
        color: "RED",
        quantity: 3,
      }),
    );

    // The confirmation shows the real registered identities, first to last — in the range
    // line and again under each QR preview, exactly as the printed sticker carries it.
    await waitFor(() =>
      expect(screen.getAllByText("SK6_RED_7/10_000001").length).toBeGreaterThan(0),
    );
    expect(screen.getAllByText("SK6_RED_7/10_000003").length).toBeGreaterThan(0);
    expect(screen.getByText(/generation complete/i)).toBeInTheDocument();
  });

  it("records the logged-in operator and the optional requester with the run", async () => {
    const generateQrBatch = vi.fn().mockResolvedValue({
      accepted: true,
      batch: {
        id: "batch-2",
        articleSizeId: "as-sk6",
        article: "SK6",
        color: "RED",
        size: "7/10",
        startSequence: 1,
        endSequence: 2,
        quantity: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBy: "Moeezkhan123",
        requestedBy: "Aslam (Production)",
      },
      qrCodes: [1, 2].map((n) => ({
        id: `SK6_RED_7/10_00000${n}`,
        batchId: "batch-2",
        article: "SK6",
        color: "RED",
        size: "7/10",
        sequence: n,
        status: "GENERATED",
        createdAt: "2026-01-01T00:00:00.000Z",
      })),
    });
    setupDesktop(baseApi({ generateQrBatch }));
    render(
      <NotificationsProvider>
        <QrGeneratorPage machine={MACHINE} username="Moeezkhan123" />
      </NotificationsProvider>,
    );

    await pickProduct();
    await pickColor("RED");
    await userEvent.type(screen.getByLabelText("Quantity"), "2");
    await userEvent.type(screen.getByLabelText(/requested by/i), "  Aslam (Production) ");
    await userEvent.click(screen.getByRole("button", { name: /generate 2 codes/i }));

    await waitFor(() =>
      expect(generateQrBatch).toHaveBeenCalledWith({
        machineId: "m-1",
        articleSizeId: "as-sk6",
        color: "RED",
        quantity: 2,
        createdBy: "Moeezkhan123",
        requestedBy: "Aslam (Production)",
      }),
    );
    // Both names are on the confirmation.
    await waitFor(() => expect(screen.getByText(/generation complete/i)).toBeInTheDocument());
    expect(screen.getByText("Moeezkhan123")).toBeInTheDocument();
    expect(screen.getByText("Aslam (Production)")).toBeInTheDocument();
  });

  it("fills the quantity from a quick-pick button", async () => {
    setupDesktop(baseApi());
    renderPage();

    await pickProduct();
    await pickColor("RED");
    await userEvent.click(screen.getByRole("button", { name: "500" }));

    expect(screen.getByLabelText("Quantity")).toHaveValue(500);
    expect(screen.getByRole("button", { name: /generate 500 codes/i })).toBeEnabled();
  });

  it("normalises a newly entered colour before sending it", async () => {
    const generateQrBatch = vi
      .fn()
      .mockResolvedValue({ accepted: false, reason: "stop" });
    setupDesktop(baseApi({ generateQrBatch }));
    renderPage();

    await pickProduct();
    await userEvent.click(screen.getByRole("button", { name: "Add new colour" }));
    await userEvent.type(screen.getByLabelText(/colour name/i), "  green ");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await userEvent.type(screen.getByLabelText("Quantity"), "2");
    await userEvent.click(screen.getByRole("button", { name: /generate 2 codes/i }));

    await waitFor(() =>
      expect(generateQrBatch).toHaveBeenCalledWith({
        machineId: "m-1",
        articleSizeId: "as-sk6",
        color: "GREEN",
        quantity: 2,
      }),
    );
  });

  it("Escape closes an open combobox menu without clearing the current selection", async () => {
    setupDesktop(baseApi());
    renderPage();

    await pickProduct();
    await openCombobox("Colour");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "RED" })).toBeInTheDocument(),
    );

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("option", { name: "RED" })).not.toBeInTheDocument();
    // The product picked earlier is still shown — Escape only closed the menu.
    expect(screen.getByLabelText("Product")).toHaveValue("SK6 / 7/10");
  });

  it("a colour added through the modal is immediately selectable from the dropdown", async () => {
    setupDesktop(baseApi());
    renderPage();

    await pickProduct();
    await userEvent.click(screen.getByRole("button", { name: "Add new colour" }));
    await userEvent.type(screen.getByLabelText(/colour name/i), "teal");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    // Clear the selection and reopen — TEAL is now offered without a page reload.
    await userEvent.click(screen.getByRole("button", { name: "Clear colour" }));
    await openCombobox("Colour");
    expect(
      await screen.findByRole("option", { name: "TEAL" }),
    ).toBeInTheDocument();
  });

  it("blocks generation until product, colour and a valid quantity are all present", async () => {
    const generateQrBatch = vi.fn();
    setupDesktop(baseApi({ generateQrBatch }));
    renderPage();

    expect(screen.getByRole("button", { name: /^generate$/i })).toBeDisabled();

    await pickProduct();
    await pickColor("RED");
    expect(screen.getByRole("button", { name: /^generate$/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Quantity"), "0");
    expect(screen.getByText(/must be at least 1/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^generate$/i })).toBeDisabled();

    await userEvent.clear(screen.getByLabelText("Quantity"));
    await userEvent.type(screen.getByLabelText("Quantity"), "10001");
    expect(screen.getByText(/maximum 10,000 per batch/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^generate$/i })).toBeDisabled();

    await userEvent.clear(screen.getByLabelText("Quantity"));
    await userEvent.type(screen.getByLabelText("Quantity"), "5");
    expect(screen.getByRole("button", { name: /generate 5 codes/i })).toBeEnabled();
    expect(generateQrBatch).not.toHaveBeenCalled();
  });

  it("rejects a colour that could not be encoded into a scannable identity", async () => {
    setupDesktop(baseApi());
    renderPage();

    await pickProduct();
    await userEvent.click(screen.getByRole("button", { name: "Add new colour" }));
    await userEvent.type(screen.getByLabelText(/colour name/i), "RED/BLUE");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    // Nothing was committed: the modal stays open and Quantity never appears.
    expect(
      screen.getByRole("dialog", { name: /add new colour/i }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Quantity")).not.toBeInTheDocument();
  });

  it("surfaces a rejected generation instead of claiming success", async () => {
    const generateQrBatch = vi.fn().mockResolvedValue({
      accepted: false,
      reason:
        "Selected product was not found in Product Master. Create it in Products first.",
    });
    setupDesktop(baseApi({ generateQrBatch }));
    renderPage();

    await pickProduct();
    await pickColor("RED");
    await userEvent.type(screen.getByLabelText("Quantity"), "3");
    await userEvent.click(screen.getByRole("button", { name: /generate 3 codes/i }));

    await waitFor(() => expect(generateQrBatch).toHaveBeenCalled());
    // No confirmation panel, and no registered identity, may appear for a rejected generation.
    expect(screen.queryByText(/generation complete/i)).not.toBeInTheDocument();
  });

  it("prefills the form from a previous batch with Use again", async () => {
    const listQrBatches = vi.fn().mockResolvedValue([
      {
        id: "batch-old",
        articleSizeId: "as-sk6",
        article: "SK6",
        color: "RED",
        size: "7/10",
        startSequence: 1,
        endSequence: 50,
        quantity: 50,
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBy: null,
        requestedBy: null,
      },
    ]);
    setupDesktop(baseApi({ listQrBatches }));
    renderPage();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /use again/i })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole("button", { name: /use again/i }));

    expect(screen.getByLabelText("Product")).toHaveValue("SK6 / 7/10");
    await waitFor(() =>
      expect(screen.getByLabelText("Colour")).toHaveValue("RED"),
    );
  });

  describe("Recent Generations", () => {
    const batches = [
      {
        id: "batch-red",
        articleSizeId: "as-sk6",
        article: "SK6",
        color: "RED",
        size: "7/10",
        startSequence: 1,
        endSequence: 50,
        quantity: 50,
        createdAt: "2026-01-01T00:00:00.000Z",
        createdBy: null,
        requestedBy: null,
      },
      {
        id: "batch-blue",
        articleSizeId: "as-sk6",
        article: "SK6",
        color: "BLUE",
        size: "7/10",
        startSequence: 1,
        endSequence: 20,
        quantity: 20,
        createdAt: "2026-01-02T00:00:00.000Z",
        createdBy: null,
        requestedBy: null,
      },
    ];

    it("lists the most recent batches with their registered ranges", async () => {
      const listQrBatches = vi.fn().mockResolvedValue(batches);
      setupDesktop(baseApi({ listQrBatches }));
      renderPage();

      await waitFor(() =>
        expect(screen.getByText("SK6_RED_7/10_000001")).toBeInTheDocument(),
      );
      expect(screen.getByText("SK6_RED_7/10_000050")).toBeInTheDocument();
      expect(screen.getByText("SK6_BLUE_7/10_000001")).toBeInTheDocument();
      expect(screen.getByText("Last 2 batches")).toBeInTheDocument();

      // Only a small, fixed window is requested — the full record is in QR Management.
      const call = listQrBatches.mock.calls.at(-1)?.[0];
      expect(call.limit).toBeLessThanOrEqual(10);
      expect(call.sinceIso).toBeUndefined();
    });

    it("offers a way through to QR Management for the full record", async () => {
      const onNavigate = vi.fn();
      setupDesktop(baseApi({ listQrBatches: vi.fn().mockResolvedValue(batches) }));
      render(
        <NotificationsProvider>
          <QrGeneratorPage machine={MACHINE} onNavigate={onNavigate} />
        </NotificationsProvider>,
      );

      await waitFor(() =>
        expect(screen.getByText("SK6_RED_7/10_000001")).toBeInTheDocument(),
      );
      await userEvent.click(screen.getByRole("button", { name: /search all codes/i }));
      expect(onNavigate).toHaveBeenCalledWith("qr-management");
    });

    it("shows the empty state when nothing has been generated", async () => {
      setupDesktop(baseApi({ listQrBatches: vi.fn().mockResolvedValue([]) }));
      renderPage();

      await waitFor(() =>
        expect(screen.getByText(/no codes generated yet/i)).toBeInTheDocument(),
      );
      expect(screen.getByText("No batches yet")).toBeInTheDocument();
    });
  });
});
