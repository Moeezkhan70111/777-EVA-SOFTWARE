# 777 ERP — Claude Development Rules

## 1. Software Purpose

This is the ERP system for **777**, a company operating a slippers manufacturing and distribution business.

The software is not a generic demo application. It is a real business system and must prioritize:

* Data correctness
* Inventory accuracy
* Scan-based traceability
* Financial/accounting correctness
* Reliability
* Maintainability
* Simple and consistent UI
* Prevention of duplicate or invalid transactions

The system includes, but is not limited to:

* Inventory management
* Product management
* Store / warehouse management
* QR/barcode scanning
* Production through scanning
* Dispatch through scanning
* Returns through scanning
* Stock tracking
* Sales and billing
* Customer/party management
* Customer ledgers
* Cash and financial vouchers
* Accounts and finance
* Reporting
* User authentication
* User roles and permissions
* Synchronization / cloud functionality
* Other functionality expected from an ERP system

### Core Business Principle

**Everything that physically comes into or goes out of the company's system should be traceable through the appropriate scanning/transaction mechanism whenever the business process requires it.**

QR/scanning-related business logic must therefore be treated as core ERP functionality, not as a secondary UI feature.

---

# 2. Existing Codebase — IMPORTANT

A large amount of code already exists.

**Do NOT assume the application should be rebuilt from scratch.**

When implementing a new requirement:

1. Inspect the existing implementation first.
2. Identify the existing components, services, domain logic, database structures, APIs, and workflows involved.
3. Reuse existing functionality wherever possible.
4. Modify existing code when it already performs the required job.
5. Refactor only what is necessary to satisfy the requirement or improve maintainability.
6. Preserve existing working business logic unless the requirement explicitly changes it.
7. Do not replace an existing implementation simply because you personally prefer another architecture.

### Never use a new implementation to bypass an existing implementation.

If the existing system already has:

* a product service,
* stock calculation,
* QR validation,
* dispatch logic,
* a reusable UI component,
* an API client,
* a database repository,

then use or improve that implementation instead of creating a second competing implementation.

---

# 3. R1 — Do Not Copy-Paste UI

## Rule

If the same UI pattern is used more than once, create a reusable component.

For example, if a Job Card appears on six pages, do NOT create six independent implementations.

Create one reusable component:

```text
JobCard.tsx
```

and reuse it.

### Apply this to:

* Cards
* Tables
* Buttons
* Inputs
* Selects
* Dialogs
* Modals
* Form sections
* Product displays
* Product cards
* Scanner states
* Success/error states
* Empty states
* Loading states
* Pagination
* Filters
* Search controls
* Status badges
* Bill rows
* Ledger rows
* Confirmation dialogs
* Other repeated UI patterns

### Before creating a new component

Check whether an appropriate component already exists.

If it exists:

**Reuse it.**

If it almost fits:

**Improve or generalize it carefully.**

Only create a new component when the existing component is genuinely unsuitable.

### Goal

There should be **one source of truth** for repeated UI behavior and appearance.

If a shared component needs to change later, changing it in one place should update all relevant usages.

---

# 4. R2 — Keep Code Simple

Write code that is easy to understand and maintain.

Do not use clever or unnecessarily abstract code simply to reduce the number of lines.

### General guidelines

* Functions should generally be under approximately **40 lines**.
* Components should generally be under approximately **200 lines**.
* Avoid more than **3 levels of nesting**.
* Avoid complicated chains of ternary operators.
* Prefer clear variable and function names.
* Prefer straightforward control flow.
* Prefer small focused functions.
* Keep business logic separate from presentation logic.
* Avoid unnecessary abstractions.
* Avoid premature optimization.
* Avoid unnecessary design patterns.

These are guidelines, not excuses to split every trivial statement into another file.

### Prefer

```text
clear
explicit
small
testable
readable
```

over:

```text
clever
compressed
highly abstract
difficult to trace
```

### Junior Developer Test

A junior developer should be able to open a file and understand its purpose and main logic without having to reverse-engineer an unnecessarily complicated abstraction system.

---

# 5. R3 — Centralize Design Values

Do not scatter design values throughout the application.

Design values must have a central source of truth.

This includes:

* Colors
* Typography
* Spacing
* Border radius
* Shadows
* Component sizing
* Other design tokens

### Bad

Do not randomly introduce values such as:

```text
bg-blue-500
text-red-600
#0f172a
```

throughout unrelated components when those values represent established application design.

### Prefer

Use centralized semantic design tokens such as:

```text
bg-primary
text-foreground
border-border
bg-background
text-muted-foreground
```

or the equivalent token system already established in the project.

### Important

Before introducing a new color, spacing value, radius, shadow, or similar design value:

1. Check the existing design system.
2. Reuse an existing token if appropriate.
3. Add a new token centrally only when genuinely necessary.
4. Use the token throughout the application.

Do not create one-off styling values for individual pages without a valid reason.

### Goal

Changing the company's visual design later should require changing centralized design tokens rather than searching through hundreds of components.

---

# 6. R4 — Centralize API Endpoints

Do not scatter API URLs throughout the application.

API endpoints must have a centralized source of truth.

Preferred structure:

```text
src/services/api/endpoints.ts
```

Example:

```ts
ENDPOINTS.jobs.detail(id)
```

instead of:

```ts
/jobs/123
```

being manually constructed throughout different files.

### Rules

* Check the existing API service structure before adding an endpoint.
* Add new endpoint definitions to the centralized endpoint location.
* Reuse endpoint definitions.
* Do not duplicate URL strings across components.
* Do not construct API URLs directly inside UI components unless the existing architecture explicitly requires it.
* Keep URL construction separate from presentation code.

### Goal

If an API route changes, there should be one obvious place to update it.

---

# 7. Refactoring Existing Code

When existing code violates these rules, gradually bring it into compliance.

Do not perform unnecessary large-scale rewrites.

For each task:

```text
Inspect
→ Identify existing implementation
→ Reuse where possible
→ Refactor only where needed
→ Implement requirement
→ Test affected functionality
→ Verify no unrelated behavior was broken
```

### Do not:

* Rewrite the entire application for a small feature.
* Replace working architecture without justification.
* Duplicate existing services.
* Duplicate existing components.
* Introduce a second design system.
* Introduce a second API layer for the same backend.
* Move large amounts of code unnecessarily.
* Delete working functionality simply to simplify an implementation.

---

# 8. Business Logic Has Priority Over UI Convenience

777 ERP is a business system.

Never change business logic merely to make the UI easier to implement.

For example:

```text
Stock
QR identity
Production
Dispatch
Returns
Billing
Ledger
Payments
```

must remain consistent with the actual business rules.

UI components should call the appropriate business/application layer rather than independently calculating critical business state.

### Never duplicate critical business calculations in multiple UI components.

If a calculation is business-critical, centralize it.

Examples:

* Stock quantity
* Available stock
* Bill totals
* Discounts
* Ledger balances
* Payment balances
* QR status
* Production status
* Dispatch status

---

# 9. Data Integrity

Never sacrifice data correctness for convenience.

For operations involving inventory, QR codes, production, dispatch, returns, billing, or financial records:

* Validate inputs.
* Prevent duplicate transactions.
* Preserve transaction history.
* Respect existing identifiers.
* Do not silently overwrite historical data.
* Do not silently delete business records.
* Use the appropriate transaction/boundary mechanism.
* Ensure related state changes remain consistent.

If a requirement is ambiguous and changing the wrong behavior could corrupt business data:

**Stop and inspect the existing business logic before making the change.**

---

# 10. Change Discipline

Every task should remain scoped to the requested change.

Before editing:

### Inspect

Determine:

* Where the functionality currently lives.
* Which components use it.
* Which services use it.
* Which database tables/models are involved.
* Which APIs are involved.
* Which existing tests/build checks apply.

### Implement

Make the smallest clean change that satisfies the requirement.

### Verify

After implementation:

* Check TypeScript/build errors.
* Check affected functionality.
* Check related business logic.
* Check that existing functionality still works.
* Check for accidental duplicated code.
* Check that new design values/API URLs were not unnecessarily hardcoded.

### Report

At the end, clearly state:

* What was changed.
* Which files were changed.
* Any important refactoring performed.
* What was tested.
* Any remaining issue or limitation.

Do not claim something was tested if it was not actually tested.

# 5. R5 — Backend Flow / Offline-First Architecture

The ERP must be designed **offline-first**.

The local application must remain fully usable even when the server/cloud is unavailable.

The intended architecture is:

```text
UI
 ↓
RTK Query
 ↓
API Layer
 ↓
Mock API / Local API
 ↓
Local Database
 ↓
Cloud Sync (when available)
```

The exact implementation may evolve, but the architectural principle must remain:

> **The UI must never depend directly on fake data or directly on a future cloud implementation.**

### Current State

The real backend/cloud connection is not being implemented yet.

However, the application must be architected so that adding the real backend later does **not** require rewriting every screen.

The mock/local implementation is a temporary backend implementation behind the same API boundary.

Conceptually:

```text
USE_MOCKS = true
```

uses the mock/local implementation.

Later:

```text
USE_MOCKS = false
```

can switch the API implementation toward the real backend/cloud.

The UI should continue using the same RTK Query endpoints and application-facing API contracts.

### Never do this

```text
UI
 ↓
Directly import fake data
```

For example, do not do:

```ts
import { products } from "../mockData";
```

inside a page simply because the real backend does not exist yet.

### Do this

```text
UI
 ↓
RTK Query
 ↓
API Layer
 ↓
Mock / Local Implementation
```

This creates a clean seam for the future backend.

### Offline requirement

The ERP must not stop functioning merely because:

* Internet is unavailable.
* The cloud server is unavailable.
* Synchronization is temporarily unavailable.
* The application starts while offline.

Local business operations must continue according to their business rules.

Cloud synchronization should be treated as a synchronization mechanism, **not as the sole source of application availability**.

### Important

Do not implement temporary mock behavior in a way that creates a second architecture.

The mock implementation must follow the same:

* API contracts
* Data shapes
* Validation rules
* Business rules
* Error behavior
* Loading behavior

that the real implementation will use.

---

# 6. R6 — Use Redux Toolkit Correctly

There are three categories of state.

## Server / persistent data

Data originating from the application's data layer/backend:

```text
Products
Product variants
Stock
Production records
QR records
Dispatch records
Parties
Sales
Vouchers
Ledgers
Users
Reports
```

Use:

```text
RTK Query
```

for server/data fetching, caching, invalidation, and synchronization.

Do not manually duplicate server state in unrelated Redux slices or component state without a specific reason.

---

## Shared application state

State that is genuinely shared across multiple parts of the application:

```text
Authenticated user/session state
Application-wide preferences
Shared workflow state
Global UI state
```

Use:

```text
Redux slices
```

when the state genuinely needs application-wide access.

---

## Local component state

Temporary state belonging to one component:

```text
Is filter open?
Selected tab
Temporary input state
Modal open/closed
Local UI interaction
```

Use:

```text
useState
```

when appropriate.

### Simple rule

```text
Server / persistent data → RTK Query

Shared application state → Redux

One-component UI state → useState
```

Do not put everything into Redux.

Do not put everything into local component state.

Use the simplest state mechanism appropriate for the data.

---

# 7. R7 — Design for Mobile Application Compatibility

The ERP web application will also be used inside an Android/iOS application.

Developers must therefore not assume that the application always runs as a conventional desktop browser.

### Avoid platform-specific browser assumptions

Do not casually use:

```ts
window.open()
```

or:

```html
target="_blank"
```

when the intended behavior should work through the application's native environment.

Use the project's approved native bridge/platform abstraction where one exists.

### Important

Mobile-specific UI does **not** need to be fully implemented now.

The current priority is:

> **Keep the architecture mobile-compatible so mobile implementation can be added later without rewriting the application.**

Avoid APIs and patterns that unnecessarily lock the application to desktop browser behavior.

---

# 8. R9 — Security From the Beginning

Security is a development requirement, not a launch-stage task.

Do not postpone security with the assumption:

> "We'll secure it before launch."

Security-sensitive implementation must be correct from the beginning.

### Rules

* Never store access tokens in `localStorage`.
* Never expose secrets through `NEXT_PUBLIC_*` or equivalent client-exposed environment variables.
* Never expose private API keys or server credentials to the renderer/client.
* Never render unsafe HTML.
* Validate API responses at application boundaries.
* Validate user input.
* Do not log passwords, access tokens, financial secrets, or unnecessary personal information.
* Do not expose sensitive business data through unnecessary client-side logging.
* Follow the existing authentication/session architecture.
* Never bypass authorization checks merely because the UI hides a feature.

### Important

UI permissions are not a substitute for backend authorization.

A user hiding a button does not mean they are authorized to perform the operation.

---

# 9. R10 — Strict TypeScript

The project uses strict TypeScript.

`any` is banned.

Do not introduce:

```ts
any
```

to silence TypeScript errors.

If the type is genuinely unknown, use:

```ts
unknown
```

and narrow/validate it properly.

### Do not bypass the type system

Avoid unnecessary:

```ts
as any
```

or other casts whose purpose is simply to make the compiler stop complaining.

If a type error reveals an actual mismatch, fix the underlying type or data contract.

### Goal

TypeScript should help detect:

* Invalid data
* Incorrect API contracts
* Missing properties
* Invalid states
* Incorrect function arguments
* Refactoring mistakes

before runtime.

---

# 10. R11 — Organize Code by Feature

Feature-specific code should live together.

Prefer a structure such as:

```text
src/features/
  products/
  inventory/
  production/
  dispatch/
  barcode/
  parties/
  billing/
  ledgers/
  cash-vouchers/
  auth/
  users/
```

rather than immediately placing every file into giant generic folders such as:

```text
components/
utils/
services/
```

### Shared code rule

A component is not automatically shared simply because it could theoretically be reused.

Make it feature-local first.

When multiple features genuinely need the same component or utility, promote it to an appropriate shared location.

### Goal

A developer working on:

```text
Production
```

should be able to find most production-related code together.

---

# 11. R12 — Every Async Screen Has Four States

Any screen that loads asynchronous data must explicitly handle all four states:

```text
Loading
Empty
Error
Success
```

## Loading

Show an appropriate skeleton/loading state.

Do not leave the user staring at an apparently broken blank screen.

## Empty

Explain that there is currently no data.

Provide a useful action when appropriate.

Example:

```text
No production records yet.
Start production by scanning a QR code.
```

## Error

Explain that the operation failed and provide:

```text
Retry
```

when retrying makes sense.

Do not silently swallow errors.

## Success

Display the actual data.

### Never design only for:

```text
Data exists → show data
```

Every asynchronous workflow must consider:

```text
Loading
Empty
Error
Success
```

---

# 12. R13 — Do Not Put Business Logic Inside UI

React components should primarily handle:

* Rendering
* User interaction
* Presentation
* Connecting UI to application logic

Do not place complicated business rules directly inside JSX.

Move business logic into appropriate:

```text
Hooks
Utilities
Selectors
Application services
Domain logic
```

depending on the existing architecture.

Conceptually:

```text
Component
   ↓
Hook / Application Logic
   ↓
Business Logic
   ↓
Data Layer
```

### ERP-specific examples

Do not independently calculate critical business rules in multiple screens.

Examples include:

* Stock availability
* Production status
* Dispatch eligibility
* Return eligibility
* Bill totals
* Discount resolution
* Ledger balances
* Payment balances
* QR validity
* Product pricing

These rules should have a clear source of truth.

---

# 13. R14 — Do Not Use Random Strings or Numbers

Avoid scattering magic strings and numbers throughout the application.

Bad:

```ts
if (status === "screening")
```

For 777 ERP, prefer domain constants/enums where appropriate:

```ts
if (status === PRODUCTION_STATUS.COMPLETED)
```

Similarly, do not randomly hardcode routes throughout the application.

Prefer:

```text
ROUTES
```

or the project's centralized routing definitions.

### Apply this principle to:

* Statuses
* Roles
* Permissions
* Transaction types
* Voucher types
* Product categories
* Units
* Error codes
* Routes
* Configuration values
* Other domain constants

### Important

Do not create constants for every trivial string.

Centralize values when they represent a stable domain concept or configuration value.

---

# 14. R15 — Money Must Use Integers

Financial calculations must not rely on floating-point currency arithmetic.

777 ERP handles Pakistani Rupees.

Internally, monetary values must be represented as integer **paisa** wherever the project's financial model requires monetary storage.

Example:

```text
PKR 60,000
```

is internally:

```text
6,000,000 paisa
```

Do not perform critical accounting calculations using JavaScript floating-point numbers representing rupees.

Use the project's established money utilities.

For display, use:

```text
formatMoney()
```

or the project's equivalent centralized formatter.

### Applies to:

* Product prices
* Purchase costs
* Sale prices
* Discounts
* Invoice totals
* Payments
* Receivables
* Payables
* Cash vouchers
* Ledger balances
* Financial reports

### Accounting data must remain exact.

---

# 15. R16 — Dates Use UTC Internally

Dates/timestamps should be stored and transported using the application's standardized UTC representation.

The application displays business dates/times in:

```text
Asia/Karachi
```

Developers must not manually perform timezone arithmetic inside individual components.

Use centralized date utilities such as:

```text
formatDate()
formatDateTime()
formatRelative()
formatDateRange()
```

or their existing project equivalents.

### Goal

Timezone handling should have one consistent implementation instead of dozens of slightly different calculations throughout the application.

---

# 16. R17 — Forms Use React Hook Form + Zod

Application forms should use:

```text
React Hook Form
+
Zod
```

Use Zod for validation and React Hook Form for form state/handling.

### Validation messages

Validation errors must be useful and understandable.

Avoid generic messages such as:

```text
Invalid input
```

when a more specific message can explain how to fix the problem.

### Multi-step forms

If a workflow is multi-step and the business process requires preserving progress, drafts should be saved automatically using the appropriate application/data layer.

Do not lose substantial user-entered data because of navigation or accidental refresh where draft persistence is expected.

---

# 17. R18 — Accessibility Is Required

Accessibility is part of the implementation, not an optional enhancement.

Every interactive element must have an accessible name.

This includes:

* Buttons
* Inputs
* Links
* Selects
* Icon buttons
* Interactive controls

Images must have appropriate:

```text
alt
```

text when meaningful.

Forms must have proper labels.

Do not rely on color alone to communicate meaning.

Bad:

```text
Green = success
Red = error
```

without any textual or semantic indication.

Prefer:

```text
✓ Production Successful
⚠ Error: QR already dispatched
```

with appropriate semantic/accessibility support.

---

# 18. R19 — Mobile-First Design

Design responsive interfaces starting from small screens.

Target progression:

```text
360px
↓
768px
↓
1280px+
```

The exact breakpoints should follow the project's existing design system.

### Touch targets

Interactive controls should generally provide approximately:

```text
44px
```

or larger touch targets where practical.

### Tables

Do not force large desktop tables onto small screens when the information can be represented more effectively as:

* Cards
* Stacked rows
* Horizontal scrolling where appropriate
* Responsive layouts

The ERP will eventually operate across:

```text
Desktop
Tablet
Android
iOS
```

Responsive behavior should therefore be considered during implementation.

---

# 19. R20 — Performance Matters

Do not load or render unnecessarily large amounts of data.

Use appropriate techniques such as:

* Code splitting
* Lazy loading
* Dynamic imports for heavy features
* Image optimization
* Pagination
* Virtualization for genuinely large lists
* Server/data-layer filtering where available
* RTK Query caching and invalidation

### ERP-specific requirement

The ERP may contain:

* Thousands of products
* Large stock records
* Large QR histories
* Thousands of production scans
* Thousands of dispatch scans
* Large ledger histories
* Large transaction histories

Do not assume datasets will remain small.

Never render thousands of records unnecessarily just because development data is small.

---

# 20. R21 — All User-Facing Text Must Be Translation-Ready

Urdu support is planned for the future.

Do not make future translation unnecessarily difficult by scattering large amounts of user-facing text directly throughout JSX.

Centralize application copy using the project's established copy/i18n structure.

For example:

```text
src/config/copy.ts
```

or the project's equivalent.

### Avoid

```tsx
<h1>Production Successful</h1>
```

being repeated throughout many components.

Prefer the project's centralized text/copy mechanism.

### Important

This does not mean every tiny developer-facing string needs to be abstracted.

The goal is to make **user-facing application text** easy to translate later.

---

# 21. R22 — Do Not Install Unnecessary Packages

Before installing an npm package, check:

1. Can the existing codebase already solve this?
2. Does an existing dependency already provide this functionality?
3. Is the package actually necessary?
4. What is its maintenance status?
5. What impact does it have on bundle size?
6. Does it introduce unnecessary complexity?

Do not install a large dependency to solve a trivial problem that can be safely implemented using existing project capabilities.

### Important

Do not introduce duplicate libraries for the same purpose.

For example, do not add another:

* State management library
* Form library
* Date library
* UI library
* HTTP client
* Validation library

without first inspecting what the project already uses.

---


# 23. Rule Priority

When implementing any new requirement, follow this priority:

```text
1. Data integrity
2. Existing business rules
3. Security
4. Correct architecture
5. Maintainability
6. Performance
7. UI/UX
8. Convenience
```

A visually convenient implementation must never compromise business data or architectural correctness.

---

# 24. No Placeholder Architecture

Temporary implementations are allowed only when they follow the architecture of the intended final system.

For example:

```text
Mock API
```

is acceptable.

But:

```text
Page → hardcoded mock array
```

is not.

The purpose of temporary code is to make the transition to the real implementation easy, not to create technical debt that must later be rewritten.
# 23. R24 — Keep the System AI-Ready

AI functionality will be added to 777 ERP in the future.

Do not implement AI functionality unless explicitly requested, but **do consider future AI integration when designing application boundaries and data structures.**

The system should make it possible to add future AI capabilities without rewriting the ERP's core architecture.

Potential future AI functionality may include:

* Natural-language queries about inventory
* Stock analysis
* Customer/payment/ledger questions
* Billing assistance
* Production analysis
* Production forecasting
* Demand forecasting
* Next-day machine scheduling
* Business reports and summaries
* An ERP assistant/chat interface
* Other AI-assisted business workflows

### Architecture principle

AI should interact with the application through controlled application/service boundaries.

Conceptually:

```text
UI
 ↓
AI Interface
 ↓
Application / AI Service
 ↓
ERP Data / APIs
```

AI functionality must **not** directly access the database from arbitrary UI components.

### Important

Do not introduce unnecessary AI dependencies, APIs, SDKs, prompts, agents, vector databases, or AI infrastructure merely to make the application "AI-ready."

Being AI-ready means:

* Clean APIs
* Well-defined data models
* Clear business/application services
* Centralized business logic
* Structured ERP data
* Predictable responses
* Proper authorization
* Auditable operations

The existing ERP must remain fully functional without AI.

AI is an additional capability, **not a dependency of core ERP functionality.**

### AI must not bypass business rules

If an AI feature eventually performs an ERP operation, it must use the same validated application/business layer as the normal UI.

Do not create:

```text
AI → Direct Database Modification
```

Prefer:

```text
AI
 ↓
Application Service
 ↓
Business Rules / Validation
 ↓
Database
```

This ensures AI cannot bypass inventory, accounting, permissions, or transaction rules.

---

# 24. R25 — Never Blindly Trust Backend Data

Never assume that data received from the backend is automatically:

* Correct
* Complete
* Safe
* Properly formatted
* Compatible with the current frontend

Even if the backend returns something such as:

```json
{
  "something": "..."
}
```

the frontend must validate it before relying on it.

### Data flow

Use:

```text
Server
 ↓
Validate
 ↓
Transform if necessary
 ↓
Application
 ↓
UI
```

Not:

```text
Server
 ↓
Trust everything
 ↓
UI
```

### Validation

Use:

```text
Zod
```

or the project's established schema-validation mechanism for external data boundaries.

Validate:

* API responses
* External service responses
* User-controlled data
* Imported data
* Synchronization payloads
* AI-generated structured data
* Other untrusted external input

### HTML and user content

Never render unsafe HTML directly.

User-provided content must be appropriately escaped or sanitized before being rendered as HTML.

Do not use unsafe HTML rendering simply because the backend claims the content is safe.

### Important

TypeScript types alone do not validate runtime data.

This:

```ts
type Product = {
  id: string;
  name: string;
};
```

does **not** prove that an API response actually conforms to `Product`.

Runtime validation is required at external boundaries.

---

# 25. The 25 Rules — High-Level Principles

The 25 rules can be remembered through these **9 major principles**:

| Principle                                | Rules                |
| ---------------------------------------- | -------------------- |
| 🧩 **Reusable & Maintainable Code**      | R1, R2, R11, R13     |
| 🎨 **Consistent UI & Localization**      | R3, R21              |
| 🔌 **Clean API & Data Architecture**     | R4, R5, R6, R10, R14 |
| 📱 **Mobile Compatibility**              | R7, R19              |
| 🔐 **Security & Trust Boundaries**       | R9, R25              |
| 🧾 **Correct Business & Financial Data** | R15, R16, R17        |
| ⚡ **UX, Accessibility & Performance**    | R12, R18, R20, R22   |
| 🤖 **AI Readiness**                      | R24                  |
| 🛠️ **Development Discipline**           | R8, R23              |

These principles are complementary and should be applied together.

For example:

```text
A new feature
     ↓
Feature-based structure (R11)
     ↓
Reusable components (R1)
     ↓
Simple implementation (R2)
     ↓
RTK Query / API layer (R5/R6)
     ↓
Runtime validation (R25)
     ↓
Business logic outside UI (R13)
     ↓
Accessible UI (R18)
     ↓
Responsive/mobile-compatible (R7/R19)
     ↓
Loading / Empty / Error / Success (R12)
     ↓
Tests + build verification (R8/R23)
```

The goal is not to follow individual rules in isolation.

The goal is to maintain a **consistent, maintainable, offline-first, secure, mobile-compatible ERP architecture** as the existing 777 codebase grows.
