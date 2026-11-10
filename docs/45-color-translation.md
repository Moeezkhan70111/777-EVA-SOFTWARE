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

## Verified before release (10 Nov 2026)

- **Local 106** on isolated copies: v0.4.6 snapshot (102 → 106 in one start), v0.5.0 snapshot (105 → 106), a cloud
  workstation (104 → 106). Every existing table identical except the expected backup and migration rows; every outbox
  row and its delivery state identical; integrity and foreign keys clean; an existing local user signs in; restart
  clean; v0.5.0 refuses the 106 database untouched; the down script returns it to 105 and v0.5.0 opens it.
- **Cloud 029** on TEST, inside a rolled-back block (`check_color_translations.sql`, 9 steps): before 029 a colour is
  `UNKNOWN_RECORD_TYPE` while a party in the same call lands; after it, lease enforcement, revision rules
  (DUPLICATE / REVISION_CONFLICT / UPDATED / SUPERSEDED), deletion, other types unchanged, takeover refusal, unscoped
  log rows readable by an enrolled device under RLS, no client write on the type tables. Nothing kept on TEST.
- **Two computers** (`packages/sync/src/colorTranslationSync.test.ts`): add, edit, delete propagate; offline and
  restart; before-029 wait without holding anything up; lease and duplicate rules.
- **A real v0.5.0 build** receiving colour events: refused permanently, nothing parked, everything else applied, cursor
  moves on, next pull clean. **Not re-delivered after it upgrades**: an edit made while a computer was still on 0.5.0
  is missed there until the colour is saved again on the master-data computer. The sequence below prevents this.

## Release sequence

1. Publish v0.5.1: Actions → *Release Windows installer* → tag `v0.5.1`. Check the release shows 0.5.1 with its
   installer and `latest.yml` reading `version: 0.5.1`.
2. Wait until **every** enrolled computer runs 0.5.1 (production, read only):
   `select device_id, label, last_seen_version, last_seen_at from device_accounts where is_active order by label;`
   Until 029, colour changes stay on the computer that made them, queued; the 23 seeded colours are already the same
   everywhere. Avoid editing colours until step 5 is done.
3. Apply 029 to **TEST** (SQL editor, whole file). Run `check_color_translations.sql` there: expect
   `COLOR_TRANSLATIONS_CHECK_PASSED`.
4. Production pre-check (read only), all must hold:
   `select count(*) from leased_record_types;` → 18 ·
   `select count(*) from leased_record_types where aggregate_type = 'COLOR_TRANSLATION';` → 0 ·
   `select domain from domain_leases where domain = 'MASTER_DATA';` → one row.
5. Apply `029_color_translation_records.up.sql` to **production** in the SQL editor, whole file (one transaction).
   Post-check: both counts above now 19 and 1; `has_table_privilege('authenticated','public.leased_record_types','INSERT')`
   and the same for `sync_aggregate_types` → false. Never run `check_*.sql` on production.
6. Watch the master-data computer's outbox: any queued `COLOR_TRANSLATION` rows go to SYNCED; the other computers show
   the same list.
7. If a computer was still on 0.5.0 when a colour change reached the cloud: open that colour on the master-data computer
   and save it again (a new revision).

**Rollback.** Cloud 029 adds two rows and nothing else; its down script is refused once a colour revision exists, and
leaving it in place is harmless. Locally the application has no downgrade: each computer keeps
`erp-premigration-105-to-106-*.sqlite` in its backups folder (or 102-to-106 from 0.4.6); restoring it loses work done
since. The 106 down script exists for a hand rollback and was rehearsed.

## Corrections learned on one computer

Before this list, correcting a material's Urdu colour also remembered it in that computer's browser storage
(`erp_learned_color_urdu_words`). Nothing writes there any more. It is still read, so nothing is lost: it fills in
colours the list does not name, and the Color Translation page lists every learned correction the list lacks or
disagrees with ("Corrections saved on this computer only"), for a person to add or resolve. The list wins wherever
it names the colour. A correction typed on one material is still saved on that material and still wins on its label.
