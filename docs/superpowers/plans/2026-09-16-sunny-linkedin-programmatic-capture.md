# Sunny LinkedIn Programmatic Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace screenshot- and model-driven LinkedIn connection inspection with a compact, deterministic Brave DOM capture pipeline that resolves reviewed company identities, skips unchanged people, and preserves Sunny's existing private 14-day referral matching workflow.

**Architecture:** Add two pure layers in front of the existing referral ledger: a browser-safe DOM extractor that emits only declared fields, and a local parser/identity resolver that classifies cards and creates a bounded Experience worklist. Upgrade the private referral state atomically from schema v1 to v2, preserving the existing job matcher and localhost output while adding card fingerprints, reviewed aliases, deterministic retry/cooldown, and a privacy-safe alias-review queue.

**Tech Stack:** Node.js 18+ ESM, built-in `node:test`, Playwright Chromium for synthetic DOM contract tests, TSV reviewed identity data, JSON private state, existing Sunny static localhost UI.

**Approved scope:** `docs/superpowers/specs/2026-09-16-sunny-linkedin-programmatic-capture-design.md`, authorized for implementation by the user's 2026-09-16 request: “幫我寫成 plan, 再套用 approved-execute”.

**Execution constraint:** Do not commit, push, merge, deploy, edit the live `sunny-24` automation, log into LinkedIn, send messages, or run a live profile sweep. The code, local protocol, fixtures, migration, and tests are in scope; external automation activation and a real Brave smoke require separate authorization.

---

## File map

- Create `local/sunny-job-search/linkedin-capture.mjs` — pure connection-date parsing, card classification, fingerprinting, and compact capture normalization.
- Create `local/sunny-job-search/linkedin-dom-extractors.mjs` — self-contained browser-context extractors for Connections cards and Experience entries.
- Create `local/sunny-job-search/company-identities.mjs` — strict company-map/alias parsing and canonical identity resolution.
- Create `data/sunny-linkedin-company-aliases.tsv` — user-layer reviewed aliases; start with header only and never auto-approve queue candidates.
- Modify `local/sunny-job-search/referrals.mjs` — schema-v2 validation/migration, worklist preparation, retry/cooldown, alias-review queue, merge, and canonical matcher.
- Modify `data/tools/build-sunny-job-search-index.mjs` — accept only validated v2 state while retaining the existing bounded invalid-state fallback.
- Modify `profiles/sunny-linkedin-referral-browser.md` — exact no-screenshot Brave operational contract and compact JSON handoff.
- Modify `modes/_custom.md` — point the daily optional phase at the versioned programmatic protocol without changing the job scan or Sheet flow.
- Create `local/sunny-job-search/tests/linkedin-capture.test.mjs` — pure parser/classifier/fingerprint tests.
- Create `local/sunny-job-search/tests/linkedin-dom-contract.test.mjs` — synthetic browser DOM extractor tests and prohibited-read contract.
- Create `local/sunny-job-search/tests/company-identities.test.mjs` — exact URL, reviewed alias, collision, and no-fuzzy tests.
- Modify `local/sunny-job-search/tests/referrals.test.mjs` — v1 migration, v2 merge, skip/retry/cap, retention, and matcher regression tests.
- Modify `local/sunny-job-search/tests/builder.test.mjs` — v2 snapshot enrichment and invalid-state fallback tests.
- Create `local/sunny-job-search/tests/fixtures/linkedin/connections.html` — 20-card synthetic baseline covering all classifications.
- Create `local/sunny-job-search/tests/fixtures/linkedin/experience.html` — grouped/current/former/multiple Experience fixtures.
- Create `local/sunny-job-search/tests/fixtures/linkedin/login.html` and `challenge.html` — fail-soft authentication fixtures.

---

### Task 1: Add the pure card parser and stable fingerprint contract

**Files:**
- Create: `local/sunny-job-search/linkedin-capture.mjs`
- Create: `local/sunny-job-search/tests/linkedin-capture.test.mjs`

- [ ] **Step 1: Write RED tests for headline classification**

Create table-driven tests with these exact expected classifications:

```js
const cases = [
  ['DS @ Capital One', 'explicit_employer', 'Capital One'],
  ['Data Engineer at Datadog', 'explicit_employer', 'Datadog'],
  ['Staff Software Engineer', 'missing_employer', null],
  ['ex-Google · Data Engineer', 'former_only', null],
  ['Google @ WPP Media', 'ambiguous_employer', null],
  ['Consultant at Client A for Agency B', 'ambiguous_employer', null],
  ['Data | Datadog', 'missing_employer', null],
];
```

Assert that `classifyHeadline()` returns only `explicit_employer`, `missing_employer`, `former_only`, or `ambiguous_employer`; unsupported delimiters must never become an explicit employer.

- [ ] **Step 2: Write RED tests for conservative connection-date parsing**

At fixed `now = 2026-09-16T16:00:00.000Z` and timezone `America/New_York`, assert:

```js
parseConnectionDate('Connected on September 16, 2026', { now })
// => { earliest: '2026-09-16', latest: '2026-09-16', precision: 'day', stableIdentity: '2026-09-16' }

parseConnectionDate('Connected yesterday', { now })
// => { earliest: '2026-09-15', latest: '2026-09-15', precision: 'relative_day', stableIdentity: '2026-09-15' }

parseConnectionDate('Connected 1 week ago', { now })
// => conservative seven-day range with precision 'relative_week'

parseConnectionDate('Recently connected', { now })
// => null dates, precision 'unknown', stableIdentity null
```

Reject future dates and impossible calendar dates rather than widening them into eligibility.

- [ ] **Step 3: Write RED tests for card normalization and fingerprints**

Test `normalizeConnectionCard(raw, { now })` with the strict input fields `profileUrl`, `fullName`, `headline`, and `connectedLabelRaw`. Require canonical `/in/{slug}/` URL, trimmed NFKC strings, parsed date fields, classification, and `cardFingerprint`.

The fingerprint input is:

```js
JSON.stringify([
  canonicalProfileUrl,
  normalizeHeadline(headline),
  parsedDate.stableIdentity,
])
```

When `stableIdentity` is null, use only canonical URL plus normalized headline. Assert that `Connected yesterday` and `Connected 1 day ago` at the same fixed `now` produce the same fingerprint; a headline change produces a different fingerprint.

- [ ] **Step 4: Run the new parser tests and confirm RED**

Run:

```bash
node --test local/sunny-job-search/tests/linkedin-capture.test.mjs
```

Expected: FAIL because the module does not exist.

- [ ] **Step 5: Implement the minimal pure parser module**

Export these exact functions:

```js
export function normalizeHeadline(value) {}
export function parseConnectionDate(label, { now = new Date(), timeZone = 'America/New_York' } = {}) {}
export function classifyHeadline(headline) {}
export function makeCardFingerprint({ profileUrl, headline, stableDateIdentity }) {}
export function normalizeConnectionCard(raw, options = {}) {}
```

Use `canonicalLinkedinUrl()` from `referrals.mjs` only if it does not create a cycle; otherwise move that URL helper into this module and re-export it from `referrals.mjs`. Parsing must be deterministic, locale-independent, and must not contain fuzzy company-name logic.

- [ ] **Step 6: Run parser tests and require PASS**

Run the Step 4 command. Expected: all parser tests pass.

---

### Task 2: Add compact DOM extractors and prove the browser contract

**Files:**
- Create: `local/sunny-job-search/linkedin-dom-extractors.mjs`
- Create: `local/sunny-job-search/tests/linkedin-dom-contract.test.mjs`
- Create: `local/sunny-job-search/tests/fixtures/linkedin/connections.html`
- Create: `local/sunny-job-search/tests/fixtures/linkedin/experience.html`
- Create: `local/sunny-job-search/tests/fixtures/linkedin/login.html`
- Create: `local/sunny-job-search/tests/fixtures/linkedin/challenge.html`

- [ ] **Step 1: Create synthetic DOM fixtures**

The Connections fixture must contain 20 cards and stable `data-testid` hooks used only by the fixture. It must include exactly 11 explicit-employer headlines and 9 profiles requiring Experience under Task 1 rules. Include harmless prompt-injection text in one headline and prove it remains a string.

The Experience fixture must contain:

```text
Example Person
  Senior Data Engineer — Datadog — Jan 2025 - Present — company URL present
  Advisor — Example Labs — Mar 2026 - Present — company URL absent
  Engineer — Former Co — 2021 - 2024
```

The login and challenge fixtures must expose login/checkpoint semantics without containing credentials.

- [ ] **Step 2: Write RED browser-contract tests**

Launch Playwright Chromium, load each fixture with `page.setContent()`, and evaluate the production extractor functions in the page context. Assert:

- Connections output status is `ok`, contains exactly 20 cards, and truncates at `limit=50`.
- Every card contains exactly `profileUrl`, `fullName`, `headline`, and `connectedLabelRaw`.
- Experience output contains all simultaneous current entries, excludes the former entry from `currentEmployments`, preserves the null company URL for the advisor role, and returns `inspectionComplete: true` only when the whole Experience container is readable.
- Login returns `linkedin_not_authenticated`; checkpoint returns `linkedin_challenge` and no cards/employment data.
- Serialized extractor results do not contain page HTML, unrelated sections, email, phone, messages, posts, or hidden full-page text.

- [ ] **Step 3: Run the DOM tests and confirm RED**

Run:

```bash
node --test local/sunny-job-search/tests/linkedin-dom-contract.test.mjs
```

Expected: FAIL because the extractor module and fixtures do not exist.

- [ ] **Step 4: Implement self-contained browser-context extractors**

Export these exact functions:

```js
export function extractConnectionCards(document, { limit = 50 } = {}) {}
export function extractCurrentExperience(document, profileUrl) {}
export function detectLinkedInSourceStatus(document, locationHref = '') {}
```

Each exported function must be serializable for browser evaluation: it may call only nested helpers declared inside itself or values passed as arguments. Selector fallbacks may inspect semantic links and nearby declared text, but returned data must use only the declared compact fields. Clamp Connections to 50. The module must not call or reference screenshot APIs, accessibility snapshots, `document.documentElement.outerHTML`, `document.body.innerHTML`, or full-page `innerText`.

- [ ] **Step 5: Add a source-level prohibition test**

Read the production extractor and `profiles/sunny-linkedin-referral-browser.md`; fail if they contain executable guidance for `screenshot`, `accessibility snapshot`, `outerHTML`, `body.innerHTML`, or whole-page `innerText`. Negative prose such as “do not use screenshots” may remain only in the markdown protocol; the JavaScript source must contain none of the prohibited APIs.

- [ ] **Step 6: Run DOM contract tests and require PASS**

Run the Step 3 command. Expected: all DOM contract tests pass without network access.

---

### Task 3: Build a reviewed canonical company identity index

**Files:**
- Create: `local/sunny-job-search/company-identities.mjs`
- Create: `local/sunny-job-search/tests/company-identities.test.mjs`
- Create: `data/sunny-linkedin-company-aliases.tsv`
- Modify: `local/sunny-job-search/referrals.mjs`

- [ ] **Step 1: Create the alias file with the exact strict header**

```tsv
alias_normalized	canonical_company_key	linkedin_company_url	verification_source	verified_on	status
```

Do not seed guessed aliases. Existing reviewed rows from `data/sunny-linkedin-company-map.tsv` are primary identity evidence; the alias file is additive.

- [ ] **Step 2: Write RED identity tests**

Cover all of these cases:

1. Exact Experience URL `https://www.linkedin.com/company/datadog/` resolves with `quality: 'company_url_exact'`.
2. Reviewed labels `Datadog`, `Datadog, Inc.`, punctuation/case/whitespace variants, and a verified alias converge on canonical key `datadog`.
3. Two reviewed legal entities mapped to the same reviewed parent LinkedIn URL converge on the URL-derived canonical key.
4. One normalized label mapped to two different URLs throws a collision and resolves as `unresolved`.
5. `Data Dog` must not match `Datadog` unless an explicit verified alias exists.
6. An alias row with invalid status/date/URL/header or a canonical key inconsistent with its reviewed company URL is rejected.
7. A company label with no reviewed identity returns bounded review candidates but never a resolved key.

- [ ] **Step 3: Run identity tests and confirm RED**

Run:

```bash
node --test local/sunny-job-search/tests/company-identities.test.mjs
```

Expected: FAIL because the module does not exist.

- [ ] **Step 4: Implement the strict identity module**

Export:

```js
export function normalizeCompanyAlias(value) {}
export function parseCompanyAliases(tsvText) {}
export function buildCompanyIdentityIndex({ companyMapRows, aliasRows }) {}
export function resolveCompanyIdentity(index, { companyLabel = '', companyLinkedinUrl = null } = {}) {}
export function suggestAliasCandidates(index, companyLabel, { limit = 3 } = {}) {}
```

Derive the default canonical key from the reviewed canonical LinkedIn company URL slug. Permit an alias file's canonical key only when that key already exists in the reviewed map/index. Return one of:

```js
{ status: 'resolved', canonicalCompanyKey, linkedinCompanyUrl, quality: 'company_url_exact' }
{ status: 'resolved', canonicalCompanyKey, linkedinCompanyUrl, quality: 'reviewed_alias' }
{ status: 'unresolved', reason: 'missing' | 'collision', candidates: [] }
```

`suggestAliasCandidates()` may rank normalized token overlap for review only. Its output must never be consumed by the automatic matcher or written into the verified alias table.

- [ ] **Step 5: Re-export the existing company-map parser without duplicating validation**

Move or wrap `parseCompanyMap()` so both `referrals.mjs` and the new identity module use one strict implementation. Preserve the existing seven-column contract and all current tests.

- [ ] **Step 6: Run identity and existing referral tests**

Run:

```bash
node --test \
  local/sunny-job-search/tests/company-identities.test.mjs \
  local/sunny-job-search/tests/referrals.test.mjs
```

Expected: PASS before starting the state migration.

---

### Task 4: Upgrade the private ledger atomically to schema v2

**Files:**
- Modify: `local/sunny-job-search/referrals.mjs`
- Modify: `local/sunny-job-search/tests/referrals.test.mjs`

- [ ] **Step 1: Write RED migration tests using an isolated temporary v1 state**

Do not mutate the live private state during unit tests. Construct a v1 fixture with:

- one verified connection whose evidence begins `Connections card headline:`;
- one verified Experience connection;
- one pending connection;
- existing matches and `seenProfileHashes`.

Assert that `migrateReferralStateV1ToV2()` returns schema 2, validates before any write, maps headline evidence to `connections_headline`, maps other verified evidence to `legacy_verified`, preserves valid current matches until recomputation, and leaves the original v1 object/file unchanged when migration validation fails.

- [ ] **Step 2: Define the exact v2 connection schema in tests**

Require these fields and reject undeclared fields:

```js
{
  profileUrl,
  fullName,
  headline,
  connectedLabelRaw,
  connectedAtEarliest,
  connectedAtLatest,
  connectedDatePrecision,
  cardFingerprint,
  cardClassification,
  observedEmployerLabel,
  verificationSource,
  employerResolutionComplete,
  experienceInspectionComplete,
  verificationStatus,
  canonicalCompanyKeys,
  currentEmployments,
  employmentVerifiedAt,
  firstSeenAt,
  lastObservedAt,
  lastVerificationAttemptAt,
  verificationAttempts,
  nextVerificationAt
}
```

Allowed `verificationSource` values are exactly `connections_headline`, `experience_dom`, `manual_review`, and `legacy_verified`. `experienceInspectionComplete` is true only after a complete Experience read. `employerResolutionComplete` can be true for reviewed headline identity, complete Experience resolution, or manual review.

- [ ] **Step 3: Define the exact alias-review queue schema in tests**

Add top-level `aliasReviewQueue` to v2 state. Each row contains only:

```js
{
  aliasNormalized,
  observedCompanyLabel,
  linkedinCompanyUrl,
  candidateCanonicalCompanyKeys,
  firstSeenAt,
  lastSeenAt,
  status
}
```

Allowed status is `pending` or `resolved`. Explicitly assert that queue serialization contains neither connection name nor profile URL.

- [ ] **Step 4: Implement strict v2 validation and pure migration**

Export:

```js
export function migrateReferralStateV1ToV2(v1, { now = new Date() } = {}) {}
export function loadAndMigrateReferralState(path, { now = new Date(), write = false } = {}) {}
```

`loadAndMigrateReferralState(..., { write: true })` must validate the full v2 document, write a mode-0600 temp file in the same directory, read and validate it, then rename atomically. On any failure it must leave the v1 file byte-for-byte intact.

- [ ] **Step 5: Preserve privacy retention during migration**

Keep the existing 90-day PII and 365-day hash rules. A migrated expired connection becomes a hash only; it must not leave name, profile URL, headline, or employer evidence in state or alias review.

- [ ] **Step 6: Run migration and referral tests**

Run:

```bash
node --test local/sunny-job-search/tests/referrals.test.mjs
```

Expected: all v1 and v2 tests pass; existing live state remains untouched.

---

### Task 5: Implement deterministic prepare/worklist, cooldown, and merge

**Files:**
- Modify: `local/sunny-job-search/referrals.mjs`
- Modify: `local/sunny-job-search/tests/referrals.test.mjs`

- [ ] **Step 1: Write RED tests for `prepareConnectionWorklist()`**

Use normalized cards from Task 1 and the identity index from Task 3. Assert:

- unchanged verified fingerprint → `skippedKnown`, no profile URL in `profilesToInspect`;
- explicit reviewed employer → a `connections_headline` observation, no profile navigation;
- explicit unreviewed employer → one PII-free alias-review row, no profile navigation;
- missing/former/ambiguous employer → profile appears once in `profilesToInspect`;
- output contains at most 20 profiles, respects the deadline, and reports at most 50 input cards;
- pending eligible retries sort before new cards;
- source-level login/challenge returns no worklist and does not consume individual attempts.

Use this exact result shape:

```js
{
  sourceStatus,
  observedAt,
  headlineObservations: [],
  profilesToInspect: [],
  aliasReviews: [],
  counts: { cardsRead, skippedKnown, headlineResolved, profilesQueued, aliasReviews }
}
```

- [ ] **Step 2: Write RED cooldown and attempt-cap tests**

At fixed times, prove:

- an incomplete profile is not eligible until 24 hours after `lastVerificationAttemptAt`;
- attempts 1–2 remain `pending_verification` with a new `nextVerificationAt`;
- the third failed complete-inspection attempt becomes `unresolved` with `nextVerificationAt: null`;
- a changed `cardFingerprint` resets the attempt count and re-enters classification;
- adding a newly verified alias reopens a matching unresolved alias without profile navigation;
- challenge/source failure changes no individual's attempt count.

- [ ] **Step 3: Write RED merge tests for Experience results**

Assert all simultaneous current roles are retained. A current entry with a reviewed company URL resolves; a label-only current entry goes to alias review and cannot match. An incomplete Experience read preserves earlier verified employer evidence. A complete read may replace or retire prior evidence.

- [ ] **Step 4: Implement worklist preparation and v2 merge**

Export:

```js
export function prepareConnectionWorklist({ state, cards, identityIndex, sourceStatus, observedAt, now, limit = 20, deadlineAt }) {}
export function mergeProgrammaticCapture(previous, capture, { identityIndex, jobs, now = new Date() } = {}) {}
```

Change CLI `worklist` to accept strict compact-card JSON plus `--company-map`, `--aliases`, `--now`, `--limit`, and `--deadline-at`, and write the result mode 0600. Keep absolute temporary input/output enforcement and data-root containment for durable files.

Change CLI `merge` to accept a strict capture with `headlineObservations` and Experience `profileInspections`. It must load/migrate v1 state, merge without downgrade, recompute matches, validate, atomically replace state, and print only compact counts:

```js
{
  sourceStatus,
  cardsRead,
  newConnections,
  skippedKnown,
  profilesOpened,
  pendingVerification,
  aliasReviews,
  matchedPeople,
  matchedJobs
}
```

- [ ] **Step 5: Update the matcher to canonical company keys**

Resolve both job `company` and each current employment through the same identity index. Match only equal `canonicalCompanyKey` values. Exact Experience company URL gives `company_url_exact`; any label-based reviewed path gives `reviewed_alias`. Never read `suggestAliasCandidates()` from matcher code.

Keep the existing date gates:

```text
connection earliest and latest both within latest 14 America/New_York calendar days
job scanDate within the same latest-14-day window
newest eligible row per canonical apply URL
```

- [ ] **Step 6: Run referral regression tests**

Run:

```bash
node --test local/sunny-job-search/tests/referrals.test.mjs
```

Expected: all old behavior and new v2 behavior pass.

---

### Task 6: Preserve localhost enrichment and invalid-state fallback

**Files:**
- Modify: `data/tools/build-sunny-job-search-index.mjs`
- Modify: `local/sunny-job-search/tests/builder.test.mjs`
- Verify unchanged: `local/sunny-job-search/app.js`

- [ ] **Step 1: Convert builder fixtures from v1 to validated v2**

Build v2 fixtures through `mergeProgrammaticCapture()` or `migrateReferralStateV1ToV2()` rather than hand-writing a shallow state. Assert that valid v2 matches enrich only the exact date-plus-canonical-URL job row.

- [ ] **Step 2: Add RED fallback tests**

Cover:

- missing referral file → `not_configured`, fresh jobs, empty contacts;
- valid v1 file → pure migration in memory, correct contacts, no write by the builder;
- malformed or invalid v2 file → `error`, fresh base jobs, only bounded validated prior contacts;
- expired/malformed contacts remain discarded;
- referral errors never freeze unrelated new jobs;
- output remains mode 0600 and atomically replaced.

- [ ] **Step 3: Run builder tests and confirm RED where v2 is unsupported**

Run:

```bash
node --test local/sunny-job-search/tests/builder.test.mjs
```

- [ ] **Step 4: Update builder validation through the shared referral validator**

Use the exported migration/validator. Do not introduce a second shallow schema. Preserve the existing output shape (`referralContacts`, `referralDataStatus`, `referralDataUpdatedAt`) so the static UI needs no schema change.

- [ ] **Step 5: Run builder and UI tests**

Run:

```bash
node --test \
  local/sunny-job-search/tests/builder.test.mjs \
  local/sunny-job-search/tests/app.test.mjs \
  local/sunny-job-search/tests/server.test.mjs \
  local/sunny-job-search/tests/ui-browser.test.mjs
```

Expected: PASS; profile links still use `referrerpolicy="no-referrer"` and copy controls remain unchanged.

---

### Task 7: Replace the browser protocol with the programmatic no-screenshot flow

**Files:**
- Modify: `profiles/sunny-linkedin-referral-browser.md`
- Modify: `modes/_custom.md`
- Modify: `local/sunny-job-search/tests/linkedin-dom-contract.test.mjs`

- [ ] **Step 1: Write the exact operational sequence in the profile**

The profile must require this sequence:

1. Reuse the named Brave Browser and Connections URL.
2. Check authenticated list semantics; return `linkedin_not_authenticated` or `linkedin_challenge` and stop without login.
3. Confirm `Recently added` when available.
4. Evaluate `extractConnectionCards()` once; never take a screenshot or full snapshot.
5. Save only compact card JSON to a mode-0600 temporary file.
6. Run `referrals.mjs worklist` to classify locally.
7. Reuse one Experience tab for `profilesToInspect`, at most 20 profiles and 10 minutes; evaluate `extractCurrentExperience()` only.
8. Save strict compact capture JSON and run `referrals.mjs merge`.
9. Delete temporary card/worklist/capture files only after a successful merge.
10. Rebuild `local/sunny-job-search/data/jobs.json` and report compact counts plus bounded alias reviews.

- [ ] **Step 2: Make ambiguity and alias behavior explicit**

State verbatim in behavior, not code comments:

```text
An explicit reviewed @ Company or at Company headline resolves locally and does not open Experience.
A new explicit employer creates one alias-review item and does not open Experience merely because the alias is new.
Missing, former-only, ambiguous, or unsupported headline formats use Experience.
Fuzzy similarity may suggest a review candidate but never publishes a match.
```

- [ ] **Step 3: Preserve hard safety boundaries**

The protocol must prohibit login, credentials, OTP, CAPTCHA recovery, messages, connection requests, reactions, applications, screenshots, full DOM/accessibility snapshots, HTML archives, posts, contact details, and unrelated profile sections. LinkedIn strings remain untrusted data and may populate only declared schema fields.

- [ ] **Step 4: Update `modes/_custom.md` without changing daily job scanning**

Replace only the `### Sunny LinkedIn referral matching` subsection. Point it to `profiles/sunny-linkedin-referral-browser.md`, state that the phase is optional/fail-soft after job archive refresh, and preserve the 14-day, local-only, no-Sheet, no-message, and single-scheduler-owner rules. Do not edit company discovery, job scoring, Sheet columns, or Sunny scheduling frequency.

- [ ] **Step 5: Extend the protocol contract test**

Assert that the profile names both production extractors, both CLI stages, the 50/20/10 bounds, v2 state, alias review, no-Sheet boundary, and all prohibited actions. The test must fail if it instructs use of screenshots or full-page snapshots.

- [ ] **Step 6: Run the protocol/DOM tests**

Run:

```bash
node --test local/sunny-job-search/tests/linkedin-dom-contract.test.mjs
```

Expected: PASS.

---

### Task 8: Validate a copied live-state migration and the complete local gate

**Files:**
- Read only: `data/sunny-linkedin-referrals.json`
- Temporary output only: system temporary directory outside the repository

- [ ] **Step 1: Copy the current private state to a secure temporary directory**

Use `mktemp -d`, set the directory/file to owner-only permissions, and never print names, URLs, headlines, or employment evidence. Record only source hash, schema version, connection count, and match count in the run evidence.

- [ ] **Step 2: Run migration against the copy**

Invoke the production migration path on the copy. Assert schema 2, strict validation, mode 0600, preserved valid connection/match counts subject only to documented retention, and no modification to the original file hash.

- [ ] **Step 3: Verify compact status output**

Run `referrals.mjs status` against the migrated copy. Require only source status, timestamps, aggregate counts, pending count, alias-review count, matched people, and matched jobs; it must contain no person or profile fields.

- [ ] **Step 4: Run the fail-fast test gate**

```bash
node --test \
  local/sunny-job-search/tests/linkedin-capture.test.mjs \
  local/sunny-job-search/tests/linkedin-dom-contract.test.mjs \
  local/sunny-job-search/tests/company-identities.test.mjs \
  local/sunny-job-search/tests/referrals.test.mjs \
  local/sunny-job-search/tests/builder.test.mjs \
  local/sunny-job-search/tests/app.test.mjs \
  local/sunny-job-search/tests/server.test.mjs \
  local/sunny-job-search/tests/ui-browser.test.mjs && \
node --check local/sunny-job-search/linkedin-capture.mjs && \
node --check local/sunny-job-search/linkedin-dom-extractors.mjs && \
node --check local/sunny-job-search/company-identities.mjs && \
node --check local/sunny-job-search/referrals.mjs && \
node --check data/tools/build-sunny-job-search-index.mjs && \
git diff --check
```

Expected: zero failed tests, zero syntax errors, and no whitespace errors.

- [ ] **Step 5: Audit the final diff and privacy boundary**

Require all of the following:

- no tracked fixture or diff contains a real connection name/profile URL;
- no Sheet-writing code changed;
- no live automation changed;
- no login/message/connect/apply path exists;
- no screenshot/full-page snapshot API exists in the production path;
- alias review contains no person/profile data;
- temporary files are mode 0600 and the copied live state is removed after checks;
- pre-existing unrelated staged, unstaged, and untracked files remain untouched.

- [ ] **Step 6: Report implementation evidence without committing**

Return changed files, exact test commands and counts, copied-state migration counts, any deliberate golden-baseline differences, and limitations. The real 20-card Brave golden smoke and live `sunny-24` prompt/activation remain pending external validation and must not be claimed as completed.

---

## Acceptance traceability

| Spec acceptance criterion | Implemented by |
|---|---|
| No screenshots/full snapshots | Tasks 2 and 7 |
| At most 50 compact cards | Task 2 |
| Reviewed explicit employer skips profile | Tasks 1, 3, and 5 |
| Missing/former/ambiguous uses one bounded Experience worklist | Tasks 1, 5, and 7 |
| Unchanged verified cards skip navigation | Tasks 1 and 5 |
| 24-hour cooldown and three-attempt cap | Task 5 |
| Canonical URL/reviewed alias only | Tasks 3 and 5 |
| Fuzzy suggestions never match | Tasks 3 and 5 |
| Compact daily output | Tasks 5 and 8 |
| Existing privacy, 14-day, localhost, and no-Sheet behavior | Tasks 4, 6, 7, and 8 |
| Golden smoke protected without live execution | Task 2 synthetic 20-card baseline; real smoke explicitly deferred |
