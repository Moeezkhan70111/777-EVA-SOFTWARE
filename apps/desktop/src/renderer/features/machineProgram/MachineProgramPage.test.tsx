import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineProgramPage } from "./MachineProgramPage";
import { NotificationsProvider } from "../../state/NotificationsContext";
import { formatLongDate, shiftIsoDate, toIsoDate } from "../../utils/dates";
import type {
  MachineProgramMaterial,
  MachineProgramRecord,
  MachineRecord,
  MachineShift,
  SaveMachineProgramLineInput,
} from "../../types/desktopApi";

// The program prints as its own A5 sheet through platform/print, so the test reads the HTML
// that was handed to the print window rather than a table of rows.
const sheet = vi.hoisted(() => ({ html: null as string | null }));
vi.mock("../../platform/print", () => ({
  loadLogoDataUrl: () => Promise.resolve(""),
  openPrintDocumentAsync: (html: Promise<string>) => {
    void html.then((content) => {
      sheet.html = content;
    });
    return true;
  },
}));

// The workspace somebody uses who is touching a computer for the first time. What matters here:
// the machine, the shift and the day are the header; the machines, both injectors and what the
// machine comes to are all on one screen; every question inside a dialog is cards, never a
// dropdown; an article added under one sole colour can never save itself under another; the
// uppers offered for an article and size are every colour of it the store holds, said by colour
// and never by supplier; the figures shown are the data layer's; and nothing destructive happens
// without being asked.

const TODAY = toIsoDate();

/** The day shift, which is what a program is made with unless the header says otherwise. */
const DAY_SHIFT: MachineShift = { startMinute: 360, endMinute: 1080 };
const NIGHT_SHIFT: MachineShift = { startMinute: 1080, endMinute: 1800 };

const partyId = (contractor: string | null): string | null => (contractor ? `c-${contractor.slice(-1)}` : null);

/** A machine is worked by two contractors: `packer` defaults to the same party as the runner. */
const machine = (id: string, name: string, contractor: string | null, packer: string | null = contractor): MachineRecord => ({
  id,
  machineCode: `M-00${id.slice(-1)}`,
  name,
  sectionId: "sec-packing",
  sectionName: "PACKING",
  sortOrder: Number(id.slice(-1)),
  status: "ACTIVE",
  contractorPartyId: partyId(contractor),
  contractorName: contractor,
  packingContractorPartyId: partyId(packer),
  packingContractorName: packer,
});

/**
 * One upper as the data layer offers it: a colour of SK6 7/10 with what is free of it. `sources`
 * is still the supplier split the Dana panel reads; the upper picker deliberately ignores it.
 */
const upper = (colour: string, sources: Array<[string, string, number]>): MachineProgramMaterial => ({
  itemId: `u-${colour.toLowerCase()}`,
  itemCode: `RM-${colour}`,
  displayName: `UPPER — RAGZINE UPPER — SK6 — ${colour} — 7/10`,
  categoryPath: "UPPER — RAGZINE UPPER",
  subCategoryName: "RAGZINE UPPER",
  colour,
  type: "SILAI",
  unitCode: "DOZEN",
  packName: "PACKET",
  physical: sources.reduce((sum, [, , qty]) => sum + qty, 0),
  reserved: 0,
  available: sources.reduce((sum, [, , qty]) => sum + qty, 0),
  sources: sources.map(([id, name, qty]) => ({ supplierPartyId: id, supplierName: name, packets: qty / 5, physical: qty, reserved: 0, available: qty })),
  allocatable: true,
  notAllocatableReason: null,
});

/** Every colour of SK6 7/10 the store holds — what choosing that article and size must offer. */
const UPPERS = [
  upper("BLACK", [["s-abc", "ABC UPPER", 50], ["s-xyz", "XYZ UPPER", 30]]),
  upper("GREEN", [["s-abc", "ABC UPPER", 60]]),
  upper("BROWN", [["s-xyz", "XYZ UPPER", 24]]),
];

/**
 * A saved program with the given upper lines on injector 1's first sole.
 *
 * `rates` is the contractor pricing of its one article — machine, packing and printing per
 * dozen, in paisa. Left out, the article is UNPRICED, which is what a program looks like before
 * anybody has priced it.
 */
const programWith = (
  lines: Array<{ colour: string; quantity: number; consumed?: number }>,
  shift: MachineShift = DAY_SHIFT,
  rates?: { machine: number; packing: number; printing: number }
): MachineProgramRecord => {
  const records = lines.map((line, index) => ({
    id: `line-${index + 1}`, runId: "run-1", lineNo: index + 1, itemId: `u-${line.colour.toLowerCase()}`,
    itemDisplayName: `UPPER — SK6 — ${line.colour}`, upperColour: line.colour, upperType: "SILAI", subCategoryName: "RAGZINE UPPER",
    quantity: line.quantity, unitCode: "DOZEN",
    consumed: line.consumed ?? 0, outstanding: line.quantity - (line.consumed ?? 0), availableAtSave: 60,
  }));
  const total = records.reduce((sum, line) => sum + line.quantity, 0);
  const consumed = records.reduce((sum, line) => sum + line.consumed, 0);
  return {
    id: "prog-1", programNumber: 1, code: "MP-000001", machineId: "m-1", machineName: "MACHINE 1", contractorPartyId: "c-A",
    contractorName: "CONTRACTOR A", packingContractorPartyId: "c-B", packingContractorName: "CONTRACTOR B",
    programDate: TODAY,
    shiftStartMinute: shift.startMinute, shiftEndMinute: shift.endMinute,
    status: "PROGRAMMED", displayStatus: consumed > 0 ? "PARTIALLY_USED" : "PROGRAMMED",
    totalQuantity: total, consumedQuantity: consumed, outstandingQuantity: total - consumed, unitCode: "DOZEN", createdBy: "aslam",
    createdAt: `${TODAY}T07:00:00.000Z`, updatedAt: `${TODAY}T07:00:00.000Z`, completedAt: null, cancelledAt: null, cancelledBy: null, cancelReason: null,
    runs: [
      {
        id: "run-1", programId: "prog-1", injectorNo: 1, runNo: 1, soleColour: "BLACK",
        articleSizeId: "as-sk6-710", article: "SK6", size: "7/10", totalQuantity: total, consumedQuantity: consumed, unitCode: "DOZEN", lines: records,
      },
    ],
    articleRates: rates
      ? [
          {
            articleSizeId: "as-sk6-710",
            machineRatePaisa: rates.machine,
            packingRatePaisa: rates.packing,
            printingRatePaisa: rates.printing,
            updatedAt: `${TODAY}T07:30:00.000Z`,
          },
        ]
      : [],
  };
};

function installApi(options: { program?: MachineProgramRecord | null } = {}) {
  const state = { program: options.program ?? null, machines: [machine("m-1", "MACHINE 1", "CONTRACTOR A", "CONTRACTOR B"), machine("m-2", "MACHINE 2", "CONTRACTOR B"), machine("m-3", "MACHINE 3", null)] };
  const api = {
    listMachines: vi.fn(async () => state.machines),
    listMachineProgramBoard: vi.fn(async (date: string) => ({
      accepted: true,
      rows: state.machines.map((m) => ({ machine: m, program: m.id === "m-1" && date === TODAY ? state.program : null })),
    })),
    getMachineProgramForDate: vi.fn(async (_machineId: string, date: string) => ({ accepted: true, program: date === TODAY ? state.program : null })),
    listParties: vi.fn(async () => ({
      rows: [
        { id: "c-A", partyCode: "P-1", partyName: "CONTRACTOR A", partyType: "CONTRACTOR", city: "Lahore", status: "ACTIVE", createdAt: "" },
        { id: "c-B", partyCode: "P-2", partyName: "CONTRACTOR B", partyType: "CONTRACTOR", city: "Kasur", status: "ACTIVE", createdAt: "" },
      ],
      total: 2, page: 1, pageSize: 500,
    })),
    assignMachineContractor: vi.fn(async (input: { machineId: string; contractorPartyId: string }) => {
      state.machines = state.machines.map((m) => (m.id === input.machineId ? { ...m, contractorPartyId: input.contractorPartyId, contractorName: input.contractorPartyId === "c-A" ? "CONTRACTOR A" : "CONTRACTOR B" } : m));
      return { accepted: true, outcome: "ASSIGNED" };
    }),
    listSoleColourOptions: vi.fn(async () => ({
      accepted: true,
      rows: [
        { colour: "BLACK", hasDana: true, danaQuantity: 100, danaUnitCode: "DOZEN" },
        { colour: "RED", hasDana: true, danaQuantity: 25, danaUnitCode: "DOZEN" },
      ],
    })),
    listMachineProgramDana: vi.fn(async () => ({
      accepted: true,
      rows: [{ ...upper("BLACK", [["s-abc", "ABC RUBBER", 75], ["s-xyz", "XYZ MATERIALS", 25]]), subCategoryName: "EVA", packName: "BAG" }],
    })),
    // SK6 7/10 carries the PRODUCT's standard contractor rates (migration 064); SK6 4/6 carries
    // none, so a program defaulting from it must open on empty boxes rather than on zeros.
    listMachineProgramArticles: vi.fn(async () => ({
      accepted: true,
      rows: [
        {
          article: "SK6",
          sizes: [
            { articleSizeId: "as-sk6-46", size: "4/6", machineRatePaisa: null, packingRatePaisa: null, printingRatePaisa: null },
            { articleSizeId: "as-sk6-710", size: "7/10", machineRatePaisa: 4000, packingRatePaisa: 1600, printingRatePaisa: 0 },
          ],
        },
        {
          article: "SK10",
          sizes: [{ articleSizeId: "as-sk10", size: "8/11", machineRatePaisa: null, packingRatePaisa: null, printingRatePaisa: null }],
        },
      ],
    })),
    listMachineProgramUppers: vi.fn(async () => ({ accepted: true, rows: UPPERS })),
    saveMachineProgramLine: vi.fn(async (input: SaveMachineProgramLineInput) => {
      const colour = UPPERS.find((candidate) => candidate.itemId === input.itemId)?.colour ?? "BLACK";
      state.program = programWith([{ colour, quantity: input.quantity }]);
      return { accepted: true, outcome: "SAVED", programId: "prog-1", runId: "run-1", lineId: "line-1" };
    }),
    saveMachineProgramRun: vi.fn(async () => ({ accepted: true, outcome: "SAVED" })),
    // Contractor pricing: the rates land on the program the same way the backend puts them
    // there, so what the screen shows afterwards is read back and never patched.
    saveMachineProgramArticleRates: vi.fn(
      async (input: { machineRate: number; packingRate: number; printingRate: number }) => {
        if (state.program) {
          state.program = {
            ...state.program,
            articleRates: [
              {
                articleSizeId: "as-sk6-710",
                machineRatePaisa: Math.round(input.machineRate * 100),
                packingRatePaisa: Math.round(input.packingRate * 100),
                printingRatePaisa: Math.round(input.printingRate * 100),
                updatedAt: `${TODAY}T08:00:00.000Z`,
              },
            ],
          };
        }
        return { accepted: true, outcome: "SAVED", programId: "prog-1" };
      }
    ),
    removeMachineProgramLine: vi.fn(async () => ({ accepted: true, outcome: "REMOVED" })),
    removeMachineProgramRun: vi.fn(async () => ({ accepted: true, outcome: "REMOVED" })),
    deleteMachineProgram: vi.fn(async () => {
      state.program = null;
      return { accepted: true, outcome: "CANCELLED", releasedQuantity: 30, consumedQuantity: 0 };
    }),
    setMachineProgramShift: vi.fn(async (input: { programId: string; shift: MachineShift }) => {
      if (state.program) state.program = { ...state.program, shiftStartMinute: input.shift.startMinute, shiftEndMinute: input.shift.endMinute };
      return { accepted: true, outcome: "SAVED", programId: input.programId };
    }),
  };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
  return api;
}

const renderPage = () =>
  render(
    <NotificationsProvider>
      <MachineProgramPage username="aslam" />
    </NotificationsProvider>
  );

const click = async (name: string | RegExp) => userEvent.click(await screen.findByRole("button", { name }));

/** The machines down the left. A machine's name is also in the header control, so rail
    queries are scoped to it. */
const rail = async () => screen.findByRole("navigation", { name: "Machines" });

const clickMachine = async (name: RegExp) => {
  const nav = await rail();
  await userEvent.click(within(nav).getByRole("button", { name }));
};

/** The workspace opens on the machines rail; choosing a machine shows both its injectors. */
const openMachine1 = async () => {
  await clickMachine(/MACHINE 1/);
};

/** Open the add dialog of one injector — "Add Sole Color" on an injector with nothing on it. */
const addSoleColour = async (injectorNo: number) => {
  const panel = await screen.findByRole("region", { name: `Injector ${injectorNo}` });
  await userEvent.click(within(panel).getByRole("button", { name: "Add Sole Color" }));
  return screen.findByRole("dialog");
};

/** Article (a searchable dropdown) → size (tiles), the two questions beside the sole colour. */
const describeArticle = async (article = "SK6", size = "7/10") => {
  await userEvent.click(screen.getByRole("combobox", { name: "Article" }));
  await userEvent.click(await screen.findByRole("option", { name: article }));
  await click(size);
};

/** The three contractor rate boxes of the dialog's fourth panel, or the pricing dialog's row. */
const typeRates = async (rates: { machine?: string; packing?: string; printing?: string }) => {
  for (const [job, value] of Object.entries(rates)) {
    const box = screen.getByLabelText(new RegExp(`${job} rate`, "i"));
    await userEvent.clear(box);
    if (value) await userEvent.type(box, value);
  }
};

/** + Add on an upper row of the Upper Stock panel, then how many of it in the selection below. */
const chooseUpper = async (colour: string, quantity: string) => {
  await click(`Add ${colour} upper`);
  await userEvent.type(await screen.findByRole("textbox", { name: new RegExp(`How many ${colour} upper`) }), quantity);
};

afterEach(() => {
  vi.restoreAllMocks();
  sheet.html = null;
});

/** The printed sheet, once the logo has resolved and the HTML has been written. */
const printedSheet = async (): Promise<string> => {
  await waitFor(() => expect(sheet.html).not.toBeNull());
  return sheet.html ?? "";
};

/** The sheet with its tags stripped, for reading what it actually says. */
const sheetText = async (): Promise<string> => (await printedSheet()).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("MachineProgramPage", () => {
  it("lists every machine in the rail with how its day stands, for today, and never a dropdown", async () => {
    installApi();
    const { container } = renderPage();

    const nav = await rail();
    expect(within(nav).getByRole("button", { name: /MACHINE 1/ })).toHaveTextContent("Idle");
    expect(within(nav).getByRole("button", { name: /MACHINE 3/ })).toHaveTextContent("No contractor yet");
    expect(screen.getByRole("button", { name: new RegExp(`Program date.*${formatLongDate(TODAY)}`) })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Shift Time.*06:00 AM/ })).toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByText(/Choose a machine/)).toBeInTheDocument();
    expect(container.querySelector("select")).toBeNull();
  });

  it("picks the machine straight from the strip — there is no machine dropdown to open", async () => {
    installApi();
    renderPage();

    const nav = await rail();
    // Every machine is on screen at once, each saying how its day stands.
    expect(within(nav).getAllByRole("button")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /^Machine —/ })).toBeNull();

    await userEvent.click(within(nav).getByRole("button", { name: /MACHINE 2/ }));
    await waitFor(() => expect(within(nav).getByRole("button", { name: /MACHINE 2/ })).toHaveAttribute("aria-pressed", "true"));
    expect(within(nav).getByRole("button", { name: /MACHINE 1/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("asks for BOTH contractors on a machine that has nobody, saves one assignment each, and opens it", async () => {
    const api = installApi();
    renderPage();

    await clickMachine(/MACHINE 3/);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Who works on MACHINE 3?")).toBeInTheDocument();

    // Neither role is optional — one answer is not enough to leave.
    const runs = within(dialog).getByRole("region", { name: "Machine contractor" });
    const packs = within(dialog).getByRole("region", { name: "Packing contractor" });
    await userEvent.click(await within(runs).findByRole("button", { name: /CONTRACTOR A/ }));
    expect(within(dialog).getByRole("button", { name: "Save contractors" })).toBeDisabled();

    await userEvent.click(within(packs).getByRole("button", { name: /CONTRACTOR B/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save contractors" }));

    // One saved assignment per role, each its own transaction.
    expect(api.assignMachineContractor).toHaveBeenCalledTimes(2);
    expect(api.assignMachineContractor).toHaveBeenNthCalledWith(1, { machineId: "m-3", role: "MACHINE", contractorPartyId: "c-A" });
    expect(api.assignMachineContractor).toHaveBeenNthCalledWith(2, { machineId: "m-3", role: "PACKING", contractorPartyId: "c-B" });

    const nav = await rail();
    await waitFor(() => expect(within(nav).getByRole("button", { name: /MACHINE 3/ })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("tab", { name: /Injector 1/ })).toBeInTheDocument();
  });

  it("a machine with only its machine contractor set is not ready, and asks for the packing one", async () => {
    const api = installApi();
    // MACHINE 2 runs under CONTRACTOR B but nobody packs for it yet.
    const halfAssigned = machine("m-2", "MACHINE 2", "CONTRACTOR B", null);
    api.listMachineProgramBoard.mockResolvedValue({ accepted: true, rows: [{ machine: halfAssigned, program: null }] });
    renderPage();

    const nav = await rail();
    expect(await within(nav).findByRole("button", { name: /MACHINE 2/ })).toHaveTextContent("No contractor yet");

    await clickMachine(/MACHINE 2/);
    const dialog = await screen.findByRole("dialog");
    // The machine contractor it already has is stated, and only the packing one is still open.
    const runs = within(dialog).getByRole("region", { name: "Machine contractor" });
    expect(within(runs).getByText("Now").parentElement).toHaveTextContent("CONTRACTOR B");
    // Half set up is still SETTING UP, not changing — the dialog says so.
    expect(within(dialog).getByText("Who works on MACHINE 2?")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save contractors" })).toBeDisabled();
    // Answering the open one is all it takes.
    const packs = within(dialog).getByRole("region", { name: "Packing contractor" });
    await userEvent.click(await within(packs).findByRole("button", { name: /CONTRACTOR A/ }));
    expect(within(dialog).getByRole("button", { name: "Save contractors" })).toBeEnabled();
  });

  it("changing one contractor from the quick view saves only that role, and says what it will not touch", async () => {
    const api = installApi();
    renderPage();
    await openMachine1();

    // Both are on the quick view, said apart.
    const summary = screen.getByRole("complementary", { name: "Program Summary" });
    expect(within(summary).getByText("Machine contractor").parentElement).toHaveTextContent("CONTRACTOR A");
    expect(within(summary).getByText("Packing contractor").parentElement).toHaveTextContent("CONTRACTOR B");

    await click(/^Change contractors/);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Change contractors?")).toBeInTheDocument();
    expect(within(dialog).getByText(/Programs already made keep the pair/)).toBeInTheDocument();
    expect(api.assignMachineContractor).not.toHaveBeenCalled();

    const packs = within(dialog).getByRole("region", { name: "Packing contractor" });
    await userEvent.click(await within(packs).findByRole("button", { name: /CONTRACTOR A/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Change contractors" }));

    // Only the role that changed is sent — the machine contractor is left exactly as it was.
    expect(api.assignMachineContractor).toHaveBeenCalledTimes(1);
    expect(api.assignMachineContractor).toHaveBeenCalledWith({ machineId: "m-1", role: "PACKING", contractorPartyId: "c-A" });
  });

  it("changes the date from the header with one tap and reads that date's programs", async () => {
    const api = installApi();
    renderPage();
    await click(/^Program date/);
    await click("Tomorrow");

    const tomorrow = shiftIsoDate(TODAY, 1);
    await waitFor(() => expect(api.listMachineProgramBoard).toHaveBeenLastCalledWith(tomorrow));
    expect(screen.getByRole("button", { name: new RegExp(`Program date.*${formatLongDate(tomorrow)}`) })).toBeInTheDocument();
  });

  it("asks sole colour, article, size and the uppers on one screen, and saves exactly that with the shift", async () => {
    const api = installApi();
    const { container } = renderPage();
    await openMachine1();

    const dialog = await addSoleColour(1);
    // The first panel is the sole COLOUR — no sole type is asked for at all.
    expect(within(dialog).getByRole("region", { name: "Sole Color" })).toBeInTheDocument();
    expect(screen.queryByText("What sole are you making?")).toBeNull();
    // Nothing can be chosen from the store until the sole is described.
    expect(within(dialog).getByText(/Choose the article and the size/)).toBeInTheDocument();

    // The Dana a colour can be moulded from is on the colour itself, never a panel of its own.
    const colourPanel = within(dialog).getByRole("region", { name: "Sole Color" });
    expect(within(colourPanel).getByRole("button", { name: /^BLACK/ })).toHaveTextContent("DANA 100 DOZEN");
    expect(within(dialog).queryByText(/Dana for a/)).toBeNull();

    await click(/^BLACK/);
    await describeArticle();

    // Every colour of SK6 7/10 in the store, one row each, named by colour and never by supplier.
    const stock = await screen.findByRole("region", { name: "Upper Stock" });
    expect(within(stock).getAllByRole("row").slice(1).map((row) => row.textContent)).toEqual([
      "BLACK80 DOZENAdd",
      "GREEN60 DOZENAdd",
      "BROWN24 DOZENAdd",
    ]);
    expect(within(stock).queryByText(/ABC UPPER|XYZ UPPER/)).toBeNull();

    // Choosing an upper saves nothing — it joins the selection, where its quantity is typed.
    await chooseUpper("GREEN", "70");
    expect(api.saveMachineProgramLine).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("At most 60 DOZEN");
    expect(screen.getByRole("button", { name: "Add to Program" })).toBeDisabled();

    const amount = screen.getByRole("textbox", { name: /How many GREEN upper/ });
    await userEvent.clear(amount);
    await userEvent.type(amount, "30");
    await click("Add to Program");

    expect(api.saveMachineProgramLine).toHaveBeenCalledWith({
      machineId: "m-1",
      programDate: TODAY,
      shift: DAY_SHIFT,
      injectorNo: 1,
      runId: null,
      run: { soleColour: "BLACK", articleSizeId: "as-sk6-710" },
      itemId: "u-green",
      quantity: 30,
    });

    // The saved upper is now a row of the BLACK sole's table, and the summary names it too.
    const sole = await screen.findByRole("article", { name: "BLACK sole" });
    expect(within(sole).getByText("GREEN")).toBeInTheDocument();
    expect(within(screen.getByRole("complementary", { name: "Program Summary" })).getByText(/SK6 7\/10/)).toHaveTextContent("GREEN");
    expect(screen.getByRole("tab", { name: /Injector 1/ })).toHaveTextContent("Configured");
    expect(container.querySelector("select")).toBeNull();
  });

  it("puts several uppers of one article on the program in one go, all on the same sole run", async () => {
    const api = installApi();
    renderPage();
    await openMachine1();

    await addSoleColour(1);
    await click(/^BLACK/);
    await describeArticle();
    await chooseUpper("GREEN", "30");
    await chooseUpper("BROWN", "12");

    // An upper already in the selection cannot be chosen twice.
    expect(screen.queryByRole("button", { name: "Add GREEN upper" })).toBeNull();

    await click("Add to Program");

    // The first line makes the run; the second joins the id it came back with, never a rival run.
    expect(api.saveMachineProgramLine).toHaveBeenCalledTimes(2);
    expect(api.saveMachineProgramLine).toHaveBeenNthCalledWith(1, expect.objectContaining({
      runId: null,
      run: { soleColour: "BLACK", articleSizeId: "as-sk6-710" },
      itemId: "u-green",
      quantity: 30,
    }));
    expect(api.saveMachineProgramLine).toHaveBeenNthCalledWith(2, expect.objectContaining({
      runId: "run-1",
      run: null,
      itemId: "u-brown",
      quantity: 12,
    }));
  });

  it("adding an article cannot change the sole colour it was opened under, and keeps the selection while the article changes", async () => {
    installApi({ program: programWith([{ colour: "BLACK", quantity: 30 }]) });
    renderPage();
    await openMachine1();

    const sole = await screen.findByRole("article", { name: "BLACK sole" });
    await userEvent.click(within(sole).getByRole("button", { name: "Add Article" }));
    const dialog = await screen.findByRole("dialog");

    // The colour belongs to the card, so it is settled here: it is stated, never offered.
    const colourPanel = within(dialog).getByRole("region", { name: "Sole Color" });
    // Settled, and still carrying the Dana figure the colour list would have shown for it.
    expect(within(colourPanel).getByText("BLACK sole")).toBeInTheDocument();
    expect(await within(colourPanel).findByText("DANA 100 DOZEN")).toBeInTheDocument();
    expect(within(colourPanel).queryByRole("button", { name: /^BLACK/ })).toBeNull();
    expect(within(colourPanel).getByText(/cannot be changed here/)).toBeInTheDocument();

    await describeArticle();
    // BLACK is already on this sole run, so it is named as such rather than offered again.
    const stock = within(dialog).getByRole("region", { name: "Upper Stock" });
    expect(within(stock).getByText("Already on this sole")).toBeInTheDocument();
    await chooseUpper("GREEN", "10");

    // Moving to another article leaves what has already been chosen in the selection.
    await describeArticle("SK10", "8/11");
    expect(screen.getByRole("textbox", { name: /How many GREEN upper/ })).toHaveValue("10");
    expect(within(dialog).getByRole("button", { name: "8/11" })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens a date's existing program, with both injectors, the colour totals and the machine total", async () => {
    installApi({ program: programWith([{ colour: "BLACK", quantity: 30 }, { colour: "GREEN", quantity: 10 }]) });
    renderPage();

    const row = within(await rail()).getByRole("button", { name: /MACHINE 1/ });
    expect(row).toHaveTextContent("Ready");
    await userEvent.click(row);

    const summary = await screen.findByRole("complementary", { name: "Program Summary" });
    expect(within(summary).getByText("BLACK sole")).toBeInTheDocument();
    expect(within(summary).getAllByText("40 DOZEN").length).toBeGreaterThan(0);
    expect(within(summary).getByText("Not configured")).toBeInTheDocument();
    // Both injectors, and again in Quick view.
    expect(within(summary).getAllByText("Total Production")).toHaveLength(3);

    // Both injectors are on screen at once; the empty one says what to do about it.
    expect(screen.getByRole("region", { name: "Injector 1" })).toHaveTextContent("Total (BLACK sole)");
    expect(screen.getByRole("region", { name: "Injector 2" })).toHaveTextContent("No program added yet");

    // Both uppers are rows of the one BLACK sole, said by colour.
    const sole = screen.getByRole("article", { name: "BLACK sole" });
    expect(within(sole).getByText("BLACK")).toBeInTheDocument();
    expect(within(sole).getByText("GREEN")).toBeInTheDocument();
  });

  it("types a new quantity in the row and saves it once, on leaving the box", async () => {
    const api = installApi({ program: programWith([{ colour: "BLACK", quantity: 30 }]) });
    renderPage();
    await openMachine1();

    const box = await screen.findByRole("textbox", { name: /Change BLACK/ });
    await userEvent.clear(box);
    await userEvent.type(box, "25");
    expect(api.saveMachineProgramLine).not.toHaveBeenCalled(); // Not on every keystroke.

    await userEvent.tab();
    await waitFor(() =>
      expect(api.saveMachineProgramLine).toHaveBeenCalledWith({
        machineId: "m-1",
        programDate: TODAY,
        injectorNo: 1,
        runId: "run-1",
        lineId: "line-1",
        itemId: "u-black",
        quantity: 25,
      })
    );
  });

  it("refuses a row quantity above what is free, and never sends it", async () => {
    const api = installApi({ program: programWith([{ colour: "BLACK", quantity: 30 }]) });
    renderPage();
    await openMachine1();

    const box = await screen.findByRole("textbox", { name: /Change BLACK/ });
    await userEvent.clear(box);
    await userEvent.type(box, "500");
    expect(await screen.findByRole("alert")).toHaveTextContent("At most 110 DOZEN");

    await userEvent.tab();
    expect(api.saveMachineProgramLine).not.toHaveBeenCalled();
  });

  it("accepts a row quantity up to the whole figure the Available Stock column shows", async () => {
    // The store holds 80 DOZEN free after every OTHER program and this row already holds 30, so
    // the column reads 110 and 110 is what the box must take — the row's own 30 is free to it.
    const api = installApi({ program: programWith([{ colour: "BLACK", quantity: 30 }]) });
    renderPage();
    await openMachine1();

    const box = await screen.findByRole("textbox", { name: /Change BLACK/ });

    // One past the column's figure is refused, and the sentence names that same figure.
    await userEvent.clear(box);
    await userEvent.type(box, "111");
    expect(await screen.findByRole("alert")).toHaveTextContent("At most 110 DOZEN");

    // The figure itself, and anything under it, goes through.
    await userEvent.clear(box);
    await userEvent.type(box, "100");
    expect(screen.queryByRole("alert")).toBeNull();

    await userEvent.tab();
    await waitFor(() =>
      expect(api.saveMachineProgramLine).toHaveBeenCalledWith(
        expect.objectContaining({ lineId: "line-1", itemId: "u-black", quantity: 100 })
      )
    );
  });

  it("shows the store's stock of the upper, without taking the row's own quantity off it", async () => {
    // The store holds 80 DOZEN free of BLACK after every OTHER program, and this row holds 30.
    // The column must say 110, not 80: the 30 is already shown in the next column, and the
    // operator is being told what there is — not what is left after themselves.
    installApi({ program: programWith([{ colour: "BLACK", quantity: 30 }]) });
    renderPage();
    await openMachine1();

    const sole = await screen.findByRole("article", { name: "BLACK sole" });
    const row = within(sole).getByText("BLACK").closest("tr") as HTMLElement;
    expect(within(row).getByText("110")).toBeInTheDocument();
    expect(within(row).getByRole("textbox", { name: /Change BLACK/ })).toHaveValue("30");
    // And it is exactly the ceiling the quantity box enforces, so the two can never disagree.
    expect(within(row).queryByText("80")).toBeNull();
  });

  it("reads what the store has free again after a save, so a second upper is not measured against a stale figure", async () => {
    // A program RESERVES stock, so adding an upper changes what is free of it. The store has
    // 60 DOZEN of GREEN free beyond every other program; put 10 on this program and the data
    // layer answers 50, exactly as RESERVED_FOR_ITEM_SQL does. The row must then read 60 — the
    // 50 plus its own 10 — and never 70, which is what answering from the figure read BEFORE
    // the save gives: the row's own reservation counted twice.
    const api = installApi({ program: programWith([{ colour: "BLACK", quantity: 30 }]) });
    const greenItemId = "u-green";
    const GREEN_IN_STORE = 60;
    api.listMachineProgramUppers.mockImplementation(async () => {
      const { program } = await api.getMachineProgramForDate("m-1", TODAY);
      const reserved = (program?.runs ?? [])
        .flatMap((run) => run.lines)
        .filter((line) => line.itemId === greenItemId)
        .reduce((sum, line) => sum + line.quantity, 0);
      return {
        accepted: true,
        rows: UPPERS.map((material) =>
          material.itemId === greenItemId ? { ...material, available: GREEN_IN_STORE - reserved } : material
        ),
      };
    });

    renderPage();
    await openMachine1();

    const sole = await screen.findByRole("article", { name: "BLACK sole" });
    await userEvent.click(within(sole).getByRole("button", { name: /Add Article/ }));
    await describeArticle();
    const stock = await screen.findByRole("region", { name: "Upper Stock" });
    // Nothing of GREEN is on the program yet, so the row offers the whole 60.
    expect(within(stock).getByRole("button", { name: "Add GREEN upper" }).closest("tr")).toHaveTextContent("60 DOZEN");
    await chooseUpper("GREEN", "10");
    await click("Add to Program");

    // The GREEN row of the sole's table, found by its own quantity box — "GREEN" is also the
    // upper named in the Program Summary.
    const row = await waitFor(() => {
      const table = screen.getByRole("article", { name: "BLACK sole" });
      return within(table).getByRole("textbox", { name: /Change GREEN/ }).closest("tr") as HTMLElement;
    });
    await waitFor(() => expect(within(row).getByText("60")).toBeInTheDocument());
    expect(within(row).queryByText("70")).toBeNull();

    // And the box enforces that same 60, not the stale 70.
    const box = within(row).getByRole("textbox", { name: /Change GREEN/ });
    await userEvent.clear(box);
    await userEvent.type(box, "61");
    expect(await screen.findByRole("alert")).toHaveTextContent("At most 60 DOZEN");
  });

  it("changes the shift of a saved program, and prints it on the sheet", async () => {
    const api = installApi({ program: programWith([{ colour: "BLACK", quantity: 30 }]) });
    renderPage();
    await openMachine1();

    await click(/^Shift Time/);
    await userEvent.click(await screen.findByRole("option", { name: /^06:00 PM/ }));
    await waitFor(() => expect(api.setMachineProgramShift).toHaveBeenCalledWith({ programId: "prog-1", shift: NIGHT_SHIFT }));

    await waitFor(() => expect(screen.getByRole("button", { name: /^Shift Time/ })).toHaveTextContent("06:00 PM"));
    await click("Print Program");
    expect(await sheetText()).toMatch(/06:00 PM/);
  });

  it("prints an A5 sheet: the meta strip, a band per injector and sole, and a card per article", async () => {
    installApi({ program: programWith([{ colour: "BLACK", quantity: 30 }, { colour: "GREEN", quantity: 10 }]) });
    renderPage();
    await openMachine1();
    await click("Print Program");

    const html = await printedSheet();
    expect(html).toContain("size: A5 landscape");

    const text = await sheetText();
    // 1. What this program IS — seven facts across one strip under the title.
    expect(text).toMatch(/Program # MP-000001/);
    expect(text).toMatch(/Machine MACHINE 1/);
    expect(text).toMatch(/Contractor CONTRACTOR A/);
    expect(text).toMatch(/Packing CONTRACTOR B/);
    expect(text).toMatch(/Shift Time 06:00 AM – 06:00 PM/);
    expect(text).toMatch(/Status Program ready/);

    // 2. What to make — the sole colour is on the BAND, not buried in every row.
    expect(text).toMatch(/Injector 1 Sole Color : BLACK/);
    expect(text).toMatch(/SK6 7\/10/);
    // A row still names both colours the way the floor says it: black sole, green upper.
    expect(text).toMatch(/BLACK BLACK 30/);
    expect(text).toMatch(/BLACK GREEN 10/);
    // A program promises an upper, not a particular supplier's pile of it.
    expect(text).not.toMatch(/ABC UPPER|XYZ UPPER/);

    // 3. What it comes to.
    expect(text).toMatch(/Total Injectors 1/);
    expect(text).toMatch(/Total Dozen 40 DOZEN/);

    // The QR is an action on the document, so it sits in the footer with who prepared it —
    // never in the head among the facts the floor reads.
    expect(text).toMatch(/Prepared by: aslam/);
    expect(text).toMatch(/MP-000001 Scan on Store Out/);
    const body = html.slice(html.indexOf("<body"));
    expect(body.slice(body.indexOf('class="foot"'))).toContain("<svg");
    expect(body.slice(0, body.indexOf('class="foot"'))).not.toContain("foot-scan");
  });

  it("removing an upper asks first, and deleting the program says stock does not change", async () => {
    const api = installApi({ program: programWith([{ colour: "BLACK", quantity: 30, consumed: 10 }]) });
    renderPage();
    await openMachine1();

    await click(/^Remove BLACK . SK6 7\/10$/);
    expect(await screen.findByText("Remove this upper?")).toBeInTheDocument();
    expect(api.removeMachineProgramLine).not.toHaveBeenCalled();
    await click("Cancel");

    await click("Delete program");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Physical Store stock will NOT be changed/)).toBeInTheDocument();
    expect(within(dialog).getByText(/10 DOZEN already left the store/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete program" }));
    expect(api.deleteMachineProgram).toHaveBeenCalledWith({ programId: "prog-1" });
    await waitFor(() => expect(screen.queryByRole("article", { name: "BLACK sole" })).toBeNull());
  });

  it("taking a whole sole colour off asks first and removes each of its runs", async () => {
    const api = installApi({ program: programWith([{ colour: "BLACK", quantity: 30 }]) });
    renderPage();
    await openMachine1();

    await click(/^Remove BLACK sole$/);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Remove this sole colour?")).toBeInTheDocument();
    expect(api.removeMachineProgramRun).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Yes, remove" }));
    expect(api.removeMachineProgramRun).toHaveBeenCalledWith({ runId: "run-1" });
  });
});

describe("+ Add Machine", () => {
  /** Adds the save the field makes. A name is all it sends. */
  const withMachineCreation = (api: ReturnType<typeof installApi>) => {
    const extra = {
      ...api,
      createMachine: vi.fn(
        async (input: { name: string; sectionId?: string }): Promise<{ accepted: boolean; machine?: MachineRecord; reason?: string }> => ({
          accepted: true,
          machine: machine("m-4", input.name.toUpperCase(), null),
        })
      ),
    };
    Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api: extra }, configurable: true });
    return extra;
  };

  const renderWithAdd = () =>
    render(
      <NotificationsProvider>
        <MachineProgramPage username="aslam" canAddMachine />
      </NotificationsProvider>
    );

  /** Presses + Add Machine and types a name into the field it turns into. */
  const typeMachineName = async (name: string) => {
    const nav = await rail();
    await userEvent.click(within(nav).getByRole("button", { name: "+ Add Machine" }));
    const field = within(nav).getByLabelText("Machine name");
    if (name) await userEvent.type(field, name);
    return nav;
  };

  it("is not offered to someone who may not add machines", async () => {
    installApi();
    renderPage();
    await within(await rail()).findByRole("button", { name: /MACHINE 1/ });
    expect(screen.queryByRole("button", { name: "+ Add Machine" })).not.toBeInTheDocument();
  });

  it("adds a machine from just its name, puts it on the strip and asks who works on it", async () => {
    const api = withMachineCreation(installApi());
    renderWithAdd();

    const nav = await typeMachineName("Machine 4");
    // Nothing else is asked: no section, no dialog.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(within(nav).queryByRole("combobox")).not.toBeInTheDocument();
    await userEvent.click(within(nav).getByRole("button", { name: "Add" }));

    expect(api.createMachine).toHaveBeenCalledWith({ name: "Machine 4" });
    await waitFor(() => expect(api.listMachineProgramBoard.mock.calls.length).toBeGreaterThan(1));
    expect(await screen.findByText("Who works on MACHINE 4?")).toBeInTheDocument();
  });

  it("adds on Enter too", async () => {
    const api = withMachineCreation(installApi());
    renderWithAdd();

    await typeMachineName("Machine 5{Enter}");
    expect(api.createMachine).toHaveBeenCalledWith({ name: "Machine 5" });
  });

  it("does not save without a name, and says why", async () => {
    const api = withMachineCreation(installApi());
    renderWithAdd();

    const nav = await typeMachineName("");
    await userEvent.click(within(nav).getByRole("button", { name: "Add" }));

    expect(api.createMachine).not.toHaveBeenCalled();
    expect(within(nav).getByRole("alert")).toHaveTextContent("Type the machine's name.");
  });

  it("keeps the field open and shows the reason when the save is refused", async () => {
    const api = withMachineCreation(installApi());
    api.createMachine.mockResolvedValueOnce({ accepted: false, reason: "Your account does not have Stock access." });
    renderWithAdd();

    const nav = await typeMachineName("Machine 4");
    await userEvent.click(within(nav).getByRole("button", { name: "Add" }));

    expect(await within(nav).findByRole("alert")).toHaveTextContent("Your account does not have Stock access.");
    expect(within(nav).getByLabelText("Machine name")).toHaveValue("Machine 4");
  });

  it("says so when the name belongs to a retired machine, instead of silently doing nothing", async () => {
    const api = withMachineCreation(installApi());
    api.createMachine.mockResolvedValueOnce({ accepted: true, machine: { ...machine("m-9", "MACHINE 9", null), status: "INACTIVE" } });
    renderWithAdd();

    const nav = await typeMachineName("Machine 9");
    await userEvent.click(within(nav).getByRole("button", { name: "Add" }));

    expect(await within(nav).findByRole("alert")).toHaveTextContent("MACHINE 9 already exists but is retired");
  });

  it("Cancel puts the button back without saving", async () => {
    const api = withMachineCreation(installApi());
    renderWithAdd();

    const nav = await typeMachineName("Machine 4");
    await userEvent.click(within(nav).getByRole("button", { name: "Cancel" }));

    expect(api.createMachine).not.toHaveBeenCalled();
    expect(within(nav).getByRole("button", { name: "+ Add Machine" })).toBeInTheDocument();
  });
});

describe("Contractor pricing", () => {
  it("prices the article while it is added, and saves the rates after the uppers are on", async () => {
    const api = installApi();
    renderPage();
    await openMachine1();

    const dialog = await addSoleColour(1);
    // The fourth question of the add screen, beside the three it always asked.
    expect(within(dialog).getByRole("region", { name: "Contractor Pricing" })).toBeInTheDocument();
    // Nothing to price until there is an article to price.
    expect(within(dialog).getByText(/Pick an article above/)).toBeInTheDocument();

    await click(/^BLACK/);
    await describeArticle();
    await chooseUpper("GREEN", "30");
    await typeRates({ machine: "45", packing: "18", printing: "12" });
    await click("Add to Program");

    // The uppers first: an article can only be priced once it is on the program.
    expect(api.saveMachineProgramLine).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(api.saveMachineProgramArticleRates).toHaveBeenCalledWith({
        programId: "prog-1",
        articleSizeId: "as-sk6-710",
        machineRate: 45,
        packingRate: 18,
        printingRate: 12,
      })
    );
  });

  it("leaves an article unpriced when neither the operator nor the product has priced it", async () => {
    const api = installApi();
    renderPage();
    await openMachine1();

    await addSoleColour(1);
    await click(/^BLACK/);
    // SK6 4/6 has no standard rates in Product Master, and nothing is typed here either.
    await describeArticle("SK6", "4/6");
    await chooseUpper("GREEN", "30");
    await click("Add to Program");

    // The uppers go on as always; the article simply stays unpriced rather than priced at zero.
    expect(api.saveMachineProgramLine).toHaveBeenCalledTimes(1);
    expect(api.saveMachineProgramArticleRates).not.toHaveBeenCalled();
  });

  it("refuses a negative rate before anything is sent", async () => {
    const api = installApi();
    renderPage();
    await openMachine1();

    await addSoleColour(1);
    await click(/^BLACK/);
    await describeArticle();
    await chooseUpper("GREEN", "30");
    await typeRates({ machine: "-5" });

    expect(screen.getByRole("alert")).toHaveTextContent(/0 or more/);
    expect(screen.getByRole("button", { name: "Add to Program" })).toBeDisabled();
    expect(api.saveMachineProgramArticleRates).not.toHaveBeenCalled();
  });

  it("shows the rates and what the program comes to at them, from the saved program", async () => {
    // 30 DOZEN of SK6 7/10 at machine 45, packing 18, printing 12 — 75.00 the dozen.
    installApi({ program: programWith([{ colour: "GREEN", quantity: 30 }], DAY_SHIFT, { machine: 4500, packing: 1800, printing: 1200 }) });
    renderPage();
    await openMachine1();

    const pricing = await screen.findByRole("region", { name: "Contractor Pricing" });
    const row = within(pricing).getByRole("row", { name: /SK6 \/ 7\/10/ });
    expect(row).toHaveTextContent("45.00");
    expect(row).toHaveTextContent("18.00");
    expect(row).toHaveTextContent("12.00");
    expect(row).toHaveTextContent("2,250.00");

    // The total is the domain's, not the screen's: 30 × 75.00.
    expect(within(pricing).getByRole("row", { name: /Total at these rates/ })).toHaveTextContent("2,250.00");
    // And it is never called "owed" — that waits for production.
    expect(within(pricing).getByText(/settled when production is recorded/)).toBeInTheDocument();
  });

  it("says an article is not priced instead of showing it as free", async () => {
    installApi({ program: programWith([{ colour: "GREEN", quantity: 30 }]) });
    renderPage();
    await openMachine1();

    const pricing = await screen.findByRole("region", { name: "Contractor Pricing" });
    expect(within(pricing).getByRole("row", { name: /SK6 \/ 7\/10/ })).toHaveTextContent("Not priced");
    expect(within(pricing).getByText(/1 article not priced yet/)).toBeInTheDocument();
    expect(within(pricing).getByRole("button", { name: "Set Pricing" })).toBeInTheDocument();
  });

  it("changes the pricing of an article already on the program, and sends only what changed", async () => {
    const api = installApi({
      program: programWith([{ colour: "GREEN", quantity: 30 }], DAY_SHIFT, { machine: 4500, packing: 1800, printing: 1200 }),
    });
    renderPage();
    await openMachine1();

    await click("Edit Pricing");
    const dialog = await screen.findByRole("dialog");
    // It opens on what the program already pays, not on empty boxes.
    expect(within(dialog).getByLabelText(/machine rate/i)).toHaveValue(45);
    // Nothing changed yet, so there is nothing to save.
    expect(within(dialog).getByRole("button", { name: "Save Pricing" })).toBeDisabled();

    await typeRates({ machine: "50" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save Pricing" }));

    await waitFor(() =>
      expect(api.saveMachineProgramArticleRates).toHaveBeenCalledWith({
        programId: "prog-1",
        articleSizeId: "as-sk6-710",
        machineRate: 50,
        packingRate: 18,
        printingRate: 12,
      })
    );
    expect(api.saveMachineProgramArticleRates).toHaveBeenCalledTimes(1);
  });

  it("prints the pricing on the program sheet", async () => {
    installApi({ program: programWith([{ colour: "GREEN", quantity: 30 }], DAY_SHIFT, { machine: 4500, packing: 1800, printing: 1200 }) });
    renderPage();
    await openMachine1();
    await click("Print Program");

    const text = await sheetText();
    expect(text).toContain("Contractor Pricing");
    expect(text).toContain("Machine");
    expect(text).toContain("45.00");
    expect(text).toContain("2,250.00");
  });
});

describe("Contractor pricing — the product's standard rates", () => {
  it("opens the pricing boxes on what the PRODUCT is normally paid, and saves that onto the program", async () => {
    const api = installApi();
    renderPage();
    await openMachine1();

    await addSoleColour(1);
    await click(/^BLACK/);
    await describeArticle();

    // Not typed by the operator: these are SK6 7/10's standard rates from Product Master.
    expect(screen.getByLabelText(/machine rate/i)).toHaveValue(40);
    expect(screen.getByLabelText(/packing rate/i)).toHaveValue(16);
    expect(screen.getByLabelText(/printing rate/i)).toHaveValue(0);

    await chooseUpper("GREEN", "30");
    await click("Add to Program");

    // The default is only a starting point — what it opened on is what the program now owns.
    await waitFor(() =>
      expect(api.saveMachineProgramArticleRates).toHaveBeenCalledWith({
        programId: "prog-1",
        articleSizeId: "as-sk6-710",
        machineRate: 40,
        packingRate: 16,
        printingRate: 0,
      })
    );
  });

  it("lets the day be priced differently from the product without touching the product", async () => {
    const api = installApi();
    renderPage();
    await openMachine1();

    await addSoleColour(1);
    await click(/^BLACK/);
    await describeArticle();
    await typeRates({ machine: "52" });
    await chooseUpper("GREEN", "30");
    await click("Add to Program");

    // Only the program is written: the typed 52 goes on it, the untouched 16 comes from the
    // product, and nothing on this screen can write back to Product Master.
    await waitFor(() =>
      expect(api.saveMachineProgramArticleRates).toHaveBeenCalledWith(
        expect.objectContaining({ machineRate: 52, packingRate: 16 })
      )
    );
  });

  it("opens on empty boxes for a product nobody has priced", async () => {
    const api = installApi();
    renderPage();
    await openMachine1();

    await addSoleColour(1);
    await click(/^BLACK/);
    // SK6 4/6 has no standard rates.
    await describeArticle("SK6", "4/6");

    expect(screen.getByLabelText(/machine rate/i)).toHaveValue(null);
    expect(screen.getByLabelText(/packing rate/i)).toHaveValue(null);
    expect(api.saveMachineProgramArticleRates).not.toHaveBeenCalled();
  });
});
