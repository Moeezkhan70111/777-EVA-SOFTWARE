/**
 * Bug Condition Exploration Tests — Party Edit Button Fix
 *
 * **Validates: Requirements 1.1, 1.2**
 *
 * Property 1 (Bug Condition): For any party row with a non-empty partyId,
 * clicking the Edit button MUST call onNavigate("party-form", partyId).
 *
 * CRITICAL: This test WILL FAIL on unfixed code — that failure proves the bug exists.
 * The bug: handleEdit() calls `window.location.hash = ...` instead of onNavigate().
 * After the fix is applied, this same test will pass, confirming the fix works.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PartyListPage } from "./PartyListPage";
import type { Party } from "../types/desktopApi";

function makeParty(id: string): Party {
  return {
    id,
    partyCode: `CODE-${id}`,
    partyName: `Party ${id}`,
    partyType: "CUSTOMER",
    status: "ACTIVE",
    createdAt: "2024-01-01",
  };
}

function setupDesktop(parties: Party[]) {
  Object.defineProperty(window, "desktop", {
    value: {
      versions: { node: "22", chrome: "128", electron: "43" },
      api: {
        listParties: vi.fn().mockResolvedValue({ rows: parties, total: parties.length }),
      },
    },
    configurable: true,
  });
}

/**
 * Non-empty string partyId generator: covers short ids, long ids, UUIDs,
 * and ids with special characters that are realistic in a database context.
 *
 * Property scope: isBugCondition(input) where
 *   input.route === "party-list"
 *   AND input.partyId is a non-empty string
 *   AND user clicks Edit
 */
function generatePartyIds(): string[] {
  return [
    "abc-123",                              // typical short ID
    "a",                                    // single character
    "party-id-with-dashes",                 // dashes
    "12345",                                // numeric string
    "abc123xyz",                            // alphanumeric
    "ffffffff-ffff-ffff-ffff-ffffffffffff", // UUID-like
    "UPPER_CASE_ID",                        // uppercase
    "id with spaces",                       // spaces (edge case)
    "very-long-party-identifier-string-that-goes-on-and-on-0001", // long id
    "special!@#chars",                      // special characters
  ];
}

describe("Property 1 (Bug Condition): Edit button must call onNavigate — NOT mutate window.location.hash", () => {
  /**
   * For all non-empty partyId values:
   * clicking the Edit button for that party row MUST call onNavigate("party-form", partyId).
   *
   * On UNFIXED code: handleEdit does `window.location.hash = ...` and never calls onNavigate.
   * This test FAILS on unfixed code — that is the expected/desired outcome for exploration.
   *
   * Validates: Requirements 1.1, 1.2
   */
  it.each(generatePartyIds())(
    "clicking Edit for partyId=%s calls onNavigate('party-form', partyId) [BUG CONDITION PROPERTY]",
    async (partyId) => {
      const party = makeParty(partyId);
      setupDesktop([party]);

      const onNavigate = vi.fn();

      render(<PartyListPage onNavigate={onNavigate} />);

      // Wait for the party list to load
      await waitFor(() => expect(screen.getByText(`Party ${partyId}`)).toBeInTheDocument());

      // Simulate clicking the Edit button for this party row
      const editButton = screen.getByRole("button", { name: "Edit" });
      await userEvent.click(editButton);

      // PROPERTY: onNavigate must be called with ("party-form", partyId)
      // FAILS on unfixed code because handleEdit mutates window.location.hash instead
      expect(onNavigate).toHaveBeenCalledWith("party-form", partyId);
      expect(onNavigate).toHaveBeenCalledTimes(1);
    }
  );
});

/**
 * Preservation Property Tests — Party Edit Button Fix
 *
 * **Validates: Requirements 3.1, 3.2, 3.3**
 *
 * Property 2 (Preservation): Non-edit navigation paths from PartyListPage
 * must be unaffected — both before and after the fix.
 *
 * Observation-first methodology:
 *   - "Add New Party" button calls onNavigate("party-form") with NO second argument
 *   - These are verified to PASS on UNFIXED code (baseline behavior)
 *   - After the fix, these same tests continue to pass (no regression)
 */

/**
 * All non-edit AppRoute values that PartyListPage could legitimately navigate to
 * via a single-argument onNavigate call — covers backward compatibility requirement.
 *
 * Scope: ¬isBugCondition, i.e. routes where no partyId should be passed.
 */
function generateNonEditNavigationCases(): Array<{
  label: string;
  action: (
    container: ReturnType<typeof import("@testing-library/react").render>,
  ) => Promise<void>;
  expectedRoute: import("../app/routes").AppRoute;
}> {
  return [
    {
      label: "Add New Party button",
      action: async (result) => {
        const { screen } = await import("@testing-library/react");
        const userEvent = (await import("@testing-library/user-event")).default;
        const btn = screen.getByRole("button", { name: "Add New Party" });
        await userEvent.click(btn);
      },
      expectedRoute: "party-form",
    },
  ];
}

describe("Property 2 (Preservation): Non-edit navigation paths call onNavigate with a single route arg (id is undefined)", () => {
  /**
   * For all non-edit navigation triggers in PartyListPage:
   * onNavigate MUST be called with only the route — the second `id` argument MUST be absent / undefined.
   *
   * This PASSES on UNFIXED code (baseline behavior confirmed).
   * This CONTINUES to pass after the fix (no regression).
   *
   * Validates: Requirements 3.1, 3.3
   */
  it(
    "clicking 'Add New Party' calls onNavigate('party-form') with no id [PRESERVATION PROPERTY]",
    async () => {
      // Setup: one party in the list so the table renders, but the action
      // under test is the "Add New Party" header button — not an Edit button.
      setupDesktop([makeParty("seed-id")]);

      const onNavigate = vi.fn();
      const { screen } = await import("@testing-library/react");
      const userEvent = (await import("@testing-library/user-event")).default;

      render(<PartyListPage onNavigate={onNavigate} />);

      // Wait for list to load
      await waitFor(() =>
        expect(screen.getByText("Party seed-id")).toBeInTheDocument(),
      );

      // Click the "Add New Party" button (no partyId involved)
      const addButton = screen.getByRole("button", { name: "Add New Party" });
      await userEvent.click(addButton);

      // PRESERVATION PROPERTY: onNavigate must receive exactly ("party-form")
      // with NO second argument — the id must be absent/undefined.
      expect(onNavigate).toHaveBeenCalledTimes(1);
      expect(onNavigate).toHaveBeenCalledWith("party-form");

      // Explicitly confirm the call was NOT made with a second defined argument
      const [firstArg, secondArg] = onNavigate.mock.calls[0]!;
      expect(firstArg).toBe("party-form");
      expect(secondArg).toBeUndefined();
    },
  );

  /**
   * For multiple parties rendered simultaneously, clicking "Add New Party"
   * still passes no id regardless of how many Edit buttons are on the page.
   *
   * Validates: Requirements 3.1
   */
  it.each([1, 3, 5])(
    "clicking 'Add New Party' with %i parties in the list still passes no id [PRESERVATION PROPERTY]",
    async (partyCount) => {
      const parties = Array.from({ length: partyCount }, (_, i) =>
        makeParty(`pid-${i}`),
      );
      setupDesktop(parties);

      const onNavigate = vi.fn();
      const { screen } = await import("@testing-library/react");
      const userEvent = (await import("@testing-library/user-event")).default;

      render(<PartyListPage onNavigate={onNavigate} />);

      // Wait for all parties to appear
      await waitFor(() =>
        expect(screen.getByText(`Party pid-0`)).toBeInTheDocument(),
      );

      await userEvent.click(
        screen.getByRole("button", { name: "Add New Party" }),
      );

      expect(onNavigate).toHaveBeenCalledTimes(1);
      expect(onNavigate).toHaveBeenCalledWith("party-form");
      expect(onNavigate.mock.calls[0]![1]).toBeUndefined();
    },
  );

  /**
   * TypeScript compatibility: the onNavigate prop type in PartyListPage accepts
   * a single-argument handler (route: AppRoute) => void.
   *
   * After the fix, the prop type changes to (route: AppRoute, id?: string) => void.
   * A single-argument function remains assignable because `id?` is optional.
   *
   * This test documents the behavioral contract: a handler that only handles `route`
   * works correctly when passed to PartyListPage.
   *
   * Validates: Requirements 3.3
   */
  it(
    "a single-argument onNavigate handler is compatible and receives only the route when 'Add New Party' is clicked [BACKWARD COMPAT PROPERTY]",
    async () => {
      setupDesktop([makeParty("compat-id")]);

      // Intentionally typed as a single-argument function — mirrors CustomerLedgerPage,
      // CustomerBalancePage and other existing callers.
      const capturedRoutes: string[] = [];
      const singleArgHandler = (route: string) => {
        capturedRoutes.push(route);
      };

      const { screen } = await import("@testing-library/react");
      const userEvent = (await import("@testing-library/user-event")).default;

      // Cast to AppRoute-accepting signature to satisfy React prop types
      render(
        <PartyListPage
          onNavigate={singleArgHandler as (route: import("../app/routes").AppRoute) => void}
        />,
      );

      await waitFor(() =>
        expect(screen.getByText("Party compat-id")).toBeInTheDocument(),
      );

      await userEvent.click(
        screen.getByRole("button", { name: "Add New Party" }),
      );

      // The single-arg handler received exactly the route string, nothing more
      expect(capturedRoutes).toHaveLength(1);
      expect(capturedRoutes[0]).toBe("party-form");
    },
  );
});
