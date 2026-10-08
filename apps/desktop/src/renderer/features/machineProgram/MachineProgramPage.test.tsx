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

const report = vi.hoisted(() => ({ last: null as null | { rows: string[][]; totals?: Array<{ label: string; value: string }> } }));
vi.mock("../../utils/reportDocument", () => ({
  openReport: (document: { rows: string[][]; totals?: Array<{ label: string; value: string }> }) => {
    report.last = document;
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

const machine = (id: string, name: string, contractor: string | null): MachineRecord => ({
  id,
  machineCode: `M-00${id.slice(-1)}`,
  name,
  sectionId: "sec-packing",
  sectionName: "PACKING",
  sortOrder: Number(id.slice(-1)),
  status: "ACTIVE",
  contractorPartyId: contractor ? `c-${contractor.slice(-1)}` : null,
  contractorName: contractor,
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

/** A saved program with the given upper lines on injector 1's first sole. */
const programWith = (
  lines: Array<{ colour: string; quantity: number; consumed?: number }>,
  shift: MachineShift = DAY_SHIFT
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
    contractorName: "CONTRACTOR A", programDate: TODAY,
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
  };
};

function installApi(options: { program?: MachineProgramRecord | null } = {}) {
  const state = { program: options.program ?? null, machines: [machine("m-1", "MACHINE 1", "CONTRACTOR A"), machine("m-2", "MACHINE 2", "CONTRACTOR B"), machine("m-3", "MACHINE 3", null)] };
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
    listMachineProgramArticles: vi.fn(async () => ({
      accepted: true,
      rows: [{ article: "SK6", sizes: [{ articleSizeId: "as-sk6-46", size: "4/6" }, { articleSizeId: "as-sk6-710", size: "7/10" }] }, { article: "SK10", sizes: [{ articleSizeId: "as-sk10", size: "8/11" }] }],
    })),
    listMachineProgramUppers: vi.fn(async () => ({ accepted: true, rows: UPPERS })),
    saveMachineProgramLine: vi.fn(async (input: SaveMachineProgramLineInput) => {
      const colour = UPPERS.find((candidate) => candidate.itemId === input.itemId)?.colour ?? "BLACK";
      state.program = programWith([{ colour, quantity: input.quantity }]);
      return { accepted: true, outcome: "SAVED", programId: "prog-1", runId: "run-1", lineId: "line-1" };
    }),
    saveMachineProgramRun: vi.fn(async () => ({ accepted: true, outcome: "SAVED" })),
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

/** Article → size, the two questions asked after the sole colour. */
const describeArticle = async () => {
  await click("SK6");
  await click("7/10");
};

afterEach(() => {
  vi.restoreAllMocks();
  report.last = null;
});

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

  it("asks who works on a machine that has nobody, saves it once, and opens the machine", async () => {
    const api = installApi();
    renderPage();

    await clickMachine(/MACHINE 3/);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Who works on MACHINE 3?")).toBeInTheDocument();
    await userEvent.click(await within(dialog).findByRole("button", { name: /CONTRACTOR B/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    expect(api.assignMachineContractor).toHaveBeenCalledWith({ machineId: "m-3", contractorPartyId: "c-B" });
    const nav = await rail();
    await waitFor(() => expect(within(nav).getByRole("button", { name: /MACHINE 3/ })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("tab", { name: /Injector 1/ })).toBeInTheDocument();
  });

  it("changing the contractor from the quick view shows the current and the new one and asks first", async () => {
    const api = installApi();
    renderPage();
    await openMachine1();
    await click(/^Change contractor/);
    const picker = await screen.findByRole("dialog");
    await userEvent.click(await within(picker).findByRole("button", { name: /CONTRACTOR B/ }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Change contractor?")).toBeInTheDocument();
    expect(within(dialog).getByText("CONTRACTOR A")).toBeInTheDocument();
    expect(within(dialog).getByText("CONTRACTOR B")).toBeInTheDocument();
    expect(within(dialog).getByText(/Future programs will use the new contractor/)).toBeInTheDocument();
    expect(api.assignMachineContractor).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Change contractor" }));
    expect(api.assignMachineContractor).toHaveBeenCalledWith({ machineId: "m-1", contractorPartyId: "c-B" });
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

  it("walks sole colour → Dana → article → size → upper → quantity, and saves exactly that with the shift", async () => {
    const api = installApi();
    const { container } = renderPage();
    await openMachine1();

    const dialog = await addSoleColour(1);
    // The first question is the sole COLOUR — no sole type is asked for at all.
    expect(within(dialog).getByText("Choose sole colour")).toBeInTheDocument();
    expect(screen.queryByText("What sole are you making?")).toBeNull();
    await click(/^BLACK/);
    expect(await screen.findByText("Dana for a BLACK sole")).toBeInTheDocument();
    expect(screen.getByText("ABC RUBBER")).toBeInTheDocument();
    expect(screen.getByText("XYZ MATERIALS")).toBeInTheDocument();

    await describeArticle();

    // Every colour of SK6 7/10 in the store, one card each, named by colour and never by supplier.
    const cards = await screen.findByText(/Available upper/);
    const picker = cards.closest("section") as HTMLElement;
    expect(within(picker).getAllByRole("button").map((card) => card.textContent)).toEqual([
      "BLACKSK6 7/10 · RAGZINE UPPER · SILAIAvailable80 DOZEN",
      "GREENSK6 7/10 · RAGZINE UPPER · SILAIAvailable60 DOZEN",
      "BROWNSK6 7/10 · RAGZINE UPPER · SILAIAvailable24 DOZEN",
    ]);
    expect(within(picker).queryByText(/ABC UPPER|XYZ UPPER/)).toBeNull();
    await userEvent.click(within(picker).getByRole("button", { name: /GREEN/ }));

    const amount = await screen.findByRole("textbox");
    await userEvent.type(amount, "70");
    expect(screen.getByRole("alert")).toHaveTextContent("At most 60 DOZEN");
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    await userEvent.clear(amount);
    await userEvent.type(amount, "30");
    expect(screen.getByText("Remaining").parentElement).toHaveTextContent("30 DOZEN");
    await click("Add");

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

  it("adding an article cannot change the sole colour it was opened under, and ← Back keeps the article", async () => {
    installApi({ program: programWith([{ colour: "BLACK", quantity: 30 }]) });
    renderPage();
    await openMachine1();

    const sole = await screen.findByRole("article", { name: "BLACK sole" });
    await userEvent.click(within(sole).getByRole("button", { name: "Add Article" }));
    await describeArticle();
    expect(await screen.findByText(/Available upper/)).toBeInTheDocument();

    // The colour belongs to the card, so it is settled here: no Change, and no walking back into it.
    expect(screen.getByText("✓ BLACK")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change Sole colour" })).toBeNull();

    await click("← Back");
    expect(await screen.findByText("Which size?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "7/10" })).toHaveAttribute("aria-pressed", "true");
    await click("← Back");
    expect(screen.getByRole("button", { name: "SK6" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("✓ BLACK")).toBeInTheDocument();

    await click("SK10");
    expect(await screen.findByText("Which size?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "8/11" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("✓ BLACK")).toBeInTheDocument();
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
    const picker = (await screen.findByText(/Available upper/)).closest("section") as HTMLElement;
    // Nothing of GREEN is on the program yet, so the card offers the whole 60.
    expect(within(picker).getByRole("button", { name: /GREEN/ })).toHaveTextContent("60 DOZEN");
    await userEvent.click(within(picker).getByRole("button", { name: /GREEN/ }));
    // Scoped to the dialog's own box: the saved rows behind it each have a quantity box too.
    await userEvent.type(await screen.findByRole("textbox", { name: /How many/i }), "10");
    await click("Add");

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
    expect(report.last?.rows).toHaveLength(1);
  });

  it("prints the saved program, one row per upper colour, with totals and no supplier", async () => {
    installApi({ program: programWith([{ colour: "BLACK", quantity: 30 }, { colour: "GREEN", quantity: 10 }]) });
    renderPage();
    await openMachine1();
    await click("Print Program");

    expect(report.last?.rows).toEqual([
      ["Injector 1", "BLACK", "SK6", "7/10", "BLACK", "RAGZINE UPPER", "30", "DOZEN"],
      ["Injector 1", "BLACK", "SK6", "7/10", "GREEN", "RAGZINE UPPER", "10", "DOZEN"],
    ]);
    expect(report.last?.totals).toEqual([
      { label: "Injector 1", value: "40 DOZEN" },
      { label: "Machine total", value: "40 DOZEN" },
    ]);
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
