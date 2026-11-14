import test from "node:test";
import assert from "node:assert/strict";
import { buildProductionDay, productionDayId, type ProductionDayLine } from "./productionDay.js";

const line = (machineName: string, article: string, size: string, color: string, cartons: number, entries = 1): ProductionDayLine => ({ machineName, article, size, color, cartons, entries });

const DAY = [
  line("MACHINE 2", "SK6", "7/10", "RED", 4), line("MACHINE 1", "SK6", "7/10", "RED", 6, 2),
  line("MACHINE 1", "SK6", "4/6", "BLUE", 3), line("MACHINE 10", "SK12", "7/10", "RED", 5),
];

test("a day is added up per machine, machines in natural order, each as Size x Colour matrices", () => {
  const day = buildProductionDay("2026-11-14", DAY, null);
  assert.deepEqual(day.machines.map((machine) => [machine.machineName, machine.cartons, machine.entries]), [["MACHINE 1", 9, 3], ["MACHINE 2", 4, 1], ["MACHINE 10", 5, 1]]);
  const [sk6] = day.machines[0]?.articles ?? [];
  assert.deepEqual([sk6?.article, sk6?.colours, sk6?.total], ["SK6", ["BLUE", "RED"], 9]);
  assert.deepEqual(sk6?.rows.map((row) => [row.size, row.quantities]), [["7/10", [0, 6]], ["4/6", [3, 0]]]);
});

test("every machine together: one matrix per article, and the day's totals", () => {
  const day = buildProductionDay("2026-11-14", DAY, null);
  assert.deepEqual(day.articles.map((article) => [article.article, article.total]), [["SK6", 13], ["SK12", 5]]);
  assert.deepEqual([day.totalCartons, day.entries, day.completed], [18, 5, null]);
});

test("an empty day is empty, and the mark is carried as given", () => {
  const mark = { date: "2026-11-14", completedAt: "2026-11-14T13:00:00.000Z", completedBy: "aslam", cartons: 0, entries: 0 };
  const day = buildProductionDay("2026-11-14", [], mark);
  assert.deepEqual([day.machines, day.articles, day.totalCartons, day.completed], [[], [], 0, mark]);
  assert.equal(productionDayId("2026-11-14"), "production-day:2026-11-14");
});
