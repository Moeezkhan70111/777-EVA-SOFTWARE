import test from "node:test";
import assert from "node:assert/strict";
import { SYNC_AGGREGATE, isReplicationExcluded } from "@erp/data";
import { APPLY_CONTRACTS } from "./applyEnvelope.js";

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

test("each aggregate type has exactly one contract, and every one is a known type", () => {
  const types = APPLY_CONTRACTS.map((contract) => contract.aggregateType);
  assert.equal(new Set(types).size, types.length, "two contracts claim the same aggregate type");
  const known = new Set<string>(Object.values(SYNC_AGGREGATE));
  for (const type of types) assert.ok(known.has(type), `${type} is not in SYNC_AGGREGATE`);
});
