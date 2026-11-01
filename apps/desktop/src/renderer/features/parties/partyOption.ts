import type { SearchableComboboxOption } from "../../components/shared/SearchableCombobox";
import { copy } from "../../config/copy";
import type { Party } from "../../types/desktopApi";
import { partyTypeLook } from "./partyTypeLook";

// A party as one row of a party picker: its name on the big line, its code underneath, and its
// type beside it as a badge, so the type is seen while choosing and not only once chosen. One
// mapping for every store picker (Move In, Move Out, Manual Entry), so they cannot drift apart.

/** The party type in words — "Supplier", "Contractor" — or the stored value for a type with no copy. */
export const partyTypeLabel = (partyType: string): string => copy.parties.typeLabel[partyType] ?? partyType;

export const partyOption = (party: Party): SearchableComboboxOption => {
  const type = party.partyType ? partyTypeLabel(party.partyType) : undefined;
  return {
    value: party.id,
    label: party.partyName,
    detail: party.partyCode,
    badge: type,
    ...partyTypeLook(party.partyType),
    // Typing a code still finds the party, and typing "contractor" finds the contractors.
    keywords: [party.partyCode, type].filter(Boolean).join(" "),
  };
};
