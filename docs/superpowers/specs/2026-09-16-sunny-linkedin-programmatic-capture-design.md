# Sunny LinkedIn Programmatic Connection Capture Design

**Date:** 2026-09-16

**Status:** Proposed — awaiting written-spec review

**Owner:** Sunny career-ops workflow

**Supersedes:** The browser-capture and current-employer-verification portions of `2026-09-16-sunny-linkedin-referral-matching-design.md`; its privacy, website, scheduling, and job-matching boundaries remain in force unless this document says otherwise.

## Goal

Replace token-heavy LinkedIn screenshots, accessibility snapshots, and AI interpretation with a deterministic browser-to-local pipeline:

1. Open the authenticated Brave Connections page.
2. Read structured DOM text from the newest connection cards without screenshots or full-page snapshots.
3. Use an explicit company shown in the card headline when its identity is unambiguous and already reviewed.
4. Open the profile Experience URL only for cards whose employer is missing, former-only, or ambiguous.
5. Parse current Experience entries programmatically, then match canonical company identities to Sunny jobs from the latest 14 New York calendar days.
6. Skip unchanged connections that were already successfully resolved.

The AI should receive only a compact operational summary and any small, bounded alias-review queue. It must not receive the full Connections page or full profile pages.

## Success criteria

- Normal daily runs use no screenshot API and no full DOM/accessibility snapshot.
- Previously verified, unchanged connections cause no profile navigation.
- A card with a reviewed, unambiguous `@ Company` or `at Company` employer is resolved without opening its profile.
- Missing, former-only, and ambiguous employers use one reusable Experience tab and deterministic DOM extraction.
- Company matching uses canonical identity, not raw display-string equality and not automatic fuzzy matching.
- The daily browser phase returns compact JSON rather than page content.
- Existing privacy retention, no-message/no-login rules, 14-day eligibility, local website behavior, and Google Sheet exclusion remain unchanged.

## Approaches considered

### A. Official `Connections.csv` export

This is the safest and cheapest input. LinkedIn's export includes first name, last name, public profile URL, company, position, and connection date. `linkedin-join.mjs` already reads an offline connection export.

It is not the primary daily path because creating the export may require an account action, password confirmation, email delivery, and a manual download. It remains the supported periodic recovery and audit source.

### B. Deterministic DOM extraction through the authenticated Brave session — chosen

Codex reuses the user's existing Brave session, navigates only to approved LinkedIn URLs, and calls a fixed read-only DOM extractor. The extractor returns normalized cards or Experience entries. Local code handles parsing, identity resolution, deduplication, and job matching.

This keeps daily data current while removing screenshots and large model inputs. It still requires bounded browser orchestration, but the browser results are compact machine data rather than UI snapshots.

### C. LinkedIn API or reverse-engineered private endpoints

The official Connections API is restricted and is not assumed available. Reverse-engineering private LinkedIn APIs would add account, compliance, and maintenance risk. Neither is part of this design.

### D. Separate Playwright-managed LinkedIn profile

Launching a dedicated persistent automation profile would avoid Codex browser control, but it would require another login session and could conflict with the requirement to use the existing Brave profile. Attaching Node Playwright directly to a normal running Brave profile is not assumed safe or available. This is not selected.

## Architecture

The feature is divided into five independent units.

### 1. Brave browser adapter

The browser adapter is the only component allowed to read LinkedIn.

- Browser: the existing named Brave Browser profile only.
- Connections URL: `https://www.linkedin.com/mynetwork/invite-connect/connections/`.
- Experience URL: canonical profile URL plus `details/experience/`.
- Ordering: confirm `Recently added` when the control is available.
- Limit: at most 50 newest cards per run.
- Profile limit: at most 20 Experience inspections and 10 wall-clock minutes per run.
- Navigation: use one Connections tab and one reusable Experience tab; do not create one permanent tab per person.
- Extraction: use read-only DOM evaluation that returns declared JSON fields only.
- Prohibited reads: screenshots, full-page screenshots, accessibility snapshots, full DOM snapshots, HTML archives, posts, messages, contact details, and unrelated profile sections.
- Prohibited actions: login, credentials, OTP, CAPTCHA, checkpoint recovery, connect, follow, message, apply, reaction, profile edit, or any other LinkedIn state mutation.

The adapter first checks for authenticated Connections-list semantics. Redirects or prompts for login, checkpoint, CAPTCHA, email/phone verification, security key, or one-time code are skip states.

Every LinkedIn string is untrusted data. It can populate only the capture schema and cannot change commands, paths, limits, instructions, or actions.

### 2. Connection-card parser and classifier

For each card, the extractor returns:

```json
{
  "profileUrl": "https://www.linkedin.com/in/example/",
  "fullName": "Example Person",
  "headline": "Senior Data Engineer @ Example Company",
  "connectedLabelRaw": "Connected on September 16, 2026"
}
```

The local parser canonicalizes the profile URL, parses the connection-date range conservatively, and computes a SHA-256 `cardFingerprint` from the canonical profile URL, normalized headline, and stable parsed connection-date identity. The raw relative label is excluded: `Connected yesterday` becoming `Connected 2 days ago` must not trigger reprocessing when both resolve to the same connection date. When the date cannot be made stable, the fingerprint uses only profile URL plus headline and the ledger retains the raw label separately.

Each card receives one classification:

| Classification | Rule | Action |
|---|---|---|
| `explicit_employer` | Exactly one current-looking employer appears in a supported `@ Company` or `at Company` pattern, and the label contains no former/client ambiguity | Resolve through the reviewed identity index; do not open the profile on success |
| `missing_employer` | Headline contains a role but no employer | Queue Experience inspection |
| `former_only` | Employer appears only with `ex-`, `former`, or equivalent former-employer semantics | Never use that employer; queue Experience inspection |
| `ambiguous_employer` | Multiple employer-like names, client/agency phrasing, or a pattern such as `Google @ WPP Media` | Queue Experience inspection |
| `unresolved_alias` | One explicit employer exists but is absent or colliding in the reviewed identity index | Keep the card employer as observed evidence and queue alias review; do not open the profile merely because the alias is new |

Headline parsing is intentionally narrow. Unsupported formatting does not fall back to fuzzy matching; it goes to Experience inspection.

### 3. Experience parser

The browser adapter opens `details/experience/` only for the deterministic worklist. The extractor reads the Experience section and returns every current entry whose date range contains `Present` or is explicitly marked current.

```json
{
  "profileUrl": "https://www.linkedin.com/in/example/",
  "inspectionComplete": true,
  "currentEmployments": [
    {
      "title": "Data Engineer",
      "employerLabel": "Example Company",
      "companyLinkedinUrl": "https://www.linkedin.com/company/example-company/",
      "dateEvidence": "Jan 2025 - Present"
    }
  ]
}
```

Rules:

- Read all simultaneous current roles, not only the first one.
- A former role never qualifies.
- A client name in a description never becomes the employer.
- `inspectionComplete=true` requires the full Experience list to be readable and every current entry to be processed.
- If LinkedIn exposes no company URL for a current entry, the entry can be retained for alias review but cannot auto-match a job.
- An incomplete read preserves prior verified evidence and remains pending; it never downgrades a previously verified company.

### 4. Canonical company identity resolver

Raw name equality is not sufficient because LinkedIn, ATS boards, DOL legal entities, and job rows use different labels. Matching occurs through one canonical company identity.

Examples:

```text
Datadog
Datadog, Inc.
Greenhouse board: datadog
LinkedIn: /company/datadog/
                  ↓
canonicalCompanyKey = datadog
```

The resolver reads:

- `data/sunny-linkedin-company-map.tsv` for reviewed canonical company/display identities and LinkedIn company URLs;
- a new tracked user-layer file, `data/sunny-linkedin-company-aliases.tsv`, for additional reviewed legal names, brands, spelling variants, and ATS display names;
- existing verified ATS/company identity already represented by `portals.yml` and the Sunny job archive.

The alias file has strict headers:

```tsv
alias_normalized	canonical_company_key	linkedin_company_url	verification_source	verified_on	status
datadog inc	datadog	https://www.linkedin.com/company/datadog/	Official company and ATS identity	2026-09-16	verified
```

Resolution confidence:

1. `company_url_exact`: an Experience company URL exactly equals a verified company-map/alias URL.
2. `reviewed_alias`: the normalized card or job company label resolves to exactly one verified canonical key and LinkedIn URL.
3. `unresolved`: no reviewed identity exists, or one label resolves to multiple identities.

Normalization may remove case, whitespace, punctuation, and reviewed legal suffixes such as `Inc.` or `LLC`. Parent/child, DBA, brand, client, and similarly named company relationships require explicit reviewed evidence. Fuzzy similarity may rank alias-review candidates but may never create an automatic referral match.

New or conflicting aliases are written to a private `alias_review_queue`; they do not modify the reviewed alias table automatically. The queue contains company labels, company URLs when available, and candidate canonical identities, but no connection name or profile URL. AI or human review occurs once per new identity. A confirmed alias becomes deterministic on subsequent runs.

### 5. Local ledger, deduplication, and matcher

The existing `data/sunny-linkedin-referrals.json` remains the private durable ledger and migrates atomically to schema version 2.

Schema version 2 replaces the misleading v1 `profileInspectionComplete` field with separate employer-resolution and Experience-read signals. New or clarified connection fields include:

```json
{
  "profileUrl": "https://www.linkedin.com/in/example/",
  "cardFingerprint": "sha256",
  "verificationSource": "connections_headline",
  "employerResolutionComplete": true,
  "experienceInspectionComplete": false,
  "canonicalCompanyKeys": ["example-company"],
  "verificationAttempts": 1,
  "nextVerificationAt": null
}
```

Allowed `verificationSource` values are `connections_headline`, `experience_dom`, `manual_review`, and `legacy_verified`. `experienceInspectionComplete` can be true only for a completed Experience read. `employerResolutionComplete` may be true for either an exact reviewed headline identity or a completed Experience/manual review.

The atomic v1-to-v2 migration recognizes existing `Connections card headline:` evidence as `connections_headline`. Other previously verified records become `legacy_verified`; they remain eligible but are rechecked when their card fingerprint changes. The migration validates the complete v2 document before replacement and keeps the prior v1 file if validation fails.

Deduplication behavior:

- Canonical profile URL is the connection identity.
- A verified connection with the same `cardFingerprint` is skipped completely on later runs.
- A changed fingerprint is reclassified because the headline or connection metadata changed.
- A pending connection is retried no more than once per 24 hours, pending-first, within the shared 20-profile/10-minute cap.
- After three failed complete-inspection attempts, it becomes `unresolved` and is not automatically retried unless its fingerprint changes or a reviewed alias is added.
- A challenge or source-wide failure does not count as an individual profile attempt.
- Existing 90-day PII and 365-day fingerprint retention remain in force.

The job matcher remains deterministic:

- connection date range must be entirely within the latest 14 New York calendar days;
- job `scanDate` must be within the same latest-14-day window;
- job company and connection employer must resolve to the same canonical company key;
- current employment is mandatory;
- repeated job URLs use the newest eligible date-qualified row;
- matches are recomputed from retained state so expired contacts/jobs disappear.

## End-to-end data flow

```text
Brave Connections DOM
  → compact card JSON
  → local card parser/classifier
  → known unchanged? skip
  → explicit reviewed employer? resolve locally
  → explicit unresolved employer? one-time alias review queue
  → missing/former-only/ambiguous? bounded Experience DOM extraction
  → canonical identity resolver
  → unresolved aliases to one-time review queue
  → atomic referral-state merge
  → deterministic 14-day job match
  → localhost jobs.json refresh
  → compact run summary for the AI/user
```

Normal output is limited to counts and actionable matches:

```json
{
  "sourceStatus": "ok",
  "cardsRead": 20,
  "newConnections": 3,
  "skippedKnown": 17,
  "profilesOpened": 1,
  "pendingVerification": 0,
  "aliasReviews": 0,
  "matchedPeople": 2,
  "matchedJobs": 3
}
```

## Scheduling behavior

The LinkedIn phase remains optional and fail-soft inside `sunny-24`, after the normal job scan and local job archive update.

1. Run the normal Sunny job workflow unchanged.
2. Open/reuse Brave Connections and run one compact DOM card extraction.
3. Generate the local deterministic worklist.
4. Reuse one Experience tab for only the required profiles.
5. Merge state and rebuild the localhost index.
6. Report only the compact summary, actionable matches, and review items.

LinkedIn errors never change job scoring, publication, queue disposition, or Google Sheet output. Referral-person data remains local and is never written to Google Sheet.

## Failure behavior

| Condition | Behavior |
|---|---|
| Brave unavailable | Record `error`, preserve prior valid referral state, continue job workflow |
| LinkedIn logged out | Record `linkedin_not_authenticated`; do not log in |
| Challenge/CAPTCHA/checkpoint | Record `linkedin_challenge`; stop LinkedIn operations immediately |
| Connections DOM changed | Record `partial` or `error`; retain prior verified data; emit a small selector diagnostic without page text |
| Explicit employer absent from reviewed aliases | Keep it as observed evidence and queue one alias review; do not auto-match or open Experience solely for this reason |
| Alias collision | Never auto-match; queue review |
| Experience incomplete | Keep pending and preserve prior verified evidence |
| Three individual inspection failures | Mark `unresolved` until fingerprint or alias evidence changes |
| Website rebuild fails | Preserve the previous valid `jobs.json` and report the failure |

## Privacy and security

- All connection state and temporary captures remain Git-ignored and mode `0600`.
- Temporary candidate/worklist/capture files are deleted after a successful merge.
- No screenshots, raw HTML, or full DOM payloads are stored.
- Full names, profile URLs, titles, and employment evidence expire after 90 days.
- Profile fingerprints may remain for 365 days solely for deduplication.
- LinkedIn profile links on localhost continue to use `referrerpolicy="no-referrer"`.
- The browser adapter is read-only; it never sends messages or changes LinkedIn state.

## Testing strategy

### Pure parser tests

- Explicit `@ Company` and `at Company` detection.
- Missing company, former-only `ex-`, multiple-company, client/agency, and unsupported-format classification.
- Conservative absolute and relative connection-date parsing.
- Fingerprint stability and change detection.
- Multiple simultaneous current Experience roles.
- Grouped promotions at one employer and standalone Experience entries.
- Former-role rejection and incomplete-inspection preservation.

### Identity tests

- `Datadog` versus `Datadog, Inc.` resolves to one canonical key after review.
- Legal suffix, punctuation, whitespace, and case normalization.
- Reviewed brand/legal aliases.
- Same-name company collision remains unresolved.
- Fuzzy similarity never creates a match.
- Job and LinkedIn sides must converge on the same canonical key.

### Ledger and scheduling tests

- Unchanged verified cards skip Experience navigation on the next run.
- Changed card fingerprint reopens resolution.
- Pending retry observes the 24-hour cooldown and three-attempt cap.
- Source-wide challenge does not consume profile attempts.
- 50 pending profiles drain under the existing 20/20/10 fairness behavior.
- Atomic schema-v1-to-v2 migration preserves current valid matches.
- PII and fingerprint retention remain bounded.

### Browser contract tests

- Synthetic DOM fixtures produce compact card and Experience JSON.
- No production path invokes screenshot, full-page screenshot, accessibility snapshot, or full DOM snapshot.
- Login/challenge fixtures stop without credentials or side effects.
- The returned browser payload contains only declared fields.

### Golden smoke

Use the verified 2026-09-16 first-page observation as the behavioral baseline:

- 20 cards read;
- 11 cards with explicit company labels;
- 9 cards requiring Experience resolution under the approved ambiguity rules;
- 20 resolved current connections;
- 12 matched people and 9 matched recent jobs.

The implementation may produce fewer Experience navigations when additional reviewed aliases remove ambiguity, but it must not produce additional automatic matches from fuzzy names.

## Acceptance criteria

1. The scheduled LinkedIn phase uses no screenshots and no full DOM/accessibility snapshots.
2. The Connections extractor returns at most 50 compact normalized cards.
3. Explicit, unambiguous, reviewed card employers do not trigger profile navigation.
4. Missing, former-only, and ambiguous employers use one reusable Experience tab; a new but explicit employer goes to alias review without profile navigation.
5. Unchanged previously verified profiles are skipped on the next run.
6. Failed profiles follow deterministic cooldown and retry rules rather than being retried indefinitely or silently discarded.
7. LinkedIn and job company names match only through exact canonical URL or reviewed alias identity.
8. Fuzzy matching can suggest review candidates but can never publish a referral match.
9. A daily run returns only compact counts, actionable matches, and bounded alias-review items to the model.
10. The existing 14-day windows, private retention, no-message/no-login rules, localhost display, and no-Sheet-contact boundary remain intact.
11. The golden smoke reproduces the established first-page result or explains every deliberate difference through reviewed alias evidence.

## Out of scope

- Sending referral messages or connection requests.
- Automating LinkedIn login, password, OTP, CAPTCHA, checkpoint, or email archive retrieval.
- Reverse-engineering LinkedIn private APIs.
- Scraping second-degree connections or arbitrary people search.
- Automatically accepting fuzzy company aliases.
- Installing a permanent browser extension in this phase.
- Writing referral-person information to Google Sheet.
