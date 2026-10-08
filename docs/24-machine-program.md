# Machine Program — planning a machine's shift against raw material

> **The chrome became a navy rail down the left on 2026-10-08, and the machines became a strip across the top — read §0000000 first.**
> **Fitted the same day to the floor machine's 1280×620 screen — §000000 has the measurements and the breakpoint.**
> **Corrected the same day — §00000: Available Stock, the Program Summary's grouping, and the dialogs.**
> **Rebuilt the same day to the owner's drawing, with a SHIFT added to a program — §0000 is that shape.**
> **The screens were rebuilt earlier on 2026-10-08 — §000 records that pass.**
> **Superseded in part on 2026-10-07 — read §00 first, then §0.** §00 is the data shape in use now.
> §0 (2026-10-05) is the shape it was built on, and §§1–10 are the first shape of all (one live
> program per machine, time slots, bags of Dana), kept because the database still carries it.

## 0000000. Revision 2026-10-08 (fifth) — a navigation rail, and the machines across the top

**Built on:** the app's chrome moved from a bar across the top to a **navy rail down the left**
(an application-wide change, see below), and this screen gave up its machine dropdown.

### The machines are a strip, not a dropdown and not a rail

```
MACHINES   [ ▤ MACHINE 1 ]  [ ▤ MACHINE 2 ]  [ ▤ MACHINE 3 ]
             ● Ready          ● Idle           ● Idle
```

The owner asked for the machines to take the dropdown's place, laid out horizontally. A floor has
a handful of machines and every one of them should say how its day stands without anybody opening
anything, so this is strictly better than either shape it replaced:

* `MachinesRail.tsx` is **gone**; `MachinesStrip.tsx` takes its place, with the same
  `machineState` wording and the same four states (R12).
* The header's `Machine` `HeaderSelect` is **gone**. `WorkspaceHeader` now carries only the shift,
  the date and Print, and no longer takes `board` or `onMachineChange`.
* The strip scrolls sideways rather than wrapping, so the workspace below it never moves down as
  machines are added.
* The workspace grid is **two columns** now — injectors | summary — because the left of the
  screen belongs to the navigation rail.

### The sizes, re-measured

1280 CSS px − 216 rail − 64 page padding = **~1000** for the workspace. The summary keeps its
256px, the injector column gets ~726, and the two sole cards still sit side by side — the sole
grid's minimum is now **322px**, the table's own minimum, so two always fit wherever the column is
656px or wider. The summary drops below the work at **990px** of window.

```
1280x620   grid 726px 256px   soles [330,330] side by side   summary at x=986   rail 216 wide
```

---

## The navigation rail (application-wide)

`.navbar` keeps its component, its sections and its profile/notification cluster; only its shape
and colours changed, so there is still exactly one thing that owns navigation.

* **Navy ground, white type**, from five central tokens — `--sidebar-bg` (pointing at the new
  `--accent-navy` #172554, the blue ramp's darkest step), `--sidebar-ink`, `--sidebar-ink-dim`,
  `--sidebar-hover`, `--sidebar-active`, `--sidebar-line`, `--sidebar-mark`. Changing the
  company's chrome colour is those lines and nothing else (R3).
* **Every section has a picture.** `SectionIcons` in `Navbar.tsx` — one per top-level entry,
  decorative, with the label beside it as what is actually read (R18). The dropdown rows kept the
  `Icons` set they already had.
* **The current section** wears a tint plus a bar down its left edge, drawn as a positioned
  `::before` rather than a `border-left` — a one-sided border costs this hardware a first-draw
  stall.
* **A section's rows fly out beside it.** `.navbar-nav` scrolls, and **a scroll container clips
  its children on both axes** (`overflow-x: visible` beside `overflow-y: auto` computes to
  `auto`), so the panel was being cut off at the rail's edge. It is portalled to `<body>`
  (`NavFlyout`) and placed from the section's own rect, nudged up when it would run off the
  bottom. It carries its own pointer handlers, because outside the section in the DOM the
  section's `mouseleave` fires the moment the pointer travels onto it.
* **The rail sits at `z-index: 400`** — above the page (1), below the dialog layer (500) — so a
  modal dims it, which is what a modal means. It was 1000 as a top bar and would have painted
  over every dialog.
* The logo was drawn for a white bar, so on the navy it sits on **its own white tile** rather than
  being inverted: a filter would cost another first-draw stall.
* `.app-shell` is a **row**; `.page-content--fullscreen` is `100vh` rather than
  `100vh − --navbar-h`; `.qrm-drawer-backdrop` clears `--sidebar-w` on the left instead of the
  old bar's height on top.

---

## 000000. Revision 2026-10-08 (fourth) — fitted to the floor machine's screen

**Built on:** CSS only. No markup change except one button moving, no use case, no figure.

The owner was zooming the app out twice to get the Program Summary back beside the injectors
instead of under them. **The breakpoint was simply set too high.**

### The screen this is now measured against

The floor machine is **1920×1080 at 150%**, which is **1280×~620 CSS px**. `.page-content` takes
64px of the width, so the workspace has about **1200px** — easily enough for three columns. The
`@media (max-width: 1280px)` rule was firing at exactly that width and dropping the summary below.

Everything was re-sized against 1200px rather than against the 1536px drawing:

| | before | now |
|---|---|---|
| machines rail | 236px | 196px |
| summary rail | 304px | 256px |
| grid gap | 16px | 12px |
| a sole card, minimum | 404px | 330px |
| the table, minimum | 404px | 322px |
| summary drops below at | **1280px** | **1070px** |

1070px is where three columns genuinely stop working: 196 + 256 + the 436 one sole card and its
card padding need, plus the gaps and `.page-content`'s 64.

Measured in Electron at the real size, not eyeballed from a screenshot:

```
1280x620   grid 196px 734px 256px   soles [334,334] side by side   summary at x=986
1080x700   grid 196px 534px 256px   soles stacked                  summary at x=786
1024x700   grid 180px 762px         soles [348,348]                summary below (by design)
1440x900   grid 196px 900px 256px   soles [417,417] side by side   summary at x=1152
```

No table scrolls horizontally at any of them, and the header never wraps above 1070.

### The one markup change

A configured injector's **+ Add Sole Color** moved from a centred block under its sole cards into
the injector's own header, as a quiet bordered button beside the badge. It is worth ~66px of
height per configured injector, and it matches the drawing better — which shows no such button
under a configured injector at all. The **empty** injector keeps the big blue centred one, where
it is the only thing to do.

### What still scrolls

At 1280×620 the page is **758px** tall, so about 140px — the empty Injector 2 card — is below the
fold. Two injector cards, a header and three rails do not fit in 620px without shrinking the
figures past what somebody reads across a workshop. The thing the owner asked for, the summary
beside the work rather than under it, now holds at 100% zoom.

---

## 00000. Revision 2026-10-08 (third) — the owner's corrections

**Built on:** no migration and no use case. One display rule changed, the summary was regrouped,
two blocks of text were removed and the dialogs were restyled.

### Available Stock (Upper) counts the row's own reservation as still the row's

The owner reported it: 15 DOZEN of BROWN in the store, 5 typed into the row, and the column then
read **10**. It should read **15**.

It was showing `available` straight from `listMachineProgramUppers`, which is Physical − Reserved
across **every** live program — this row's own 5 included. The column now shows
**`available + the row's own quantity`**:

* The row's own reservation is **not** taken off, because it is already shown in the very next
  column. The operator is being told what there is, not what is left after themselves.
* Other programs' reservations **are** still taken off, so the figure never over-promises the
  store.
* It is **exactly the ceiling the quantity box enforces** (`QuantityCell`'s `limit`), so the two
  columns can never disagree — one figure, computed once, used twice.

Where some of the line has already been scanned out, the arithmetic still lands on the store's
original holding: physical has dropped by what left, and the line's outstanding has dropped with
it, so `available + quantity` adds the consumed part back exactly once.

Pinned by `MachineProgramPage.test.tsx` → "shows the store's stock of the upper, without taking
the row's own quantity off it" (80 free + 30 on the row → **110**, never 80).

### The Program Summary is per UPPER, under its sole

```
Injector 1                       Configured
  ● BLACK sole
      SK6 7/10 BLACK      10 DOZEN
      SK6 7/10 BLUE       10 DOZEN
      SK12 7/10 RED       20 DOZEN
  ● BROWN sole
      SK12 1/6 BLUE       10 DOZEN
Total Production (Injector 1)    50 DOZEN
```

It used to be one line per sole colour with that colour's total. What the machine actually makes
is an article, a size and an **upper colour**, and that is what the floor asks the store for — a
sole colour on its own cannot be fetched. The per-colour subtotal went with it; the sole's own
card in the middle column still carries `Total (BLACK sole)`.

### Removed

* The page subtitle "Create production program for your machines and injectors."
* The whole **Production Plan** note in the summary rail. `reservationNote` survives it — the
  printed program sheet still carries "a program does not move stock", and the delete dialog
  still says it in full with what has already been scanned out.

### The dialogs were drawn in the workspace's language

`+ Add Sole Color`, `+ Add Article` and `Change this sole` were still wearing the old palette
(teal `--primary`, uppercase headings, shadowed white cards on white). The `.mp-*` block — which
nothing outside this feature uses — was rewritten onto the same tokens as `.mpx-*`:

* The **trail** is a three-card stepper: answered steps wear `--action-tint` with the answer in
  `--action-strong`, the step being asked wears the action border, what is open stays plain. Each
  still says which it is in words (✓ / —), never by colour alone (R18).
* A step is a **soft panel** inside the dialog rather than a shadowed card; the question is
  sentence case at 1.08rem, and **← Back is hidden on the first question** — there was nothing
  behind it but the dialog's own Cancel.
* **Choice cards and upper cards** match the machine rail: white, hover grey, chosen =
  `--action-tint` + action border + a round tick. `ChoiceCards` gained an optional **`swatch`**,
  so the sole colour step and the upper picker now show the physical colour beside its name
  (`ColorSwatch`, the app's one colour mapping).
* **How many?** keeps its big box (fixed at 140px — the rule is two classes deep so it beats
  `.form-input { width: 100% }` rather than relying on source order), with Available and Remaining
  as separate chips and a flat action-blue **Add**.

Files: `ChoiceCards.tsx` (+`swatch`), `RunSteps.tsx`, `UpperPicker.tsx`, `RunBuilder.tsx`
(first-question Back), `SoleRunRows.tsx` (`inStore`), `ProgramSummaryRail.tsx`,
`WorkspaceHeader.tsx`, `copy.ts` (`subtitle`, `planTitle`, `planHint` deleted), `theme.css`
(the `.mp-*` block rewritten; `.mpx-plan*`, `.mpx-subtitle` and `.mpx-summary-colour*` removed,
`.mpx-summary-sole/-lines/-line*` added).

Tests: `MachineProgramPage.test.tsx` is now **15, all passing**.

---

## 0000. Revision 2026-10-08 (second) — the owner's drawing, and a SHIFT on the program

**Built on:** migration `058_machine_program_shift`, one new use case, one new IPC channel, and a
rewrite of the workspace's markup and `.mpx-*` styles. §000 (earlier the same day) is superseded
on screen; its behavioural decisions all still hold.

The owner supplied a second, fuller UI reference and asked for it exactly. Three things in it had
no equivalent in the system, and each was settled with the owner before any of it was built:

| In the drawing | Settled as |
| --- | --- |
| A **"Shift Time"** control (06:00 AM – 06:00 PM) | **Built for real.** A program now stores the shift it runs. The date moves beside it in the header. |
| A blue **"Save Program"** button | **Kept as instant save**, button relabelled **Print Program**. Every edit is already its own saved transaction, so a Save step would only be able to lie. |
| Injector 1 **and** Injector 2 both drawn, under a tab strip | **Both stacked**, with the tabs scrolling to one and marking it. The whole machine stays on screen. |

### The shift

```
MACHINE 1 · 8 Oct 2026 · 06:00 AM – 06:00 PM
```

`machine_programs.shift_start_minute` / `shift_end_minute`, **minutes from midnight of
`program_date`** — exactly how the first shape of this feature held its time slots
(`machine_program_lines`, migration 044). `end_minute` may pass 1440, which is what an evening
shift finishing the next morning does, so "runs into tomorrow" is an integer comparison and no
screen does timezone arithmetic of its own (R16). Existing rows default to the day shift.

The shift is a fact about the **program**, not about a line:

* It is **not** part of the key. One machine still has one program per date
  (`idx_machine_programs_machine_date` is untouched), and that program runs one shift.
* Changing it **reserves, releases and moves nothing** — the same uppers are promised, for a
  different stretch of the clock. `SetMachineProgramShiftUseCase` writes two columns and an audit
  row, and refuses a deleted program like every other write.
* A program that does not exist yet has no shift to change: the header's choice is simply what
  the next one will be made with, and it travels on `saveLine` as `shift` to the insert.

`MACHINE_SHIFTS` (day 06:00–18:00, night 18:00–06:00), `checkMachineShift`, `formatMinuteOfDay`
and `formatShiftRange` are in `@erp/domain/machineProgram.ts`, so the screen, the program sheet
and the backend all say the shift the same way. A program whose stored shift is neither of the two
still appears in the dropdown as its own option, so it can always say what it runs.

### The shape

```
⚙ Machine Program                MACHINE      SHIFT TIME     PROGRAM DATE   [ Print Program ]
┌──────────┬──────────────────────────────────────┬──────────────────┐
│ MACHINES │ [Injector 1 · Configured][Injector 2] │ PROGRAM SUMMARY  │
│ ▤ Mach 1 │ ┌ ◉ Injector 1 ─────── Configured ─┐ │  Injector 1 …    │
│   ● Ready│ │  ● BLACK sole   ● BROWN sole     │ │  Total Production│
│ ▤ Mach 2 │ │        + Add Sole Color          │ │  ⓘ Production    │
│   ● Idle │ └──────────────────────────────────┘ │     Plan         │
│ ▤ Mach 3 │ ┌ ◉ Injector 2 ─── Not configured ─┐ │  QUICK VIEW      │
│   ● Idle │ │      No program added yet        │ │  machine · shift │
│          │ │      + Add Sole Color            │ │  contractor      │
└──────────┴─┴──────────────────────────────────┴─┴──────────────────┘
```

The two numbered steps of §000 are gone. There is no "choose the colours first" panel any more:
**+ Add Sole Color** opens one dialog that asks the colour (with its Dana), the article, the size,
the upper and how many; **+ Add Article** on a colour's card opens the same dialog minus the
colour, which is the card's. Both still go through `RunBuilder` → `UpperPicker` → `QuantityEntry`,
so the questions, the Dana and every refusal are unchanged — only their frame is.

A sole colour's card is the drawing's table: **Article · Size · Upper Color · Available Stock
(Upper) · Qty to Run (DOZEN)**, one row per upper line, with a bin per row and a bin on the card
header for the colour as a whole. Available Stock is a bare number because the unit is declared
once, in the Qty heading, and every figure in the table is in it.

### What this changed about behaviour, and why

* **Qty to Run is typed in the row** (`QuantityCell`), not in a dialog. It saves **on blur or
  Enter — never on a keystroke**, because a half-typed number is not a number. `checkProgramQuantity`
  runs as you type as a courtesy; the save is still re-checked inside the write lock and its
  refusal is what the cell shows. Escape puts the saved figure back, and when the program is
  re-read with a different figure (another terminal, a scan) the box follows it.
* **The bin on a sole card takes the whole colour off that injector.** A colour may be several
  runs and the backend has no "remove a colour" — a colour is not a thing it stores — so the
  dialog removes them one at a time and **stops at the first refusal**, naming the run that
  stopped it. That is what happens when something on a run has already been scanned out: that run
  is history and stays. Whatever came off before the refusal stays off.
* **The run's own change moved onto the Article and Size cells.** They are buttons that open
  `RunChangeDialog`; the drawing has no Change button and the function had to stay reachable.
* **The contractor moved out of the header into Quick View**, where the machine's contractor is
  already named, with a "Change contractor" link onto the same `ContractorDialog`. Choosing a
  machine that has nobody still asks before anything else.
* **`FinalProgram` is gone.** It read the injector back under itself, which the Program Summary
  rail already does for both injectors and for the machine. `SoleColourStep` is gone with the
  two-step layout.

### Files

New: `MachineProgramIcons.tsx` (the cog, machine, injector, clock, calendar, person, info, bin,
plus and caret this screen is drawn with), `HeaderControl.tsx` (`HeaderControl` + `HeaderSelect`,
the one shell all three header controls use), `QuantityCell.tsx`.

Gone: `FinalProgram.tsx`, `SoleColourStep.tsx`.

Rewritten: `MachineProgramPage.tsx`, `WorkspaceHeader.tsx`, `MachinesRail.tsx`,
`InjectorWorkspace.tsx`, `InjectorPanel.tsx`, `SoleGroup.tsx`, `SoleRunRows.tsx`,
`SoleEditors.tsx`, `ProgramSummaryRail.tsx`. `RunChange.tsx` became `RunChangeDialog`.
`ProgramDate.tsx`'s control variant now renders through `HeaderControl`, so the date, the machine
and the shift are one control with three contents.

Backend: `migrations/sqlite/058_machine_program_shift.{up,down}.sql`; `@erp/domain`
(`MACHINE_SHIFTS`, `checkMachineShift`, `formatMinuteOfDay`, `formatShiftRange`,
`shiftEndsNextDay`, `sameMachineShift`); `SetMachineProgramShiftUseCase`;
`MachineProgramRepository.setMachineProgramShift` + the shift on `insertMachineProgram` and on
`getMachineProgramByDateForWrite`; `IPC.setMachineProgramShift` with its handler, preload bridge
and `DesktopApi` entry; the shift printed on the program sheet and shown in the delete dialog.

`theme.css`: two tokens added centrally — `--accent-action` (#2563eb, the step between
`--accent-mid` and `--accent-deep`, already in the app as `.btn-primary`'s hover shadow) and
`--accent-edge` (#bfdbfe) — with the semantic aliases `--action`, `--action-strong`,
`--action-tint`, `--action-line` beside the other aliases. The `.mpx-*` block was rewritten onto
them. Nothing outside this feature changed colour. The blue bar down a selected machine is a
`::before` block, not a `border-left`, and the header's blue action is a flat fill, not
`.btn-primary`'s gradient — both for the first-draw stall this machine's GPU has on gradients and
one-sided borders.

Tests: `MachineProgramPage.test.tsx` is now 14, all passing, with new ones for choosing the
machine from the header, typing a row quantity (saved once, on blur), refusing a row quantity
above what is free, changing a saved program's shift, and taking a whole sole colour off.
`@erp/domain` has 3 new shift tests (49 total). `packages/data/src/machineProgram.test.ts` (28) is
untouched and still passing. The screens were checked by screenshot in Electron against the real
stylesheet, at 1536×1024 and at 1280×624.

---

## 000. Revision 2026-10-08 — one workspace instead of a sequence of screens

**Built on:** no migration, no use case, no repository change. The database, the business rules and
every figure are exactly as §00 left them. This revision is the screens only.

The owner gave a UI reference for this feature. The screens were rebuilt to it, and the domain was
kept: the reference's **"Shift Time"** was dropped at this pass, because a program keys on a
**DATE** (`idx_machine_programs_machine_date`), and the contractor, the Dana panel and the DOZEN
reservations the reference does not show were kept, because the business needs them.

> Superseded by §0000, later the same day: the owner asked for the shift to be built for real,
> as a field on the program rather than as a second key. The date did not move out of the way for
> it — both are in the header now.

### The shape

```
┌──────────┬──────────────────────────────────┬──────────────────┐
│ MACHINES │ INJECTOR 1 | INJECTOR 2          │ PROGRAM SUMMARY  │
│ Machine 1│  (1) sole colours   (2) article  │  Injector 1 …    │
│ Machine 2│                     + upper + how│  Total production│
│ Machine 3│  FINAL PROGRAM (Injector 1)      │  Quick view      │
└──────────┴──────────────────────────────────┴──────────────────┘
```

The machine board, the "Create program" step and the one-question-per-screen walk down to the
injector are gone: the machine is a rail you choose from, the date and the contractor are header
controls, and the injector is a tab. What used to be a wizard is now two numbered steps side by
side — **(1) which sole colours**, **(2) for each colour, the article, the upper and how many** —
with the injector's reading-back along the bottom and the machine's totals down the right.

A sole colour's card is a table: **one row per upper line**, showing the run's article and size,
the upper's colour, what is **free in the store right now** (read live from
`listMachineProgramUppers`, not remembered), and the quantity. The quantity opens the same
`QuantityEntry`; the ✕ is the same confirmed `removeMachineProgramLine`.

### What this changed about behaviour, and why

* **A colour already on the program cannot be un-ticked.** Un-ticking would mean silently taking
  saved soles off, so the chip stays on and says so; its soles come off one at a time in step 2,
  and the colour leaves with the last of them.
* **A repeated article + size joins its run instead of making a rival one.** `runForArticleSize`
  finds the run and the save passes its `runId`. The backend has always inserted a new run for a
  null `runId` (`SaveMachineProgramLineUseCase.resolveRun`), and the old "+ Add another sole"
  could therefore leave two runs with the same colour, article and size on one injector. A sole
  run *is* those three things, so this is the screen matching the domain, not a new rule.
* **`RunBuilder` now takes `asks`** — which of its three questions it owns. Adding an article
  inside a colour's card owns only the article and the size: the colour is the card's, so it is
  shown settled and can be neither changed nor walked back into. Without this, an article added
  under BLACK could have saved itself under RED. `RunChange` still owns all three.

### Files

Gone (replaced, not re-homed): `MachineBoard.tsx`, `MachineCard.tsx`, `InjectorCards.tsx`,
`ProgramSummary.tsx`, `RunCard.tsx`, `MachineWorkspace.tsx`.

New: `WorkspaceHeader.tsx`, `MachinesRail.tsx`, `InjectorPanel.tsx`, `SoleColourStep.tsx`,
`SoleGroup.tsx`, `SoleRunRows.tsx`, `SoleEditors.tsx`, `FinalProgram.tsx`,
`ProgramSummaryRail.tsx`. Rewritten: `MachineProgramPage.tsx`, `InjectorWorkspace.tsx`.
Generalized: `ProgramDate.tsx` (a `control` variant for the header), `RunBuilder.tsx` (`asks`).
Untouched: every hook, every write, `machineProgramPrint.ts`, `ChoiceCards`, `UpperPicker`,
`UpperEditors`, `QuantityEntry`, `DanaPanel`, `RunChange`, `ContractorDialog`, `MiniCalendar`.

Reused rather than rebuilt: `TabStrip` for the injector tabs, `StepHeading` for the two numbered
steps, `ColorSwatch` for every colour dot, `StateView` for all four states, `ConfirmDialog` for
both removals and the delete.

`theme.css`: the feature's block was rewritten. The shared `.mp-*` pieces (panels, choice cards,
upper cards, How many?, the date picker, the trail) are unchanged; the layout is a new `.mpx-*`
set, on tokens only and within the paint set this machine's GPU draws without a first-draw stall.
Below 1280px the summary drops under the work; below 560px the table stops being a table and each
upper becomes a stacked row carrying its column's name.

Tests: `renderer/features/machineProgram/MachineProgramPage.test.tsx` (9, all passing — rewritten
for the new journey, with a new one pinning that an article added under one sole colour cannot be
moved to another). `packages/data/src/machineProgram.test.ts` (28) is untouched and still passing.
The screens were checked by screenshot in Electron against the real stylesheet.

---

## 00. Revision 2026-10-07 — no sole type, and uppers chosen by colour alone

**Built on:** `migrations/sqlite/057_machine_program_no_sole_type`, and the same files §0 lists.

The owner removed two things on 2026-10-07. Both were in the way of the same thing: saying which
uppers a machine takes, quickly, without being asked for facts the program does not need.

### A run is the sole COLOUR, the article, the size

```
before   sole (SKECHERS) → sole colour → article → size
now      sole colour → article → size
```

* `sole_types` was a master invented for that first question. Nothing asks for it any more, so the
  list, its `+ Add sole` form, `listSoleTypes` / `createSoleType` and their IPC channels are gone.
* `machine_program_runs.sole_type_id` is **kept, made nullable, and never written again**. The five
  runs saved before this date still say which sole they were made for, and `sole_types` stays as
  the target of that key. Nothing reads either. Migration 057 rebuilds the table to relax the
  NOT NULL — checked against a copy of the live database, where all 5 runs and 6 upper lines came
  through byte-identical and `PRAGMA foreign_key_check` was clean.
* The Dana panel now reads **"Dana for a BLACK sole"**, and a saved run reads **"BLACK sole"**.

### Every colour of the upper, and no supplier

Choosing SK6 7/10 shows **every SK6 7/10 upper the store holds, in every colour** — which colour
of upper goes on a sole is the operator's choice, and the sole's colour never narrows it. That was
already what `listMachineProgramUppers` returned; what changed is how it is shown and reserved:

| | Before | Now |
|---|---|---|
| A card | one per **supplier** of a colour | one per **upper** |
| It says | supplier name, kind, free | **colour**, article + size + kind, free |
| Grouping | a row per colour, cards beside it | one flat grid |
| A line is against | (upper, supplier) | the **upper** |
| Its ceiling | the supplier's free stock, capped by the upper's | the **upper's** free stock |

`machine_program_upper_lines.supplier_party_id` follows `sole_type_id`: kept for the lines that
named one, written NULL from now on. One upper is one line on a sole
(`findMachineProgramLineForItem`), so a second ADD of it still changes its quantity rather than
making a rival line.

**The reconciliation got simpler, and it reaches back.** Raw Material Output used to look for a
line naming the packet's own supplier first, and only then a line naming none. A program names no
supplier now, so the match is the material and nothing else — and the lines saved before today are
matched the same way rather than staying locked to a supplier the program no longer means. Oldest
first (program date, number, injector, run, line) is unchanged.

**What did not change:** the three figures and where they come from, that a program reserves and
never moves stock, the one-program-per-machine-per-date rule, editing in place, a scanned line
being a record, and the Dana panel — which still names suppliers, because it is showing what is
physically on the shelf rather than what is promised.

Tests: `packages/data/src/machineProgram.test.ts` (28, all passing, including *every colour of an
upper for the article and size is offered, whoever supplied it*, *a line may take everything the
store holds of the upper*, *a packet serves the oldest line for its upper, whoever supplied the
packet* and *a saved run names no sole type at all*);
`renderer/features/machineProgram/MachineProgramPage.test.tsx` (9). The screens were checked by
screenshot in Electron against the real stylesheet.

---

## 0. Revision 2026-10-05 — date, injectors, soles and uppers

> Partly superseded by §00: the sole type and the per-supplier upper lines described below are
> gone. Everything else here still holds.

**Built on:** `migrations/sqlite/050_machine_program_injectors`, `packages/domain/src/machineProgram.ts`,
`packages/application/src/machineProgramUseCases.ts` + `machineProgramEditUseCases.ts`,
`packages/data/src/database/machinePrograms.ts` / `machineProgramStock.ts` / `machineProgramWrites.ts` /
`machineProgramSql.ts`, `apps/desktop/src/renderer/features/machineProgram/`.

```
machine (+ its permanent contractor)
  └ program            one per machine per DATE        machine_programs (layout = INJECTORS)
      └ sole run       injector 1|2 · sole · sole colour · Product Master article+size
          └ upper line upper item · supplier · quantity (DOZEN)   ← the reservation
```

* **Contractor lives on the machine** (`machines.contractor_party_id`), set once, changed only
  through a confirmed "Change contractor". A program copies it (`contractor_party_id` +
  `contractor_name_snapshot`) when it is created, so history never changes.
* **One program per machine per date** — partial unique index
  `idx_machine_programs_machine_date WHERE layout='INJECTORS' AND status<>'CANCELLED'`. A second save on
  the same date adds to the first. Deleting frees the date.
* **Sole types** are a new master (`sole_types`) — nothing in the ERP named a sole before. Added
  inline ("+ Add sole"), idempotent on name.
* **Sole colours** = colours of the DANA materials (top-level category DANA, attribute `color`);
  when the store has no DANA at all (true of the live DB on 2026-10-05) every colour the store knows
  is offered. Dana is **shown, never reserved**.
* **Uppers** = top-level category UPPER whose `article` and `size` attributes equal the Product
  Master article_size **exactly** (trim + upper-case, never fuzzy). Each supplier is its own source;
  unlabelled stock is a "Supplier not recorded" source. Still subject to the route rule (hop 1 must
  be the machine's section) — live machines stand in PACKING and uppers route to PACKING.
* **Quantities are in the upper's stock unit** (DOZEN), up to 2 decimals. Physical is the balance;
  supplier split is labelled IN_STORE contents. Consumption = Σ STORE_EXIT quantity − Σ STORE_ENTRY
  quantity on events stamped `raw_material_qr_events.machine_program_upper_line_id` (a new column —
  the first-shape `machine_program_line_id` is history and no longer written).
* **Saved as it is made**: each ADD / quantity change / removal is its own transaction, re-checked
  in the write lock. Edits are in place (no cancel-and-recreate), measured against free stock plus the
  line's own reservation; never below what was scanned out. A line or sole that has ever been scanned
  is a record and cannot be removed (FKs are enforced) — lower it, or delete the program.
* **Raw Material Output** stamps the oldest matching line: exact supplier first, then program date,
  number, injector, run, line. The scan that takes the last outstanding quantity completes the
  program; a packet received back re-opens it.
* Migration 050 closed any first-shape PROGRAMMED program (reason recorded); completed ones stay as
  history.

Tests: `packages/data/src/machineProgram.test.ts` (28), `packages/domain/src/machineProgram.test.ts`,
`renderer/features/machineProgram/MachineProgramPage.test.tsx` (10). Screens were checked by
screenshot in Electron against the real stylesheet.

---

**Date:** 2026-09-29
**Status:** Implemented 2026-09-29. Superseded in part 2026-10-05 (§0).
**Built on:** `migrations/sqlite/044_machine_programs`, `packages/domain/src/machineProgram.ts`,
`packages/application/src/machineProgramUseCases.ts`, `packages/data/src/database/machinePrograms.ts`.
**Scope:** A reservation layer over raw material store stock. No change to the stock model, the
QR identity model, the packing model, or what the two scan stations physically do.

---

## 1. What it is

A Machine Program says: *between these hours, this machine, working for this contractor, will
consume this many bags of this material from this supplier.*

It is **planning, not movement** — the same relationship a Gatepass has to a carton:

| | Gatepass (cartons) | Machine Program (raw material) |
|---|---|---|
| What it reserves | cartons in the store | bags in the store |
| What consumes it | Store Move Out scan | **Raw Material Output** scan |
| Ownership stamp | `production_events.gatepass_id` | `raw_material_qr_events.machine_program_line_id` |
| Reserved | Σ (requested − dispatched) over CREATED gatepasses | Σ (bags − issued) over PROGRAMMED programs |
| Free for a new one | Current − Reserved | Physical − Reserved |

Creating a program writes **nothing** to `inventory_stock_balances`, `inventory_stock_events`,
`raw_material_qrs` or `raw_material_qr_events`. There is a test that asserts exactly that.

---

## 2. The three figures

All three live in one place — `packages/domain/src/machineProgram.ts`, beside the gatepass rules
they mirror — and every screen and query reads them from there.

```
Physical bags   the authoritative balance (inventory_stock_balances) divided by the
                material's own pack, floored. A part-pack is not a bag anybody can pick up.
Reserved        Σ over live programs' lines of (bags − issued for that line)
Available       Physical − Reserved, never below zero for a new allocation
```

### Where supplier comes from, and the honest gap

`inventory_stock_balances` has **one row per material and no supplier column**. The only place the
ERP records where a packet came from is `raw_material_qrs.party_id`, which exists once a label has
been printed and scanned in on Raw Material Input.

So the two facts are used for what each of them actually knows:

* **The balance is the authority on the total.** It moves for opening stock and for approved
  corrections, neither of which has a label behind it.
* **The labels attribute it.** Packets standing `IN_STORE` are counted per supplier.
* **The difference is reported as itself** — a row reading *"Supplier not recorded"*, with the
  note *"Stock counted in the store with no label naming a supplier."*

This was not a theoretical concern: **the live database today holds 100 DOZEN of DANA and 12 DOZEN
of rubber upper with zero QR labels**, all of it opening stock. Without the unattributed row the
page would have shown 0 bags available for everything and been unusable on day one.

A program line therefore carries `supplier_party_id`, **nullable**:

* named → the line is against that supplier's bags, and only a packet from that supplier can
  satisfy it;
* null → the line is against stock with no supplier on it, and any packet of that material may
  satisfy it — but only after an exact supplier match has been looked for.

Both ceilings are enforced on save: a line may not exceed what its **source** has free, nor what
the **material as a whole** has free.

---

## 3. What a machine may be programmed with — answered from the data, not assumed

The brief asked whether Upper should be allocatable or only shown, and said to stop and report if
the existing system could not answer it. It can:

| Material | Pack | Route (hop 1) |
|---|---|---|
| `DANA — EVA — BLACK / BLUE / GREY` | BAG of 25 DOZEN | **MACHINE** |
| `UPPER — RUBBER UPPER — SK6 — RED — 7/10` | PACKET of 2 DOZEN | **PACKING** |

A machine program reserves stock that will leave the **store** for **that machine**. So the rule
is: **a material is allocatable when the first hop of its route — where the store sends it — is
the machine's own section.**

Dana is routed to MACHINE, so it is allocatable. The upper is routed to PACKING, so it is shown
with its full figures and marked *"For information only"*, with the reason spelled out:
*"The store sends UPPER — RUBBER UPPER — SK6 — RED — 7/10 to PACKING, not to this machine."*
No fake reservation is created for it.

This is **data-driven, not hardcoded**. Route an upper to MACHINE in Raw Material → Stock and it
becomes allocatable with no code change. Equally, the reconciliation is narrowed to programs on
machines standing in the section a packet is actually being issued to, so a packet on its way to
PACKING can never consume a machine's bags.

**A machine is a new entity.** `work_sections` holds *destinations* (MACHINE, PACKING); a machine
is one unit standing inside one. Hence `machines.section_id`, and that link is what the rule above
reads.

---

## 4. Reconciliation with Raw Material Output

Raw Material Output remains the only thing that moves raw material stock. It gained one step,
inside the transaction it already had:

```
scan → IN_STORE → ISSUED
     → balance −1 pack, inventory_stock_events row          (unchanged)
     → find the oldest program still owing THIS material    (new)
         from THIS packet's supplier, on a machine in the
         section this packet is being sent to
     → stamp that line id on the STORE_EXIT event           (new)
     → if that was the program's last bag, complete it      (new)
```

The storekeeper **names nothing**. Matching is on the exact inventory identity — the material and
the packet's own supplier — never on a colour string or a timestamp. Ordering is
`(exact supplier first, then program number, then line number)`: a deterministic FIFO, with an
exact supplier match always beating an older program that named no supplier.

If nothing is waiting, the scan is an ordinary issue and no program changes. The existing generic
flow is untouched — all 38 pre-existing raw-material movement tests still pass.

**Receiving a packet back** stamps the same line on the compensating `STORE_ENTRY`, so the bag
returns to the program's outstanding quantity. A program that had been completed by that very
packet is put back in service, unless its machine has since been given another program — in which
case the completed one stays closed rather than fighting for the machine.

---

## 5. Statuses

Stored: `PROGRAMMED` → `COMPLETED` / `CANCELLED`. Only `PROGRAMMED` reserves anything, so
completing or cancelling releases by that status change alone — the gatepass rule.

**`PARTIALLY_USED` is deliberately not stored.** It is what a live program looks like once some of
its bags have been scanned out, and it is derived from the event log every time it is asked for,
so it cannot drift from what actually happened at the scanner.

A **unique partial index** (`WHERE status = 'PROGRAMMED'`) gives each machine at most one live
program, so a machine card has exactly one unambiguous state.

---

## 6. Editing and deleting

**Editing** cancels the old document and writes a new one, in one transaction — and cancels it
**before** measuring the new lines, so the program's own bags are back in circulation first.
Otherwise raising BLACK from 20 to 25 would be checked against a store that still held its own 20.
(That ordering was wrong in the first draft; the test `raising an allocation is checked against
what is available now` caught it.)

Bags already scanned out stay recorded against the document they left under. The new document
starts with nothing consumed and must fit inside what is free today.

**Deleting** cancels. The document and every line are kept, only the outstanding bags are
released, and bags already issued are never restored — they are on the machine. The confirmation
says so, and names them.

---

## 7. Reading the store when it holds hundreds of materials (revised 2026-09-29)

The first build showed each material as a block: a heading, a meta line, then one row per
supplier carrying three labelled figures. With the three materials in the database today that
read fine. With the store the owner actually expects — two kinds of Dana in forty colours, and
uppers at article × colour × size — it is a wall nobody can read, which is worse than no list.

The panel was rebuilt around **finding rather than scrolling**:

| | Before | Now |
|---|---|---|
| Per material | a block, ~5 lines | **one line**, figures on the line |
| Grouping | one heading per top kind (`DANA`) | one per **category path** (`DANA — EVA`, `DANA — EVR`) |
| Groups this machine cannot use | fully drawn | **folded**, with count and destination on the header |
| The pack | repeated on every row | said **once on the group header** when the group shares it |
| Finding something | scroll | **search** over name, attributes, code and supplier |
| Empty materials | drawn | hidden behind a checkbox — a **fully promised** one always shows |
| A very long group | fully drawn | first 25 rows + **"Show all N"** |

Measured on the rendered document (`stockPanelScale.test.tsx`): **222 materials → 42 lines**
drawn; a single group of 300 → 25 lines. No virtualisation library was added (R22) — capping,
folding and search keep the document small on their own.

Two rules were kept deliberately, because they are business facts rather than decoration:

* **Suppliers are still never merged.** Each source keeps its own chip with its own free figure,
  so `BLACK · ABC RUBBER 18 · XYZ MATERIALS 7` still reads as two different piles of bags.
* **A fully promised material still shows.** `None left · 5 BAGS in store · 5 promised` is exactly
  the explanation somebody needs when they cannot take any. Only a material with nothing in the
  store *and* nothing promised is hidden, because it has nothing to say.

A search reaches into the folded groups and opens the ones it matched — nobody would think to
open a shut group first. The add-a-colour picker got the same treatment: a compact list rather
than a grid of tiles, search above ten sources, capped at forty rows with *"N more — type to
narrow the list."*

---

## 8. The machine card (revised 2026-09-29, to the owner's design)

The owner supplied a mock-up for the card on the machine board, and it is now built to it:

```
 ╭───╮ ┌──────────────────────────────────┐
 │ 1 │ │                       MACHINE 1  │   ← the machine, small and muted
 ╰───╯ │             CONTRACTOR A         │   ← who it is running for, the headline
       │            ✓ Program ready       │   ← state, in words and a mark
       │                        40 BAGS   │
       │        [ VIEW / EDIT PROGRAM ]   │
       │      ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄     │   ← the machine's own picture,
       └────▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄────┘      breaking past the foot of the card
```

* **The number is the machine.** `machineTag()` takes the trailing number off the name
  (`MACHINE 12` → `12`); a machine the floor named something else gets its first two letters
  (`MIXER LINE` → `MI`) rather than nothing. The badge is one deep blue on every card — it is
  identity, not state — and is `aria-hidden`, because the full name is printed beside it.
* **The headline is the contractor**, because on a board of eight machines that is the thing an
  operator is looking for. An unprogrammed machine says *"No contractor yet"* in the same slot,
  so every card reads top to bottom the same way.
* **State is never colour alone**: `✓ Program ready`, `◐ Partly used`, `· Program not made`,
  with the border tint only echoing what the words already say (R18).
* **The whole card is the button.** The pill is drawn, not nested, so a gloved hand has one large
  target rather than a small one inside a big one.
* **The picture breaks out of the card** — bottom and both sides — which is what makes a card
  read as a machine before a word of it is read. It needs `overflow: visible` on the card and
  padding on the grid for the badge and the bleed to hang in.
* Every pill lands on the same line whatever a card says, because the body flexes and the action
  is pushed to its foot.

The artwork is one shared file, `renderer/assets/machines/machine.png`, copied to `dist` by the
renderer build as a tree — a new asset needs no build-script change. It is `alt=""`: every
machine shares it, so it adds nothing to read.

Kept inside the paint set this machine's GPU draws without a first-draw stall: flat fills
(the card tint is the existing `--primary-soft` token, not a new value), uniform 1px borders,
radius, and ordinary `--shadow-*`. No gradient, drop-shadow, inset ring or one-sided border.

Checked by screenshotting the real component against the real stylesheet in Electron, not by
eye over the code.

---

## 9. What was built

| Layer | File |
|---|---|
| Migration | `migrations/sqlite/044_machine_programs.{up,down}.sql` |
| Business rules | `packages/domain/src/machineProgram.ts` (+ 11 tests) |
| Use cases | `packages/application/src/machineProgramUseCases.ts` |
| Reconciliation | `rawMaterialIssueUseCase.ts`, `rawMaterialReceiptUseCase.ts` |
| Queries / writes | `packages/data/src/database/machinePrograms.ts` |
| IPC | `shared/ipcChannels.ts`, `main/ipc/machinePrograms.ts` |
| Screens | `renderer/features/machineProgram/` (9 files) + `assets/machines/machine.png` |
| Machines setup | `renderer/features/rawMaterial/MachinesPanel.tsx` |
| Tests | `packages/data/src/machineProgram.test.ts` (34), `MachineProgramPage.test.tsx` (24), `stockPanelScale.test.tsx` (7) |

`Modal.tsx` was **promoted** from the Raw Material feature to `components/shared/`, because a
second feature now needs it; the six existing imports still work through a one-line re-export.

---

## 10. Still open for the owner

1. **Should an Upper ever be allocated to a machine?** Today the routes say no, and the rule
   follows the routes. If a machine genuinely consumes uppers, the fix is to give that material a
   route through MACHINE — a data change, not a code change — but somebody has to say so.
2. **Who may write a machine program?** A new permission code `machine-program` was added, so
   nobody holds it yet except administrators. It has to be granted deliberately.
3. **Machines are seeded empty.** The floor's real machines have to be added under
   Raw Material → Setup → Machines. Names are normalised to upper case, as sections are.
4. **Should the printed sheet show the supplier?** It does, because the storekeeper reading it has
   to know which bags to bring. Say the word if the paper should be simpler.
