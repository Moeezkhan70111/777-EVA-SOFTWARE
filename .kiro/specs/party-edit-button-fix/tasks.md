# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Edit Button Does Not Navigate
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate clicking Edit does not change the route
  - **Scoped PBT Approach**: Scope the property to the concrete failing case: any party row where `partyId` is a non-empty string
  - From Bug Condition in design: `isBugCondition(input)` where `input.route === "party-list"` AND `input.partyId` is a non-empty string AND user clicks Edit
  - Render `PartyListPage` with a mock `onNavigate` spy; simulate a click on an Edit button; assert `onNavigate` was called with `("party-form", partyId)` — this will FAIL because `handleEdit` calls `window.location.hash = ...` instead
  - Document counterexample found: e.g., "clicking Edit for partyId='abc-123' never called onNavigate; window.location.hash was set to '#party-form?id=abc-123' instead"
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct — it proves the bug exists)
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Non-Edit Navigation Paths Unaffected
  - **IMPORTANT**: Follow observation-first methodology
  - **Non-bug-condition scope**: Covers cases where `isBugCondition` is false — i.e., "Add New Party" button navigation (no id), and single-argument `onNavigate` callers
  - **Observation step** (run on UNFIXED code):
    - Observe: clicking "Add New Party" calls `onNavigate("party-form")` with no second argument — confirmed working
    - Observe: `CustomerLedgerPage` and `CustomerBalancePage` call `onNavigate(route)` with one arg — confirmed working
  - Write property-based test: for all non-edit navigation events from `PartyListPage`, `onNavigate` is called with `(route)` only and `id` is `undefined` — these should pass on unfixed code
  - Write property-based test: updating `onNavigate` prop type to `(route: AppRoute, id?: string) => void` does not break single-argument callers — verify TypeScript compatibility
  - Verify tests PASS on UNFIXED code (confirms baseline behavior to preserve)
  - **EXPECTED OUTCOME**: Tests PASS (confirms baseline behavior)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3_

- [x] 3. Fix: Party edit button navigation end-to-end

  - [x] 3.1 Update `onNavigate` prop type in `PartyListPage.tsx`
    - In `PartyListPageProps`, change `onNavigate: (route: AppRoute) => void` to `onNavigate: (route: AppRoute, id?: string) => void`
    - This makes the optional `id` parameter available to `handleEdit` while remaining backward-compatible with all existing single-argument callers
    - _Bug_Condition: isBugCondition(input) where input.route === "party-list" AND input.partyId is non-empty_
    - _Preservation: optional id? keeps single-argument callers valid (Requirements 3.3)_
    - _Requirements: 2.1, 3.3_

  - [x] 3.2 Fix `handleEdit` in `PartyListPage.tsx`
    - Replace `window.location.hash = \`#party-form?id=${partyId}\`` with `onNavigate("party-form", partyId)`
    - This routes through React state instead of hash mutation
    - _Bug_Condition: isBugCondition(input) — handleEdit fires for any non-empty partyId_
    - _Expected_Behavior: expectedBehavior(result) where result.route === "party-form" AND result.selectedPartyId === partyId_
    - _Requirements: 2.1_

  - [x] 3.3 Add `selectedPartyId` state in `App.tsx`
    - Add `const [selectedPartyId, setSelectedPartyId] = useState<string | undefined>(undefined);` alongside `selectedProductId`
    - _Preservation: mirrors existing selectedProductId pattern; does not affect product/voucher flows (Requirements 3.4)_
    - _Requirements: 2.2_

  - [x] 3.4 Update `party-list` case in `App.tsx` to capture `partyId`
    - Replace `<PartyListPage onNavigate={setRoute} />` with the inline callback form:
      ```tsx
      <PartyListPage
        onNavigate={(r, id?) => {
          setSelectedPartyId(id);
          setRoute(r);
        }}
      />
      ```
    - _Bug_Condition: without this, partyId from onNavigate("party-form", partyId) is discarded_
    - _Expected_Behavior: setSelectedPartyId(id) stores the partyId before route changes_
    - _Preservation: when Add New Party fires onNavigate("party-form") with no id, selectedPartyId becomes undefined — create mode preserved (Requirements 3.1)_
    - _Requirements: 2.1, 2.2, 3.1_

  - [x] 3.5 Update `party-form` case in `App.tsx` to pass `partyId` and clear on navigate away
    - Replace `<PartyFormPage onNavigate={setRoute} />` with:
      ```tsx
      <PartyFormPage
        partyId={selectedPartyId}
        onNavigate={(r) => {
          setSelectedPartyId(undefined);
          setRoute(r);
        }}
      />
      ```
    - _Expected_Behavior: PartyFormPage receives partyId prop and loads existing party data_
    - _Preservation: clearing selectedPartyId on navigate-away ensures next visit opens in create mode (Requirements 3.2)_
    - _Requirements: 2.2, 2.3, 3.2_

  - [x] 3.6 Add `selectedPartyId` to `useMemo` dependency array in `App.tsx`
    - Add `selectedPartyId` to the dependency array of the `content` useMemo
    - _Preservation: without this dep, React skips re-render when selectedPartyId changes, breaking the fix (Requirements 3.5)_
    - _Requirements: 2.2, 3.5_

  - [x] 3.7 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Edit Button Navigates with partyId
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 asserts `onNavigate` is called with `("party-form", partyId)` — this now passes
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - _Requirements: 2.1, 2.2_

  - [x] 3.8 Verify preservation tests still pass
    - **Property 2: Preservation** - Non-Edit Navigation Paths Unaffected
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm "Add New Party", single-argument onNavigate callers, selectedProductId flow all unaffected

- [x] 4. Checkpoint — Ensure all tests pass
  - Run the full test suite for the renderer package
  - Confirm all TypeScript types compile without errors (`tsc --noEmit`)
  - Confirm both exploration test (task 1) and preservation tests (task 2) pass
  - Confirm no regressions in product, voucher, or other navigation flows
  - Ask the user if any questions arise
