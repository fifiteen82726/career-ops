# Sunny LinkedIn Programmatic Capture R2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace screenshot- and model-driven LinkedIn connection inspection with a lossless, compact, deterministic Brave DOM capture pipeline that resolves only reviewed company identities, skips unchanged people, and preserves Sunny's existing private 14-day referral matching workflow.

**Architecture:** A self-contained read-only DOM extractor returns declared compact fields through the installed `tab.playwright.evaluate(...)` contract. A local parser and reviewed identity index prepare every observed card into a durable batch, a bounded adapter inspects at most 20 ambiguous profiles through one reusable Experience tab, and a schema-v2 ledger atomically merges all selected and nonselected observations with deterministic retry/cooldown before rebuilding the existing localhost index.

**Tech Stack:** Node.js 18+ ESM, built-in `node:test`, Playwright Chromium for synthetic DOM tests, injected fake browser/clock tests, strict TSV identity data, private JSON state, existing Sunny static localhost UI.

**Approved scope:** `docs/superpowers/specs/2026-09-16-sunny-linkedin-programmatic-capture-design.md`, authorized by the user's 2026-09-16 request: “幫我寫成 plan, 再套用 approved-execute”. This R2 incorporates the first independent PLAN_REVIEW findings without expanding scope.

**Execution constraints:** Do not commit, push, merge, publish, deploy, edit or activate the live `sunny-24` automation, log into LinkedIn, send messages, or run a live Brave/LinkedIn sweep. Local code, protocol, fixtures, copied-state migration, and tests are in scope. Preserve every pre-existing user file and unrelated instruction.

---

## File map

**Create**

- `local/sunny-job-search/linkedin-capture.mjs` — pure date parsing, headline classification, normalization, and stable card fingerprints.
- `local/sunny-job-search/linkedin-dom-extractors.mjs` — self-contained semantic DOM extractors returning compact JSON only.
- `local/sunny-job-search/company-identities.mjs` — strict reviewed company-map/alias parsing, collision quarantine, and canonical resolution.
- `local/sunny-job-search/linkedin-browser-adapter.mjs` — bounded orchestration over an injected read-only Brave session, filesystem/CLI functions, and clock.
- `data/sunny-linkedin-company-aliases.tsv` — exact six-column reviewed alias table, initially header-only.
- `local/sunny-job-search/tests/linkedin-capture.test.mjs`
- `local/sunny-job-search/tests/linkedin-dom-contract.test.mjs`
- `local/sunny-job-search/tests/company-identities.test.mjs`
- `local/sunny-job-search/tests/linkedin-browser-adapter.test.mjs`
- Synthetic fixtures below `local/sunny-job-search/tests/fixtures/linkedin/` for Connections, Experience, grouped Experience, empty-current, incomplete/loading, login, and challenge states.

**Modify**

- `local/sunny-job-search/referrals.mjs` — strict prepared/capture/state schemas, v1→v2 migration, lossless merge, retry state machine, canonical matcher, compact CLI.
- `local/sunny-job-search/tests/referrals.test.mjs` — v2, migration, lossless-ingest, retry, retention, and matching regressions.
- `data/tools/build-sunny-job-search-index.mjs` — shared v1/v2 migration/validation and existing bounded fallback.
- `local/sunny-job-search/tests/builder.test.mjs` — v1/v2 enrichment and fallback regressions.
- `profiles/sunny-linkedin-referral-browser.md` — executable no-screenshot protocol using the adapter.
- `modes/_custom.md` — referral-specific bullets only; preserve unrelated ATS/LCA/dedup rules byte-for-byte.
- `.gitignore` — add only `!data/sunny-linkedin-company-aliases.tsv` immediately after `data/*`.

**Verify unchanged unless a RED integration test proves a defect**

- `local/sunny-job-search/app.js`
- `local/sunny-job-search/index.html`
- `local/sunny-job-search/serve.mjs`
- Google Sheet writers and Sunny job-scan/company-discovery code.

---

### Task 1: Freeze explicit contracts and baseline hashes

**Files:**
- Read: every file in the map above
- Write evidence only: approved-execute run directory outside the repository

- [ ] Record initial HEAD, staged/unstaged state, exact untracked inventory, and SHA-256 hashes for every existing target, including ignored files under `local/`, `data/`, `profiles/`, and `modes/`.
- [ ] Record absence of every new file. Never use ordinary `git diff` as the only baseline because most implementation targets are ignored.
- [ ] Run the existing fail-fast baseline:

```bash
node --test \
  local/sunny-job-search/tests/referrals.test.mjs \
  local/sunny-job-search/tests/builder.test.mjs \
  local/sunny-job-search/tests/app.test.mjs \
  local/sunny-job-search/tests/server.test.mjs \
  local/sunny-job-search/tests/ui-browser.test.mjs
```

Expected: 30 tests pass, 0 fail. If not, stop and report the intervening conflict.

- [ ] Record private-state evidence without printing PII: schema version, connection count, match-row count, distinct matched people/jobs, mode, and SHA-256 only.
- [ ] Define strict schemas in tests before implementation:
  - compact card: `profileUrl`, `fullName`, `headline`, `connectedLabelRaw` only;
  - prepared batch: every normalized card, one deterministic disposition per card, selected worklist, source status, observed time, deadline, and counts;
  - final capture: the complete prepared batch plus inspection results for selected profiles only;
  - selection does not count as an attempt, and an inspection result cannot introduce or duplicate a profile.

---

### Task 2: Implement pure card parsing and cross-day-stable fingerprints

**Files:**
- Create: `local/sunny-job-search/linkedin-capture.mjs`
- Create: `local/sunny-job-search/tests/linkedin-capture.test.mjs`

- [ ] Write table-driven RED tests for:

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

Also cover multiple `@`/`at` names, former-plus-current text, client/agency phrasing, and unsupported delimiters. Uncertainty routes to Experience; it never becomes an explicit employer.

- [ ] Write RED date tests at New York midnight and DST boundaries for absolute English dates, `yesterday`, `N days ago`, `1 week ago`, unknown labels, impossible dates, and future dates. Require a conservative range and stable identity.
- [ ] Prove cross-day stability: “Connected yesterday” on day D and “Connected 2 days ago” on D+1 must produce the same parsed connection date and card fingerprint.
- [ ] Run and confirm RED:

```bash
node --test local/sunny-job-search/tests/linkedin-capture.test.mjs
```

- [ ] Implement and export exactly:

```js
export function canonicalLinkedinUrl(raw) {}
export function normalizeHeadline(value) {}
export function parseConnectionDate(label, { now = new Date(), timeZone = 'America/New_York' } = {}) {}
export function classifyHeadline(headline) {}
export function makeCardFingerprint({ profileUrl, headline, stableDateIdentity }) {}
export function normalizeConnectionCard(raw, options = {}) {}
```

Fingerprint the canonical profile URL, normalized headline, and stable absolute date identity. If no stable date can be obtained, fingerprint URL plus headline only. Keep this module dependency-free and re-export `canonicalLinkedinUrl` from `referrals.mjs` to preserve existing callers without an import cycle.

- [ ] Rerun the test command. Expected: all parser/date/fingerprint tests pass.

---

### Task 3: Implement reviewed identity resolution with collision quarantine

**Files:**
- Create: `local/sunny-job-search/company-identities.mjs`
- Create: `local/sunny-job-search/tests/company-identities.test.mjs`
- Create: `data/sunny-linkedin-company-aliases.tsv`
- Modify: `.gitignore`

- [ ] Create the alias file with only this exact header:

```tsv
alias_normalized	canonical_company_key	linkedin_company_url	verification_source	verified_on	status
```

- [ ] Add exactly `!data/sunny-linkedin-company-aliases.tsv` after the existing `data/*` ignore rule. Do not unignore any other user or runtime data.
- [ ] Write RED tests for exact Experience company URL, reviewed map label, verified alias, punctuation/case/whitespace normalization, reviewed parent convergence, missing identity, and same-name collision.
- [ ] Test that `Data Dog` does not match `Datadog` without a verified alias, fuzzy suggestions never resolve, an unknown label cannot override a conflicting observed Experience URL, and one collision does not disable unrelated identities.
- [ ] Distinguish malformed input from ambiguity:
  - wrong headers/columns, invalid URLs/dates/status fail validation;
  - syntactically valid conflicting label→URL rows quarantine that label as unresolved/reviewable;
  - a legacy strict parser wrapper may still throw for existing callers.
- [ ] Run and confirm RED:

```bash
node --test local/sunny-job-search/tests/company-identities.test.mjs
```

- [ ] Implement and export:

```js
export function normalizeCompanyAlias(value) {}
export function parseCompanyMapRows(tsvText, { collisionMode = 'quarantine' } = {}) {}
export function parseCompanyAliases(tsvText) {}
export function buildCompanyIdentityIndex({ companyMapRows, aliasRows }) {}
export function resolveCompanyIdentity(index, { companyLabel = '', companyLinkedinUrl = null } = {}) {}
export function suggestAliasCandidates(index, companyLabel, { limit = 3 } = {}) {}
```

Derive canonical keys from verified LinkedIn company URL slugs. Accept alias keys only when already present in the reviewed identity index. Use existing reviewed company-map relationships as evidence; do not infer aliases from unreviewed `portals.yml` or archive labels.

Return only:

```js
{ status: 'resolved', canonicalCompanyKey, linkedinCompanyUrl, quality: 'company_url_exact' }
{ status: 'resolved', canonicalCompanyKey, linkedinCompanyUrl, quality: 'reviewed_alias' }
{ status: 'unresolved', reason: 'missing' | 'collision' | 'url_conflict', candidates: [] }
```

- [ ] Rerun identity tests. Expected: PASS.

---

### Task 4: Implement strict schema v2 and atomic v1 migration

**Files:**
- Modify: `local/sunny-job-search/referrals.mjs`
- Modify: `local/sunny-job-search/tests/referrals.test.mjs`
- Add fixtures: `local/sunny-job-search/tests/fixtures/referrals/v1-*.json`

- [ ] Write RED tests for strict top-level, connection, employment, match, hash, prepared-batch, capture, and alias-review schemas. Reject unknown keys at every level and bound all strings/arrays.
- [ ] Define v2 connection fields exactly:

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
  resolvedCardFingerprint,
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

`verificationSource` is nullable until successful evidence exists; otherwise it is `connections_headline`, `experience_dom`, `manual_review`, or `legacy_verified`. `cardFingerprint` is the latest observed revision; `resolvedCardFingerprint` is the revision whose employer resolution succeeded. Legacy records may have null fingerprints.

- [ ] Define employment evidence so it separately retains observed `employerLabel`, observed `companyLinkedinUrl`, title, current/date evidence, resolved key, and resolution quality. Never fill a missing observed Experience URL with an alias-derived URL.
- [ ] Define a PII-free `aliasReviewQueue` row:

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

Assert serialization contains no person name or profile URL.
- [ ] Create v1 fixtures for headline evidence, legacy Experience evidence, pending, expired, malformed, and duplicate records. Write RED tests for pure, non-mutating migration.
- [ ] Migrate `Connections card headline:` evidence to `connections_headline`. Other previously valid verified evidence becomes `legacy_verified`; do not infer a completed DOM read solely from v1 `profileInspectionComplete`. Preserve valid matches until deterministic recomputation.
- [ ] Keep 90-day PII and 365-day hash retention. Expired person data must disappear from connections, matches, and review queue.
- [ ] Implement and export:

```js
export function validateReferralState(state) {}
export function migrateReferralStateV1ToV2(v1, { now = new Date() } = {}) {}
export function loadAndMigrateReferralState(path, { now = new Date(), write = false } = {}) {}
export function writeReferralStateAtomic(path, state) {}
```

For `write: true`, validate the whole v2 document, write/read/validate a mode-0600 same-directory temp file, then rename. Any error leaves original bytes unchanged.
- [ ] Run:

```bash
node --test local/sunny-job-search/tests/referrals.test.mjs
```

Expected: migration/schema/retention and pre-existing referral tests pass; live state remains untouched.

---

### Task 5: Implement lossless prepare, merge, retry, and canonical matching

**Files:**
- Modify: `local/sunny-job-search/referrals.mjs`
- Modify: `local/sunny-job-search/tests/referrals.test.mjs`

- [ ] Write a RED prepare→capture→merge test with 50 new cards requiring Experience. The first run inspects 20 yet persists all 50. With no cards supplied on later cycles, the worklist must inspect 20 then 10. Selection/unselection consumes no attempt.
- [ ] Write a RED explicit-unknown test: the connection observation persists with company evidence, creates one company-only review item, does not navigate merely because the alias is new, and resolves after a verified alias is added even if that card is absent from the next input.
- [ ] Write a RED changed-revision state-machine test:
  1. previously verified old fingerprint stays eligible;
  2. a new fingerprint with incomplete inspection preserves prior match but does not become resolved;
  3. attempts do not reset when the same changed card reappears;
  4. 24-hour cooldown is enforced;
  5. third actual individual failure marks that revision unresolved with no next retry;
  6. source challenge/error, unselected, and deadline-excluded cards consume no attempts.
- [ ] Cover complete negative Experience (no current role), multiple current roles, label-only Experience, incomplete reads, same capture replay, and fingerprint change after unresolved.
- [ ] Define the prepared batch exactly:

```js
{
  schemaVersion: 1,
  sourceStatus,
  observedAt,
  deadlineAt,
  cards: [
    {
      normalizedCard,
      disposition: 'skip_unchanged' | 'headline_resolved' | 'alias_review' | 'inspect_selected' | 'inspect_deferred'
    }
  ],
  profilesToInspect: [],
  aliasReviews: [],
  counts: { cardsRead, skippedKnown, headlineResolved, profilesQueued, profilesSelected, aliasReviews }
}
```

Every normalized card appears exactly once. Retained pending records absent from today's card list may appear in the selected worklist and must reference their durable state identity.
- [ ] Implement and export:

```js
export function prepareConnectionWorklist({ state, cards, identityIndex, sourceStatus, observedAt, now, limit = 20, deadlineAt }) {}
export function mergeProgrammaticCapture(previous, capture, { identityIndex, jobs, now = new Date() } = {}) {}
export function buildReferralMatches({ jobs, state, identityIndex, now = new Date(), windowDays = 14 }) {}
```

Sort never-attempted pending first, then eligible least-recently-attempted pending, then new inspection-required cards. Process at most 50 new cards and select at most 20 profiles under one deadline.
- [ ] Merge all prepared cards, including deferred ones, before applying actual inspection outcomes. Validate that outcomes are unique and selected. Recompute matches on every merge, including source failures.
- [ ] Match job and employment only when both resolve to the same reviewed canonical key. A real observed Experience URL may yield `company_url_exact`; a label-based reviewed path yields `reviewed_alias`. Missing observed Experience URL never auto-matches through a label alias. Never call `suggestAliasCandidates()` from matching code.
- [ ] Preserve both connection-range endpoints and job `scanDate` inside the latest 14 New York calendar days, and choose the newest eligible row per canonical apply URL.
- [ ] Update CLI:
  - `worklist` consumes strict compact cards plus map/alias paths and writes the complete prepared batch mode 0600;
  - `merge` consumes the complete prepared batch plus inspection outcomes, loads/migrates state, atomically writes v2, and rebuilds matches;
  - `status` outputs aggregate counts only.

Temporary paths remain absolute; durable paths remain inside the resolved data root. Bound model-visible alias reviews to 10 company-only rows with at most 3 candidates and a remaining count.
- [ ] Run referral tests. Expected: PASS, including 20/20/10 from initially unpersisted cards and changed-fingerprint retry behavior.

---

### Task 6: Implement semantic compact DOM extraction

**Files:**
- Create: `local/sunny-job-search/linkedin-dom-extractors.mjs`
- Create: `local/sunny-job-search/tests/linkedin-dom-contract.test.mjs`
- Create fixtures below: `local/sunny-job-search/tests/fixtures/linkedin/`

- [ ] Build semantic fixtures using realistic profile/company links, headings, list structure, and date labels. Test after stripping every fixture-only `data-testid`; production extraction must not depend on test hooks.
- [ ] Connections fixtures cover 20 cards with exactly 11 explicit and 9 Experience-required classifications, plus a separate >50-card fixture, duplicates, malformed URLs, hidden unrelated text, and inert prompt-injection text.
- [ ] Experience fixtures cover standalone entries, grouped promotions inheriting parent company URL, simultaneous current roles, former roles, complete zero-current, loading, unreadable, truncated/expansion-required, and unsupported states.
- [ ] Authentication fixtures cover login, checkpoint, CAPTCHA, OTP, email/phone verification, and security-key states.
- [ ] Write RED Playwright tests asserting:
  - at most 50 compact cards;
  - output keys are declared only;
  - grouped/current/former behavior is correct;
  - `inspectionComplete=true` requires identifiable fully processed Experience with no unreadable/incomplete signal;
  - changed/unrecognized Connections DOM is `partial`/`error`, never successful empty;
  - login/challenge emits no card/employment payload.
- [ ] Run and confirm RED:

```bash
node --test local/sunny-job-search/tests/linkedin-dom-contract.test.mjs
```

- [ ] Implement self-contained, browser-serializable exports:

```js
export function detectLinkedInSourceStatus(document, locationHref = '') {}
export function extractConnectionCards(document, { limit = 50 } = {}) {}
export function extractCurrentExperience(document, profileUrl) {}
```

Each function may use only nested helpers declared inside itself or explicit arguments. Read bounded relevant element text/attributes only. Do not use screenshots, accessibility snapshots, raw HTML, `outerHTML`, `body.innerHTML`, whole-page `innerText`, messages, posts, contact details, or unrelated profile sections.
- [ ] Add a source-level prohibition test and rerun. Expected: PASS without network.

---

### Task 7: Add an executable bounded Brave adapter

**Files:**
- Create: `local/sunny-job-search/linkedin-browser-adapter.mjs`
- Create: `local/sunny-job-search/tests/linkedin-browser-adapter.test.mjs`

- [ ] Write RED tests using injected fake session/tabs, filesystem/CLI functions, and fake clock. Production orchestration—not a test duplicate—must be invoked.
- [ ] Prove:
  - the named existing Brave profile is required; unavailable/ambiguous profile fails soft;
  - one Connections tab is reused;
  - one Experience tab is acquired lazily and reused;
  - known/explicit/alias-review-only cards cause zero profile navigation;
  - no more than 20 Experience navigations occur;
  - one absolute 10-minute deadline is checked before every browser operation;
  - expiry mid-loop stops further navigation without charging uninspected attempts;
  - challenge during any page stops browser work immediately;
  - every navigation URL equals a canonical selected worklist URL plus `details/experience/`;
  - model-visible output is aggregate counts plus bounded company-only reviews.
- [ ] Implement against the installed documented read-only API `tab.playwright.evaluate(...)`. The adapter must never call screenshot, DOM/accessibility snapshot, direct CDP attachment, separate persistent browser profile, or LinkedIn private endpoints.
- [ ] Implement the sequence:
  1. establish absolute deadline;
  2. acquire/reuse named Brave Connections tab and confirm authenticated list semantics;
  3. evaluate `extractConnectionCards` and run preparation;
  4. lazily reuse one Experience tab for selected profiles only;
  5. evaluate `extractCurrentExperience` with remaining-time bounds;
  6. merge the complete prepared batch;
  7. delete private temp handoffs after successful merge;
  8. rebuild localhost snapshot atomically;
  9. report rebuild failure without replacing the previous valid snapshot.
- [ ] Run:

```bash
node --test local/sunny-job-search/tests/linkedin-browser-adapter.test.mjs
```

Expected: PASS. Do not bind or execute this adapter against live Brave in this task.

---

### Task 8: Preserve builder/UI behavior and update protocol narrowly

**Files:**
- Modify: `data/tools/build-sunny-job-search-index.mjs`
- Modify: `local/sunny-job-search/tests/builder.test.mjs`
- Modify: `profiles/sunny-linkedin-referral-browser.md`
- Modify only referral bullets: `modes/_custom.md`

- [ ] Write RED builder regressions for valid v2 enrichment, valid v1 in-memory migration with unchanged bytes, missing/invalid referral input, fresh unrelated jobs, bounded prior contact cache, invalid/expired contacts, exact date+canonical-URL attachment, mode 0600, and atomic replacement.
- [ ] Use the shared strict validator/migration; do not add a second shallow schema. Preserve existing `referralContacts`, `referralDataStatus`, and `referralDataUpdatedAt`, so UI production files remain unchanged.
- [ ] Run:

```bash
node --test \
  local/sunny-job-search/tests/builder.test.mjs \
  local/sunny-job-search/tests/app.test.mjs \
  local/sunny-job-search/tests/server.test.mjs \
  local/sunny-job-search/tests/ui-browser.test.mjs
```

Expected: PASS; local profile links remain `referrerpolicy="no-referrer"`.
- [ ] Update the browser profile with exact adapter/CLI usage, prepared/capture shapes, 50/20/10 bounds, authentication/challenge stops, reviewed-alias behavior, private temp cleanup, compact output, and no fallback to prohibited reads.
- [ ] Edit only the referral-specific bullets in `modes/_custom.md`. Preserve verbatim these existing trailing rules:
  - official ATS/careers resolution for qualifying seeds;
  - historical LCA titles as ranking evidence only;
  - legal employer plus ATS board identity deduplication.

Preserve every unrelated company-discovery, daily scan, Sheet, and scheduler instruction.
- [ ] Extend protocol tests to assert exact production extractor/adapter names, caps, private v2 state, alias review, no-Sheet boundary, and all prohibited actions. Protocol prose supplements executable adapter tests; it does not replace them.

---

### Task 9: Verify full synthetic golden behavior and copied-state preservation

**Files:**
- Add synthetic golden fixtures under `local/sunny-job-search/tests/fixtures/linkedin/`
- Temporary owner-only data root outside repository

- [ ] Add an offline golden test with:
  - 20 cards;
  - 11 explicit reviewed employers;
  - 9 Experience inspections;
  - 20 resolved current connections;
  - 12 matched people;
  - 9 matched recent jobs;
  - a second unchanged run with zero Experience navigations;
  - one fuzzy near-match producing no referral.

Use synthetic people, identities, and jobs only.
- [ ] Securely copy the real v1 state, reviewed company map, and job archive to a `mktemp -d` owner-only data root. Use fixed time `2026-09-16T16:00:00.000Z`. Never print person data.
- [ ] Run production migration and matching against copies. Compare match-key sets privately and report only aggregate equality. Expected baseline unless explicit reviewed evidence explains a difference: 20 connections, 16 match rows, 12 people, 9 jobs.
- [ ] Prove original hashes unchanged, copied output schema 2 valid, files mode 0600, status output PII-free, and exact temporary artifacts deleted after verification.
- [ ] Run the complete fail-fast gate:

```bash
node --test \
  local/sunny-job-search/tests/linkedin-capture.test.mjs \
  local/sunny-job-search/tests/linkedin-dom-contract.test.mjs \
  local/sunny-job-search/tests/linkedin-browser-adapter.test.mjs \
  local/sunny-job-search/tests/company-identities.test.mjs \
  local/sunny-job-search/tests/referrals.test.mjs \
  local/sunny-job-search/tests/builder.test.mjs \
  local/sunny-job-search/tests/app.test.mjs \
  local/sunny-job-search/tests/server.test.mjs \
  local/sunny-job-search/tests/ui-browser.test.mjs && \
node --check local/sunny-job-search/linkedin-capture.mjs && \
node --check local/sunny-job-search/linkedin-dom-extractors.mjs && \
node --check local/sunny-job-search/company-identities.mjs && \
node --check local/sunny-job-search/linkedin-browser-adapter.mjs && \
node --check local/sunny-job-search/referrals.mjs && \
node --check data/tools/build-sunny-job-search-index.mjs && \
git diff --check
```

Expected: zero failed tests, syntax errors, and whitespace errors.
- [ ] Compare every explicit task file to its initial snapshot and record final hashes because Git excludes ignored local files. Audit:
  - no real person in tracked fixtures/diffs/logs;
  - no private live-state mutation;
  - no Sheet writer or live automation change;
  - no login/message/connect/apply path;
  - no screenshot/full-page snapshot path;
  - alias-review data contains no person/profile fields;
  - unrelated user files and customization instructions remain unchanged.
- [ ] Report exact checks, aggregate copied-state migration results, changed-file hashes, and limitations without committing. Real Brave selector compatibility/golden smoke and `sunny-24` activation are deferred, not passed.

---

## Acceptance traceability

| Spec acceptance criterion | Evidence required |
|---|---|
| No screenshots/full snapshots | DOM source prohibition + executable adapter tests + protocol |
| At most 50 compact cards | >50 semantic Connections fixture |
| Reviewed explicit employer skips profile | prepare + fake-adapter navigation tests |
| Missing/former/ambiguous uses one reusable tab | parser + fake-adapter tab-count tests |
| Unchanged verified cards skip navigation | resolved-vs-observed fingerprint regression + second golden run |
| Deterministic cooldown/three-attempt cap | changed-card state-machine tests |
| Exact canonical URL/reviewed alias only | identity collision and matcher tests |
| Fuzzy suggestions never match | identity and golden near-match tests |
| Compact model-visible output | strict adapter/CLI output tests |
| Existing privacy, 14-day, localhost, no-Sheet behavior | migration, retention, builder/UI and audit tests |
| Golden smoke | complete synthetic 20/11/9→20/12/9 oracle + copied-state preservation; live Brave explicitly deferred |
