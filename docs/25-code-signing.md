# Windows code signing — what is blocking distribution, and how to fix it

> Written 2026-10-10, after Smart App Control blocked `777 ERP Setup 0.2.0.exe` on the
> owner's machine. The application itself ran; only the installer was refused.
> Revised the same day after an independent review of the configuration — §4 records what
> that review corrected.
>
> Nothing here has been purchased and no account has been opened. The configuration in
> `apps/desktop/electron-builder.yml` is in place and inert until credentials exist.

## 1. The gap, precisely

Every executable 777 ERP ships is unsigned. Verified against the 0.2.0 build:

| Artifact | State |
|---|---|
| `777 ERP Setup 0.2.0.exe` (installer) | **unsigned** |
| `777 ERP.exe` (the application) | **unsigned** |
| `resources\elevate.exe` (NSIS helper) | **unsigned** |
| `Uninstall 777 ERP.exe` (written at install time) | **unsigned** |
| `dxcompiler.dll`, `ffmpeg.dll`, `libEGL.dll`, `libGLESv2.dll`, `vk_swiftshader.dll`, `vulkan-1.dll` | **unsigned** — these ship unsigned from the Electron project |
| `d3dcompiler_47.dll`, `dxil.dll` | already validly signed by Microsoft — leave them alone |

Nine artifacts need our signature. Two are already signed by their vendor and must not be
re-signed.

**Signing the installer alone is not enough.** By default electron-builder signs only the main
executable and the installer artifacts, which would leave six unsigned DLLs inside a
nominally signed app. `win.signExts: ['.dll', '.node']` closes that.

## 2. Smart App Control vs SmartScreen — they are not the same gate

These get conflated constantly, and the difference decides what is worth buying.

| | What it does | What satisfies it |
|---|---|---|
| **Smart App Control** | Blocks execution outright. No "Run anyway". On by default only on clean Windows 11 installs, and it moves from evaluation to enforcement on its own. | A **valid signature from a CA in the Microsoft Trusted Root Program**. Microsoft states that when its app-intelligence service cannot make a prediction, SAC "will still allow an app to run if it is signed with a certificate issued by a certificate authority within the Trusted Root Program… even when cloud reputation is not yet established." |
| **SmartScreen** | Shows a warning the user can click past. | **Reputation**, accrued from clean download volume over weeks. A signature alone does not remove the first-run warning. |

So a certificate is expected to remove the hard block, and to *reduce but not immediately
eliminate* SmartScreen friction. Reputation then accumulates across releases **only if every
release is signed with the same identity**.

Smart App Control supports both RSA and ECC certificates.

**Still unproven here.** This is Microsoft's documented behaviour, not an observed result —
there is no certificate to test with. Treat SAC acceptance as expected, not demonstrated,
until a signed build has actually run on a SAC-enforcing machine.

A domestic Pakistani CA such as **NIFT does not help**. NIFT certificates exist for SECP
e-filing and are not in the Microsoft Trusted Root Program, so Windows will not trust them
for code signing.

## 3. Which certificate, and from whom

**Azure Artifact Signing (formerly Trusted Signing) — ~$9.99/month — is not available to us.**
Microsoft limits it to organisations in the USA, Canada, the EU and the UK. 777 / T&T Traders
is in Pakistan. Re-check if that list widens; at that price it would be the obvious answer.

**EV is not worth the premium.** Microsoft's own documentation: *"EV certificates no longer
bypass SmartScreen… Paying a premium for EV solely to avoid SmartScreen warnings is no longer
justified."* That changed in 2024. EV still matters for kernel-mode driver signing, which we
do not do.

Since June 2023 the CA/Browser Forum requires the private key of **any** publicly trusted code
signing certificate — OV included — to live on FIPS 140-2 Level 2 hardware. There is no
"just a .pfx on the build machine" option any more. The real choice is **USB token vs cloud
HSM**, and for us it is cloud: a token must be physically plugged into whichever machine cuts
the release, which is fragile in a one-person shop and impossible in CI.

### Candidate providers

Prices are vendor list prices gathered 2026-10-10 and will vary by term and reseller. They are
**estimates, not quotes**.

| Provider | OV price (list) | Key storage | Remote signing works with signtool/electron-builder? | Pakistan eligibility |
|---|---|---|---|---|
| **SSL.com** (OV + eSigner) | ~$129/yr, lower on multi-year | eSigner cloud HSM; no token, no attestation fee | Yes — eSigner is designed for CI and standard Authenticode | **Unverified.** No published country restriction found; must be confirmed before paying |
| **Certum** (Standard Code Signing in the Cloud) | ~€209 / ~$249 | SimplySign cloud, presented to Windows as a virtual smart card | Yes — works directly with `signtool.exe`, so electron-builder's `certificateSubjectName` path applies | **Unverified.** Certum is Polish and EU-focused; non-EU acceptance not published |
| **DigiCert** (KeyLocker) | List price not published; quote required | KeyLocker cloud HSM, FIPS 140-2 **Level 3** | Yes — KeyLocker is built for automated pipelines | **Unverified.** Global CA, most likely to have a Pakistan process, but confirm |
| Sectigo / resellers (SignMyCode, CodeSigningStore, SSL Dragon) | ~$215–270/yr advertised | token or cloud depending on SKU | varies by SKU | **Unverified** |

**The eligibility column is the honest answer: no CA publishes a "we serve Pakistan" statement
one way or the other.** Pakistan is not a sanctioned jurisdiction, and global CAs do validate
international entities against government registries, so this is very likely workable — but
it is not evidenced, and it is the one thing that must be settled before any money moves.

Validation will need the exact SECP-registered legal name, a verifiable physical address (no
PO box), and a phone listing the CA can call. Allow several business days, longer for a
first-time applicant from a country the CA sees rarely.

## 4. What the independent review corrected

The first pass of this configuration had three defects, all found by checking
electron-builder 26.15.3's own schema and source rather than its documentation:

1. **Timestamping was described as newly enabled. It was already the default.**
   electron-builder defaults both timestamp servers to `http://timestamp.digicert.com`. The
   setting is still written out explicitly — a signature without a timestamp dies when the
   certificate expires, which is too important to leave implicit — but it pins a default
   rather than switching something on. The value was also changed from Sectigo's TSA back to
   the default DigiCert one, because picking a TSA from a CA we have not chosen was arbitrary.
2. **`timeStampServer` was redundant and has been removed.** signtool uses `/t` with it only
   for the SHA-1 pass; with `signingHashAlgorithms: ['sha256']` the SHA-1 pass never runs.
   Leaving it in implied it did something.
3. **Nothing could tell a signed build from an unsigned one.** See below — this was the real
   gap, and `scripts/verify-signatures.mjs` was added to close it.

`signingHashAlgorithms: ['sha256']` is a genuine improvement worth keeping: the default is
`['sha1','sha256']`, and SHA-1 Authenticode is deprecated.

### Why a verification script, and not just `forceCodeSigning`

electron-builder is forgiving about signing in two ways that matter:

- When a file cannot be signed it logs `signing failed for file, queue will continue to next
  file` as a **warning** and carries on. A release can therefore finish "successfully" with
  some binaries unsigned.
- The line `signing with signtool.exe path=…` is printed **before** signing is attempted, so
  it appears for every artifact even when no certificate exists at all. The build log cannot
  be read as evidence that anything was signed.

`npm run verify:signatures` inspects the finished artifacts instead, which is the only thing
that cannot lie. **No artifact may be called distributable until this gate exits 0.**

It reports every PE file plus the installer and **fails closed** — anything it cannot
positively verify, including its own errors, counts as a failure. It fails on:

- any required artifact unsigned, or in any state other than `Valid`
- a valid signature with **no timestamp** (the signature would die with the certificate)
- a **self-signed** certificate, detected as subject equal to issuer — a test certificate
  installed into the local trusted root reports `Valid` to Windows, and this is what stops
  that passing for a real release
- a signer that is not the expected publisher, when one is supplied via `--publisher` or
  `ERP_EXPECTED_PUBLISHER`
- **more than one signing identity** in a single release, which splits reputation
- a vendor-signed file that is no longer validly signed

The two Microsoft-signed DLLs (`d3dcompiler_47.dll`, `dxil.dll`) are recognised and not
re-signed.

Behaviour verified by test on 2026-10-10, against the real build and against deliberately
broken inputs:

| Case | Result |
|---|---|
| Real unsigned build | FAILED, exit 1, all 9 artifacts named; the 2 vendor-signed DLLs correctly exempt |
| Genuinely signed + timestamped binary | **PASSED, exit 0** — the success path works, not just the failure path |
| Correct `--publisher` | PASSED, exit 0 |
| Wrong `--publisher` | FAILED, exit 1, names both actual and expected |
| Missing release directory | FAILED, exit 1 |
| Malformed/unreadable PE file | FAILED, exit 1, reported per file |
| File deleted mid-run (PowerShell throws) | FAILED, exit 1, **no stack trace** — handled, other files still reported |
| `powershell.exe` unavailable | FAILED, exit 1, detected up front |

### `forceCodeSigning`

**Do not enable it yet.** With no credentials present it fails every build, including ordinary
development ones. Enable it **in the same change that introduces the certificate** — it is
left in the config, commented, at the right place. It and the verification script are belt and
braces: `forceCodeSigning` fails the build at signing time, the script catches anything that
slips past afterwards.

## 5. How signing is wired in

`apps/desktop/electron-builder.yml`, `win:` section. **No credential is in the file or in git.**

electron-builder reads them from the environment at build time:

```
CSC_LINK           path to the .pfx, or its base64
CSC_KEY_PASSWORD   its password
```

For a token or cloud HSM where the key cannot be exported, set
`signtoolOptions.certificateSubjectName` or `certificateSha1` instead and let the provider's
driver supply the key. This is the path Certum SimplySign and most token setups use.

Configured and verified against the 26.15.3 schema:

- `signExts: ['.dll', '.node']` — covers the six unsigned Electron DLLs
- `rfc3161TimeStampServer` — pinned
- `signingHashAlgorithms: ['sha256']`

Left for whoever holds the certificate:

- `publisherName` — must equal the certificate's subject CN **exactly**. Deliberately not
  guessed, because a wrong value breaks signature verification quietly instead of failing loudly.
- `forceCodeSigning: true` — uncomment at the same time.

`.gitignore` now blocks `.env`, `*.pfx`, `*.p12`, `*.pem`, `*.key`, `*.cer`, `*.crt`, `*.spc`
and `*.pvk`. Verified that no legitimate tracked file matches those patterns.

## 6. Producing a signed release

1. Make the certificate available to the build machine — cloud-HSM credentials exported as
   environment variables **in the shell only**. Never in a file in the repo, never in a
   committed script, never echoed to the terminal.
2. Set `publisherName` to the certificate's exact CN and uncomment `forceCodeSigning: true`.
   Commit that — neither is a secret.
3. Bump `version` in `apps/desktop/package.json`.
4. From the repository root: `npm run package:win`.
5. **`npm run --workspace @erp/desktop verify:signatures`** — must print PASSED and exit 0.
   Do not skip this because the build succeeded; the build succeeding means nothing here.
6. Cross-check the chain independently:
   ```powershell
   signtool verify /pa /v /all "apps\desktop\release\777 ERP Setup <version>.exe"
   ```
   This validates the full certificate chain and the timestamp, which
   `Get-AuthenticodeSignature` alone does not fully cover.
7. Install on a machine with Smart App Control **enforced** — the build machine is not a
   valid test unless SAC is enforced there too.
8. Keep signing every subsequent release with the same certificate, or reputation restarts.

Known limitation: the uninstaller only exists inside the installer, so
`verify:signatures` cannot inspect it directly. Confirm it after an install by running
`Get-AuthenticodeSignature` against `Uninstall 777 ERP.exe` in the install folder.

## 7. If a certificate is not bought

The fleet is small and known, so distribution does not have to go through the public trust
system at all:

- **Most machines will not have Smart App Control enforced.** It only self-enables on clean
  Windows 11 installs. There the unsigned installer works today, with a SmartScreen warning
  the operator clicks past.
- **Copying the unpacked build** (`release\win-unpacked\`) runs even under enforced SAC — this
  is how 0.2.0 reached the owner's machine on 2026-10-10. No Start Menu entry, no uninstaller:
  a workaround, not a deployment method.
- **Do not turn Smart App Control off.** On Windows 11 it cannot be turned back on without
  reinstalling Windows.

The cost of waiting is friction and a weaker security posture, not a blocked rollout.

## 8. Open points

- **Confirm CA eligibility for a Pakistani entity before paying.** This is the one genuine
  unknown. Inquiries to SSL.com and DigiCert are written and ready to send in
  **`docs/25a-provider-inquiries.md`** — they need four blanks filled (legal name, SECP
  number, address, phone) and have not been sent.
- Confirm the exact registered legal name and address — it becomes the publisher name every
  operator sees.
- Decide cloud HSM vs token. Cloud costs more and is worth it the moment a second machine or
  CI builds releases.
- Re-check Azure Artifact Signing's country list periodically.
- Certum note: from 2026-02-27 a code signing certificate may be valid for at most 459 days,
  so multi-year purchases involve reissues. Factor that into any multi-year quote.
