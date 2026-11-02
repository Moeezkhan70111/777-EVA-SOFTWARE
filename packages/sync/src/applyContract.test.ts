import test from "node:test";
import assert from "node:assert/strict";
import { NUMBER_SITES, SYNC_AGGREGATE, isReplicationExcluded } from "@erp/data";
import { APPLY_CONTRACTS } from "./applyEnvelope.js";
import { LEASED_RECORD_CONTRACTS } from "./leasedRecordContracts.js";

// THE REGISTRY ITSELF, checked without a database.
//
// The applier writes whatever a registered contract tells it to. These are the rules a new
// contract cannot be allowed to break, so they are checked once here for every contract rather
// than remembered by whoever writes the next one.

test("no contract writes a table that must stay per-computer", () => {
  for (const contract of APPLY_CONTRACTS) {
    assert.equal(
      isReplicationExcluded(contract.table),
      false,
      `${contract.aggregateType} writes ${contract.table}, which is on the replication exclusion list`
    );
  }
});

test("a contract that writes a numbered table is one that stamps its sender", () => {
  // THE WALL THE 1 NOV REHEARSAL HIT. The number-range guard counts a row with no origin_device_id
  // as this computer's own (numberRange.ts). A replicated row in a numbered table that lands
  // unstamped makes the receiver refuse any range the sender's numbers do not fit -- and a new PC
  // syncs before it is given a range. The master-record contracts stamp the sender
  // (leasedRecordContracts.ts withSender). Products are the next numbered table to travel
  // (article_sizes.product_code; today only variant identities do, which carry no number): a
  // contract for them must stamp too, and this fails until it does. Checked by each contract's own
  // table; a contract that writes a numbered table as a follow-up must be added here by hand.
  const numbered = new Set<string>(Object.values(NUMBER_SITES).map((site) => site.table));
  const stamping = new Set(LEASED_RECORD_CONTRACTS.map((contract) => contract.aggregateType));
  for (const contract of APPLY_CONTRACTS) {
    if (!numbered.has(contract.table)) continue;
    assert.ok(
      stamping.has(contract.aggregateType),
      `${contract.aggregateType} writes ${contract.table}, a numbered table, without stamping its sender as origin_device_id`
    );
  }
});

test("each aggregate type has exactly one contract, and every one is a known type", () => {
  const types = APPLY_CONTRACTS.map((contract) => contract.aggregateType);
  assert.equal(new Set(types).size, types.length, "two contracts claim the same aggregate type");
  const known = new Set<string>(Object.values(SYNC_AGGREGATE));
  for (const type of types) assert.ok(known.has(type), `${type} is not in SYNC_AGGREGATE`);
});
