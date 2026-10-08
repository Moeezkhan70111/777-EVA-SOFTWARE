# Design: Party Edit Button Fix

## Overview

The fix wires up the party edit flow end-to-end across two files, mirroring the existing `selectedProductId` pattern already used for `ProductListPage` → `ProductFormPage`. Six targeted changes are required.

---

## Bug Condition

### isBugCondition (pseudocode)
```
isBugCondition(input) =
  input.route === "party-list"
  AND input.partyId is a non-empty string
  AND user clicks the Edit button for that partyId
```

A concrete counterexample:
- Navigate to Party List — `route = "party-list"`
- Click Edit on any party row — `partyId = "abc-123"` (any valid ID)
- **Observed**: `window.location.hash` is mutated to `#party-form?id=abc-123`; rendered route remains `"party-list"`
- **Expected**: Route changes to `"party-form"`; `PartyFormPage` renders with `partyId = "abc-123"`

### Why the bug is deterministic
Every click of the Edit button goes through `handleEdit`, which always executes `window.location.hash = ...`. The hash mutation never triggers a React state update, so the bug fires for every party row, every time.

---

## Expected Behavior

### expectedBehavior (pseudocode)
```
expectedBehavior(result) =
  result.route === "party-form"
  AND result.selectedPartyId === input.partyId
  AND PartyFormPage receives partyId prop === input.partyId
```

After the fix, for any `partyId` passed to `handleEdit`:
1. `onNavigate("party-form", partyId)` is called
2. `App.tsx` sets `selectedPartyId = partyId` and `route = "party-form"`
3. The `useMemo` in `App.tsx` re-evaluates; `party-form` case renders `<PartyFormPage partyId={selectedPartyId} ... />`
4. `PartyFormPage` uses `partyId` to load the existing party record

### Expected Behavior Properties
- For all `partyId` values: clicking Edit navigates to `party-form` with `partyId` populated
- `PartyFormPage` always has `partyId === selectedPartyId` when the route is `"party-form"` via Edit
- After navigating away from `party-form`, `selectedPartyId` is `undefined`

---

## Preservation Requirements

### Non-bug-condition inputs (¬C(X))
```
¬isBugCondition(input) =
  input.route !== "party-list"
  OR the navigation originates from the "Add New Party" button (no partyId)
  OR the navigation originates from the navbar / keyboard shortcut
```

### Preservation Properties
- **P1** — "Add New Party" button: `onNavigate("party-form")` called with no `id` → `selectedPartyId` stays `undefined` → `PartyFormPage` opens in create mode
- **P2** — Other `onNavigate` callers (CustomerLedger, CustomerBalance): they call `onNavigate(route)` with a single arg; updated prop type `(route: AppRoute, id?: string) => void` remains backward-compatible
- **P3** — `selectedProductId` flow: untouched; `ProductListPage`, `ProductFormPage`, voucher pages unaffected
- **P4** — `useMemo` deps: `selectedPartyId` added to dependency array so re-render occurs when party selection changes

---

## Fix Design — 6 Changes

### File 1: `src/renderer/pages/PartyListPage.tsx`

**Change 1.1 — Update `onNavigate` prop type**
```tsx
// BEFORE
interface PartyListPageProps {
  onNavigate: (route: AppRoute) => void;
}

// AFTER
interface PartyListPageProps {
  onNavigate: (route: AppRoute, id?: string) => void;
}
```
_Rationale_: Allows `handleEdit` to pass `partyId` to the parent. The optional `id?` keeps all existing single-argument callers valid (_Requirements: 3.3_).

**Change 1.2 — Fix `handleEdit`**
```tsx
// BEFORE
const handleEdit = (partyId: string) => {
  window.location.hash = `#party-form?id=${partyId}`;
};

// AFTER
const handleEdit = (partyId: string) => {
  onNavigate("party-form", partyId);
};
```
_Rationale_: Uses the React state-based router instead of hash manipulation (_Requirements: 2.1_).

---

### File 2: `src/renderer/app/App.tsx`

**Change 2.1 — Add `selectedPartyId` state**
```tsx
// ADD alongside selectedProductId
const [selectedPartyId, setSelectedPartyId] = useState<string | undefined>(undefined);
```
_Rationale_: Stores the party ID between the `party-list` navigation event and the `party-form` render (_Requirements: 2.2_).

**Change 2.2 — Update `party-list` case to capture `partyId`**
```tsx
// BEFORE
case "party-list":
  return <PartyListPage onNavigate={setRoute} />;

// AFTER
case "party-list":
  return (
    <PartyListPage
      onNavigate={(r, id?) => {
        setSelectedPartyId(id);
        setRoute(r);
      }}
    />
  );
```
_Rationale_: Captures the optional `id` from the updated `onNavigate` signature and stores it in state (_Requirements: 2.1, 2.2_).

**Change 2.3 — Update `party-form` case to pass `partyId` and clear on navigate away**
```tsx
// BEFORE
case "party-form":
  return <PartyFormPage onNavigate={setRoute} />;

// AFTER
case "party-form":
  return (
    <PartyFormPage
      partyId={selectedPartyId}
      onNavigate={(r) => {
        setSelectedPartyId(undefined);
        setRoute(r);
      }}
    />
  );
```
_Rationale_: Passes `selectedPartyId` to `PartyFormPage` so it loads the correct record. Clears `selectedPartyId` on navigate-away so the next `party-form` visit starts fresh (_Requirements: 2.2, 2.3_).

**Change 2.4 — Add `selectedPartyId` to `useMemo` dependency array**
```tsx
// BEFORE
}, [
  authError, authSuccess, authView, isAddingAccount, members, requestStatus,
  roleOptions, roles, route, selectedProductId, session, sessionToken, workspaceTab,
]);

// AFTER
}, [
  authError, authSuccess, authView, isAddingAccount, members, requestStatus,
  roleOptions, roles, route, selectedPartyId, selectedProductId, session, sessionToken, workspaceTab,
]);
```
_Rationale_: Without this, React will not re-render `content` when `selectedPartyId` changes, meaning `PartyFormPage` would not receive the updated `partyId` prop (_Requirements: 3.5_).

---

## Pattern Alignment

This fix mirrors the existing `selectedProductId` pattern verbatim:

| Concern | Product pattern (existing) | Party pattern (new) |
|---------|---------------------------|---------------------|
| State | `selectedProductId` | `selectedPartyId` |
| List page prop | `onNavigate={(r, id?) => { setSelectedProductId(id); setRoute(r); }}` | `onNavigate={(r, id?) => { setSelectedPartyId(id); setRoute(r); }}` |
| Form page prop | `productId={selectedProductId}` | `partyId={selectedPartyId}` |
| Clear on away | `setSelectedProductId(undefined)` | `setSelectedPartyId(undefined)` |
| useMemo dep | `selectedProductId` | `selectedPartyId` |

`PartyFormPage` already accepts `partyId?: string` — no changes needed there.
