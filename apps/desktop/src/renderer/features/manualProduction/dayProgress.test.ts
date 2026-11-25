import { describe, expect, it } from "vitest";
import { dayProgress } from "./dayProgress";
import { normalizeDozensText, typedCartons } from "./manualProductionDraft";

const MACHINES = [{ id: "m1", name: "MACHINE 1" }, { id: "m2", name: "MACHINE 2" }, { id: "m3", name: "MACHINE 3" }];

describe("where today stands", () => {
  it("names the machines in and the ones still to come, in the machines' order", () => {
    const progress = dayProgress(MACHINES, [{ machineName: "MACHINE 3", cartons: 40 }, { machineName: "MACHINE 1", cartons: 24 }]);
    expect(progress.done.map((machine) => machine.name)).toEqual(["MACHINE 1", "MACHINE 3"]);
    expect(progress.missing.map((machine) => machine.name)).toEqual(["MACHINE 2"]);
    expect(progress.cartonsByMachine.get("m3")).toBe(40);
  });

  it("does not count a machine whose production was all voided, or one no longer set up", () => {
    const progress = dayProgress(MACHINES, [{ machineName: "MACHINE 2", cartons: 0 }, { machineName: "OLD MACHINE", cartons: 10 }]);
    expect(progress.done).toEqual([]);
    expect(progress.missing).toHaveLength(3);
  });
});

describe("the dozens box reads what people type (Postel's law)", () => {
  it("accepts a unit, a decimal comma and a thousands comma", () => {
    expect(normalizeDozensText(" 5 dz ")).toBe("5");
    expect(normalizeDozensText("5 Dozen")).toBe("5");
    expect(normalizeDozensText("2,5")).toBe("2.5");
    expect(normalizeDozensText("1,200")).toBe("1200");
    expect(typedCartons("2,5")).toBe(typedCartons("2.5"));
    expect(typedCartons("5 dzn")).toBe(typedCartons("5"));
  });

  it("leaves anything else to the domain's own rule", () => {
    expect(normalizeDozensText("abc")).toBe("abc");
    expect(typedCartons("abc")).toBeNull();
    expect(typedCartons("")).toBeNull();
  });
});
