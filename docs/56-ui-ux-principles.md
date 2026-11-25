# 56 — UI/UX Principles (mandatory reading before any UI work)

**Who reads this:** anyone (developer or AI) who designs, builds or changes a screen, dialog, card, table, form or
animation in 777 ERP.

**Rule:** read this file **before** designing. Every UI change must follow it. When you finish, run the review
checklist at the end and say in your report which principles shaped the change.

Owner's instruction, 25 Nov 2026: *"Everything in our software UI/UX should follow these rules and laws."*

These principles sit **under** the business rules in `CLAUDE.md`. Data integrity, existing business rules, security
and architecture come first (CLAUDE.md §23). A principle never justifies hiding, rounding or simplifying a business
figure.

---

## 0. The five questions to ask before drawing anything

1. **What is the one thing this screen is for?** That thing gets the most weight, colour and space (Von Restorff,
   Pareto). Everything else steps back.
2. **What does the user already know from our other screens?** Reuse that pattern and component (Jakob, Similarity,
   CLAUDE.md R1).
3. **What can wait until asked for?** Put it behind a toggle, menu or `<details>` (Progressive Disclosure, Hick,
   Cognitive Load).
4. **What must the user type or remember that the system already knows?** Fill it in or offer it as a choice
   (Tesler, Recognition over Recall, Default Effect).
5. **What do Loading, Empty, Error and Success look like?** All four, without layout shift (CLAUDE.md R12, Doherty,
   Layout Shift).

---

## 1. Laws of perception and grouping (Gestalt)

| Principle | Rule in 777 ERP |
|---|---|
| **Law of Proximity** | Things that belong together sit close together; unrelated groups get clearly more space between them than within them. A label sits right next to its value. A total sits directly under the column it sums. |
| **Law of Common Region** | A group gets a shared boundary: a card (`.card`, `--sp-radius-card`, `--sp-line` border) or a tinted panel. One idea per card. Don't put a card inside a card inside a card. |
| **Law of Similarity** | Things that behave alike look alike: every primary button, status badge, amount column and party picker uses the same component and style. Something that looks different must *be* different. |
| **Law of Prägnanz** | Pick the simplest shape that reads. Prefer one clear grid (`utils/bentoLayout.ts`, `BENTO_COLUMNS = 12`, `BENTO_GAP_PX = 16`) over hand-placed boxes. Sums read as an equation, left to right (e.g. the Customer Ledger's *Brought forward + Debit − Credit = Balance*). |
| **Uniform Connectedness** | Elements visually joined (a line, a shared background, a connector) are read as one unit. Use it for steps, an equation strip, or a parent row and its child rows. Never join things that aren't related. |

## 2. Laws of decision and memory

| Principle | Rule in 777 ERP |
|---|---|
| **Hick's Law** | Fewer, clearer choices. Group header actions into one or two menus (`ActionMenu`) instead of five buttons. A filter row shows the 4–6 choices people actually use. |
| **Miller's Law** | Chunk information into groups of about 5–9. Long numbers are grouped (`10,552,520`), long lists are paged (`Pager`) or grouped by article or colour, and a form is split into named sections. |
| **Cognitive Load** | Every element must earn its place. Remove repeated labels, decorative text and duplicate figures. When the owner says "too cluttered", the answer is to remove things, not shrink them. |
| **Recognition over Recall** | Show choices instead of asking people to remember codes: searchable pickers (`SearchableCombobox`), recent values, the old value next to an edit ("was ALAMGIR"), article and colour swatches (`ColorSwatch`). |
| **Tesler's Law** (conservation of complexity) | Complexity that can't be removed goes into the system, not onto the user. Pre-fill what we know (today's date, the party's last rate, the archive's closing balance) and calculate in the data layer. Never ask the user to do arithmetic. |
| **Default Effect** | Most people keep the default, so it must be the safe, common choice: the ledger opens on *All time*, quantities default to the usual unit (dozens), destructive actions are never the default button. |
| **Occam's Razor** | Of two designs that both work, ship the one with fewer parts. No feature or panel "just in case". |
| **Pareto Principle** | About 20% of the actions are used 80% of the time. Those get the large, obvious controls in the first place the eye lands. Rare actions go into menus. |
| **Parkinson's Law** | Work expands to fill the time it's given. Keep tasks short with clear end points: autosave drafts, "Save N changes", one-click completion when everything is ready. Don't add confirmation steps that only stretch a routine task. |
| **Paradox of the Active User** | People never read instructions; they start using the screen right away. The screen must explain itself through labels, placeholders, empty states and inline hints. Nothing important belongs only in a help page or tooltip. |

## 3. Laws of attention and memory over time

| Principle | Rule in 777 ERP |
|---|---|
| **Von Restorff Effect** | One thing per screen stands out: the answer (Current Balance, Saved Today, the primary action). Use one accent block or colour for it, never several. If everything is highlighted, nothing is. |
| **Serial Position Effect** | People remember the first and last items best. Put the key figure first (top-left or top hero) and the conclusion last (a table ends on its closing balance row). Navigation keeps the most-used items at the start and end. |
| **Peak-End Rule** | People judge an experience by its best moment and by how it ended. Make success clear and satisfying ("✓ Production added", a saved receipt), and end every flow cleanly with confirmation, the next step, and no dead ends. Error states must be calm and say how to fix the problem. |
| **Goal-Gradient Effect** | People speed up as they near the end. Show progress ("Machines in 2 / 3", "Still to add: MACHINE 3", step 2 of 3) and bring the final action into view once everything is ready. |
| **Zeigarnik Effect** | Unfinished tasks stay in mind. Make open work visible and easy to return to: pending orders, unsaved lines ("3 lines not saved yet"), drafts, "Still to add" lists. |
| **Doherty Threshold** | Respond in under 400 ms. Show immediate feedback (pressed state, optimistic update, skeleton) and never a frozen screen. Anything slower than about 1 s gets a loading state that keeps the layout. |
| **Aesthetic–Usability Effect** | A clean, consistent, well-aligned screen is trusted more and feels easier to use. Polish (alignment, spacing, tabular numbers, consistent radii) is part of the job, not decoration. It never replaces clarity. |

## 4. Laws of interaction

| Principle | Rule in 777 ERP |
|---|---|
| **Jakob's Law** | People expect our screens to work like the other screens they know, both ours and the old software's. Reuse our patterns (header with back + title, page actions top-right, tabs, period bar) and keep the old ledger's column order where accountants expect it. |
| **Fitts's Law** | Important targets are big and close to where the user is working. Primary actions are wide buttons near the content they act on; whole cards or rows are clickable when that's the obvious action (e.g. a machine card opens its contractors). Destructive actions are small and kept apart from frequent ones. |
| **Postel's Law** | Be liberal in what you accept and strict in what you produce. Accept loose input (`1,000`, `1000`, ` 1000 `, `½`, `0.5 dz`, `rv-1`, lower case, Urdu or English) and normalise it (`looseSearch.ts`, `normalizeDozensText`). Always store and show one exact, validated form. |
| **Affordance** | A control must look like what it does: buttons look pressable, fields look editable, links look like links, draggable things show a handle. A read-only figure never looks like an input. |
| **Touch target** | At least **44 × 44 px** for anything tappable (CLAUDE.md R19), with at least 8 px between neighbouring targets. The app also runs on tablets and phones. |
| **Combobox** | Choosing from more than about 7 options, or from a list that grows (parties, articles, colours), uses the shared `SearchableCombobox`: type to filter, arrow keys, Enter, Escape, an accessible name, and an empty-result message. Never a bare `<select>` for parties or articles. |
| **Progressive Disclosure** | Show what most people need; reveal the rest on request ("More columns", an "Imported ledgers" `<details>`, an action menu, an advanced section). Never hide anything required to finish the task correctly. |
| **Optimistic update** | When an action almost always succeeds and can be undone, update the UI immediately and reconcile with the reply; on failure, roll back and say so. **Never** do this for stock, money, QR or ledger writes: those wait for the confirmed reply from the data layer (CLAUDE.md §8–9). For those, show a pending state instead. |

## 5. Typography and numbers

| Principle | Rule in 777 ERP |
|---|---|
| **Tabular numbers** | Every figure that can change or be compared (amounts, quantities, balances, counts, dates in tables) uses `font-variant-numeric: tabular-nums` and is right-aligned in tables, so digits line up and don't jump when they change. |
| **Kerning** | Keep the font's kerning on (`font-kerning: normal`). Large display headings may be tightened slightly; never letter-space body text by hand. |
| **Tracking** (letter-spacing) | Small uppercase labels get positive tracking (about `0.04–0.08em`). Large headings get zero or slightly negative tracking. Body text gets none. |
| **Leading / line height** | Body text about `1.45–1.6`, dense tables about `1.3`, large headings about `1.1–1.2`. Urdu (Nastaliq) needs noticeably more line height. Use the Urdu font token and never clip its tall marks. |
| **x-height** | Choose sizes by how tall lowercase letters look, not only by the px value. Mixed fonts (Latin and Urdu) are sized so they read at the same weight. Nothing in the UI goes below 12 px; figures that matter are at least 14 px. |
| **Widow** | Don't leave a single word alone on the last line of a heading or short paragraph: use `text-wrap: balance` on headings and `text-wrap: pretty` on paragraphs, and rewrite the copy if needed. |
| **Line length** | Running text is 45–75 characters per line. Long descriptions in tables wrap rather than stretch the table. |
| **Optimal center** | The eye's resting point is slightly above the geometric middle. Place hero content, empty states and dialogs at the *optical* centre (a little above true centre), and nudge icons inside circles to look centred, not just measure centred. |

## 6. Layout, colour and motion

| Principle | Rule in 777 ERP |
|---|---|
| **Layout shift** | Nothing jumps. Skeletons have the final layout's size; numbers use tabular figures; images and charts reserve their space; error and empty states replace the content in the same box. A refresh keeps the old data visible with a quiet busy state (`aria-busy`) rather than blanking the screen. |
| **Safe area** | Respect device safe areas (notch, home indicator, rounded corners) with `env(safe-area-inset-*)` for anything fixed to the screen edge, ready for the Android/iOS app (CLAUDE.md R7). |
| **OKLCH** | New colours are defined as tokens in `theme.css` (CLAUDE.md R3), preferably in `oklch()`, so lightness steps are even and hover, active and disabled states are made by changing lightness only. Never a raw hex in a component. Contrast meets WCAG AA. Meaning is never carried by colour alone: add an icon and words (CLAUDE.md R18). |
| **Aesthetic visibility** | What matters is visible without hunting: the main figure, the main action and the current state. Nothing important is hidden by hover-only controls; the app also runs on touch screens. |
| **Origin-aware animation** | Things grow from where they came from: a menu opens from its button, a dialog from the clicked card, a dropdown from its field (`transform-origin` set to the trigger). |
| **Interruptible animation** | Every animation can be interrupted or reversed mid-way (CSS transitions, not fixed keyframes that must finish). A click during an animation acts at once; nothing blocks input while it plays. |
| **Stagger** | When a list or a set of cards appears, stagger the items by about 20–40 ms each, capped so the whole sequence takes under about 300 ms. Never stagger on every re-render or data refresh, only on first appearance. |
| **Shared element transitions** | When one element becomes another (a card opening its detail, a tab switch, a row opening a voucher), animate the continuity with `utils/withViewTransition.ts` so the eye can follow. Fall back silently where unsupported. |
| **Motion budget** | UI transitions take 150–250 ms and enter/exit takes up to about 300 ms, eased (ease-out to enter, ease-in to exit). Every animation respects `prefers-reduced-motion: reduce` (fade or none). Animate only `opacity` and `transform`. A `transform` on a parent traps `position: fixed` children, so use an opacity fade for containers that hold dropdowns. |

---

## 7. Where these live in the code (reuse, don't rebuild)

| Need | Use |
|---|---|
| Colours, radii, spacing, fonts | Tokens in `apps/desktop/src/renderer/styles/theme.css` |
| User-facing text | `apps/desktop/src/renderer/config/copy.ts` (CLAUDE.md R21) |
| Pick from a growing list | `components/shared/SearchableCombobox.tsx` |
| Search box with `/` shortcut | `components/shared/SearchField.tsx` + `hooks/useSlashToSearch.ts` |
| Grouped actions (Hick) | `components/shared/ActionMenu.tsx` |
| Dialogs | `components/shared/Modal.tsx` (has `headerAction`), `ConfirmDialog.tsx` |
| Loading / Empty / Error | `components/shared/StateView.tsx` + a skeleton of the final layout |
| Paging long lists | `components/shared/Pager.tsx` |
| Quantities by size and colour | `components/shared/SizeColourGrid.tsx`, `MissingSizeCell.tsx`, `AddColorControl.tsx` |
| KPI tiles | `components/dashboard/KpiCard.tsx` |
| Grid layout | `utils/bentoLayout.ts`, `hooks/useElementWidth.ts` |
| Shared element / tab transitions | `utils/withViewTransition.ts` |
| Bring a new block into view (Goal-Gradient) | `utils/revealBlock.ts` |
| Dates and money for display | `utils/dates.ts` (`formatDate` …), `app/format.ts` (`formatWholeMoney` …) |

If a component almost fits, generalise it carefully (CLAUDE.md R1). Never fork it.

---

## 8. Review checklist (run before reporting any UI change as done)

- [ ] **One focus:** the screen's main figure or action stands out alone (Von Restorff, Pareto).
- [ ] **Familiar:** same patterns and shared components as the rest of the app (Jakob, Similarity, R1).
- [ ] **Uncluttered:** every element earns its place, and rare things are behind disclosure (Cognitive Load, Occam, Progressive Disclosure).
- [ ] **Few choices:** at most about 7 visible options per group, with actions grouped into menus (Hick, Miller).
- [ ] **Grouped:** related items are close together and share a region; unrelated ones have clear space (Proximity, Common Region, Uniform Connectedness).
- [ ] **No recall:** pickers, defaults and pre-filled values; nothing needs memorising or arithmetic (Recognition, Tesler, Default Effect).
- [ ] **Forgiving input:** loose input accepted, exact value stored and shown (Postel).
- [ ] **Targets:** at least 44 px, important ones big and close, destructive ones apart (Fitts, Touch target).
- [ ] **Four states:** loading, empty, error and success are designed, with no layout shift (R12, Layout shift, Doherty).
- [ ] **Feedback in under 400 ms:** pressed state, busy state, and optimistic updates only where safe (Doherty, Optimistic update).
- [ ] **Progress and open work** are visible where a task has steps (Goal-Gradient, Zeigarnik).
- [ ] **Good ending:** a clear success state and the next step (Peak-End, Serial Position).
- [ ] **Numbers:** tabular, right-aligned, grouped with thousands separators, formatted by the shared formatters.
- [ ] **Type:** sensible leading, tracking on small caps, no widows, Urdu gets room (Typography).
- [ ] **Colour:** tokens only (OKLCH for new ones), AA contrast, never colour alone (R3, R18).
- [ ] **Motion:** origin-aware, interruptible, ≤300 ms, reduced-motion respected, staggered only on first appearance.
- [ ] **Responsive:** works from 360 px, with safe areas respected (R19, Safe area).
- [ ] **Accessible:** every control has a name; dialogs trap focus; Escape closes only the top layer (R18).
- [ ] **Text** comes from `copy.ts` (R21).
