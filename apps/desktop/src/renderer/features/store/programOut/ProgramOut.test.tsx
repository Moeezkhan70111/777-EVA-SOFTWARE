import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_KIND } from "@erp/domain";
import { StoreOutPage } from "../StoreOutPage";
import { NotificationsProvider } from "../../../state/NotificationsContext";
import { notificationTarget } from "../../users/notificationTarget";
import type { MachineProgramRecord } from "../../../types/desktopApi";

// MACHINE MOVE OUT, from the operator's side.
//
// What matters here: all three doors open the SAME program workflow (the lookup box, a
// notification, and the program sheet scanned into the station that holds the focus), the
// backend decides everything, ONE SCAN IS ONE MOVEMENT, and the cartons the machine owes back
// are offered for exactly what went out — never typed and never guessed.
//
// The two Move Out panes are mocked away: they are existing screens with their own tests, and
// mounting their scanners here would put a second armed scan box on the page. The mock keeps the
// one seam that matters — a program code scanned into the station is handed up to the lookup.
vi.mock("../../../pages/RawMaterialOutputPage", () => ({
  RawMaterialOutputPage: ({
    onSessionChange,
    onMachineProgramScan,
  }: {
    onSessionChange?: (id: string | null) => void;
    onMachineProgramScan?: (code: string) => void;
  }) => {
    React.useEffect(() => onSessionChange?.("session-1"), [onSessionChange]);
    return (
      <div data-testid="rm-output-station">
        Raw Material Output
        <button type="button" onClick={() => onMachineProgramScan?.("MP-000001")}>
          station scan MP-000001
        </button>
      </div>
    );
  },
}));
vi.mock("../../HandMovePanel", () => ({ HandMovePanel: () => <div data-testid="hand-move">Move Out by Hand</div> }));
vi.mock("../HandMovePanel", () => ({ HandMovePanel: () => <div data-testid="hand-move">Move Out by Hand</div> }));
vi.mock("../../../utils/playScanSound", () => ({ playScanSound: () => undefined }));

const printWindow = vi.fn((_opts: { ids: string[] }) => true);
vi.mock("../../../utils/qrLabels", () => ({
  openCartonLabelPrintWindow: (opts: { ids: string[] }) => printWindow(opts) as boolean,
}));

const TODAY = "2026-10-09";

/** MP-000001: 100 DOZEN of BLACK and 50 of RED, with `issued` already out of the store. */
const program = (issued: { black?: number; red?: number } = {}): MachineProgramRecord => {
  const lines = [
    { id: "line-black", itemId: "u-black", colour: "BLACK", quantity: 100, consumed: issued.black ?? 0 },
    { id: "line-red", itemId: "u-red", colour: "RED", quantity: 50, consumed: issued.red ?? 0 },
  ].map((line, index) => ({
    id: line.id,
    runId: "run-1",
    lineNo: index + 1,
    itemId: line.itemId,
    itemDisplayName: `UPPER — RAGZINE UPPER — SK6 — ${line.colour} — 7/10`,
    upperColour: line.colour,
    upperType: "SILAI",
    subCategoryName: "RAGZINE UPPER",
    quantity: line.quantity,
    unitCode: "DOZEN",
    consumed: line.consumed,
    outstanding: line.quantity - line.consumed,
    availableAtSave: 200,
  }));
  const total = lines.reduce((sum, line) => sum + line.quantity, 0);
  const consumed = lines.reduce((sum, line) => sum + line.consumed, 0);
  return {
    id: "prog-1",
    programNumber: 1,
    code: "MP-000001",
    machineId: "m-1",
    machineName: "MACHINE 1",
    contractorPartyId: "c-A",
    contractorName: "CONTRACTOR A",
    packingContractorPartyId: "c-B",
    packingContractorName: "CONTRACTOR B",
    programDate: TODAY,
    shiftStartMinute: 360,
    shiftEndMinute: 1080,
    status: "PROGRAMMED",
    displayStatus: consumed > 0 ? "PARTIALLY_USED" : "PROGRAMMED",
    totalQuantity: total,
    fixQuantity: 0,
    productionQuantity: total,
    consumedQuantity: consumed,
    outstandingQuantity: total - consumed,
    unitCode: "DOZEN",
    createdBy: "aslam",
    createdAt: `${TODAY}T07:00:00.000Z`,
    updatedAt: `${TODAY}T07:00:00.000Z`,
    completedAt: null,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    runs: [
      {
        id: "run-1",
        programId: "prog-1",
        injectorNo: 1,
        runNo: 1,
        soleColour: "BLACK",
        innerSoleColour: null,
        fixQuantity: 0,
        articleSizeId: "as-sk6-710",
        article: "SK6",
        size: "7/10",
        totalQuantity: total,
        consumedQuantity: consumed,
        unitCode: "DOZEN",
        lines,
      },
    ],
    // Contractor pricing belongs to the program screen; Store Out never reads it.
    articleRates: [],
  };
};

/** Each packet holds 2 DOZEN, so each one is 4 cartons coming back. */
const PACKETS: Record<string, { itemId: string; colour: string }> = {
  RM_6_42_1: { itemId: "u-black", colour: "BLACK" },
  RM_6_42_2: { itemId: "u-black", colour: "BLACK" },
  RM_6_43_1: { itemId: "u-red", colour: "RED" },
  // On the program, but the upper carries no colour, so no carton identity can be built.
  RM_6_45_1: { itemId: "u-black", colour: "" },
  // Not on this program at all.
  RM_6_44_1: { itemId: "u-green", colour: "GREEN" },
};

function installApi(options: { openRefusal?: { outcome: string; reason: string } } = {}) {
  const state = { program: program(), black: 0, red: 0, sequence: 0 };
  const api = {
    openMachineProgramStoreOut: vi.fn(async (lookup: string) => {
      if (options.openRefusal) return { accepted: false, ...options.openRefusal, program: null };
      if (!["MP-000001", "1", "prog-1"].includes(lookup)) {
        return { accepted: false, outcome: "PROGRAM_NOT_FOUND", reason: `${lookup} does not exist.`, program: null };
      }
      return { accepted: true, outcome: "OPENED", programId: "prog-1", programCode: "MP-000001", program: state.program };
    }),
    // One scan is one of these calls. The verdict is the backend's, verbatim.
    machineProgramStoreOutSaveBatch: vi.fn(async (input: { qrIds: string[]; batchKey: string; sessionId?: string | null }) => {
      const qrId = input.qrIds[0];
      const packet = PACKETS[qrId];
      if (!packet) {
        return {
          accepted: false,
          outcome: "SCAN_REFUSED",
          reason: "This QR has not been generated in the system.",
          refusedQrId: qrId,
          refusedVerdict: "UNKNOWN_QR",
          program: state.program,
        };
      }
      if (packet.itemId === "u-green") {
        return {
          accepted: false,
          outcome: "SCAN_REFUSED",
          reason: "GREEN is not waiting on this machine program. Nothing was issued.",
          refusedQrId: qrId,
          refusedVerdict: "NOT_ON_PROGRAM",
          program: state.program,
        };
      }

      if (packet.itemId === "u-black") state.black += 2;
      else state.red += 2;
      state.program = program({ black: state.black, red: state.red });
      return {
        accepted: true,
        outcome: "SAVED",
        batchId: `batch-${qrId}`,
        programId: "prog-1",
        packetCount: 1,
        programCompleted: false,
        program: state.program,
        packets: [
          {
            qrId,
            itemId: packet.itemId,
            itemDisplayName: `UPPER — SK6 — ${packet.colour || "—"} — 7/10`,
            partyName: "SHEHZAD RUBBER",
            quantity: 2,
            unitCode: "DOZEN",
            packName: "PACKET",
            cartons: packet.colour
              ? {
                  articleSizeId: "as-sk6-710",
                  article: "SK6",
                  size: "7/10",
                  soleColour: "BLACK",
                  innerSoleColour: null,
                  fixQuantity: 0,
                  colour: packet.colour,
                  count: 4,
                }
              : null,
            cartonNote: packet.colour
              ? null
              : "UPPER — SK6 — — — 7/10 has no colour on it, and a carton QR needs one.",
          },
        ],
      };
    }),
    listMachineProgramIssueBatches: vi.fn(async () => ({ accepted: true, rows: [] })),
    // Dana Issue: the store holds two BLACK Danas, which is exactly the case a colour
    // alone cannot describe — the operator has to pick the material.
    listMachineProgramDanaOptions: vi.fn(async () => ({
      accepted: true,
      rows: [
        {
          itemId: "d-eva-black", displayName: "DANA — EVA — BLACK", colour: "BLACK", subCategoryName: "EVA",
          packName: "BAG", packSize: 25, packingUnitCode: "KILOGRAM", stockUnitCode: "KILOGRAM",
          quantityOnHand: 200, bagsOnHand: 8, blockedReason: null as string | null,
        },
        {
          itemId: "d-pvc-black", displayName: "DANA — PVC — BLACK", colour: "BLACK", subCategoryName: "PVC",
          packName: "BAG", packSize: 25, packingUnitCode: "KILOGRAM", stockUnitCode: "KILOGRAM",
          quantityOnHand: 75, bagsOnHand: 3, blockedReason: null,
        },
      ],
    })),
    issueMachineProgramDana: vi.fn(async (): Promise<{ accepted: boolean; outcome: string; reason?: string; quantity?: number; unitCode?: string }> => ({ accepted: true, outcome: "MOVED", quantity: 50, unitCode: "KILOGRAM" })),
    listMachineProgramDanaIssues: vi.fn(async () => ({ accepted: true, rows: [] })),
    generateQrBatch: vi.fn(async (input: { articleSizeId: string; color: string; quantity: number }) => {
      const ids = Array.from({ length: input.quantity }, (_, index) => {
        state.sequence += 1;
        void index;
        return `SK6_${input.color}_7/10_${String(state.sequence).padStart(6, "0")}`;
      });
      return {
        accepted: true,
        batch: {
          id: `qrb-${state.sequence}`,
          articleSizeId: input.articleSizeId,
          article: "SK6",
          color: input.color,
          size: "7/10",
          startSequence: state.sequence - input.quantity + 1,
          endSequence: state.sequence,
          quantity: input.quantity,
          createdAt: `${TODAY}T08:00:00.000Z`,
          createdBy: "aslam",
          requestedBy: "MP-000001",
        },
        qrCodes: ids.map((id) => ({ id, batchId: `qrb-${state.sequence}`, article: "SK6", color: input.color, size: "7/10", sequence: 1, status: "GENERATED" })),
      };
    }),
  };
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });
  return api;
}

const renderPage = (props: { initialProgramId?: string } = {}) =>
  render(
    <NotificationsProvider>
      <StoreOutPage token="t-1" username="aslam" onBack={() => undefined} {...props} />
    </NotificationsProvider>
  );

const lookupBox = () => screen.getByLabelText("Scan QR or enter Machine Program No.");

/** One scan, the way a wedge scanner delivers it: the whole code, then Enter. */
const scan = async (code: string) => {
  const box = screen.getByLabelText("Scanner input");
  await userEvent.click(box);
  await userEvent.paste(code);
  await userEvent.keyboard("{Enter}");
};

/** The program screen is open once its own heading is on the page. */
const openedProgram = () => screen.findByRole("heading", { name: "Machine Program Issue" });

/** The article card for one article, found by its heading figures. */
const card = async (article: string) => {
  const heading = await screen.findByText(article);
  return heading.closest(".mpi-card") as HTMLElement;
};

/** Scanning is behind Start Scan now: the program is read-only until it is pressed. */
const startScan = async () => {
  await userEvent.click(await screen.findByRole("button", { name: /Start Scan|Resume Scan/ }));
};

/**
 * The authorised-uppers row for one UPPER colour.
 *
 * Found by the upper cell, not by the text: a row names two colours — the sole it is moulded in
 * and the upper going on it — and they are often the same word.
 */
const row = async (upperColour: string) => {
  // Matched on the UPPER span: a row names the sole too, and they are often the same word.
  await screen.findAllByRole("table");
  const cell = Array.from(document.querySelectorAll(".mpi-upper-of")).find((node) => node.textContent === upperColour);
  if (!cell) throw new Error(`no row for the ${upperColour} upper`);
  return cell.closest("tr") as HTMLElement;
};

const cartonSection = () => screen.getByRole("region", { name: "Cartons to label" });

afterEach(() => {
  vi.restoreAllMocks();
  printWindow.mockClear();
  printWindow.mockReturnValue(true);
});

describe("notificationTarget", () => {
  it("sends a machine-program notice to Store Out, carrying the program's stored id", () => {
    expect(notificationTarget({ kind: NOTIFICATION_KIND.MACHINE_PROGRAM_ISSUED, entityId: "prog-1" })).toEqual({
      route: "store-out-operator",
      programId: "prog-1",
    });
  });

  it("sends nothing anywhere without an entity to open", () => {
    expect(notificationTarget({ kind: NOTIFICATION_KIND.MACHINE_PROGRAM_ISSUED, entityId: null })).toBeNull();
  });
});

describe("Machine Move Out — opening a program", () => {
  it("opens the program typed into the box, and shows what it authorises", async () => {
    const api = installApi();
    renderPage();

    await userEvent.type(lookupBox(), "MP-000001");
    await userEvent.keyboard("{Enter}");

    expect(await openedProgram()).toBeInTheDocument();
    expect(api.openMachineProgramStoreOut).toHaveBeenCalledWith("MP-000001", { token: "t-1" });
    expect(screen.getByText("MACHINE 1")).toBeInTheDocument();
    expect(screen.getByText("Program ready")).toBeInTheDocument();

    // The authorised uppers, with the data layer's own figures: authorised, issued, remaining.
    expect(await row("BLACK")).toHaveTextContent("BLACK1000100");
    expect(await row("RED")).toHaveTextContent("RED50050");
  });

  it("opens the same workflow from a notification, without the operator typing anything", async () => {
    const api = installApi();
    renderPage({ initialProgramId: "prog-1" });

    expect(await openedProgram()).toBeInTheDocument();
    expect(api.openMachineProgramStoreOut).toHaveBeenCalledWith("prog-1", { token: "t-1" });
  });

  it("opens the program from a sheet scanned into the station that holds the focus", async () => {
    const api = installApi();
    renderPage();

    // The Scan Out station is armed as soon as its session opens, so this is where the program
    // sheet's QR actually lands. It must open the program, not be refused as a bad packet.
    await userEvent.click(screen.getByRole("button", { name: "station scan MP-000001" }));

    expect(await openedProgram()).toBeInTheDocument();
    expect(api.openMachineProgramStoreOut).toHaveBeenCalledWith("MP-000001", { token: "t-1" });
  });

  it("shows the backend's refusal and never opens a different program instead", async () => {
    installApi();
    renderPage();

    await userEvent.type(lookupBox(), "MP-000999");
    await userEvent.keyboard("{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("MP-000999 does not exist.");
    expect(screen.queryByRole("heading", { name: "Machine Program Issue" })).not.toBeInTheDocument();
    // The ordinary Store Out page is still there, untouched.
    expect(screen.getByTestId("rm-output-station")).toBeInTheDocument();
  });

  it("refuses a cancelled program with the reason the backend gave", async () => {
    installApi({ openRefusal: { outcome: "PROGRAM_CANCELLED", reason: "MP-000001 has been deleted." } });
    renderPage();

    await userEvent.type(lookupBox(), "MP-000001");
    await userEvent.keyboard("{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("has been deleted");
    expect(screen.queryByLabelText("Scanner input")).not.toBeInTheDocument();
  });
});

describe("Machine Move Out — one scan, one movement", () => {
  const open = async () => {
    await userEvent.type(lookupBox(), "MP-000001");
    await userEvent.keyboard("{Enter}");
    await openedProgram();
    await startScan();
  };

  it("moves an authorised packet out of the store on the scan itself", async () => {
    const api = installApi();
    renderPage();
    await open();

    await scan("RM_6_42_1");

    expect(await screen.findByTestId("scan-status")).toHaveTextContent("MOVED OUT OF STORE");
    await waitFor(() =>
      expect(api.machineProgramStoreOutSaveBatch).toHaveBeenCalledWith(
        expect.objectContaining({ programId: "prog-1", sessionId: "session-1", qrIds: ["RM_6_42_1"] }),
        { token: "t-1" }
      )
    );
    // Its own idempotency key, so a reply lost on the way back cannot issue it twice.
    expect(api.machineProgramStoreOutSaveBatch.mock.calls[0][0].batchKey).toMatch(/[0-9a-f-]{8,}/);

    // Issued and remaining are the re-read program's, never patched on screen.
    expect(await row("BLACK")).toHaveTextContent("BLACK100298");
    expect(screen.getByText("Uppers being taken")).toBeInTheDocument();
  });

  it("shows a rejection, moves nothing, and stays armed for the next packet", async () => {
    const api = installApi();
    renderPage();
    await open();

    await scan("RM_6_44_1");
    expect(await screen.findByTestId("scan-status")).toHaveTextContent("NOT ON THIS PROGRAM");
    expect(await row("BLACK")).toHaveTextContent("BLACK1000100");
    expect(within(cartonSection()).getByText("Scan a packet out and its cartons appear here.")).toBeInTheDocument();

    // A refusal did not end the session: the very next packet goes out.
    await scan("RM_6_42_1");
    expect(await screen.findByTestId("scan-status")).toHaveTextContent("MOVED OUT OF STORE");
    expect(api.machineProgramStoreOutSaveBatch).toHaveBeenCalledTimes(2);
  });

  it("offers the cartons the machine owes back, and generates exactly that many QR codes", async () => {
    const api = installApi();
    renderPage();
    await open();

    await scan("RM_6_42_1");
    // 2 DOZEN out is 4 cartons coming back.
    expect(await within(cartonSection()).findByText("4 cartons")).toBeInTheDocument();
    expect(within(cartonSection()).getByText("SK6 / 7/10 / BLACK")).toBeInTheDocument();

    // A second packet of the same upper is the same carton run, not a second one.
    await scan("RM_6_42_2");
    expect(await within(cartonSection()).findByText("8 cartons")).toBeInTheDocument();

    // A different upper is its own run.
    await scan("RM_6_43_1");
    expect(await within(cartonSection()).findByText("SK6 / 7/10 / RED")).toBeInTheDocument();

    await userEvent.click(within(cartonSection()).getByRole("button", { name: "Print 8 carton QR labels for SK6 / 7/10 / BLACK" }));

    await waitFor(() =>
      expect(api.generateQrBatch).toHaveBeenCalledWith({
        articleSizeId: "as-sk6-710",
        color: "BLACK",
        quantity: 8,
        createdBy: "aslam",
        requestedBy: "MP-000001",
      })
    );
    expect(printWindow).toHaveBeenCalledTimes(1);
    expect(printWindow.mock.calls[0][0].ids).toHaveLength(8);

    // Printed once and not offered again, with the range it reserved on the record.
    await waitFor(() => expect(within(cartonSection()).queryByText("8 cartons")).not.toBeInTheDocument());
    expect(within(cartonSection()).getByText(/SK6_BLACK_7\/10_000001 → SK6_BLACK_7\/10_000008/)).toBeInTheDocument();
    // The RED run is untouched by printing the BLACK one.
    expect(within(cartonSection()).getByText("4 cartons")).toBeInTheDocument();
  });

  it("says why cartons cannot be labelled instead of printing a guessed identity", async () => {
    const api = installApi();
    renderPage();
    await open();

    await scan("RM_6_45_1");

    expect(await screen.findByTestId("scan-status")).toHaveTextContent("MOVED OUT OF STORE");
    expect(await within(cartonSection()).findByText(/has no colour on it/)).toBeInTheDocument();
    expect(within(cartonSection()).queryByRole("button", { name: /Print/ })).not.toBeInTheDocument();
    expect(api.generateQrBatch).not.toHaveBeenCalled();
  });
});
// ─── Dana Issue ───────────────────────────────────────────────────────────────
// Dana is the SOLE's own material. A program never reserved it, so there is nothing planned
// and nothing remaining here — only what the store holds and what is being taken today.

describe("Machine Program Issue — Dana", () => {
  const open = async () => {
    await userEvent.type(lookupBox(), "MP-000001");
    await userEvent.keyboard("{Enter}");
    await openedProgram();
  };

  const danaSection = () => screen.getByRole("region", { name: "Dana Issue" });

  it("offers one stepper per MATERIAL, so two Danas of one colour can be told apart", async () => {
    const api = installApi();
    renderPage();
    await open();

    await waitFor(() => expect(api.listMachineProgramDanaOptions).toHaveBeenCalledWith("prog-1", { token: "t-1" }));
    const dana = danaSection();
    // A colour alone would not say which of these left the store.
    expect(within(dana).getByText("BLACK · EVA")).toBeInTheDocument();
    expect(within(dana).getByText("BLACK · PVC")).toBeInTheDocument();
    expect(within(dana).getByText("8 BAGS in store")).toBeInTheDocument();
    expect(within(dana).getByText("3 BAGS in store")).toBeInTheDocument();
    // Nothing is asked for yet, so there is nothing to issue.
    expect(within(dana).getByRole("button", { name: "Issue Dana" })).toBeDisabled();
  });

  it("issues the bags that were asked for, and only those", async () => {
    const api = installApi();
    renderPage();
    await open();
    const dana = danaSection();

    await userEvent.click(await within(dana).findByRole("button", { name: "One more bag of BLACK · EVA" }));
    await userEvent.click(within(dana).getByRole("button", { name: "One more bag of BLACK · EVA" }));
    await userEvent.click(within(dana).getByRole("button", { name: "Issue Dana" }));

    await waitFor(() =>
      expect(api.issueMachineProgramDana).toHaveBeenCalledWith(
        { programId: "prog-1", itemId: "d-eva-black", bags: 2 },
        { token: "t-1" }
      )
    );
    // The PVC bag was never asked for, so it never moved.
    expect(api.issueMachineProgramDana).toHaveBeenCalledTimes(1);
    // And the program is re-read, because its figures are the database's, never the screen's.
    await waitFor(() => expect(api.openMachineProgramStoreOut).toHaveBeenCalledTimes(2));
  });

  it("never offers more bags than the store holds", async () => {
    installApi();
    renderPage();
    await open();
    const dana = danaSection();

    const box = await within(dana).findByRole("textbox", { name: "Bags of BLACK · PVC" });
    await userEvent.clear(box);
    await userEvent.type(box, "99");

    // 3 bags on the shelf is the ceiling, typed or clicked.
    expect(box).toHaveValue("3");
    expect(within(dana).getByRole("button", { name: "One more bag of BLACK · PVC" })).toBeDisabled();
  });

  it("will not let a labelled Dana be typed out, and says to scan it instead", async () => {
    const api = installApi();
    api.listMachineProgramDanaOptions.mockResolvedValue({
      accepted: true,
      rows: [
        {
          itemId: "d-eva-black", displayName: "DANA — EVA — BLACK", colour: "BLACK", subCategoryName: "EVA",
          packName: "BAG", packSize: 25, packingUnitCode: "KILOGRAM", stockUnitCode: "KILOGRAM",
          quantityOnHand: 200, bagsOnHand: 8,
          blockedReason: "6 labelled packets of this material are in the store. Scan them out on the right instead.",
        },
      ],
    });
    renderPage();
    await open();
    const dana = danaSection();

    expect(await within(dana).findByText(/6 labelled packets/)).toBeInTheDocument();
    expect(within(dana).getByRole("button", { name: "One more bag of BLACK · EVA" })).toBeDisabled();
    expect(within(dana).getByRole("button", { name: "Issue Dana" })).toBeDisabled();
  });

  it("keeps the refusal on screen when the store turns an issue down", async () => {
    const api = installApi();
    api.issueMachineProgramDana.mockResolvedValue({
      accepted: false,
      outcome: "NOT_ENOUGH_STOCK",
      reason: "Only 50 KILOGRAM is in the store.",
    });
    renderPage();
    await open();
    const dana = danaSection();

    await userEvent.click(await within(dana).findByRole("button", { name: "One more bag of BLACK · EVA" }));
    await userEvent.click(within(dana).getByRole("button", { name: "Issue Dana" }));

    expect(await within(dana).findByRole("alert")).toHaveTextContent("Only 50 KILOGRAM is in the store.");
  });
});

describe("Machine Program Issue — reading the program", () => {
  const open = async () => {
    await userEvent.type(lookupBox(), "MP-000001");
    await userEvent.keyboard("{Enter}");
    await openedProgram();
  };

  it("groups the work by injector and SOLE colour, and says how far each article is", async () => {
    installApi();
    renderPage();
    await open();

    // The band names the sole once, instead of it being repeated on every row.
    expect(await screen.findByRole("region", { name: "Injector 1, BLACK sole" })).toBeInTheDocument();

    const sk6 = await card("SK6");
    expect(sk6).toHaveTextContent("7/10");
    expect(sk6).toHaveTextContent("0 / 150");
    expect(sk6).toHaveTextContent("Pending");
    // The unit is named ONCE, in the column head, not on every figure.
    expect(within(sk6).getByText("Planned (Dozen)")).toBeInTheDocument();
  });

  it("does not arm the scanner until Start Scan is pressed", async () => {
    const api = installApi();
    renderPage();
    await open();

    // A stray scan while somebody is reading the page must not move stock.
    expect(screen.queryByLabelText("Scanner input")).not.toBeInTheDocument();

    await startScan();
    expect(await screen.findByLabelText("Scanner input")).toBeEnabled();
    expect(api.machineProgramStoreOutSaveBatch).not.toHaveBeenCalled();
  });
});
