import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoreInPage } from "./StoreInPage";
import type { StoreInTab } from "./storeOperators";
import { NotificationsProvider } from "../../state/NotificationsContext";
import type { MachineProgramCartonPacket, MachineProgramReconciliation, MachineProgramRecord } from "../../types/desktopApi";

// STORE IN — the machine program lookup.
//
// What matters here: Store In can open ANY machine program to read it (fully issued included),
// can print the cartons it is owed, and can never issue against it — no Dana Issue, no Upper Out
// scanner. Its own job on a program is Carton In: the program's printed carton labels scanned
// back into the store — on the page's ONE scan station on the right, which becomes Carton In while a
// program is open (Scan Material stays mounted behind it). There is never a second scanner on the left.
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
  totalQuantity: 20, fixQuantity: 0, productionQuantity: 20, consumedQuantity: 20, outstandingQuantity: 0, unitCode: "DOZEN",
  createdBy: "aslam", createdAt: `${TODAY}T07:00:00.000Z`, updatedAt: `${TODAY}T07:00:00.000Z`,
  completedAt: `${TODAY}T09:00:00.000Z`, cancelledAt: null, cancelledBy: null, cancelReason: null,
  runs: [
    {
      id: "run-1", programId: "prog-1", injectorNo: 1, runNo: 1, soleColour: "BLACK", innerSoleColour: null, fixQuantity: 0, articleSizeId: "as-sk6-710",
      article: "SK6", size: "7/10", totalQuantity: 20, consumedQuantity: 20, unitCode: "DOZEN", startMinute: null, endMinute: null,
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
    cartonCount: 4, receivedInRun: 1, voidedInRun: 0, colour: "BLACK", grade: null, printedBy: "aslam", printedAt: `${TODAY}T07:30:00.000Z`,
  },
};

/** 2 DOZEN went out and its 4 carton labels were never printed. */
const owedPacket: MachineProgramCartonPacket = {
  eventId: "ev-1", qrId: "RM_6_42_1", itemDisplayName: "UPPER — SK6 — BLACK — 7/10", quantity: 2, unitCode: "DOZEN",
  issuedAt: `${TODAY}T08:00:00.000Z`,
  cartons: { articleSizeId: "as-sk6-710", article: "SK6", size: "7/10", soleColour: "BLACK", colour: "BLACK", count: 4 },
  cartonNote: null, label: null,
};

/** MP-000001 standing against its cartons: BLACK GREY had 8 due and `back` came back. */
const standing = (back: number): MachineProgramReconciliation => ({
  programId: "prog-1",
  code: "MP-000001",
  closure: null,
  machineContractor: { partyId: "c-A", name: "CONTRACTOR A" },
  packingContractor: { partyId: "c-B", name: "CONTRACTOR B" },
  cartonsDue: 8,
  cartonsBack: back,
  blockedReason: null,
  fixRuns: [],
  fixCartonsShort: 0,
  lines: [
    {
      lineId: "line-black", itemId: "u-black", upperName: "UPPER — SK6 — BLACK — 7/10", article: "SK6", size: "7/10",
      soleColour: "BLACK", upperColour: "GREY", issuedCartons: 8, returnedUpperCartons: 0, cartonsDue: 8, cartonsBack: back,
      bCartons: 0, bBack: 0, missingCartons: 8 - back, shortfallUppers: (8 - back) * 6,
      suppliers: [{ partyId: "s-1", name: "ABC UPPER" }], saved: null,
    },
  ],
});

function installApi(
  packets: MachineProgramCartonPacket[] = [owedPacket],
  progress: Array<{ lineId: string; cartonsDue: number | null; cartonsBack: number }> = [],
  reconciliation: MachineProgramReconciliation = standing(8),
  /** FIX runs: their cartons come from the plan, with no packet ever issued (migration 071). */
  fixRuns: Array<Record<string, unknown>> = []
) {
  const close = { view: reconciliation };
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
    listMachineProgramCartonPackets: vi.fn(async () => ({ accepted: true, rows: packets, progress, fixRuns })),
    getMachineProgramReconciliation: vi.fn(async () => ({ accepted: true, reconciliation: close.view })),
    // The backend closes it and says how; the screen then re-reads and shows it closed.
    completeMachineProgramProduction: vi.fn(async (input: { programId: string; entries: unknown[] }) => {
      const outcome = input.entries.length > 0 ? "RECONCILED" : "COMPLETE";
      const closure = { outcome, cartonsDue: 8, cartonsBack: close.view.cartonsBack, closedBy: "aslam", closedAt: `${TODAY}T12:00:00.000Z` } as const;
      close.view = { ...close.view, closure };
      return { accepted: true, closure };
    }),
    // Return Upper and B cartons of an upper line: the backend's verdicts, verbatim.
    returnMachineProgramUpper: vi.fn(async (input: { programId: string; rawScan: string }) =>
      input.rawScan === "RM_6_41_2"
        ? { accepted: true, outcome: "RECEIVED", qrId: input.rawScan, itemDisplayName: "UPPER — SK6 — GREY — 7/10", packingQuantity: 2, packingUnitCode: "DOZEN" }
        : { accepted: false, outcome: "ALREADY_IN_STORE", qrId: input.rawScan, reason: "This packet has already been received." }
    ),
    convertMachineProgramUpperCartonsToB: vi.fn(async () => ({
      accepted: true,
      voidedQrIds: ["SK6_BLACKGREY_7/10_000008"],
      qrCodes: [{ id: "SK6_MIX_7/10_000001", batchId: "qrb-b", article: "SK6", color: "MIX", size: "7/10", sequence: 1, status: "GENERATED" }],
    })),
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
    getStoreDailyReport: vi.fn(async ({ date }: { date: string }) => ({
      accepted: true,
      report: { date, direction: "IN", entries: [], entryCount: 0, summary: { movements: 0, packets: 0, cartons: 0, bySource: [], byMaterial: [], byProduct: [] } },
    })),
  };
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });
  return api;
}

const renderPage = (onNavigate: (route: string) => void = () => undefined, tab: StoreInTab = "stock") =>
  render(
    <NotificationsProvider>
      <StoreInPage
        tab={tab}
        token="t-1"
        username="aslam"
        isAdmin={false}
        access={{ stock: true, labels: true, settings: true, report: true }}
        onNavigate={onNavigate}
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

describe("Store In — Daily Report tab", () => {
  it("shows the day's Store In report on the left while the scan station stays on the right", async () => {
    const api = installApi();
    renderPage(undefined, "report");

    expect(await screen.findByText("Nothing came into the store on this day")).toBeInTheDocument();
    expect(api.getStoreDailyReport).toHaveBeenCalledWith(expect.objectContaining({ direction: "IN", token: "t-1" }));
    expect(screen.getByRole("tab", { name: "Daily Report Store In" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("rm-input-station")).toBeInTheDocument();
  });
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
    // ONE scanner: the station on the right becomes Carton In; the program on the left has none.
    expect(screen.getByRole("complementary", { name: "Carton In · MP-000001" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Start Scan/ })).not.toBeInTheDocument();
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

    // The right-hand station is Carton In now, armed — no Start Scan, no second scanner.
    const station = await screen.findByRole("complementary", { name: "Carton In · MP-000001" });
    expect(screen.getByText("1 of 4 back in store")).toBeInTheDocument();
    await waitFor(() => expect(within(station).getByLabelText("Scanner input")).toBeEnabled());

    await userEvent.type(within(station).getByLabelText("Scanner input"), "SK6_BLACK_7/10_000002{Enter}");
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

    const station = await screen.findByRole("complementary", { name: "Carton In · MP-000001" });
    expect(within(station).getByText("No carton labels printed yet")).toBeInTheDocument();
    expect(within(station).queryByLabelText("Scanner input")).not.toBeInTheDocument();
  });
  // A FIX article issues nothing, so a program made only of them has no packet to print cartons
  // against — its labels come from the plan. Store In must still open for them to be scanned back.
  it("opens Carton In for a FIX article's printed cartons, though nothing was ever issued", async () => {
    installApi([], [], standing(8), [
      {
        runId: "run-fix", articleSizeId: "as-dc3", article: "DC3", size: "7/10",
        outerSoleColour: "BLACK", innerSoleColour: "ORANGE", quantity: 32, unitCode: "DOZEN",
        cartonsPlanned: 64, cartonsToPrint: 0, cartonNote: null,
        labels: [
          {
            qrBatchId: "qrb-fix", firstQrId: "DC3_BLACK_7/10_000001", lastQrId: "DC3_BLACK_7/10_000064",
            cartonCount: 64, receivedInRun: 0, voidedInRun: 0, colour: "BLACK", grade: null, printedBy: "aslam", printedAt: "2026-10-12T05:00:00.000Z",
          },
        ],
      },
    ]);
    renderPage();
    await openProgram("MP-000001");

    const station = await screen.findByRole("complementary", { name: "Carton In · MP-000001" });
    await waitFor(() => expect(within(station).getByLabelText("Scanner input")).toBeEnabled());
    expect(within(station).queryByText("No carton labels printed yet")).toBeNull();
  });

  it("reads the program in CARTONS coming back: due for what was issued, back, and still to come", async () => {
    // 20 DOZEN of BLACK went out, so 40 cartons are due; 6 of them are back.
    installApi([printedPacket], [{ lineId: "line-black", cartonsDue: 40, cartonsBack: 6 }]);
    renderPage();
    await openProgram("MP-000001");
    await screen.findByRole("heading", { name: "Machine Program" });

    const card = screen.getByRole("progressbar", { name: "Cartons of SK6 7/10 back in store" }).closest("section") as HTMLElement;
    expect(within(card).getByText("6 / 40")).toBeInTheDocument();
    expect(within(card).getByText("Coming back")).toBeInTheDocument();
    expect(within(card).getByRole("columnheader", { name: "Due (Cartons)" })).toBeInTheDocument();
    expect(within(card).getByRole("columnheader", { name: "To come" })).toBeInTheDocument();
    // Store Out's dozens are not what Store In reads.
    expect(within(card).queryByRole("columnheader", { name: /Planned/ })).toBeNull();
    const row = within(card).getByRole("row", { name: /BLACK/ });
    expect(row).toHaveTextContent("40");
    expect(row).toHaveTextContent("6");
    expect(row).toHaveTextContent("34");
  });

  it("puts the program away when a section tab is chosen", async () => {
    installApi();
    const navigate = vi.fn();
    renderPage(navigate);
    await openProgram("MP-000001");
    await screen.findByRole("heading", { name: "Machine Program" });

    await userEvent.click(screen.getByRole("tab", { name: "Stock" }));

    expect(await screen.findByTestId("rm-section")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Machine Program" })).not.toBeInTheDocument();
    expect(navigate).toHaveBeenCalledWith("store-in-stock");
  });
  // Reported 2026-10-12: 1 of 20 EVR FIX cartons back read "0 of 0 cartons back — every carton due
  // is back". A fix run's cartons are counted — and (owner, 2026-10-12) the program cannot be
  // completed at all until every carton is back: Complete stays disabled and says why.
  it("counts an EVR FIX program's cartons, and will not complete until every carton is back", async () => {
    const fixStanding: MachineProgramReconciliation = {
      ...standing(0),
      lines: [],
      cartonsDue: 20,
      cartonsBack: 1,
      fixCartonsShort: 19,
      blockedReason:
        "19 EVR FIX cartons are still to come back. Scan them on Carton In — or, if they came back as B, make them B cartons in Reconciliation. MP-000001 cannot close until every carton is back.",
      fixRuns: [
        { runId: "run-fix", article: "DC3", size: "7/10", outerSoleColour: "BLACK", innerSoleColour: "RED", cartonsDue: 20, cartonsBack: 1, cartonNote: null, convertible: 19, bCartons: 0, bBack: 0 },
      ],
    };
    const api = installApi([], [], fixStanding);
    renderPage();
    await openProgram("MP-000001");

    const section = await screen.findByRole("region", { name: "Complete Program" });
    expect(await within(section).findByText("1 of 20 cartons back")).toBeInTheDocument();
    expect(within(section).queryByText("Every carton due is back.")).not.toBeInTheDocument();
    expect(within(section).getByText(/19 EVR FIX cartons still to come back/)).toBeInTheDocument();
    // The missing ones are listed where they can be made B cartons.
    expect(within(section).getByRole("row", { name: /DC3 7\/10 \(BLACK \/ RED\)/ })).toBeInTheDocument();

    // Complete Program is disabled, and says why — there is no way to close it short.
    expect(within(section).getByRole("button", { name: "Complete Program" })).toBeDisabled();
    expect(within(section).getByText(/cannot close until every carton is back/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Close Program Short/ })).not.toBeInTheDocument();
    expect(api.completeMachineProgramProduction).not.toHaveBeenCalled();
  });

  // The owner's B-carton flow (2026-10-12): 20 labels printed, 10 back. Reconciliation asks how
  // many are B; Generate voids the 10 not back and prints 10 B labels (MIX), confirmed first.
  it("Reconciliation turns the EVR FIX cartons not back into B cartons, after a confirmation", async () => {
    const fixRun = { runId: "run-fix", article: "EVR9", size: "7/10", outerSoleColour: "BLACK", innerSoleColour: "RED", cartonsDue: 20, cartonsBack: 10, cartonNote: null, convertible: 10, bCartons: 0, bBack: 0 };
    const api = installApi([], [], { ...standing(0), lines: [], cartonsDue: 20, cartonsBack: 10, fixCartonsShort: 10, fixRuns: [fixRun] });
    const bCodes = Array.from({ length: 10 }, (_, i) => ({ id: `EVR9_MIX_7/10_00000${i}`, article: "EVR9", color: "MIX", size: "7/10", status: "GENERATED" }));
    const convert = vi.fn(async () => ({ accepted: true, batch: { id: "qrb-b" }, qrCodes: bCodes, voidedQrIds: [] }));
    Object.assign(api, { convertMachineProgramCartonsToB: convert });
    renderPage();
    await openProgram("MP-000001");

    const table = await screen.findByRole("region", { name: "Reconciliation" });
    const row = within(table).getByRole("row", { name: /EVR9 7\/10/ });
    expect(row).toHaveTextContent("20");
    // How many B cartons: it opens on everything that is not back.
    const input = within(row).getByLabelText(/B cartons of EVR9/);
    expect(input).toHaveValue("10");

    // More than are missing is refused before anything is sent.
    await userEvent.clear(input);
    await userEvent.type(input, "11");
    expect(within(row).getByRole("alert")).toHaveTextContent("at most 10");
    expect(within(row).getByRole("button", { name: "Generate B labels" })).toBeDisabled();

    await userEvent.clear(input);
    await userEvent.type(input, "10");
    await userEvent.click(within(row).getByRole("button", { name: "Generate B labels" }));
    const confirm = await screen.findByRole("dialog", { name: "Make 10 B cartons?" });
    expect(confirm).toHaveTextContent("10 voided — they can no longer be scanned");
    await userEvent.click(within(confirm).getByRole("button", { name: "Generate B labels" }));

    await waitFor(() => expect(convert).toHaveBeenCalledWith({ programId: "prog-1", runId: "run-fix", count: 10 }, { token: "t-1" }));
    // The B labels print straight away, as B — MIX, no inner sole.
    await waitFor(() => expect(printWindow).toHaveBeenCalled());
    const printed = printWindow.mock.calls[printWindow.mock.calls.length - 1][0] as unknown as { ids: string[]; identity: { color: string; grade: string; innerColor: string | null } };
    expect(printed.ids).toHaveLength(10);
    expect(printed.identity).toMatchObject({ color: "MIX", grade: "B", innerColor: null });
  });

  it("completes a program when every carton is back, after a confirmation", async () => {
    const api = installApi([printedPacket], [], standing(8));
    renderPage();
    await openProgram("MP-000001");

    const section = await screen.findByRole("region", { name: "Complete Program" });
    expect(await within(section).findByText("8 of 8 cartons back")).toBeInTheDocument();
    expect(within(section).getByText("Every carton due is back.")).toBeInTheDocument();
    await userEvent.click(within(section).getByRole("button", { name: "Complete Program" }));

    const confirm = await screen.findByRole("dialog", { name: "Complete MP-000001?" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Complete Program" }));

    await waitFor(() => expect(api.completeMachineProgramProduction).toHaveBeenCalledWith({ programId: "prog-1", entries: [] }, { token: "t-1" }));
    expect(await within(section).findByText(/Closed — complete/)).toBeInTheDocument();
    // Closed is final: the Carton In station says so and has no scan box.
    const station = screen.getByRole("complementary", { name: "Carton In · MP-000001" });
    expect(await within(station).findByText("Program closed")).toBeInTheDocument();
    expect(within(station).queryByLabelText("Scanner input")).not.toBeInTheDocument();
  });

  it("short cartons open the Reconciliation: cut size and a priced claim account for every pair, then it completes", async () => {
    const api = installApi([printedPacket], [], standing(7));
    renderPage();
    await openProgram("MP-000001");

    const section = await screen.findByRole("region", { name: "Complete Program" });
    expect(await within(section).findByText("1 carton short — 6 pairs to account for")).toBeInTheDocument();
    // Short uppers are completed from the workspace, not from a header button.
    expect(within(section).queryByRole("button", { name: "Complete Program" })).not.toBeInTheDocument();
    const workspace = within(section).getByRole("region", { name: "Reconciliation" });
    const line = within(workspace).getByRole("region", { name: "SK6 7/10 · BLACK / GREY" });
    const submit = within(workspace).getByRole("button", { name: "Reconcile & Complete" });
    expect(submit).toBeDisabled();

    await userEvent.type(within(line).getByLabelText("Cut Size Upper — pairs of SK6 7/10 · BLACK / GREY"), "4");
    expect(within(line).getByRole("status")).toHaveTextContent("2 of the 6 remaining pairs are not accounted for yet.");
    await userEvent.type(within(line).getByLabelText("Cut Size Pairs — pairs of SK6 7/10 · BLACK / GREY"), "1");

    // A claim: the only supplier is already named; the pairs, the amount and the reason are typed.
    await userEvent.click(within(line).getByRole("button", { name: "+ Add claim" }));
    expect(within(line).getByLabelText("Against")).toHaveValue("SUPPLIER:s-1");
    await userEvent.type(within(line).getByLabelText("Pairs"), "1");
    await userEvent.type(within(line).getByLabelText("Amount per pair (Rs)"), "50");
    expect(within(line).getByText("Rs 50.00")).toBeInTheDocument();
    expect(submit).toBeDisabled();
    await userEvent.type(within(line).getByLabelText("Reason"), "torn upper");

    expect(within(line).getByRole("status")).toHaveTextContent("All 6 pairs accounted for");
    await userEvent.click(submit);
    const confirm = await screen.findByRole("dialog", { name: "Reconcile and complete MP-000001?" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Reconcile & Complete" }));

    await waitFor(() =>
      expect(api.completeMachineProgramProduction).toHaveBeenCalledWith(
        {
          programId: "prog-1",
          entries: [
            {
              lineId: "line-black", cutSizeUppers: 4, cutSizePairs: 1,
              claims: [{ role: "SUPPLIER", supplierPartyId: "s-1", pairs: 1, ratePaisa: 5000, reason: "torn upper" }],
            },
          ],
        },
        { token: "t-1" }
      )
    );
    expect(await within(section).findByText(/Closed — reconciled/)).toBeInTheDocument();
  });

  it("Return Upper scans a sealed packet back, and says why another cannot come back", async () => {
    const api = installApi([printedPacket], [], standing(7));
    renderPage();
    await openProgram("MP-000001");
    const workspace = await screen.findByRole("region", { name: "Reconciliation" });
    const box = within(workspace).getByLabelText("Scan or type the packet's QR");

    await userEvent.type(box, "RM_6_41_2{Enter}");
    expect(await within(workspace).findByText("2 DOZEN of UPPER — SK6 — GREY — 7/10 back in stock", { exact: false })).toBeInTheDocument();
    expect(api.returnMachineProgramUpper).toHaveBeenCalledWith({ programId: "prog-1", rawScan: "RM_6_41_2" }, { token: "t-1" });
    expect(box).toHaveValue("");

    await userEvent.type(box, "RM_6_41_9{Enter}");
    expect(await within(workspace).findByText("This packet has already been received.", { exact: false })).toBeInTheDocument();
  });

  it("B-Carton MIX makes B labels for an upper line after a confirmation", async () => {
    const api = installApi([printedPacket], [], standing(7));
    renderPage();
    await openProgram("MP-000001");
    const workspace = await screen.findByRole("region", { name: "Reconciliation" });

    await userEvent.type(within(workspace).getByLabelText("B cartons of SK6 7/10 · BLACK / GREY"), "2");
    expect(within(workspace).getByRole("alert")).toHaveTextContent("Only 1 carton is missing, so at most 1 can be B cartons.");
    await userEvent.clear(within(workspace).getByLabelText("B cartons of SK6 7/10 · BLACK / GREY"));
    await userEvent.type(within(workspace).getByLabelText("B cartons of SK6 7/10 · BLACK / GREY"), "1");
    await userEvent.click(within(workspace).getByRole("button", { name: "Generate B labels" }));

    const confirm = await screen.findByRole("dialog", { name: "Make 1 B carton?" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Generate B labels" }));
    await waitFor(() =>
      expect(api.convertMachineProgramUpperCartonsToB).toHaveBeenCalledWith({ programId: "prog-1", lineId: "line-black", count: 1 }, { token: "t-1" })
    );
  });
});


