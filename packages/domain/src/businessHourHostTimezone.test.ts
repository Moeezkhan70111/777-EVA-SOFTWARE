import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// THE WHOLE POINT OF businessHourOf, PROVED THE ONLY WAY IT CAN BE.
//
// The defect it fixes was `new Date(t).getHours()`, which answers in the HOST computer's zone: a
// machine on UTC-7 filed a 19:00Z scan under hour 12 while a machine on UTC+5 filed the same
// instant under hour 0, and once the two computers synced, neither hourly breakdown meant
// anything.
//
// TZ IS READ WHEN THE PROCESS STARTS. Assigning process.env.TZ mid-test does not reliably move
// the clock on Windows, so each zone is checked in a child process started with that TZ -- which
// is also exactly how the bug would reach production: a differently configured Windows machine.
//
// The assertion is deliberately not "equals 0" alone: it is that every zone agrees, so this
// cannot pass by accident on a machine that happens to be in Karachi.

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Compiled beside this file: the suite runs from dist (see package.json "test"). A dynamic
 *  import in a child needs a file:// URL -- a Windows absolute path is rejected as protocol "c:". */
const MODULE_URL = () => pathToFileURL(path.join(HERE, "contractorLedger.js")).href;

/** What one of the module's functions answers for one instant, in a fresh process in the given zone. */
const answerUnderZone = (fn: "businessHourOf" | "businessDateOf", timeZone: string, iso: string): string =>
  execFileSync(
    process.execPath,
    [
      "-e",
      `import(${JSON.stringify(MODULE_URL())}).then((m) => process.stdout.write(String(m.${fn}(${JSON.stringify(iso)}))));`,
    ],
    { env: { ...process.env, TZ: timeZone }, encoding: "utf8" }
  ).trim();

/** The business hour of one instant, as computed by a fresh process in the given zone. */
const hourUnderZone = (timeZone: string, iso: string): string => answerUnderZone("businessHourOf", timeZone, iso);

const ZONES = ["UTC", "America/Los_Angeles", "Asia/Karachi"];

test("the business hour is the same in every host timezone", () => {
  // 19:00:13Z is midnight in Karachi. A UTC-7 host used to answer 12 here.
  const answers = ZONES.map((zone) => [zone, hourUnderZone(zone, "2026-10-19T19:00:13.479Z")] as const);
  for (const [zone, hour] of answers) {
    assert.equal(hour, "0", `${zone} answered ${hour}; the business hour must not depend on the host`);
  }
});

test("the host cannot move the hour either side of Karachi midnight", () => {
  for (const zone of ZONES) {
    assert.equal(hourUnderZone(zone, "2026-10-19T18:59:59.000Z"), "23", `${zone} disagreed at 18:59:59Z`);
    assert.equal(hourUnderZone(zone, "2026-10-19T06:00:00.000Z"), "11", `${zone} disagreed at 06:00:00Z`);
  }
});

test("a host in Los Angeles no longer reproduces the original defect", () => {
  // The exact instant and zone that produced the wrong stored hour on PC2.
  const viaHelper = hourUnderZone("America/Los_Angeles", "2026-10-19T19:00:13.479Z");
  const viaHostClock = execFileSync(
    process.execPath,
    ["-e", `process.stdout.write(String(new Date("2026-10-19T19:00:13.479Z").getHours()));`],
    { env: { ...process.env, TZ: "America/Los_Angeles" }, encoding: "utf8" }
  ).trim();
  assert.equal(viaHelper, "0");
  assert.equal(viaHostClock, "12", "if this is no longer 12, the premise of this test has changed");
  assert.notEqual(viaHelper, viaHostClock);
});

test("the business date -- which dates a return -- is the same in every host timezone, daylight saving or not", () => {
  // Karachi keeps no daylight saving; the hosts may. Each instant is just after Karachi midnight:
  // an ordinary night, the night US clocks went forward, and the night European clocks went forward.
  const nights = [
    { iso: "2026-11-03T19:00:00.000Z", date: "2026-11-04" },
    { iso: "2026-03-08T19:30:00.000Z", date: "2026-03-09" },
    { iso: "2026-03-29T19:30:00.000Z", date: "2026-03-30" },
  ];
  for (const zone of [...ZONES, "Europe/London", "Pacific/Kiritimati"]) {
    for (const { iso, date } of nights) {
      assert.equal(answerUnderZone("businessDateOf", zone, iso), date, `${zone} dated ${iso} differently`);
    }
  }
});
