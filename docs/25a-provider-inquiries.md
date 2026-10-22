# Code-signing provider inquiries — ready to send

> **OV CODE-SIGNING INQUIRY — DRAFT PREPARED, NOT SENT.** Owner selected the
> company-validated route. Pakistan eligibility, payment acceptance and issuance timing remain
> unconfirmed. No provider contacted and no purchase authorized.

> **Decision history — kept deliberately, not superseded silently.**
>
> * **2026-10-10 — on hold.** The owner decided 777 ERP was for internal use on company
>   machines only, with no commercial distribution, and that no certificate would be bought and
>   no CA contacted. That note pointed at `docs/26` for the strategy adopted instead; `docs/26`
>   is in fact the Phase 1a migration plan, so the cross-reference was wrong and is not repeated.
> * **2026-10-21 — reopened; OV chosen.** A signed release is wanted so Windows shows the
>   **company** as publisher. That rules out an individual-validated (IV) certificate, which
>   would name a person, and it keeps Pakistani organization eligibility as the open question.
>   §1a below is the inquiry to send. **It has not been sent.**

> Prepared 2026-10-10. **Nothing has been sent.** No account has been created, no document
> uploaded, no payment made. Send these yourself, or authorise me to.
>
> Why they exist: eligibility for a Pakistani entity is the one genuine unknown in
> `docs/25-code-signing.md`. No CA publishes a position either way, so it has to be asked.
> Settle it **before** paying, not after.

## Before sending — fill in these blanks

Each message below contains the same placeholders. Replace them everywhere:

| Placeholder | What to put |
|---|---|
| `[LEGAL NAME]` | the exact company name as registered with the SECP, character for character |
| `[SECP REG NO]` | the SECP registration / incorporation number |
| `[ADDRESS]` | the registered physical address — not a PO box |
| `[PHONE]` | a landline the CA can call, ideally one that appears in a public directory |
| `[YOUR NAME]` | the authorized representative submitting the application |
| `[EMAIL]` | a business email address on the company own domain, if one exists |

The legal name matters beyond the form: it becomes the publisher name every Windows user
sees, and it must match `publisherName` in `electron-builder.yml` exactly.

---

## 1a. SSL.com — revised OV inquiry (2026-10-21, UNSENT)

**This is the current version. Send this one, not §1.** §1 is the 2026-10-10 draft, kept for
history; this revision adds five questions whose absence would each have cost a round trip.

**Send to:** sales via https://www.ssl.com/contact/ (or `sales@ssl.com`)
**Subject:** OV code signing certificate + eSigner for a Pakistan-registered company

> Hello SSL.com Code Signing Team,
>
> We are preparing to sign a Windows desktop ERP application for internal deployment on
> company-owned computers. We are evaluating an Organization Validated (OV) Code Signing
> Certificate with your eSigner cloud signing service.
>
> Before purchasing, we need to confirm eligibility and the practical requirements for an
> organization based in Pakistan.
>
> **1. Pakistan eligibility and organization validation**
>
> * Can a Pakistan-registered business obtain your OV Code Signing Certificate?
> * Which company registration documents do you require for a Pakistani entity? Would SECP
>   registration documents be sufficient?
> * Do you require a D-U-N-S number, a third-party legal opinion, a publicly listed business
>   telephone number, or any additional documentation?
> * Can your verification team complete validation using a Pakistani business address and
>   telephone number?
>
> **2. Identity and validation process**
>
> * Which identity documents are required from the authorized representative?
> * Is a telephone verification call to a Pakistani number supported?
> * What are the standard and expedited validation timelines for a Pakistani applicant?
>
> **3. eSigner cloud signing**
>
> * Can an OV Code Signing Certificate issued to a Pakistani organization be used with eSigner?
> * Does eSigner meet the applicable hardware-backed private-key storage requirements for
>   publicly trusted code-signing certificates?
> * Can eSigner integrate with `signtool.exe` and an Electron Builder Windows packaging
>   workflow?
> * What client software, drivers, environment variables or signing configuration would be
>   required for automated Windows release builds?
>
> **4. RFC 3161 timestamping**
>
> * Is RFC 3161 timestamping included in the certificate or the eSigner service?
> * Which timestamp authority (TSA) URL should we use?
> * Our build currently pins `http://timestamp.digicert.com`. Is that compatible with a
>   certificate issued by you, or should it be changed?
> * Please confirm that a timestamped signature remains valid after the signing certificate
>   expires, and state anything we must do at signing time to ensure that.
>
> **5. Signing volume and eSigner tier**
>
> * Each release contains approximately **12 signable files**: the main application
>   executable, six Electron DLLs (`ffmpeg`, `libEGL`, `libGLESv2`, `vk_swiftshader`,
>   `vulkan-1`, `dxcompiler`), `elevate.exe`, the installer and the uninstaller, plus any
>   further signing targets as applicable.
> * We anticipate roughly **100–200 signatures per year** across a handful of releases.
> * Which eSigner tier fits that volume? Please state the annual cost, the included signature
>   allowance, and the cost of exceeding it.
>
> **6. Non-interactive signing**
>
> * Does eSigner CKA support automated `signtool.exe` signing **without manual OTP entry or a
>   confirmation step for every individual file**?
> * Please describe initial enrollment, how authentication works thereafter, whether a signing
>   session expires, and any per-signature interaction that cannot be avoided.
> * Signing 12 files per release would be impractical if each one required a separate code.
>
> **7. Certificate validity and reissuance**
>
> * What is the maximum certificate validity term currently available for an OV code-signing
>   certificate?
> * If we purchase a multi-year service, how do certificate expiry and reissuance work during
>   the term, and what additional fees or repeated validation steps apply?
>
> **8. Exact publisher subject**
>
> * Can you confirm the exact certificate subject / Common Name (CN) that would be issued to
>   our registered company, as it will appear to Windows users?
> * We must set a `publisherName` value in our build configuration that matches the issued
>   subject **character for character** — a mismatch breaks signature verification silently
>   rather than failing visibly — so we need the exact string before the first signed build.
>
> **9. Pricing and payment**
>
> * What is the total cost of the certificate plus eSigner, including any setup, validation,
>   renewal or signing-volume charges? We would like the all-in first-year and the recurring
>   annual figures, not the certificate price alone.
> * Can a Pakistan-based customer complete payment with an internationally enabled Pakistani
>   debit or credit card, or is another payment method required?
> * Can payment-method acceptance be confirmed **before** we commit to a purchase?
> * Are there any country-specific restrictions or additional charges?
>
> **10. Issuance and Windows trust**
>
> * What is the earliest realistic issuance timeline after a complete Pakistani organization
>   application is submitted?
> * Will the issued certificate chain be trusted by currently supported Windows versions?
> * Can you confirm the certificate suitability for signing a Windows desktop installer and
>   its packaged application files, including Windows Smart App Control compatibility?
>
> Our intended use is internal company deployment, not public commercial distribution. We want
> to use a properly issued, publicly trusted certificate and to comply with the applicable
> signing requirements.
>
> Please confirm our eligibility and the required documents before we proceed with a purchase.
>
> Thank you,
> [YOUR NAME], Authorized Representative
> [LEGAL NAME]
> SECP registration number: [SECP REG NO]
> Registered address: [ADDRESS]
> Telephone: [PHONE]
> Email: [EMAIL]

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
