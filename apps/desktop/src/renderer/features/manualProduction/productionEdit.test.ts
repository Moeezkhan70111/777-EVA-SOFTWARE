import { describe, expect, it } from "vitest";
import { cellKey, productionGrid } from "./manualProductionDraft";
import { boxCartons, editCells, editChanges, editProblems, parseArticleTodayReply, parseEditReply, savedByCell, startingTyped, type ArticleToday } from "./productionEdit";

// Editing today's production of one article on one machine, before it is saved: the boxes start at today's figures,
// and only what the person changes is sent. Dozens on screen, cartons underneath (1 dozen = 2 cartons).

const CHOICES = [
  { articleSizeId: "sk12-710", article: "SK12", size: "7/10", colors: ["BLACKBLUE", "BLACKRED", "GREEN"] },
  { articleSizeId: "sk12-46", article: "SK12", size: "4/6", colors: ["BLACKBLUE", "BLACKRED"] },
];
const grid = productionGrid(CHOICES, "SK12");

const TODAY: ArticleToday = {
  date: "2026-11-14",
  machineId: "m1",
  machineName: "MACHINE 1",
  article: "SK12",
  cells: [
    { articleSizeId: "sk12-710", size: "7/10", color: "BLACKRED", cartons: 10 },
    { articleSizeId: "sk12-710", size: "7/10", color: "BLACKBLUE", cartons: 2 },
    { articleSizeId: "sk12-46", size: "4/6", color: "BLACKRED", cartons: 20 },
  ],
};

describe("the boxes as the edit opens", () => {
  it("start at today's figures in dozens, empty where nothing was saved", () => {
    expect(startingTyped(TODAY)).toEqual({
      [cellKey("sk12-710", "BLACKRED")]: "5",
      [cellKey("sk12-710", "BLACKBLUE")]: "1",
      [cellKey("sk12-46", "BLACKRED")]: "10",
    });
  });
});

describe("what the person changed", () => {
  const saved = savedByCell(TODAY);

  it("5 edited to 3 is one change, 5 -> 3 dozen", () => {
    const typed = { ...startingTyped(TODAY), [cellKey("sk12-710", "BLACKRED")]: "3" };
    expect(editChanges(grid, saved, typed)).toEqual([{ articleSizeId: "sk12-710", size: "7/10", color: "BLACKRED", fromCartons: 10, toCartons: 6 }]);
  });

  it("a cleared box or a 0 removes the figure; a new box adds one; the rest are not sent", () => {
    const typed = {
      ...startingTyped(TODAY),
      [cellKey("sk12-710", "BLACKBLUE")]: "",
      [cellKey("sk12-46", "BLACKRED")]: "0",
      [cellKey("sk12-710", "GREEN")]: "54",
    };
    const changes = editChanges(grid, saved, typed);
    expect(changes.map((change) => [change.size, change.color, change.fromCartons, change.toCartons])).toEqual([
      ["7/10", "BLACKBLUE", 2, 0],
      ["7/10", "GREEN", 0, 108],
      ["4/6", "BLACKRED", 20, 0],
    ]);
    expect(editCells(changes)).toEqual([
      { articleSizeId: "sk12-710", color: "BLACKBLUE", dozens: "0" },
      { articleSizeId: "sk12-710", color: "GREEN", dozens: "54" },
      { articleSizeId: "sk12-46", color: "BLACKRED", dozens: "0" },
    ]);
  });

  it("nothing changed is no change at all", () => {
    expect(editChanges(grid, saved, startingTyped(TODAY))).toEqual([]);
  });

  it("a box still being typed is left out and says why; 0 and empty are never problems", () => {
    const typed = { [cellKey("sk12-710", "BLACKRED")]: "1.25", [cellKey("sk12-710", "BLACKBLUE")]: "0", [cellKey("sk12-46", "BLACKRED")]: "" };
    expect([...editProblems(typed).keys()]).toEqual([cellKey("sk12-710", "BLACKRED")]);
    expect(boxCartons("1.25")).toBeNull();
    expect(boxCartons("0")).toBe(0);
    expect(boxCartons(" ")).toBe(0);
    expect(boxCartons("2.5")).toBe(5);
    expect(editChanges(grid, saved, typed).some((change) => change.color === "BLACKRED" && change.size === "7/10")).toBe(false);
  });

  it("a box for a colour the size is not made in is never a change", () => {
    const typed = { [cellKey("sk12-46", "GREEN")]: "4" };
    expect(editChanges(grid, saved, { ...startingTyped(TODAY), ...typed })).toEqual([]);
  });
});

describe("the main process's answers, checked", () => {
  it("reads today's figures, and refuses anything malformed", () => {
    expect(parseArticleTodayReply({ accepted: true, article: TODAY }, "failed")).toEqual({ ok: true, value: TODAY });
    expect(parseArticleTodayReply({ accepted: true, article: { ...TODAY, cells: [{ size: 3 }] } }, "failed")).toEqual({ ok: false, reason: "failed" });
    expect(parseArticleTodayReply({ accepted: false, reason: "Your account cannot record production." }, "failed")).toEqual({ ok: false, reason: "Your account cannot record production." });
    expect(parseArticleTodayReply(null, "failed")).toEqual({ ok: false, reason: "failed" });
  });

  it("reads how many figures an edit changed, or why it was refused", () => {
    expect(parseEditReply({ accepted: true, changes: [{}, {}] }, "failed")).toEqual({ ok: true, value: 2 });
    expect(parseEditReply({ accepted: false, reason: "SK12 7/10 BLACKRED: These cartons have already gone out on gatepass GP-000004." }, "failed"))
      .toEqual({ ok: false, reason: "SK12 7/10 BLACKRED: These cartons have already gone out on gatepass GP-000004." });
    expect(parseEditReply({ accepted: true }, "failed")).toEqual({ ok: false, reason: "failed" });
  });
});
