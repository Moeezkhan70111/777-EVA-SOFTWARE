# Code-signing provider inquiries — ready to send

> **ON HOLD as of 2026-10-10.** The owner decided 777 ERP is for internal use on company
> machines only, with no commercial distribution, and that no certificate will be bought and
> no CA contacted. Nothing here has been sent and nothing should be sent without a new
> decision. Kept because the questions stay correct if that changes — see `docs/26` for the
> internal deployment strategy adopted instead.

> Prepared 2026-10-10. **Nothing has been sent.** No account has been created, no document
> uploaded, no payment made. Send these yourself, or authorise me to.
>
> Why they exist: eligibility for a Pakistani entity is the one genuine unknown in
> `docs/25-code-signing.md`. No CA publishes a position either way, so it has to be asked.
> Settle it **before** paying, not after.

## Before sending — fill in these four blanks

Both messages contain the same placeholders. Replace them everywhere:

| Placeholder | What to put |
|---|---|
| `[LEGAL NAME]` | the exact company name as registered with the SECP, character for character |
| `[SECP REG NO]` | the SECP registration / incorporation number |
| `[ADDRESS]` | the registered physical address — not a PO box |
| `[PHONE]` | a landline the CA can call, ideally one that appears in a public directory |

The legal name matters beyond the form: it becomes the publisher name every Windows user
sees, and it must match `publisherName` in `electron-builder.yml` exactly.

---

## 1. SSL.com — primary

**Send to:** sales via https://www.ssl.com/contact/ (or `sales@ssl.com`)
**Subject:** OV code signing certificate + eSigner for a Pakistan-registered company

> Hello,
>
> We are a manufacturing company registered in Pakistan with the Securities and Exchange
> Commission of Pakistan (SECP). We distribute a Windows desktop application internally to
> our own factory computers and need Authenticode code signing, primarily because Windows
> Smart App Control blocks our unsigned installer.
>
> Before we proceed, could you confirm the following:
>
> 1. **Eligibility.** Do you issue OV (Organization Validation) Authenticode code signing
>    certificates to a company registered in Pakistan? Are there any country restrictions
>    that would prevent issuance to us?
> 2. **Validation documents.** Exactly which documents do you require for a Pakistani entity?
>    We can provide the SECP certificate of incorporation, a National Tax Number certificate,
>    a bank letter and utility bills. Do you require a D-U-N-S number or a third-party legal
>    opinion letter? How is the verification phone call handled for a non-US number?
> 3. **eSigner.** Does eSigner cloud signing support an OV code signing certificate issued to
>    a Pakistani organisation, with no hardware token shipped to us? We would prefer cloud
>    signing specifically to avoid shipping a USB token to Pakistan.
> 4. **Workflow compatibility.** We sign with `signtool.exe` driven by electron-builder on
>    Windows. We need to sign roughly 12 files per release (one .exe, several .dll files, an
>    installer and an uninstaller), a handful of releases per year. Does eSigner work with a
>    standard `signtool` invocation in that setup, and is there a non-interactive mode
>    suitable for an automated build?
> 5. **RFC 3161 timestamping.** Is RFC 3161 timestamping included, and which timestamp
>    authority URL should we use?
> 6. **Total cost.** Please quote the full first-year cost and the recurring annual cost,
>    including: the OV certificate, the eSigner subscription tier appropriate for roughly
>    100–200 signatures per year, and any one-off validation, attestation or shipping fees.
>    We would like the all-in figure, not the certificate price alone.
> 7. **Renewal and reissuance.** What is the certificate's maximum validity, what does
>    renewal cost, and does re-validation have to be repeated each time? If a multi-year
>    purchase requires reissues during the term, please say so.
> 8. **Timeline.** How long does validation typically take for a first-time applicant from
>    Pakistan?
>
> Company details for eligibility assessment:
> Legal name: [LEGAL NAME]
> SECP registration number: [SECP REG NO]
> Registered address: [ADDRESS]
> Telephone: [PHONE]
>
> Thank you,
> [YOUR NAME], [LEGAL NAME]

---

## 2. DigiCert KeyLocker — fallback

Send this only if SSL.com declines or cannot confirm eligibility. DigiCert does not publish
KeyLocker pricing, so a quote is required either way.

**Send to:** https://www.digicert.com/contact-us (Sales — Software Trust Manager / KeyLocker)
**Subject:** OV code signing + KeyLocker quote for a Pakistan-registered company

> Hello,
>
> We are a manufacturing company registered in Pakistan with the Securities and Exchange
> Commission of Pakistan (SECP), distributing a Windows desktop application to our own
> factory computers. Our unsigned installer is blocked by Windows Smart App Control, so we
> need Authenticode code signing.
>
> Could you confirm:
>
> 1. **Eligibility.** Do you issue OV Authenticode code signing certificates to a company
>    registered in Pakistan? Are there country restrictions that would prevent this?
> 2. **Validation documents.** Which documents are required for a Pakistani entity, and is a
>    D-U-N-S number or legal opinion letter mandatory? How is the verification call handled
>    for a Pakistani telephone number?
> 3. **KeyLocker.** Can the certificate be held in DigiCert KeyLocker rather than on a
>    shipped hardware token? We want to avoid international shipment of a USB token.
> 4. **Workflow.** We sign with `signtool.exe` via electron-builder on Windows — about 12
>    files per release (.exe, .dll, installer, uninstaller), a few releases per year. Does
>    KeyLocker support that through its signing client, non-interactively?
> 5. **Signature allowance.** We understand KeyLocker includes 1,000 signatures per
>    certificate year. Please confirm, and state the cost of additional blocks if exceeded.
> 6. **RFC 3161 timestamping.** Included? Which timestamp URL?
> 7. **Pricing.** Please quote the total first-year cost and the recurring annual cost,
>    covering the OV certificate, the KeyLocker service fee and any one-off validation fees.
> 8. **Renewal.** Maximum certificate validity, renewal cost, and whether re-validation is
>    required at renewal.
> 9. **Timeline.** Expected validation time for a first-time Pakistani applicant.
>
> Company details:
> Legal name: [LEGAL NAME]
> SECP registration number: [SECP REG NO]
> Registered address: [ADDRESS]
> Telephone: [PHONE]
>
> Thank you,
> [YOUR NAME], [LEGAL NAME]

---

## 3. Comparing the replies

Decide on the **all-in annual** figure, not the headline certificate price. Capture for each:

| | SSL.com | DigiCert |
|---|---|---|
| Issues to a Pakistani SECP entity? | | |
| Documents required | | |
| Cloud signing without a token? | | |
| Works with signtool / electron-builder non-interactively? | | |
| RFC 3161 timestamp URL | | |
| First-year total | | |
| Recurring annual total | | |
| Max validity / reissue obligations | | |
| Validation time | | |

Reject any offer that requires a shipped USB token unless both decline cloud signing — a
token must be physically present for every release and cannot be used from a second machine
or a build server.

## 4. Do not do these while enquiring

- Do not upload identity documents until eligibility is confirmed in writing.
- Do not pay before confirming the **all-in** recurring cost.
- Do not accept a certificate issued to a personal name rather than the company — the
  publisher name is what operators see.
- Do not let a reseller substitute a different CA's product without saying so.
