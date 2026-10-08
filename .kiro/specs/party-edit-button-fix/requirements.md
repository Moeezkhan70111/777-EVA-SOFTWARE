# Bug Report: Party Edit Button Not Working

## Summary

Clicking the Edit button on a row in the Party Management / Party List page does nothing. The user expects to be taken to the Party Form page pre-populated with that party's data for editing.

## Bug Description

### What happens (defective behavior)
When the user clicks the Edit button on any party row in `PartyListPage`, the page does not navigate to `PartyFormPage`. No visible change occurs — the user remains on the Party List page. Double-clicking a row (which calls the same handler) also fails silently.

### When it happens (trigger conditions)
The bug is triggered whenever:
- The Party List page is displayed (`route === "party-list"`) and
- The user clicks the Edit button for any party row (any non-empty `partyId`)

### What should happen (expected behavior)
Clicking Edit should navigate to the `party-form` route and render `PartyFormPage` pre-populated with the selected party's data, identified by `partyId`.

---

## Root Cause Analysis

Four defects across two files work together to prevent edit navigation:

### Defect 1 — `PartyListPage.tsx`: `handleEdit` uses `window.location.hash` instead of `onNavigate`
```tsx
// BUGGY
const handleEdit = (partyId: string) => {
  window.location.hash = `#party-form?id=${partyId}`;
};
```
The app uses React state-based routing (not hash routing), so mutating `window.location.hash` has no effect on the rendered route.

### Defect 2 — `PartyListPage.tsx`: `onNavigate` prop type does not accept a second `id` argument
```tsx
// BUGGY
interface PartyListPageProps {
  onNavigate: (route: AppRoute) => void;  // no id parameter
}
```
Even if `handleEdit` were corrected, it could not pass `partyId` through to the parent.

### Defect 3 — `App.tsx`: No `selectedPartyId` state
`App.tsx` manages edit context with `selectedProductId` for products, vouchers, etc., but has no equivalent `selectedPartyId` state for the party flow.

### Defect 4 — `App.tsx`: `PartyFormPage` rendered without `partyId` prop
```tsx
// BUGGY
case "party-form":
  return <PartyFormPage onNavigate={setRoute} />;
```
`PartyFormPage` already accepts an optional `partyId?: string` prop but never receives it, so it always opens in "create new" mode.

---

## Requirements

### 1. Bug Condition

**1.1** The bug occurs when all of the following are true:
- The current route is `"party-list"`
- The user clicks the Edit button for a party row with a valid `partyId`

**1.2** In the buggy state, clicking Edit does not change the rendered route (the user stays on the Party List page).

### 2. Expected Behavior After Fix

**2.1** When the user clicks Edit for a party with `partyId`, the app navigates to `"party-form"` and renders `PartyFormPage` with `partyId` set to the selected party's ID.

**2.2** `PartyFormPage` must receive `partyId` so it can load and pre-populate the party's existing data.

**2.3** When the user subsequently navigates away from `party-form` (e.g., Save or Cancel), `selectedPartyId` is cleared so the next visit to `party-form` does not re-open a stale party.

### 3. Preservation Requirements

**3.1** The "Add New Party" button in `PartyListPage` must continue to navigate to `"party-form"` without any `partyId`, opening `PartyFormPage` in create mode.

**3.2** Navigating to `"party-form"` via the navbar or keyboard shortcut (if applicable) must continue to open `PartyFormPage` in create mode (no `partyId`).

**3.3** All other routes that use `onNavigate` with a single argument (e.g., `CustomerLedgerPage`, `CustomerBalancePage`) must be unaffected by changes to `PartyListPage`'s prop type.

**3.4** The `selectedProductId` state and the product/voucher navigation flows in `App.tsx` must be unaffected.

**3.5** The `useMemo` dependency array in `App.tsx` must remain correct after adding `selectedPartyId`.
