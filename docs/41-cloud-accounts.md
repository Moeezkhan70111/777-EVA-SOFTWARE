# 41 — Cloud accounts: one account on every PC

**Status: DESIGN, approved in outline by the owner on 2026-11-01. Being built on
`feat/cloud-accounts`. Ships only after PC2's cutover (`docs/36 §10`).**

This is `docs/37 §U.2`, built to the owner's flow of 2026-11-01. Where the two differ, this note
wins: people **sign themselves up** (U.2 had an admin create them), and they sign in with an
**email** (U.2 and today: a username). Everything else in U.2 stands, including its two binding
rules:

- **No password hash or verifier ever replicates.** A PC holds a check only for people who have
  signed in on that PC.
- **No last-write-wins on accounts.** Every change is made by a cloud function and reaches every PC
  as a numbered revision, in log order.

## 0. Decisions (owner, 2026-11-01)

| | Decision |
|---|---|
| Where people sign up | **Enrolled PCs only.** Enrolling a PC is work the owner does anyway, and every cloud function already refuses a computer that is not enrolled. No open sign-up, no anonymous accounts. |
| Sign-in name | **Email, not verified.** Nothing sends mail. The address is a name; an admin's approval is the check. A forgotten password is reset by an admin. |
| The first admin | **Set once by the owner in the SQL editor** (`make_first_admin`). Never taken from a PC's local admin: every install makes one of those on first run. |
| Existing accounts | Move without a password reset, and arrive **PENDING**. An admin approves them like anyone new. |
| Offline maximum | **7 days** (owner, 2026-10-23, unchanged). |
| Number-block ceiling | **99**, with code lists sorted by number rather than text (§9). |
| Migrations | Local **100**, cloud **020**. Cloud 020 goes to **test only**; production stays at 019 until after the cutover. |

## 1. The flow, and what happens underneath

| Step (owner) | What the software does |
|---|---|
| 1. Someone signs up on a PC with email and password. No admin present. | The PC calls `sign_up` as itself (an enrolled device). The cloud creates the person, **PENDING**, with a bcrypt verifier no client can read. |
| 2. The account lives in the cloud, not on that PC. | The cloud logs a `PERSON` revision: non-secret facts only. That PC caches its own check of the password, made locally with a fresh salt, so the person can come back to it offline. |
| 3. Until an admin acts, the account can do nothing. | The local gate is unchanged: `Authorizer.requireUser` refuses everything that is not APPROVED, and the waiting screen shows. There is no separate "Request Access" click any more: signing up **is** the request. |
| 4. The profile appears on the admin's PC, wherever it is. | Every PC applies the `PERSON` revision to its local list of people. The admin screen reads that list, so it shows even offline. |
| 5. The admin sets the role and screens, once. | One cloud function, `admin_set_access`. It needs the internet, and a **person token** proving that an admin, not merely a PC, asked. |
| 6. It applies on every PC, immediately. | A new `PERSON` revision. Online PCs get it within seconds through the log's doorbell (016). The same email and password work on any enrolled PC, online. |
| 7. Revoking once removes access everywhere. | Status **REVOKED** and a new credential version. Each PC that applies it ends that person's open sessions and wipes its cached check. |

## 2. What lives where

### In the cloud only (never sent to a PC)

| Table | Holds |
|---|---|
| `people` | id, email (unique, case-insensitive), display name, status, `is_admin`, role code, extra permissions, job role, authority level, **verifier** (bcrypt), credential version, revision, failed attempts, locked-until. Clients read nothing from it. |
| `person_tokens` | The SHA-256 of each person token, the person, the device account it is bound to, and when it expires (12 hours). |
| `account_roles`, `account_role_permissions` | The role catalogue: what each role may see. One catalogue for every PC, replacing each PC's own. |
| `account_events` | Append-only audit: who did what to whom, and from which PC. |

### In the log, to every enrolled PC

Two new aggregate types, global (they name no factory):

- **`PERSON`** — a whole snapshot of one person's non-secret facts at a revision: id, email, display
  name, status, admin, role code, extra permissions, job role, authority level, credential version.
- **`ACCOUNT_ROLE`** — a whole snapshot of one role at a revision: code, name, description, login
  policy, permissions, or "deleted".

A PC applies a revision only if it is newer than the one it holds (the pattern of
`leasedRecordContracts.ts`). An older one is a duplicate. That is what "no last-write-wins" means
in practice: the cloud numbers the changes, and nothing a PC does locally can overtake them.

### On each PC

| Table | Replicates? | Holds |
|---|---|---|
| `app_users` | **Receives** `PERSON` (never pushed from a PC) | The local list of people. **Loses its password columns** in migration 100. |
| `user_role_assignments`, `user_additional_permissions` | Receive, as part of `PERSON` | Written only by applying a revision, in cloud mode. |
| `roles`, `role_permissions` | Receive `ACCOUNT_ROLE` | Written only by applying a revision, in cloud mode. |
| **`user_credentials`** (new) | **Never** | This PC's check of a person's password: PBKDF2 hash and salt (as today), the credential version it was made at, and when it was last confirmed online. In local mode it is the password itself; in cloud mode, a cache. |
| `user_sessions`, `user_notifications` | Never | Unchanged. |

`replicationScope.ts` changes accordingly: `app_users`, `user_role_assignments` and
`user_additional_permissions` leave the exclusion list, because they no longer hold a secret and
arrive only through their contract. `user_credentials` joins it, with the reason.

## 3. Cloud functions (migration 020)

Every function is `security definer`, `search_path = ''`, and refuses a caller that is not an
enrolled, active device — the same check as `is_enrolled_device()`. None is reachable by `anon`.
Errors come back as codes, never as text containing what was typed: a password must not end up in
a log line.

| Function | Who may call | Does |
|---|---|---|
| `sign_up(email, password, display_name)` | Any enrolled PC | Creates a PENDING person. Refuses a taken email. Returns the person's snapshot. |
| `verify_login(email, password)` | Any enrolled PC | Checks the verifier. **Five failures lock the person for 15 minutes.** Success returns the snapshot and a person token bound to that PC. A PENDING person still gets a token: it proves nothing, because every admin function also checks the person. |
| `change_password(token, current, new)` | The person, signed in online | New verifier, credential version + 1. |
| `claim_existing_account(local_id, email, password, display_name)` | Any enrolled PC | Moves an existing local account (§6). Keeps its id. Arrives PENDING. Refused if the id or email is taken. |
| `admin_set_access(token, person, status, is_admin, role, extra permissions, job role, authority)` | An APPROVED admin's token | Approves, changes or revokes. Revoking also raises the credential version. |
| `admin_reset_password(token, person, new password)` | An admin's token | New verifier, credential version + 1. |
| `admin_save_role`, `admin_delete_role` | An admin's token | Edits the catalogue. A role still assigned to someone cannot be deleted. |
| `admin_import_roles(token, roles)` | An admin's token, **once** | Copies a PC's existing role catalogue up, only while the cloud has none. |
| `make_first_admin(email)` | **Nobody but the owner**, in the SQL editor | Makes one person an approved admin. Refused once any admin exists. No client role has EXECUTE. |

**Guards that hold in the cloud, whatever a screen does:** an admin cannot revoke or demote
themselves, and the last approved admin can never be revoked or demoted.

## 4. Signing in

| Situation | Rule | What the person sees |
|---|---|---|
| Online | The cloud checks, every time. The PC's cache is refreshed. **A cloud "no" is final**: the cache is never tried after a refusal. | Wrong password: "Wrong email or password." Locked: "Too many attempts. Try again in 15 minutes." |
| Offline, signed in here before | The cache is accepted only if its credential version equals the latest this PC has applied, the person is APPROVED or PENDING here, **and** it was last confirmed online within 7 days. | Signed in as normal. |
| Offline, never signed in here | Refused. Nothing on this PC can check the password, by design. | "This computer needs an internet connection the first time you sign in here." |
| Offline, cache older than 7 days | Refused. | "You have not signed in online on this computer for 7 days. Connect to the internet to sign in." |
| Signing up offline | Refused. The account lives in the cloud. | "Creating an account needs an internet connection." |
| PENDING | Signed in to the waiting screen, as today. | The waiting screen, without the "Request Access" button. |
| REVOKED | Refused online; offline, the cache was wiped when the revocation arrived. | "Your access has been removed. Ask an administrator." |

**The window, stated plainly:** a PC that was offline when someone was revoked accepts that person
until it next syncs, for at most 7 days. Any offline sign-in has a window like this; the 7 days
bound it.

**And the other side of it:** nobody can sign in on a PC that has been offline for more than 7
days. That is the same 7 days, accepted on 2026-10-23.

## 5. When a revision arrives on a PC

All in the applier's one transaction:

1. Upsert the person into `app_users`, and their role and extra permissions into the two
   assignment tables. Recalculate their effective permissions (`persistEffectivePermissions`).
2. If the credential version went up: delete this PC's `user_credentials` row for them.
3. If the status is REVOKED or REJECTED: revoke their open sessions on this PC. The renderer
   finds the session gone on its next call and returns to sign-in.

## 6. Moving the accounts that already exist

PC2 holds the real accounts. On each person's **next online sign-in on PC2**:

1. The password is checked locally, against the PBKDF2 hash, as today.
2. If the account has no email, they are asked for one.
3. `claim_existing_account` creates them in the cloud **with their existing id**, PENDING, so every
   record that already names them still names the same person.
4. The admin approves them. The approval screen offers their **old role and permissions from this
   PC** as a starting point, so nobody has to remember them.

**The first admin**, once, on each project: the owner signs in (or up) online, then runs
`select public.make_first_admin('<email>');` in the SQL editor. On that admin's next online sign-in
on PC2, the app offers to copy PC2's role catalogue up (`admin_import_roles`).

## 7. Two modes, one switch

A PC stays in **local mode** (today's behaviour, unchanged) until it is enrolled **and** its cloud
project answers the account functions. It then switches to **cloud mode** once, recorded in
`app_settings` (`accounts.mode`), and never switches back by itself.

In cloud mode:

- The first-run "create the administrator" screen is gone. On a PC in local mode it remains,
  because that PC is connected to nothing.
- Local account-changing actions (create, approve, assign a role, revoke, change a password) go to
  the cloud functions. The local writes behind them are reached only by applying a revision.
- A PC still on a version without cloud mode keeps its local accounts, and the cloud does not know
  them. Nothing breaks, but that PC is outside the scheme until it updates, so every PC moves to the
  release together.

## 8. Not in this work

- **Permission requests** (a user asks for one more screen). Per-PC today. In cloud mode they need
  to reach the admin wherever they are. Left as they are for now, and decided before release.
- **Email verification and "forgot password" by email.** They need mail sending. An admin resets.
- **Notifications across PCs.** `user_notifications` stays per PC.
- **In-app enrolment** (`docs/37 §U.1`). Enrolment stays the owner's procedure (`docs/36 §7.6`).

## 9. Number-block ceiling: 5 → 99

`MAX_ASSIGNABLE_BLOCK` (`numberRange.ts`) is the only limit. The cloud (018) requires a block of 1
or more and one computer per block, and no more, so the change needs **no migration**. A block is
used up for good by every installation that ever holds it (018: a block never moves by itself), so
the ceiling counts installations over the company's life, not PCs in service.

| Blocks | Document numbers | Carton serials |
|---|---|---|
| 1–10 | Six digits, as today (`GP-999999` at most) | Six or seven digits, as blocks 2–5 already are |
| 11–99 | Seven digits (`GP-1000000`) | Eight digits |

Blocks 1–10 see no change. For blocks 11 and up:

- **Code lists sorted as text** put `PTY-1000000` before `PTY-200000`. Every sort of a numbered
  code becomes a sort by its number. Worth doing regardless: the first seven-digit code would show
  it.
- **Printed slips and labels** are checked for one more digit.
- **Scanning** is unaffected: the parsers read any number of digits.
- `check_number_blocks.sql` stops using blocks 7–9 as test values, since they become real.

## 10. Order of work

1. This note.
2. Cloud 020 and `check_accounts.sql`, on **test** only.
3. Local migration 100: `user_credentials`, `app_users` without password columns, `accounts.mode`.
4. The `PERSON` and `ACCOUNT_ROLE` contracts, and the sign-in rules (§4).
5. The admin screen in cloud mode, and the waiting screen without its button.
6. The block ceiling and numeric sorting (§9), at any point.

Nothing here ships before PC2's cutover: migration 100 would move PC2 off schema 099, which the
rehearsed cutover depends on (`docs/36 §10.5`).
