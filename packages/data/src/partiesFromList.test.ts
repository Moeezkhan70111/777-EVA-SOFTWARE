import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

// A PASTED LIST OF PARTIES (owner, 25 Nov 2026): one city, one group, each party made exactly as Add Party makes it
// (its own code, queued to travel to the cloud), and nothing made twice.

function open() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-parties-list-"));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "a.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(1, "test");
  return { db, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const LIST = {
  rows: [
    { partyName: "ABDUL GHANI HYDERABAD", partyNameUrdu: "عبدل غنی حیدرآباد" },
    { partyName: "Kilaash Chappal Hyderabad", partyNameUrdu: "کیلاش چپل حیدرآباد" },
    { partyName: "abdul ghani hyderabad", partyNameUrdu: "" },
  ],
  city: "Hyderabad",
  groupName: "Hyderabad",
  partyType: "CUSTOMER",
};

test("makes each new party with its own code, the city and the group, made when missing", () => {
  const { db, cleanup } = open();
  try {
    const result = db.addPartiesFromList(LIST);
    assert.deepEqual(result.created.map((each) => each.partyName), ["ABDUL GHANI HYDERABAD", "Kilaash Chappal Hyderabad"]);
    assert.deepEqual(result.skipped, ["abdul ghani hyderabad"], "a name twice in the list is made once");
    assert.equal(new Set(result.created.map((each) => each.partyCode)).size, 2);
    const group = db.getPartyGroupByName("Hyderabad");
    assert.ok(group, "the group is made");
    const listed = db.listParties({ groupId: group.id, page: 1, pageSize: 50 });
    assert.equal(listed.total, 2);
    const ghani = db.getParty(db.getPartyByName("ABDUL GHANI HYDERABAD")!.id)!;
    assert.equal(ghani.partyNameUrdu, "عبدل غنی حیدرآباد");
    assert.equal(ghani.city, "Hyderabad");
    assert.equal(ghani.partyType, "CUSTOMER");
    const marked = db.db.prepare("SELECT record_id FROM sync_dirty_records WHERE aggregate_type = 'PARTY'").all() as Array<{ record_id: string }>;
    for (const each of result.created) assert.ok(marked.some((row) => row.record_id === db.getPartyByName(each.partyName)?.id), `${each.partyName} is marked to travel to the cloud, like a party typed by hand`);
  } finally {
    cleanup();
  }
});

test("saving the same list again makes nothing and reuses the group", () => {
  const { db, cleanup } = open();
  try {
    db.addPartiesFromList(LIST);
    const again = db.addPartiesFromList(LIST);
    assert.deepEqual(again.created, []);
    assert.equal(again.skipped.length, 3);
    assert.equal(db.listPartyGroups().filter((group) => group.groupName === "Hyderabad").length, 1);
  } finally {
    cleanup();
  }
});

// Customer Balance filters by group (26 Nov 2026): each balance row says which group its customer is in.
test("each customer's balance row carries its group", () => {
  const { db, cleanup } = open();
  try {
    db.addPartiesFromList(LIST);
    db.createParty({ partyName: "No Group Karachi", partyType: "CUSTOMER", city: "Karachi" });
    const rows = db.listCustomerBalances().rows;
    assert.equal(rows.find((row) => row.partyName === "ABDUL GHANI HYDERABAD")?.groupName, "Hyderabad");
    assert.equal(rows.find((row) => row.partyName === "No Group Karachi")?.groupName, null);
  } finally {
    cleanup();
  }
});
