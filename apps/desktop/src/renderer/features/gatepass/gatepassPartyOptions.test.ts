import { describe, expect, it } from "vitest";
import type { Party } from "../../types/desktopApi";
import { gatepassPartyOptions } from "./useGatepassData";

// Owner, 24 Nov 2026: the Gatepass offers customers only — not suppliers, contractors, dealers, distributors or
// transporters. The use cases refuse the others too; this is what the party picker lists.

const party = (id: string, partyType: string): Party =>
  ({ id, partyCode: id.toUpperCase(), partyName: `${partyType} ${id}`, partyType, city: "Lahore", status: "ACTIVE", createdAt: "2026-01-01T00:00:00.000Z" }) as Party;

const PARTIES = [
  party("c1", "CUSTOMER"),
  party("s1", "SUPPLIER"),
  party("k1", "CONTRACTOR"),
  party("d1", "DEALER"),
  party("x1", "DISTRIBUTOR"),
  party("t1", "TRANSPORTER"),
  party("c2", "CUSTOMER"),
];

describe("gatepassPartyOptions", () => {
  it("offers customers only, in the order given", () => {
    expect(gatepassPartyOptions(PARTIES).map((p) => p.id)).toEqual(["c1", "c2"]);
  });

  it("keeps the party of a gatepass being edited, even one made for another type before the rule", () => {
    expect(gatepassPartyOptions(PARTIES, "s1").map((p) => p.id)).toEqual(["c1", "s1", "c2"]);
    expect(gatepassPartyOptions(PARTIES, null).map((p) => p.id)).toEqual(["c1", "c2"]);
  });
});
