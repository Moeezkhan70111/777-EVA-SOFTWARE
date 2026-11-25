import { describe, expect, it } from "vitest";
import { parsePartiesFromListReply, partiesFromText } from "./partiesFromList";

// The list as the owner sent it on 25 Nov 2026: a table from a chat, with its header and ruling line.
const TABLE = `| English Name               | Urdu Name            |
| -------------------------- | -------------------- |
| ABDUL GHANI HYDERABAD      | عبدل غنی حیدرآباد    |
| M Furqaan Hyderabad        | فرقان حیدرآباد - M   |
| QZ Hyderabad               | حیدرآباد QZ          |
`;

describe("partiesFromText", () => {
  it("reads a pasted table, leaving out its header and ruling line", () => {
    expect(partiesFromText(TABLE)).toEqual([
      { partyName: "ABDUL GHANI HYDERABAD", partyNameUrdu: "عبدل غنی حیدرآباد" },
      { partyName: "M Furqaan Hyderabad", partyNameUrdu: "فرقان حیدرآباد - M" },
      { partyName: "QZ Hyderabad", partyNameUrdu: "حیدرآباد QZ" },
    ]);
  });

  it("reads cells copied from Excel, a name alone, and Urdu written first", () => {
    expect(partiesFromText("DUA CHAPPAL HYDERABAD\tدعا چپل حیدرآباد\r\n\r\nNS Chappal Hyderabad\nلال چپل حیدرآباد\tLAAL CHAPPAL HYDERABAD")).toEqual([
      { partyName: "DUA CHAPPAL HYDERABAD", partyNameUrdu: "دعا چپل حیدرآباد" },
      { partyName: "NS Chappal Hyderabad", partyNameUrdu: "" },
      { partyName: "LAAL CHAPPAL HYDERABAD", partyNameUrdu: "لال چپل حیدرآباد" },
    ]);
  });
});

describe("parsePartiesFromListReply", () => {
  it("takes what was made and what was already on file", () => {
    expect(parsePartiesFromListReply({ accepted: true, created: [{ partyName: "A", partyCode: "PTY-1" }], skipped: ["B"] }))
      .toEqual({ ok: true, created: [{ partyName: "A", partyCode: "PTY-1" }], skipped: ["B"] });
  });

  it("passes on a refusal, and treats a malformed answer as a failure", () => {
    expect(parsePartiesFromListReply({ accepted: false, reason: "Not allowed" })).toEqual({ ok: false, reason: "Not allowed" });
    expect(parsePartiesFromListReply({ accepted: true, created: [{ partyName: "A" }], skipped: [] }).ok).toBe(false);
    expect(parsePartiesFromListReply(null).ok).toBe(false);
  });
});
