import React from "react";
import { CONTRACTOR_PARTY_TYPE, type PartyType } from "@erp/domain";
import type { SearchableComboboxOption } from "../../components/shared/SearchableCombobox";

// How a party's type is drawn beside it in a picker (1 Nov 2026): a supplier in blue with a box, a
// contractor in green with a hard hat. The word is always there too, so colour and picture only
// repeat it (R18). Any other type keeps the plain blue badge and no picture.

/** A box: what a supplier delivers. */
const BoxIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
    <path d="M4 7.5L12 12l8-4.5M12 12v9" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
  </svg>
);

/** A hard hat: a contractor's people. */
const HardHatIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M4 17a8 8 0 0 1 16 0" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    <path d="M10 9.4V6.5h4v2.9M3 17h18v2.5H3z" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
  </svg>
);

type BadgeLook = Pick<SearchableComboboxOption, "badgeTone" | "badgeIcon">;

const LOOKS: Readonly<Partial<Record<PartyType, BadgeLook>>> = {
  SUPPLIER: { badgeTone: "info", badgeIcon: <BoxIcon /> },
  [CONTRACTOR_PARTY_TYPE]: { badgeTone: "ok", badgeIcon: <HardHatIcon /> },
};

/** The badge tone and picture for a party type; the plain look for any other. */
export const partyTypeLook = (partyType: string | undefined): BadgeLook =>
  (partyType ? LOOKS[partyType as PartyType] : undefined) ?? {};
