import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CLAIM_RATE_PAISA,
  claimDecisionReasonProblem,
  claimRatePaisaProblem,
  claimRequestStatus,
  formatClaimRequestCode,
  formatPartyClaimCode,
} from "./partyClaims.js";

// Claims (docs/55): the store asks, Accounts prices. The rules Accounts' posting, rejection and reversal apply.

test("claim rules: an amount a pair is whole paisa within bounds, and every decision has a reason", () => {
  assert.equal(claimRatePaisaProblem(5_000), null);
  assert.match(claimRatePaisaProblem(0) ?? "", /more than 0/);
  assert.match(claimRatePaisaProblem(12.5) ?? "", /more than 0/);
  assert.match(claimRatePaisaProblem(MAX_CLAIM_RATE_PAISA + 1) ?? "", /too large/);
  assert.equal(claimDecisionReasonProblem("wrong rate"), null);
  assert.match(claimDecisionReasonProblem("   ") ?? "", /Say why/);
  assert.match(claimDecisionReasonProblem(42) ?? "", /Say why/);
  assert.deepEqual(
    [claimRequestStatus({ rejected: false, postedClaims: 0 }), claimRequestStatus({ rejected: false, postedClaims: 1 }), claimRequestStatus({ rejected: true, postedClaims: 0 })],
    ["PENDING", "POSTED", "REJECTED"]
  );
  assert.equal(formatClaimRequestCode(41), "CR-000041");
  assert.equal(formatPartyClaimCode(17), "CL-000017");
});
