import { describe, expect, it } from "vitest";
import { matchesSearch } from "../../components/shared/SearchableCombobox";
import type { Party } from "../../types/desktopApi";
import { partyOption } from "./partyOption";

// A party row in every store picker: the name on the big line, the code under it, the type as a
// badge — blue for a supplier, green for a contractor — and still found by its code.

const party = (partyType: string) => ({ id: "p1", partyCode: "PTY-000018", partyName: "Ilyas", partyType, status: "ACTIVE" }) as Party;

describe("partyOption", () => {
  it("puts the name on the big line and the code underneath", () => {
    const option = partyOption(party("SUPPLIER"));
    expect(option.label).toBe("Ilyas");
    expect(option.detail).toBe("PTY-000018");
    expect(option.badge).toBe("Supplier");
  });

  it("gives a supplier the blue badge and a contractor the green one, each with its picture", () => {
    expect(partyOption(party("SUPPLIER"))).toMatchObject({ badgeTone: "info" });
    expect(partyOption(party("CONTRACTOR"))).toMatchObject({ badge: "Contractor", badgeTone: "ok" });
    expect(partyOption(party("CONTRACTOR")).badgeIcon).toBeTruthy();
    expect(partyOption(party("CUSTOMER")).badgeTone).toBeUndefined();
  });

  it("is found by its code and its type", () => {
    const option = partyOption(party("CONTRACTOR"));
    expect(matchesSearch(option, "pty-000018")).toBe(true);
    expect(matchesSearch(option, "contractor ilyas")).toBe(true);
  });
});
