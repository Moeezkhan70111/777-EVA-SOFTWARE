import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoreInPage } from "./StoreInPage";
import { NotificationsProvider } from "../../state/NotificationsContext";
import type { MachineProgramCartonPacket, MachineProgramRecord } from "../../types/desktopApi";

// STORE IN — the machine program lookup.
//
// What matters here: Store In can open ANY machine program to read it (fully issued included),
// can print the cartons it is owed, and can never issue against it — no Dana Issue, no Upper Out
// scanner. Its own job on a program is Carton In: the program's printed carton labels scanned
// back into the store. The receiving station on the right stays mounted throughout.
//
// The sections and the receiving station are existing screens with their own tests; they are
// mocked so only the lookup and the program view are under test here.
vi.mock("../../pages/RawMaterialInputPage", () => ({
  RawMaterialInputPage: () => <div data-testid="rm-input-station">Raw Material Input</div>,
}));
vi.mock("../rawMaterial/RawMaterialSection", () => ({
  RawMaterialSection: () => <div data-testid="rm-section">Stock section</div>,
}));
vi.mock("../rawMaterial/useRawMaterialLookups", () => ({
  useRawMaterialLookups: () => ({ loading: false, error: null, categories: [], units: [], reload: async () => undefined }),
}));
vi.mock("./HandMovePanel", () => ({ HandMovePanel: () => <div>Move In by Hand</div> }));
vi.mock("../../utils/playScanSound", () => ({ playScanSound: () => undefined }));

const printWindow = vi.fn((_opts: { ids: string[] }) => true);
vi.mock("../../utils/qrLabels", () => ({
  openCartonLabelPrintWindow: (opts: { ids: string[] }) => printWindow(opts) as boolean,
}));

const TODAY = "2026-10-09";

/** MP-000001, 20 DOZEN of BLACK uppers, every one of them already out of the store. */
const finishedProgram: MachineProgramRecord = {
  id: "prog-1", programNumber: 1, code: "MP-000001", machineId: "m-1", machineName: "MACHINE 1",
  contractorPartyId: "c-A", contractorName: "CONTRACTOR A", packingContractorPartyId: "c-B", packingContractorName: "CONTRACTOR B",
  programDate: TODAY, shiftStartMinute: 360, shiftEndMinute: 1080,
  status: "COMPLETED", displayStatus: "COMPLETED",
  totalQuantity: 20, consumedQuantity: 20, outstandingQuantity: 0, unitCode: "DOZEN",
  createdBy: "aslam", createdAt: `${TODAY}T07:00:00.000Z`, updatedAt: `${TODAY}T07:00:00.000Z`,
  completedAt: `${TODAY}T09:00:00.000Z`, cancelledAt: null, cancelledBy: null, cancelReason: null,
  runs: [
    {
      id: "run-1", programId: "prog-1", injectorNo: 1, runNo: 1, soleColour: "BLACK", articleSizeId: "as-sk6-710",
      article: "SK6", size: "7/10", totalQuantity: 20, consumedQuantity: 20, unitCode: "DOZEN",
      lines: [
        {
          id: "line-black", runId: "run-1", lineNo: 1, itemId: "u-black", itemDisplayName: "UPPER — SK6 — BLACK — 7/10",
          upperColour: "BLACK", upperType: "SILAI", subCategoryName: "RAGZINE UPPER", quantity: 20, unitCode: "DOZEN",
          consumed: 20, outstanding: 0, availableAtSave: 200,
        },
      ],
    },
  ],
  articleRates: [],
};

/** 2 DOZEN went out and its 4 carton labels were printed; one has come back so far. */
const printedPacket: MachineProgramCartonPacket = {
  eventId: "ev-0", qrId: "RM_6_41_1", itemDisplayName: "UPPER — SK6 — BLACK — 7/10", quantity: 2, unitCode: "DOZEN",
  issuedAt: `${TODAY}T07:00:00.000Z`,
  cartons: { articleSizeId: "as-sk6-710", article: "SK6", size: "7/10", soleColour: "BLACK", colour: "BLACK", count: 4 },
  cartonNote: null,
  label: {
    qrBatchId: "qrb-0", firstQrId: "SK6_BLACK_7/10_000001", lastQrId: "SK6_BLACK_7/10_000004",
    cartonCount: 4, receivedInRun: 1, printedBy: "aslam", printedAt: `${TODAY}T07:30:00.000Z`,
  },
};

/** 2 DOZEN went out and its 4 carton labels were never printed. */
const owedPacket: MachineProgramCartonPacket = {
  eventId: "ev-1", qrId: "RM_6_42_1", itemDisplayName: "UPPER — SK6 — BLACK — 7/10", quantity: 2, unitCode: "DOZEN",
  issuedAt: `${TODAY}T08:00:00.000Z`,
  cartons: { articleSizeId: "as-sk6-710", article: "SK6", size: "7/10", soleColour: "BLACK", colour: "BLACK", count: 4 },
  cartonNote: null, label: null,
};

function installApi(packets: MachineProgramCartonPacket[] = [owedPacket]) {
  const api = {
    openMachineProgramStoreOut: vi.fn(async (lookup: string) =>
      ["MP-000001", "1"].includes(lookup)
        ? {
            accepted: false, outcome: "PROGRAM_COMPLETED", programId: "prog-1", programCode: "MP-000001",
            reason: "MP-000001 is fully issued. Everything on it has already left the store.", program: finishedProgram,
          }
        : { accepted: false, outcome: "PROGRAM_NOT_FOUND", reason: `${lookup} does not exist.`, program: null }
    ),
    listMachineProgramIssueBatches: vi.fn(async () => ({ accepted: true, rows: [] })),
    listMachineProgramCartonPackets: vi.fn(async () => ({ accepted: true, rows: packets })),
    // The backend's verdict on one scanned carton label, verbatim.
    machineProgramCartonIn: vi.fn(async (input: { programId: string; rawScan: string }) =>
      input.rawScan === "SK6_BLACK_7/10_000002"
        ? { accepted: true, outcome: "RECEIVED", qrId: input.rawScan, article: "SK6", color: "BLACK", size: "7/10", producedNow: true, receivedAt: `${TODAY}T11:00:00.000Z` }
        : { accepted: false, outcome: "OTHER_PROGRAM", qrId: input.rawScan, reason: "This carton was printed for MP-000002. Open MP-000002 to receive it." }
    ),
    printMachineProgramCartons: vi.fn(async () => ({
      accepted: true,
      batch: {
        id: "qrb-1", articleSizeId: "as-sk6-710", article: "SK6", color: "BLACK", size: "7/10", startSequence: 1, endSequence: 4,
        quantity: 4, createdAt: `${TODAY}T10:00:00.000Z`, createdBy: "aslam", requestedBy: "MP-000001",
      },
      qrCodes: [1, 2, 3, 4].map((sequence) => ({
        id: `SK6_BLACK_7/10_00000${sequence}`, batchId: "qrb-1", article: "SK6", color: "BLACK", size: "7/10", sequence, status: "GENERATED",
      })),
    })),
    machineProgramStoreOutSaveBatch: vi.fn(),
    listMachineProgramDanaOptions: vi.fn(async () => ({ accepted: true, rows: [] })),
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
      <StoreInPage
        tab="stock"
        token="t-1"
        username="aslam"
        isAdmin={false}
        access={{ stock: true, labels: true, settings: true }}
        onNavigate={() => undefined}
      />
    </NotificationsProvider>
  );

const openProgram = async (lookup: string) => {
  await userEvent.type(screen.getByLabelText("Scan QR or enter Machine Program No."), lookup);
  await userEvent.keyboard("{Enter}");
};

afterEach(() => {
  vi.restoreAllMocks();
  printWindow.mockClear();
});

describe("Store In — machine program lookup", () => {
  it("opens a fully issued program to read, with no way to issue anything against it", async () => {
    const api = installApi();
    renderPage();

    await openProgram("MP-000001");

    expect(await screen.findByRole("heading", { name: "Machine Program" })).toBeInTheDocument();
    expect(api.openMachineProgramStoreOut).toHaveBeenCalledWith("MP-000001", { token: "t-1" });
    expect(screen.getByText("Finished")).toBeInTheDocument();
    // Nothing can be issued: the two sections that take stock out are not on the page at all.
    expect(screen.queryByRole("region", { name: "Upper Out" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Carton In" })).toBeInTheDocument();
    expect(api.listMachineProgramDanaOptions).not.toHaveBeenCalled();
    // The program replaces the section on the left; the receiving station is untouched.
    expect(screen.queryByTestId("rm-section")).not.toBeInTheDocument();
    expect(screen.getByTestId("rm-input-station")).toBeInTheDocument();
  });

  it("prints the cartons a program is owed: 2 DOZEN out is 4 labels", async () => {
    const api = installApi();
    renderPage();
    await openProgram("MP-000001");

    const cartons = await screen.findByRole("region", { name: "Cartons to label" });
    await userEvent.click(within(cartons).getByRole("button", { name: "Print 4 carton QR labels for SK6 / 7/10 / BLACK" }));

    await waitFor(() =>
      expect(api.printMachineProgramCartons).toHaveBeenCalledWith({ programId: "prog-1", eventIds: ["ev-1"] }, { token: "t-1" })
    );
    expect(printWindow.mock.calls[0][0].ids).toHaveLength(4);
    expect(api.machineProgramStoreOutSaveBatch).not.toHaveBeenCalled();
  });

  it("goes back to the section it replaced when the program is closed", async () => {
    installApi();
    renderPage();
    await openProgram("1");
    await screen.findByRole("heading", { name: "Machine Program" });

    await userEvent.click(screen.getByRole("button", { name: /back/i }));

    expect(await screen.findByTestId("rm-section")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Machine Program" })).not.toBeInTheDocument();
  });

  it("shows the backend's refusal for a program that does not exist, and opens nothing", async () => {
    installApi();
    renderPage();

    await openProgram("MP-000999");

    expect(await screen.findByRole("alert")).toHaveTextContent("MP-000999 does not exist.");
    expect(screen.getByTestId("rm-section")).toBeInTheDocument();
  });

  it("scans the program's carton labels back in, and refuses another program's by name", async () => {
    const api = installApi([printedPacket]);
    renderPage();
    await openProgram("MP-000001");

    const cartonIn = await screen.findByRole("region", { name: "Carton In" });
    expect(screen.getByText("1 of 4 back in store")).toBeInTheDocument();
    await userEvent.click(within(cartonIn).getByRole("button", { name: /Start Scan/ }));

    await userEvent.type(screen.getByLabelText("Scanner input"), "SK6_BLACK_7/10_000002{Enter}");
    expect(await screen.findByTestId("scan-status")).toHaveTextContent("STORED IN");
    expect(api.machineProgramCartonIn).toHaveBeenCalledWith(
      { programId: "prog-1", rawScan: "SK6_BLACK_7/10_000002" },
      { token: "t-1" }
    );
    // The counts are re-read from the database, never patched on screen.
    await waitFor(() => expect(api.listMachineProgramCartonPackets.mock.calls.length).toBeGreaterThan(1));

    await userEvent.type(screen.getByLabelText("Scanner input"), "SK6_RED_7/10_000009{Enter}");
    expect(await screen.findByText("This carton was printed for MP-000002. Open MP-000002 to receive it.")).toBeInTheDocument();
    expect(screen.getByTestId("scan-status")).toHaveTextContent("ANOTHER PROGRAM'S CARTON");
  });

  it("keeps Carton In closed until the program has printed carton labels", async () => {
    installApi([owedPacket]);
    renderPage();
    await openProgram("MP-000001");

    const cartonIn = await screen.findByRole("region", { name: "Carton In" });
    expect(within(cartonIn).getByRole("button", { name: /Start Scan/ })).toBeDisabled();
    expect(within(cartonIn).getByText("No carton labels printed yet")).toBeInTheDocument();
  });
});
