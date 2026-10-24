import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_KIND } from "@erp/domain";
import { StoreOutPage } from "../StoreOutPage";
import { NotificationsProvider } from "../../../state/NotificationsContext";
import { notificationTarget } from "../../users/notificationTarget";
import type {
  MachineProgramCartonPacket,
  MachineProgramFixCartonRun,
  MachineProgramRecord,
} from "../../../types/desktopApi";

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

const printWindow = vi.fn((_opts: { ids: string[]; identity?: { innerColor?: string | null } }) => true);
vi.mock("../../../utils/qrLabels", () => ({
  openCartonLabelPrintWindow: (opts: { ids: string[]; identity?: { innerColor?: string | null } }) =>
    printWindow(opts) as boolean,
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
        startMinute: null,
        endMinute: null,
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

/** A packet out for the program as the carton list reads it back from the events. */
const cartonPacket = (qrId: string, colour: string, eventId = `ev-${qrId}`): MachineProgramCartonPacket => ({
  eventId,
  qrId,
  itemDisplayName: `UPPER — SK6 — ${colour || "—"} — 7/10`,
  quantity: 2,
  unitCode: "DOZEN",
  issuedAt: `${TODAY}T07:00:00.000Z`,
  cartons: colour
    ? { articleSizeId: "as-sk6-710", article: "SK6", size: "7/10", soleColour: "BLACK", colour, count: 4 }
    : null,
  cartonNote: colour ? null : "UPPER — SK6 — — — 7/10 has no colour on it, and a carton QR needs one.",
  label: null,
});

function installApi(
  options: {
    openRefusal?: { outcome: string; reason: string };
    /** The program exists but may not be issued against: the backend refuses AND returns it. */
    fullyIssued?: boolean;
    earlierPackets?: MachineProgramCartonPacket[];
    /** A FIX article on the program: no upper, two soles, and cartons owed by its PLAN. */
    fixRuns?: MachineProgramFixCartonRun[];
    /** The program Store Out opens — an EVR FIX one, say. Defaults to the SK6 upper program. */
    program?: MachineProgramRecord;
  } = {}
) {
  const state = {
    program: options.program ?? program(),
    black: 0,
    red: 0,
    sequence: 0,
    cartonPackets: [...(options.earlierPackets ?? [])],
    fixRuns: [...(options.fixRuns ?? [])],
  };
  const api = {
    openMachineProgramStoreOut: vi.fn(async (lookup: string) => {
      if (options.openRefusal) return { accepted: false, ...options.openRefusal, program: null };
      if (options.fullyIssued) {
        return {
          accepted: false,
          outcome: "PROGRAM_COMPLETED",
          reason: "MP-000001 is fully issued. Everything on it has already left the store.",
          programId: "prog-1",
          programCode: "MP-000001",
          program: { ...program({ black: 100, red: 50 }), status: "COMPLETED", displayStatus: "COMPLETED" },
        };
      }
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
      state.cartonPackets.push(cartonPacket(qrId, packet.colour));
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
    listQrCodesForBatch: vi.fn(async (_batchId: string): Promise<Array<{ id: string; batchId: string; article: string; color: string; size: string; sequence: number; status: string }>> => []),
    listMachineProgramCartonPackets: vi.fn(async () => ({
      accepted: true,
      rows: state.cartonPackets.map((packet) => ({ ...packet })),
      fixRuns: state.fixRuns.map((run) => ({ ...run })),
    })),
    // Dana Issue: the store holds two BLACK Danas, which is exactly the case a colour
    // alone cannot describe — the operator has to pick the material.
    listMachineProgramDanaOptions: vi.fn(async () => ({
      accepted: true,
      rows: [
        // EVA BLACK has 1 BAG = 25 KG on its ladder; PVC BLACK is counted in KG only.
        { itemId: "d-eva-black", displayName: "DANA — EVA — BLACK", colour: "BLACK", subCategoryName: "EVA", units: ["BAG", "KG"], stockUnitCode: "KG", issuedQuantity: 45, blockedReason: null as string | null },
        { itemId: "d-pvc-black", displayName: "DANA — PVC — BLACK", colour: "BLACK", subCategoryName: "PVC", units: ["KG"], stockUnitCode: "KG", issuedQuantity: 0, blockedReason: null },
      ],
    })),
    issueMachineProgramDana: vi.fn(async (): Promise<{ accepted: boolean; outcome: string; reason?: string; quantity?: number; unitCode?: string }> => ({ accepted: true, outcome: "MOVED", quantity: 50, unitCode: "KILOGRAM" })),
    listMachineProgramDanaIssues: vi.fn(async () => ({ accepted: true, rows: [] })),
    // The backend's print: the count comes from the packets, and each packet is labelled once.
    printMachineProgramCartons: vi.fn(async (input: { programId: string; eventIds?: string[]; runId?: string }) => {
      // A FIX run is labelled by its own id: it has no packet to be owed to.
      if (input.runId) {
        const run = state.fixRuns.find((candidate) => candidate.runId === input.runId);
        if (!run || run.cartonsToPrint <= 0) return { accepted: false, reason: "Every carton this article plans has already been labelled." };
        const ids = Array.from({ length: run.cartonsToPrint }, () => {
          state.sequence += 1;
          return `${run.article}_${run.outerSoleColour}_${run.size}_${String(state.sequence).padStart(6, "0")}`;
        });
        const fixBatchId = `qrb-fix-${state.sequence}`;
        state.fixRuns = state.fixRuns.map((candidate) =>
          candidate.runId === run.runId ? { ...candidate, cartonsToPrint: 0 } : candidate
        );
        return {
          accepted: true,
          batch: { id: fixBatchId, article: run.article, color: run.outerSoleColour, size: run.size, quantity: ids.length },
          qrCodes: ids.map((id, index) => ({
            id, batchId: fixBatchId, article: run.article, color: run.outerSoleColour, size: run.size,
            sequence: index + 1, status: "GENERATED",
          })),
        };
      }
      const chosen = state.cartonPackets.filter((packet) => (input.eventIds ?? []).includes(packet.eventId));
      if (chosen.some((packet) => packet.label)) return { accepted: false, reason: "The cartons for this upper were already printed." };
      const color = chosen[0].cartons!.colour;
      const quantity = chosen.reduce((total, packet) => total + packet.cartons!.count, 0);
      const ids = Array.from({ length: quantity }, () => {
        state.sequence += 1;
        return `SK6_${color}_7/10_${String(state.sequence).padStart(6, "0")}`;
      });
      const batchId = `qrb-${state.sequence}`;
      for (const packet of chosen) {
        packet.label = {
          qrBatchId: batchId, firstQrId: ids[0], lastQrId: ids[ids.length - 1],
          cartonCount: packet.cartons!.count, receivedInRun: 0, voidedInRun: 0, colour: "BLACK", grade: null, printedBy: "aslam", printedAt: `${TODAY}T08:00:00.000Z`,
        };
      }
      return {
        accepted: true,
        batch: {
          id: batchId, articleSizeId: "as-sk6-710", article: "SK6", color, size: "7/10",
          startSequence: state.sequence - quantity + 1, endSequence: state.sequence, quantity,
          createdAt: `${TODAY}T08:00:00.000Z`, createdBy: "aslam", requestedBy: "MP-000001",
        },
        qrCodes: ids.map((id) => ({ id, batchId, article: "SK6", color, size: "7/10", sequence: 1, status: "GENERATED" })),
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
      <StoreOutPage token="t-1" onBack={() => undefined} onOpenReport={() => undefined} {...props} />
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

  it("still opens a fully issued program to read it and print its cartons, but never to scan", async () => {
    const api = installApi({ fullyIssued: true, earlierPackets: [cartonPacket("RM_6_42_1", "BLACK")] });
    renderPage();

    await userEvent.type(lookupBox(), "MP-000001");
    await userEvent.keyboard("{Enter}");

    // Opened, with its status in words — not an error banner.
    expect(await openedProgram()).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("MP-000001 is fully issued. Everything on it has already left the store.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start Scan|Resume Scan/ })).toBeDisabled();

    // The cartons it is owed can still be printed.
    await userEvent.click(within(cartonSection()).getByRole("button", { name: "Print 4 carton QR labels for SK6 / 7/10 / BLACK" }));
    await waitFor(() => expect(api.printMachineProgramCartons).toHaveBeenCalledTimes(1));
    expect(api.machineProgramStoreOutSaveBatch).not.toHaveBeenCalled();
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
    // One scan, ONE save. The scan arrives as a paste and an Enter, so the box has two ways to
    // send it; this held only by timing until useScanBox read the live buffer on Enter.
    expect(api.machineProgramStoreOutSaveBatch).toHaveBeenCalledTimes(1);
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
    expect(await within(cartonSection()).findByRole("button", { name: "Print 4 carton QR labels for SK6 / 7/10 / BLACK" })).toBeInTheDocument();
    expect(within(cartonSection()).getByText("SK6 / 7/10 / BLACK")).toBeInTheDocument();

    // A second packet of the same upper is the same carton run, not a second one.
    await scan("RM_6_42_2");
    expect(await within(cartonSection()).findByRole("button", { name: "Print 8 carton QR labels for SK6 / 7/10 / BLACK" })).toBeInTheDocument();

    // A different upper is its own run.
    await scan("RM_6_43_1");
    expect(await within(cartonSection()).findByText("SK6 / 7/10 / RED")).toBeInTheDocument();

    await userEvent.click(within(cartonSection()).getByRole("button", { name: "Print 8 carton QR labels for SK6 / 7/10 / BLACK" }));

    // The screen names the packets; the count is the backend's to work out from them.
    await waitFor(() =>
      expect(api.printMachineProgramCartons).toHaveBeenCalledWith(
        { programId: "prog-1", eventIds: ["ev-RM_6_42_1", "ev-RM_6_42_2"] },
        { token: "t-1" }
      )
    );
    expect(printWindow).toHaveBeenCalledTimes(1);
    expect(printWindow.mock.calls[0][0].ids).toHaveLength(8);

    // Printed once and not offered again, with the range it reserved on the record.
    await waitFor(() => expect(within(cartonSection()).queryByRole("button", { name: /^Print \d+ carton QR labels for SK6 \/ 7\/10 \/ BLACK/ })).not.toBeInTheDocument());
    expect(within(cartonSection()).getByText(/SK6_BLACK_7\/10_000001 → SK6_BLACK_7\/10_000008/)).toBeInTheDocument();
    // The RED run is untouched by printing the BLACK one.
    expect(within(cartonSection()).getByRole("button", { name: "Print 4 carton QR labels for SK6 / 7/10 / RED" })).toBeInTheDocument();
  });

  it("says why cartons cannot be labelled instead of printing a guessed identity", async () => {
    const api = installApi();
    renderPage();
    await open();

    await scan("RM_6_45_1");

    expect(await screen.findByTestId("scan-status")).toHaveTextContent("MOVED OUT OF STORE");
    expect(await within(cartonSection()).findByText(/has no colour on it/)).toBeInTheDocument();
    expect(within(cartonSection()).queryByRole("button", { name: /Print/ })).not.toBeInTheDocument();
    expect(api.printMachineProgramCartons).not.toHaveBeenCalled();
  });

  it("offers cartons owed from an earlier sitting without opening the scanner, and never twice", async () => {
    // 2 DOZEN went out yesterday and its labels were never printed; another packet was.
    const printed = cartonPacket("RM_6_43_1", "RED");
    printed.label = {
      qrBatchId: "qrb-old", firstQrId: "SK6_RED_7/10_000001", lastQrId: "SK6_RED_7/10_000004",
      cartonCount: 4, receivedInRun: 0, voidedInRun: 0, colour: "BLACK", grade: null, printedBy: "aslam", printedAt: `${TODAY}T06:30:00.000Z`,
    };
    const api = installApi({ earlierPackets: [cartonPacket("RM_6_42_1", "BLACK"), printed] });
    renderPage();
    await open();

    // No Start Scan: the list is on the program itself. 2 DOZEN is 4 carton labels.
    expect(await within(cartonSection()).findByRole("button", { name: "Print 4 carton QR labels for SK6 / 7/10 / BLACK" })).toBeInTheDocument();
    expect(within(cartonSection()).getByText(/SK6_RED_7\/10_000001 → SK6_RED_7\/10_000004/)).toBeInTheDocument();
    expect(within(cartonSection()).queryByRole("button", { name: /^Print .*RED/ })).not.toBeInTheDocument();

    await userEvent.click(within(cartonSection()).getByRole("button", { name: "Print 4 carton QR labels for SK6 / 7/10 / BLACK" }));
    await waitFor(() => expect(printWindow).toHaveBeenCalledTimes(1));
    expect(printWindow.mock.calls[0][0].ids).toHaveLength(4);
    expect(api.printMachineProgramCartons).toHaveBeenCalledWith(
      { programId: "prog-1", eventIds: ["ev-RM_6_42_1"] },
      { token: "t-1" }
    );

    // Printed, recorded, and gone from the owed list.
    await waitFor(() => expect(within(cartonSection()).queryByRole("button", { name: /Print 4/ })).not.toBeInTheDocument());
    expect(within(cartonSection()).getByText(/SK6_BLACK_7\/10_000001 → SK6_BLACK_7\/10_000004/)).toBeInTheDocument();
  });

  it("reprints a printed run with the SAME codes, and never generates or records anything new", async () => {
    // RED's 4 labels were printed earlier; one has since been voided in QR Management.
    const printed = cartonPacket("RM_6_43_1", "RED");
    printed.label = {
      qrBatchId: "qrb-old", firstQrId: "SK6_RED_7/10_000001", lastQrId: "SK6_RED_7/10_000004",
      cartonCount: 4, receivedInRun: 1, voidedInRun: 0, colour: "BLACK", grade: null, printedBy: "aslam", printedAt: `${TODAY}T06:30:00.000Z`,
    };
    const api = installApi({ earlierPackets: [printed] });
    api.listQrCodesForBatch.mockResolvedValue(
      [1, 2, 3, 4].map((sequence) => ({
        id: `SK6_RED_7/10_00000${sequence}`, batchId: "qrb-old", article: "SK6", color: "RED", size: "7/10",
        sequence, status: sequence === 3 ? "VOID" : "GENERATED",
      }))
    );
    renderPage();
    await userEvent.type(lookupBox(), "MP-000001");
    await userEvent.keyboard("{Enter}");
    await openedProgram();

    await userEvent.click(await within(cartonSection()).findByRole("button", { name: "Reprint the carton QR labels for SK6 / 7/10 / RED" }));

    await waitFor(() => expect(printWindow).toHaveBeenCalledTimes(1));
    expect(api.listQrCodesForBatch).toHaveBeenCalledWith("qrb-old");
    // The same identities, minus the voided one — nothing new is reserved, nothing is recorded.
    expect(printWindow.mock.calls[0][0].ids).toEqual(["SK6_RED_7/10_000001", "SK6_RED_7/10_000002", "SK6_RED_7/10_000004"]);
    expect(api.printMachineProgramCartons).not.toHaveBeenCalled();
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

  it("offers one quantity box per MATERIAL, in its own unit, with no stock shown first", async () => {
    const api = installApi();
    renderPage();
    await open();

    await waitFor(() => expect(api.listMachineProgramDanaOptions).toHaveBeenCalledWith("prog-1", { token: "t-1" }));
    const dana = danaSection();
    // A colour alone would not say which of these left the store.
    expect(within(dana).getByRole("textbox", { name: "Quantity of BLACK · EVA" })).toBeInTheDocument();
    expect(within(dana).getByRole("textbox", { name: "Quantity of BLACK · PVC" })).toBeInTheDocument();
    // EVA has 1 BAG = 25 KG on its ladder, so its unit is chosen; PVC is counted in KG only.
    const evaUnits = within(dana).getByRole("group", { name: "Unit for BLACK · EVA" });
    expect(within(evaUnits).getByRole("button", { name: "KG" })).toHaveAttribute("aria-pressed", "true");
    expect(within(evaUnits).getByRole("button", { name: "BAG" })).toHaveAttribute("aria-pressed", "false");
    expect(within(dana).queryByRole("group", { name: "Unit for BLACK · PVC" })).toBeNull();
    // What has already gone out for this program is shown on each row.
    expect(within(dana).getByText("Issued for this program: 45 KG")).toBeInTheDocument();
    expect(within(dana).getByText("Issued for this program: 0 KG")).toBeInTheDocument();
    // No stock figure, and no bag size to set.
    expect(within(dana).queryByText(/in store|holds/)).toBeNull();
    expect(within(dana).getByRole("button", { name: "Issue Dana" })).toBeDisabled();
  });

  it("issues the quantity typed, in the unit chosen, and only for the Dana asked for", async () => {
    const api = installApi();
    renderPage();
    await open();
    const dana = danaSection();

    await userEvent.type(await within(dana).findByRole("textbox", { name: "Quantity of BLACK · EVA" }), "2");
    await userEvent.click(within(within(dana).getByRole("group", { name: "Unit for BLACK · EVA" })).getByRole("button", { name: "BAG" }));
    await userEvent.type(within(dana).getByRole("textbox", { name: "Quantity of BLACK · PVC" }), "7.5");
    await userEvent.click(within(dana).getByRole("button", { name: "Issue Dana" }));

    await waitFor(() => expect(api.issueMachineProgramDana).toHaveBeenCalledTimes(2));
    expect(api.issueMachineProgramDana).toHaveBeenCalledWith(
      { programId: "prog-1", itemId: "d-eva-black", quantity: 2, unitCode: "BAG" },
      { token: "t-1" }
    );
    expect(api.issueMachineProgramDana).toHaveBeenCalledWith(
      { programId: "prog-1", itemId: "d-pvc-black", quantity: 7.5, unitCode: "KG" },
      { token: "t-1" }
    );
    // And the program is re-read, because its figures are the database's, never the screen's.
    await waitFor(() => expect(api.openMachineProgramStoreOut).toHaveBeenCalledTimes(2));
  });

  it("takes any quantity typed, and says so when the store does not hold that much", async () => {
    const api = installApi();
    api.issueMachineProgramDana.mockResolvedValueOnce({
      accepted: false,
      outcome: "NOT_ENOUGH_STOCK",
      reason: "Only 75 KG is in the store.",
    });
    renderPage();
    await open();
    const dana = danaSection();

    // No ceiling on the box: what was typed is what is asked for.
    const box = await within(dana).findByRole("textbox", { name: "Quantity of BLACK · PVC" });
    await userEvent.type(box, "99");
    expect(box).toHaveValue("99");

    await userEvent.click(within(dana).getByRole("button", { name: "Issue Dana" }));
    // The stock rule is the main process's, and its sentence is what the operator reads.
    expect(await within(dana).findByRole("alert")).toHaveTextContent("Only 75 KG is in the store.");
  });

  it("will not let a labelled Dana be typed out, and says to scan it instead", async () => {
    const api = installApi();
    api.listMachineProgramDanaOptions.mockResolvedValue({
      accepted: true,
      rows: [
        {
          itemId: "d-eva-black", displayName: "DANA — EVA — BLACK", colour: "BLACK", subCategoryName: "EVA",
          units: ["KG"], stockUnitCode: "KG", issuedQuantity: 0,
          blockedReason: "6 labelled packets of this material are in the store. Scan them out on the right instead.",
        },
      ],
    });
    renderPage();
    await open();
    const dana = danaSection();

    expect(await within(dana).findByText(/6 labelled packets/)).toBeInTheDocument();
    expect(within(dana).getByRole("textbox", { name: "Quantity of BLACK · EVA" })).toBeDisabled();
    expect(within(dana).getByRole("button", { name: "Issue Dana" })).toBeDisabled();
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

describe("Machine Move Out — a FIX article's cartons", () => {
  // A fix article is moulded from two soles and has no upper, so nothing is ever issued for it.
  // Its cartons are owed by the PLAN: 32 DOZEN is 64 cartons, ready from the moment it is saved.
  const fixRun = (over: Partial<MachineProgramFixCartonRun> = {}): MachineProgramFixCartonRun => ({
    runId: "run-fix",
    articleSizeId: "as-dc3-710",
    article: "DC3",
    size: "7/10",
    outerSoleColour: "SILVER GREY",
    innerSoleColour: "BLACK",
    quantity: 32,
    unitCode: "DOZEN",
    cartonsPlanned: 64,
    cartonsToPrint: 64,
    cartonNote: null,
    labels: [],
    ...over,
  });

  const open = async () => {
    await userEvent.type(lookupBox(), "MP-000001");
    await userEvent.keyboard("{Enter}");
    await openedProgram();
  };

  it("offers a fix article its whole plan in cartons, with nothing issued", async () => {
    const api = installApi({ fixRuns: [fixRun()] });
    renderPage();
    await open();

    const cartons = cartonSection();
    await waitFor(() => expect(within(cartons).getByText("DC3 / 7/10 / SILVER GREY")).toBeInTheDocument());
    // The banner names the whole job; the label card shows the count big.
    expect(within(cartons).getByText("Print 64 carton QR labels")).toBeInTheDocument();

    await userEvent.click(
      within(cartons).getByRole("button", { name: "Print 64 carton QR labels for DC3 / 7/10 / SILVER GREY" })
    );

    // Labelled against the RUN, never against a packet — there is no packet.
    await waitFor(() =>
      expect(api.printMachineProgramCartons).toHaveBeenCalledWith(
        { programId: "prog-1", runId: "run-fix" },
        expect.anything()
      )
    );
    expect(printWindow).toHaveBeenCalledTimes(1);
    expect(printWindow.mock.calls[0][0].ids).toHaveLength(64);
    // The sticker names BOTH soles: the code carries the outer, the label says the inner too.
    expect(printWindow.mock.calls[0][0].identity?.innerColor).toBe("BLACK");
  });

  it("offers nothing once the whole plan is labelled, and shows what was printed", async () => {
    const api = installApi({
      fixRuns: [
        fixRun({
          cartonsToPrint: 0,
          labels: [
            {
              qrBatchId: "qrb-9",
              firstQrId: "DC3_SILVERGREY_7/10_000001",
              lastQrId: "DC3_SILVERGREY_7/10_000064",
              cartonCount: 64,
              receivedInRun: 10, voidedInRun: 0, colour: "BLACK", grade: null,
              printedBy: "aslam",
              printedAt: "2026-10-12T05:00:00.000Z",
            },
          ],
        }),
      ],
    });
    renderPage();
    await open();

    const cartons = cartonSection();
    await waitFor(() =>
      expect(within(cartons).getByText(/DC3_SILVERGREY_7\/10_000001 → DC3_SILVERGREY_7\/10_000064/)).toBeInTheDocument()
    );
    expect(within(cartons).getByText("10 of 64 back in store")).toBeInTheDocument();
    expect(within(cartons).queryByRole("button", { name: /^Print \d+ carton/ })).toBeNull();
    expect(api.printMachineProgramCartons).not.toHaveBeenCalled();
  });

  /** An EVR FIX program: one fix article, 32 DOZEN, no upper and no injector at all. */
  const fixOnlyProgram = (): MachineProgramRecord => {
    const base = program();
    return {
      ...base,
      totalQuantity: 0,
      consumedQuantity: 0,
      outstandingQuantity: 0,
      fixQuantity: 32,
      productionQuantity: 32,
      runs: [
        {
          ...base.runs[0],
          id: "run-fix", injectorNo: null, soleColour: "SILVER GREY", innerSoleColour: "BLACK", fixQuantity: 32,
          articleSizeId: "as-dc3-710", article: "DC3", size: "7/10", totalQuantity: 0, consumedQuantity: 0, lines: [],
        },
      ],
    };
  };

  it("an EVR FIX program shows no upper sections: no Upper Out, no 'no uppers', no '(Upper)' on the total", async () => {
    installApi({ program: fixOnlyProgram(), fixRuns: [fixRun()] });
    renderPage();
    await open();

    await waitFor(() => expect(within(cartonSection()).getByText("DC3 / 7/10 / SILVER GREY")).toBeInTheDocument());
    expect(screen.queryByRole("region", { name: "Upper Out" })).not.toBeInTheDocument();
    expect(screen.queryByText("No uppers on this program yet")).not.toBeInTheDocument();
    expect(screen.getByText("Total Dozen")).toBeInTheDocument();
    expect(screen.queryByText("Total Dozen (Upper)")).not.toBeInTheDocument();
    // EVR FIX has no injector either, so there is no injector count.
    expect(screen.queryByText("Total Injectors")).not.toBeInTheDocument();
  });

  it("a program with uppers keeps every upper section, even with a fix article beside them", async () => {
    installApi({ fixRuns: [fixRun()] });
    renderPage();
    await open();

    expect(await screen.findByRole("region", { name: "Upper Out" })).toBeInTheDocument();
    expect(screen.getByText("Total Dozen (Upper)")).toBeInTheDocument();
    expect(screen.getByText("Total Injectors")).toBeInTheDocument();
  });

  it("asks for the carton labels to be printed, as a job — not as a line of text", async () => {
    installApi({ program: fixOnlyProgram(), fixRuns: [fixRun()] });
    renderPage();
    await open();

    const cartons = cartonSection();
    // The banner says it is a job, how big, and the three steps of it.
    const banner = await within(cartons).findByRole("status");
    expect(banner).toHaveTextContent("Action needed");
    expect(banner).toHaveTextContent("Print 64 carton QR labels");
    expect(within(banner).getAllByRole("listitem").map((step) => step.textContent)).toEqual([
      "1Print the labels",
      "2Stick one on every carton",
      "3Store In scans it back",
    ]);
    // The label card shows the count big, and its button says exactly how many it prints.
    expect(within(cartons).getByRole("button", { name: /Print 64 carton QR labels/ })).toHaveTextContent("Print 64 labels");
  });

  it("turns the banner green once every label is printed, and says how many cartons are back", async () => {
    installApi({
      program: fixOnlyProgram(),
      fixRuns: [
        fixRun({
          cartonsToPrint: 0,
          labels: [
            {
              qrBatchId: "qrb-9", firstQrId: "DC3_SILVERGREY_7/10_000001", lastQrId: "DC3_SILVERGREY_7/10_000064",
              cartonCount: 64, receivedInRun: 10, voidedInRun: 0, colour: "BLACK", grade: null, printedBy: "aslam", printedAt: "2026-10-12T05:00:00.000Z",
            },
          ],
        }),
      ],
    });
    renderPage();
    await open();

    const banner = await within(cartonSection()).findByRole("status");
    expect(banner).toHaveTextContent("All carton labels printed");
    expect(banner).toHaveTextContent("10 of 64 cartons back in store");
    expect(banner).not.toHaveTextContent("Action needed");
  });

  it("says why a fix article cannot be labelled instead of rounding its cartons", async () => {
    installApi({
      fixRuns: [
        fixRun({
          quantity: 32.25,
          cartonsPlanned: null,
          cartonsToPrint: 0,
          cartonNote: "DC3 7/10 is not planned in whole cartons of DOZEN, so its cartons have to be generated in QR Generator.",
        }),
      ],
    });
    renderPage();
    await open();

    const cartons = cartonSection();
    await waitFor(() => expect(within(cartons).getByRole("alert")).toHaveTextContent("whole cartons of DOZEN"));
    expect(within(cartons).queryByRole("button", { name: /^Print \d+ carton/ })).toBeNull();
  });
});
