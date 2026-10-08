# Bugfix Requirements Document

## Introduction

Clicking the Edit button on any party entry in the Party List page does nothing — no navigation occurs, no form opens, and no feedback is given. The root cause is a broken navigation mechanism in `PartyListPage`: the `handleEdit` handler writes to `window.location.hash`, which has no effect in this app's React state-based router. Additionally, the app's root router (`App.tsx`) holds no `selectedPartyId` state and passes no `partyId` prop to `PartyFormPage`, so even if routing were triggered the edit form would open in "create" mode rather than edit mode.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the user clicks the Edit button on a party row in the Party List THEN the system writes to `window.location.hash` and nothing visible happens — no navigation occurs and no form opens

1.2 WHEN the user double-clicks a party row in the Party List THEN the system writes to `window.location.hash` and nothing visible happens — no navigation occurs and no form opens

1.3 WHEN navigation to `party-form` is triggered with a party ID THEN the system renders `PartyFormPage` without a `partyId` prop, causing the form to open in create mode instead of edit mode

### Expected Behavior (Correct)

2.1 WHEN the user clicks the Edit button on a party row THEN the system SHALL navigate to the party edit form with the selected party's data pre-populated

2.2 WHEN the user double-clicks a party row THEN the system SHALL navigate to the party edit form with the selected party's data pre-populated

2.3 WHEN navigation to `party-form` is triggered with a party ID THEN the system SHALL render `PartyFormPage` with the correct `partyId` prop so the form loads in edit mode

### Unchanged Behavior (Regression Prevention)

3.1 WHEN the user clicks "Add New Party" in the Party List THEN the system SHALL CONTINUE TO navigate to the party form in create mode (no partyId)

3.2 WHEN the user submits the party create form THEN the system SHALL CONTINUE TO create a new party and navigate back to the party list

3.3 WHEN the user submits the party edit form THEN the system SHALL CONTINUE TO update the existing party and navigate back to the party list

3.4 WHEN the user navigates between other routes (product-list, sale-voucher-list, etc.) THEN the system SHALL CONTINUE TO pass the correct entity IDs to their respective form pages unchanged
