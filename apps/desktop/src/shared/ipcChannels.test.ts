// @vitest-environment node
import { describe, expect, it } from "vitest";
import { IPC } from "./ipcChannels";

// Phase 1 retired the Machine Program's planning workflow. Its channels are not registered by
// the main process and not exposed by the preload, so nothing — screen, devtools or a later AI
// feature — can plan a program through them. Phase 1.1 gave the Machine Program its machines back
// (Add Machine, change contractors); a program itself only opens from a QR run.

const RETIRED_PLANNING_CHANNELS = [
  "listMachineProgramBoard",
  "getMachineProgramForDate",
  "listSoleColourOptions",
  "listMachineProgramArticles",
  "listMachineProgramUppers",
  "saveMachineProgramLine",
  "saveMachineProgramRun",
  "saveMachineProgramFixRun",
  "saveMachineProgramArticleRates",
  "removeMachineProgramLine",
  "removeMachineProgramRun",
  "deleteMachineProgram",
  "setMachineProgramShift",
  "setMachineProgramSoleSlot",
];

describe("Machine Program IPC channels", () => {
  it("G: the retired planning workflow has no channel left", () => {
    for (const name of RETIRED_PLANNING_CHANNELS) expect(Object.keys(IPC)).not.toContain(name);
  });

  it("the Machine Program reads, and what Store In/Out still use, are there", () => {
    expect(IPC.listMachineDayPrograms).toBe("erp:list-machine-day-programs");
    expect(IPC.listCartonProgramBatches).toBe("erp:list-carton-program-batches");
    expect(IPC.addMachine).toBe("erp:add-machine");
    expect(IPC.assignMachineContractor).toBe("erp:assign-machine-contractor");
    expect(IPC.listMachineProgramDana).toBeDefined();
    expect(IPC.openMachineProgramStoreOut).toBeDefined();
    expect(IPC.generateQrBatch).toBeDefined();
  });
});
