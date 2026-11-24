import type { AppRoute } from "../../app/routes";
import { NAV_SECTIONS, type PageTone } from "./navCatalogue";

// WHICH PAGE THIS IS, AT A GLANCE (owner, 15 Nov 2026): "every card page is looking the same ... users have to see the
// heading first to understand what page they are on."
//
// A page opened from a Dashboard card keeps that card's identity: its own colour across the page (theme.css,
// [data-page-tone]). It comes from the card's entry in the navigation catalogue, so the card and its page can never
// disagree. (The card's picture beside the title was removed, owner, 23 Nov 2026.) Every other page has no identity and looks as it
// always has.

export interface PageIdentity {
  readonly tone: PageTone;
}

const IDENTITIES: ReadonlyMap<AppRoute, PageIdentity> = new Map(
  NAV_SECTIONS.flatMap((section) =>
    section.items.flatMap((item) =>
      item.feature?.pageTone ? [[item.route, { tone: item.feature.pageTone }] as const] : []
    )
  )
);

/** The page's colour, or null for a page with no Dashboard card of its own. */
export const pageIdentityOf = (route: AppRoute): PageIdentity | null => IDENTITIES.get(route) ?? null;
