# 45 — Color Translation: one English-to-Urdu colour list

**Status (2026-11-10):** built on `feat/carton-stock`, uncommitted. Local migration 106. Cloud migration 029 prepared,
**not applied** to test or production.

## What it is

A colour is stored in English everywhere it already is: a product variant's colour, a carton's QR identity, a
material's Colour attribute. The factory floor reads colours in Urdu. The **Color Translation** page (Setup →
Color Translation) holds the one list that says what each English colour is called in Urdu. Every place that shows
a colour in Urdu reads it:

| Where | Unknown colour |
|---|---|
| Carton Stock matrix headers | shown in English, as stored |
| Carton sticker, raw material label | spelled out in Urdu sound by sound (unchanged behaviour: a label must print Urdu) |
| Add Material colour field | English typed → Urdu filled in; Urdu typed → English filled in; Urdu the list cannot read back is refused |
| Add Material colour dropdown | each option shows `ENGLISH · اردو` when the list names it |

Nothing stored changes when the list changes: no stock, carton, material or synchronisation payload is rewritten.

## Rules (`@erp/domain` colorTranslation.ts)

- English keys are case-insensitive and whitespace-safe (`normalizeColorKey`). One English key, one mapping:
  enforced by a UNIQUE index and refused as `DUPLICATE_ENGLISH`.
- Urdu is kept exactly as entered, trimmed. It is never normalised.
- Compounds are named word by word ("CREAM MUSTARD"), and run-together carton colours piece by piece ("BLACKRED").
- Urdu → English: an Urdu name two English colours share ("گرے" is Grey and Gray) is ambiguous; a dropdown's own
  options settle it.

## Storage and sync

`color_translations` (local 106) is master data: a `COLOR_TRANSLATION` leased record under `MASTER_DATA`, captured
by trigger, sent whole by revision like every other master record (docs/37). Writes need Settings or Raw Material
Setup and the master-data lease.

Every computer is seeded with the same 23 rows under fixed ids (`color:<key>`), so the same colour is the same
record everywhere; the seed is not queued. The 23 are the owner's 15 of 2026-11-10 and the 8 the raw material
label's built-in dictionary had besides (Brown, Cream, Skin, Army, Green, Sky, Gray, Mustard). The 10 names both
lists had are spelled identically, code point for code point. "Army Green" equals "Army" + "Green".

**Until cloud 029 is applied**, a colour revision is answered `UNKNOWN_RECORD_TYPE` and waits (transient) without
holding up anything else. Apply 029 to TEST first, then production in its own window.

## Corrections learned on one computer

Before this list, correcting a material's Urdu colour also remembered it in that computer's browser storage
(`erp_learned_color_urdu_words`). Nothing writes there any more. It is still read, so nothing is lost: it fills in
colours the list does not name, and the Color Translation page lists every learned correction the list lacks or
disagrees with ("Corrections saved on this computer only"), for a person to add or resolve. The list wins wherever
it names the colour. A correction typed on one material is still saved on that material and still wins on its label.
