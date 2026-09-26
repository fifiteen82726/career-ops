# Sunny LinkedIn Title-Only Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace LinkedIn profile/Experience fallback with a Connections-headline-only resolver that uses exact local identities first, a catalog-bounded AI decision second, durable learned aliases third, and zero profile navigation in every path.

**Architecture:** A read-only Brave adapter extracts at most 50 visible Connections cards. Pure local modules normalize cards, build one collision-aware company relation, prepare at most 10 PII-minimized AI requests, validate decisions, and atomically persist accepted company-only aliases. A strict schema-v3 referral ledger caches resolved and unresolved title decisions, preserves eligible legacy matches, applies 90/365 retention, and feeds the existing localhost job index. The adapter contains a hard URL guard: only the Connections URL may be loaded.

**Tech Stack:** Node.js ES modules, Node test runner, Playwright for offline DOM-contract tests only, injected installed-browser interface for Brave adapter tests, TSV/JSON user-layer storage, SHA-256 revisions and fingerprints.

**Approved spec:** `docs/superpowers/specs/2026-09-16-sunny-linkedin-title-only-capture-design.md`

**Execution constraint:** Do not commit, push, merge, deploy, publish, activate a schedule, run a live LinkedIn sweep, send messages, connect, apply, or mutate Google Sheets. All tests use fixtures or copied private state.

---

## File structure

- Modify `local/sunny-job-search/linkedin-capture.mjs`: URL/date/headline normalization only.
- Modify `local/sunny-job-search/company-identities.mjs`: strict identity relation, exact resolution, candidate generation, revisions.
- Create `local/sunny-job-search/linkedin-title-resolver.mjs`: AI request/decision schemas and acceptance gate.
- Create `local/sunny-job-search/company-alias-store.mjs`: locked atomic alias persistence.
- Modify `local/sunny-job-search/referrals.mjs`: schema-v3 migration, validation, preparation, merge, retention, matching, CLI handoffs.
- Modify `local/sunny-job-search/linkedin-dom-extractors.mjs`: self-contained Connections extractor only.
- Modify `local/sunny-job-search/linkedin-browser-adapter.mjs`: Connections-only installed-interface adapter.
- Modify `data/tools/build-sunny-job-search-index.mjs`: schema-v3 enrichment and fail-safe rebuild.
- Modify `profiles/sunny-linkedin-referral-browser.md`, `modes/_custom.md`, and `data/sunny-linkedin-company-aliases.tsv`.
- Modify existing LinkedIn/referral/builder tests and create `linkedin-title-resolver.test.mjs`, `company-alias-store.test.mjs`, and `linkedin-title-only-golden.test.mjs`.

---

### Task 1: Freeze the no-profile contract and simplify headline parsing

**Files:**
- Modify: `local/sunny-job-search/linkedin-capture.mjs`
- Test: `local/sunny-job-search/tests/linkedin-capture.test.mjs`

- [ ] **Step 1: Write title-only parsing tests**

Add:

```js
test('title-only parser distinguishes current former ambiguous and missing', () => {
  assert.deepEqual(classifyHeadline('DS @ Capital One | CMU Alumni'), {
    classification: 'explicit_employer', employerLabel: 'Capital One',
  });
  assert.deepEqual(classifyHeadline('Staff Software Engineer'), {
    classification: 'missing_employer', employerLabel: null,
  });
  assert.deepEqual(classifyHeadline('Former Engineer at Old Co'), {
    classification: 'former_only', employerLabel: null,
  });
  assert.deepEqual(classifyHeadline('Former Engineer at Old Co · Staff Engineer at Capital One'), {
    classification: 'explicit_employer', employerLabel: 'Capital One',
  });
  assert.equal(classifyHeadline('Engineer at Alpha | Consultant at Beta').classification, 'ambiguous_employer');
});

test('tracking query is removed from stored profile identity', () => {
  const card = normalizeConnectionCard({
    profileUrl: 'https://www.linkedin.com/in/example/?miniProfileUrn=abc',
    fullName: 'Example', headline: 'Engineer at Capital One',
    connectedLabelRaw: 'Connected on September 16, 2026',
  }, { now: new Date('2026-09-16T16:00:00Z') });
  assert.equal(card.profileUrl, 'https://www.linkedin.com/in/example/');
  assert.equal(card.stableDateIdentity, '2026-09-16');
});
```

- [ ] **Step 2: Run RED**

Run `node --test local/sunny-job-search/tests/linkedin-capture.test.mjs`.

Expected: tracking-query canonicalization and at least one clause case fail.

- [ ] **Step 3: Implement the strict normalized-card boundary**

The public output must have exactly:

```js
{
  profileUrl, fullName, headline, connectedLabelRaw,
  connectedAtEarliest, connectedAtLatest, connectedDatePrecision,
  stableDateIdentity, cardFingerprint, classification, employerLabel,
}
```

Strip query/hash only after validating LinkedIn host and exact `/in/<slug>` pathname. Parse former markers per clause. Reject unknown input fields, impossible/future dates, oversized strings, non-profile URLs, and classifications outside `explicit_employer`, `ambiguous_employer`, `former_only`, `missing_employer`.

- [ ] **Step 4: Run GREEN**

Expected: all capture tests pass.

---

### Task 2: Build one collision-aware company identity relation

**Files:**
- Modify: `local/sunny-job-search/company-identities.mjs`
- Modify: `data/sunny-linkedin-company-aliases.tsv`
- Test: `local/sunny-job-search/tests/company-identities.test.mjs`

- [ ] **Step 1: Write identity and candidate tests**

Add the exact cross-namespace case:

```js
const reviewed = overrides => ({
  company_key: 'default-key', company_display: 'Default',
  linkedin_company_url: 'https://www.linkedin.com/company/default/',
  linkedin_people_url: 'https://www.linkedin.com/company/default/people/',
  verification_source: 'test-reviewed-identity', verified_on: '2026-09-16', status: 'verified',
  ...overrides,
});

test('one relation quarantines collisions across all namespaces', () => {
  const index = buildCompanyIdentityIndex({ companyMapRows: [
    reviewed({ company_key: 'first-key', company_display: 'First', linkedin_company_url: 'https://www.linkedin.com/company/alpha/' }),
    reviewed({ company_key: 'second-key', company_display: 'Alpha', linkedin_company_url: 'https://www.linkedin.com/company/beta/' }),
    reviewed({ company_key: 'capital-one', company_display: 'Capital One', linkedin_company_url: 'https://www.linkedin.com/company/capital-one/' }),
  ], aliasRows: [] });
  assert.equal(resolveCompanyIdentity(index, { companyLabel: 'alpha' }).reason, 'collision');
  assert.equal(resolveCompanyIdentity(index, { companyLabel: 'Capital One' }).canonicalCompanyKey, 'capital-one');
});

test('candidate generation ranks but never resolves fuzzy text', () => {
  const index = buildCompanyIdentityIndex({
    companyMapRows: [reviewed({
      company_key: 'american-express', company_display: 'American Express',
      linkedin_company_url: 'https://www.linkedin.com/company/american-express/',
      linkedin_people_url: 'https://www.linkedin.com/company/american-express/people/',
    })],
    aliasRows: [],
  });
  const candidates = generateCompanyCandidates(index, 'AMEX', { limit: 5 });
  assert.ok(candidates.length <= 5);
  assert.equal(resolveCompanyIdentity(index, { companyLabel: 'AMEX' }).status, 'unresolved');
  assert.equal(new Set(candidates.map(x => x.canonicalCompanyKey)).size, candidates.length);
});
```

Reject impossible dates, non-finite/out-of-range confidence, person URLs, blank fingerprints/revisions, unknown targets/columns, duplicate aliases, and conflicting accepted rows.

- [ ] **Step 2: Run RED**

Run `node --test local/sunny-job-search/tests/company-identities.test.mjs`.

- [ ] **Step 3: Implement the unified candidate relation**

Replace independent precedence maps with `normalized token -> Set<canonicalCompanyKey>`. Add tokens for reviewed key, display label, canonical LinkedIn slug, and accepted aliases. Resolution succeeds only when the set has one key and URL evidence agrees.

Export:

```js
parseCompanyMapRows(tsvText)
parseCompanyAliases(tsvText)
buildCompanyIdentityIndex({ companyMapRows, aliasRows, trackedCompanyRows })
resolveCompanyIdentity(index, { companyLabel, companyLinkedinUrl })
generateCompanyCandidates(index, observedText, { limit = 5 })
computeCatalogRevision(index)
computeAliasMappingRevision(aliasRows)
```

Candidates contain `{ canonicalCompanyKey, companyDisplay, linkedinCompanyUrl, compatibilitySignals }`. Signals are drawn only from `exact_token`, `acronym`, `token_overlap`, `slug_overlap`, `edit_distance` and never auto-resolve.

- [ ] **Step 4: Replace the header-only alias file schema**

Use exactly:

```tsv
alias_normalized	canonical_company_key	linkedin_company_url	resolution_source	confidence	evidence_fingerprint	catalog_revision	resolved_on	status
```

- [ ] **Step 5: Run GREEN**

Expected: every identity test passes.

---

### Task 3: Implement the bounded AI title contract

**Files:**
- Create: `local/sunny-job-search/linkedin-title-resolver.mjs`
- Create: `local/sunny-job-search/tests/linkedin-title-resolver.test.mjs`

- [ ] **Step 1: Write PII, membership, confidence, limit, and cache tests**

```js
const normalizedCard = overrides => ({
  profileUrl: 'https://www.linkedin.com/in/example/', fullName: 'Example Person',
  headline: 'DS @ AMEX', connectedLabelRaw: 'Connected on September 16, 2026',
  connectedAtEarliest: '2026-09-16', connectedAtLatest: '2026-09-16',
  connectedDatePrecision: 'day', stableDateIdentity: '2026-09-16',
  cardFingerprint: 'c'.repeat(64), classification: 'explicit_employer', employerLabel: 'AMEX',
  ...overrides,
});
const candidate = (canonicalCompanyKey, companyDisplay, compatibilitySignals) => ({
  canonicalCompanyKey, companyDisplay,
  linkedinCompanyUrl: `https://www.linkedin.com/company/${canonicalCompanyKey}/`,
  compatibilitySignals,
});
const inputsOfLength = length => Array.from({ length }, (_, index) => ({
  card: normalizedCard({
    profileUrl: `https://www.linkedin.com/in/example-${index}/`,
    cardFingerprint: String(index).padStart(64, '0'),
  }),
  candidates: [candidate('american-express', 'American Express', ['acronym'])],
  catalogRevision: 'a'.repeat(64), aliasMappingRevision: 'b'.repeat(64),
}));

test('accepted decision is candidate-bounded and PII-minimized', () => {
  const request = buildTitleResolutionRequest({
    card: normalizedCard({ headline: 'DS @ AMEX', employerLabel: 'AMEX' }),
    candidates: [candidate('american-express', 'American Express', ['acronym'])],
    catalogRevision: 'a'.repeat(64), aliasMappingRevision: 'b'.repeat(64),
  });
  assert.doesNotMatch(JSON.stringify(request), /Example Person|linkedin\.com\/in/);
  const accepted = validateTitleResolutionDecision(request, {
    schemaVersion: 1, decision: 'resolved', canonicalCompanyKey: 'american-express',
    confidence: 0.98, reasonCode: 'recognized_brand_alias',
  });
  assert.equal(accepted.status, 'accepted');
});

test('batch is deterministic and capped at ten', () => {
  const batch = buildTitleResolutionBatch(inputsOfLength(12));
  assert.equal(batch.requests.length, 10);
  assert.equal(batch.deferredCount, 2);
  assert.deepEqual(batch.requests.map(x => x.requestId), [...batch.requests.map(x => x.requestId)].sort());
});

test('outside candidate low confidence malformed and former-only never resolve', () => {
  const request = buildTitleResolutionRequest(inputsOfLength(1)[0]);
  for (const decision of [
    { schemaVersion: 1, decision: 'resolved', canonicalCompanyKey: 'outside', confidence: 0.99, reasonCode: 'recognized_brand_alias' },
    { schemaVersion: 1, decision: 'resolved', canonicalCompanyKey: 'american-express', confidence: 0.94, reasonCode: 'recognized_brand_alias' },
    { schemaVersion: 1, decision: 'resolved', confidence: 'high' },
  ]) assert.equal(validateTitleResolutionDecision(request, decision).status, 'unresolved');
  assert.equal(buildTitleResolutionRequest({
    ...inputsOfLength(1)[0],
    card: normalizedCard({ classification: 'former_only', employerLabel: null }),
  }), null);
});
```

Test outside-candidate, low-confidence, malformed, former-only, no compatibility signal, duplicate request IDs, and cache-key revision changes.

- [ ] **Step 2: Run RED**

Run `node --test local/sunny-job-search/tests/linkedin-title-resolver.test.mjs` and expect module-not-found.

- [ ] **Step 3: Implement pure contracts**

Export:

```js
buildTitleResolutionRequest({ card, candidates, catalogRevision, aliasMappingRevision })
buildTitleResolutionBatch(inputs, { limit = 10 })
validateTitleResolutionDecision(request, decision)
makeUnresolvedCacheKey({ cardFingerprint, catalogRevision, aliasMappingRevision })
makeAcceptedAliasRow({ request, decision, resolvedOn })
```

Use SHA-256 for request IDs, evidence fingerprints, and cache keys. Enforce exact schemas. The request excludes name/profile URL; the accepted row excludes the full headline. Untrusted model output returns normalized unresolved rather than mutating state.

- [ ] **Step 4: Run GREEN**

Expected: all resolver tests pass.

---

### Task 4: Persist learned aliases atomically

**Files:**
- Create: `local/sunny-job-search/company-alias-store.mjs`
- Create: `local/sunny-job-search/tests/company-alias-store.test.mjs`

- [ ] **Step 1: Write temporary-store tests**

Use `mkdtemp`, never the live mapping:

```js
const amexRow = {
  alias_normalized: 'amex', canonical_company_key: 'american-express',
  linkedin_company_url: 'https://www.linkedin.com/company/american-express/',
  resolution_source: 'ai_title', confidence: '0.98',
  evidence_fingerprint: 'e'.repeat(64), catalog_revision: 'c'.repeat(64),
  resolved_on: '2026-09-16', status: 'accepted',
};

test('accepted alias writes once and replay is byte-identical', () => {
  const first = mergeAcceptedAliasRows(path, [amexRow], { lockTimeoutMs: 50 });
  const bytes = readFileSync(path);
  const second = mergeAcceptedAliasRows(path, [amexRow], { lockTimeoutMs: 50 });
  assert.equal(first.added, 1);
  assert.equal(second.added, 0);
  assert.deepEqual(readFileSync(path), bytes);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('conflict quarantines without overwriting', () => {
  mergeAcceptedAliasRows(path, [amexRow]);
  const result = mergeAcceptedAliasRows(path, [{ ...amexRow, canonical_company_key: 'other' }]);
  assert.equal(result.quarantined.length, 1);
  assert.match(readFileSync(path, 'utf8'), /american-express/);
  assert.doesNotMatch(readFileSync(path, 'utf8'), /\tother\t/);
});
```

Also test lock contention, invalid next document, injected rename failure, cleanup, and prior-byte preservation.

- [ ] **Step 2: Run RED**

Run `node --test local/sunny-job-search/tests/company-alias-store.test.mjs` and expect module-not-found.

- [ ] **Step 3: Implement locked atomic storage**

Export `loadAliasStore(path)` and `mergeAcceptedAliasRows(path, rows, { lockTimeoutMs = 2000, fs = defaultFs })`. Use exact sibling lock/temp files, exclusive lock creation, complete-next-document validation through `parseCompanyAliases`, mode `0600`, fsync, atomic rename, and `finally` cleanup. Identical rows are no-ops; conflicts return a bounded company-only quarantine result.

- [ ] **Step 4: Run GREEN**

Expected: all alias-store tests pass with no temp leak.

---

### Task 5: Replace Experience worklists with a strict schema-v3 title-only ledger

**Files:**
- Modify: `local/sunny-job-search/referrals.mjs`
- Modify: `local/sunny-job-search/tests/referrals.test.mjs`

- [ ] **Step 1: Replace profile-retry tests with title-only state tests**

Delete desired-behavior assertions for `profilesToInspect`, `inspectionResults`, `experienceInspectionComplete`, `verificationAttempts`, and Experience evidence. Add:

```js
const now = new Date('2026-09-16T16:00:00Z');
const observedAt = now.toISOString();
const laterDate = new Date('2026-09-16T17:00:00Z');
const later = laterDate.toISOString();
const companyRow = (company_key, company_display) => ({
  company_key, company_display,
  linkedin_company_url: `https://www.linkedin.com/company/${company_key}/`,
  linkedin_people_url: `https://www.linkedin.com/company/${company_key}/people/`,
  verification_source: 'test-reviewed-identity', verified_on: '2026-09-16', status: 'verified',
});
const capitalOneRow = companyRow('capital-one', 'Capital One');
const americanExpressRow = companyRow('american-express', 'American Express');
const acmeRow = companyRow('acme', 'Acme');
const exactCard = normalizeConnectionCard({
  profileUrl: 'https://www.linkedin.com/in/exact/', fullName: 'Exact',
  headline: 'Engineer at Capital One', connectedLabelRaw: 'Connected yesterday',
}, { now });
const aiCard = normalizeConnectionCard({
  profileUrl: 'https://www.linkedin.com/in/ai/', fullName: 'AI',
  headline: 'DS @ AMEX', connectedLabelRaw: 'Connected yesterday',
}, { now });
const missingCard = normalizeConnectionCard({
  profileUrl: 'https://www.linkedin.com/in/missing/', fullName: 'Missing',
  headline: 'Staff Software Engineer', connectedLabelRaw: 'Connected yesterday',
}, { now });
const identityIndex = buildCompanyIdentityIndex({
  companyMapRows: [capitalOneRow, americanExpressRow], aliasRows: [], trackedCompanyRows: [],
});
const cards = [exactCard, aiCard, missingCard];
const jobs = [];

test('prepare resolves exact creates bounded AI work and has no profile work', () => {
  const prepared = prepareTitleOnlyCapture({ state: null, cards, identityIndex, observedAt, now });
  assert.equal('profilesToInspect' in prepared, false);
  assert.equal('inspectionResults' in prepared, false);
  assert.equal(prepared.counts.profileNavigations, 0);
  assert.equal(prepared.aiRequests.length, 1);
});

test('identical second run reuses resolved and unresolved with zero AI', () => {
  const stableCards = [exactCard, missingCard];
  const preparedFirst = prepareTitleOnlyCapture({ state: null, cards: stableCards, identityIndex, observedAt, now });
  const finalizedFirst = finalizeTitleOnlyCapture(preparedFirst, [], { persistedAliasRows: [] });
  const first = mergeTitleOnlyCapture(null, finalizedFirst, { identityIndex, jobs, now });
  const second = prepareTitleOnlyCapture({ state: first, cards: stableCards, identityIndex, observedAt: later, now: laterDate });
  assert.equal(second.aiRequests.length, 0);
  assert.equal(second.counts.reusedResolved + second.counts.reusedUnresolved, stableCards.length);
  assert.equal(second.counts.profileNavigations, 0);
});

test('catalog or mapping revision retries one unresolved title', () => {
  const sameCard = normalizeConnectionCard({
    profileUrl: 'https://www.linkedin.com/in/acme/', fullName: 'Acme Person',
    headline: 'Engineer at Acme', connectedLabelRaw: 'Connected yesterday',
  }, { now });
  const firstPrepared = prepareTitleOnlyCapture({ state: null, cards: [sameCard], identityIndex, observedAt, now });
  const state = mergeTitleOnlyCapture(null, finalizeTitleOnlyCapture(firstPrepared, [], { persistedAliasRows: [] }), { identityIndex, jobs, now });
  const changedIndex = buildCompanyIdentityIndex({
    companyMapRows: [capitalOneRow, americanExpressRow, acmeRow], aliasRows: [], trackedCompanyRows: [],
  });
  const next = prepareTitleOnlyCapture({ state, cards: [sameCard], identityIndex: changedIndex, observedAt, now });
  assert.equal(next.aiRequests.length, 1);
});
```

Add rejection tests for unknown fields, impossible dates, invalid hashes/revisions, malformed resolutions, duplicate cards/connections/matches, inconsistent counts, outside-request decisions, and more than 10 AI requests. Add v1/v2 migration plus 90/365 retention tests at load, migration, merge, and rebuild.

- [ ] **Step 2: Run RED**

Run `node --test local/sunny-job-search/tests/referrals.test.mjs`.

Expected: title-only exports are missing and old Experience fields remain.

- [ ] **Step 3: Implement schema v3 and pure migration**

V3 connection fields are exactly:

```js
{
  profileUrl, profileHash, fullName, headline, connectedLabelRaw,
  connectedAtEarliest, connectedAtLatest, connectedDatePrecision,
  cardFingerprint, cardClassification, observedEmployerLabel,
  resolutionStatus, resolutionSource, canonicalCompanyKey,
  companyLinkedinUrl, roleTitle, resolvedCardFingerprint,
  resolutionEvidenceFingerprint, unresolvedCacheKey,
  firstSeenAt, lastObservedAt,
}
```

Allowed sources: `connections_headline_exact`, `connections_headline_ai_alias`, `manual_review`, `legacy_verified`, `null`. Resolved records require canonical key, company URL, source, and resolved fingerprint. Unresolved records require a cache key unless the source was skipped before card processing.

Export:

```js
migrateReferralStateToV3(state, { now })
validateReferralStateV3(state)
prepareTitleOnlyCapture({ state, cards, identityIndex, observedAt, sourceStatus, now })
finalizeTitleOnlyCapture(prepared, decisions, { persistedAliasRows })
mergeTitleOnlyCapture(previous, finalized, { identityIndex, jobs, now })
loadAndMigrateReferralState(path, { now, write })
writeReferralStateAtomic(path, state)
```

V1/v2 migrations remain pure. Existing eligible verified data becomes `legacy_verified`; copied match keys remain identical. Production code no longer constructs profile work or Experience state.

- [ ] **Step 4: Implement title-only preparation and merge**

Preparation dispositions are exactly:

```text
reuse_resolved
reuse_unresolved
resolved_exact
request_ai
unresolved_no_candidate
deferred_ai_limit
source_skipped
```

Sort AI requests by request ID and cap at 10. Finalization accepts only decisions whose alias rows were persisted successfully. Merge recomputes deterministic 14-day matches. Source-wide errors preserve prior good evidence and never create a successful empty capture.

- [ ] **Step 5: Run GREEN**

Expected: all title-only schema, migration, retention, dedup, resolution, and matching tests pass.

---

### Task 6: Make DOM extraction and Brave orchestration Connections-only

**Files:**
- Modify: `local/sunny-job-search/linkedin-dom-extractors.mjs`
- Modify: `local/sunny-job-search/linkedin-browser-adapter.mjs`
- Modify: `local/sunny-job-search/tests/linkedin-dom-contract.test.mjs`
- Modify: `local/sunny-job-search/tests/linkedin-browser-adapter.test.mjs`
- Modify fixtures under: `local/sunny-job-search/tests/fixtures/linkedin/`

- [ ] **Step 1: Write real serialized DOM tests with no Experience API**

Execute `extractConnectionCards.toString()` in headless Playwright for semantic list, hidden/sidebar cards, tracking-query links, dates, loading, wrong ordering, login, OTP, email/phone/security key, iframe CAPTCHA, injection text, and unknown structure.

```js
const domModule = await import('../linkedin-dom-extractors.mjs');
assert.equal('extractCurrentExperience' in domModule, false);
```

- [ ] **Step 2: Write adapter invariant tests**

```js
const semanticConnectionsPayload = {
  sourceStatus: 'ok', ordering: 'recently_added',
  cards: [{
    profileUrl: 'https://www.linkedin.com/in/example/', fullName: 'Example',
    headline: 'Engineer at Capital One', connectedLabelRaw: 'Connected on September 16, 2026',
  }],
};
const installedFake = (calls, payload) => ({ browsers: {
  async list() { calls.push('browsers.list'); return [{ id: 'brave', name: 'Brave' }]; },
  async get() { return { tabs: {
    async list() { return [{ id: 'connections', url: 'https://www.linkedin.com/mynetwork/invite-connect/connections/' }]; },
    async get() { return { playwright: { async evaluate() { calls.push('evaluate'); return payload; } } }; },
    async new() { throw new Error('unexpected new tab'); },
  } }; },
} });

test('adapter never opens or navigates to a profile', async () => {
  const calls = [];
  const result = await runLinkedinTitleCapture({
    agent: installedFake(calls, semanticConnectionsPayload),
    prepare, resolveAiBatch, persistAliases, finalize, merge, rebuild,
  });
  assert.equal(result.profileNavigations, 0);
  assert.equal(calls.some(x => /\/in\/|details\/experience/.test(x)), false);
});

test('navigation guard permits only Connections', async () => {
  const bridge = createInstalledLinkedinBridge(agent);
  await assert.rejects(() => bridge.goto('https://www.linkedin.com/in/example/'), /Connections-only invariant/);
  await assert.rejects(() => bridge.goto('https://www.linkedin.com/in/example/details/experience/'), /Connections-only invariant/);
});
```

Also cover missing/ambiguous Brave, wrong profile/URL, tab create/reuse, missing `Recently added`, timeout, source-stop, stage failures, cleanup, failure persistence, and previous-snapshot preservation.

- [ ] **Step 3: Run RED**

Run:

```bash
node --test local/sunny-job-search/tests/linkedin-dom-contract.test.mjs \
  local/sunny-job-search/tests/linkedin-browser-adapter.test.mjs
```

Expected: Experience export and profile loop violate the new contract.

- [ ] **Step 4: Remove every Experience/profile path**

Delete `extractCurrentExperience`, Experience-tab acquisition, profile loops, `/details/experience/`, `profilesToInspect`, `inspectionResults`, and attempt reporting from production capture code.

Export:

```js
createInstalledLinkedinBridge(agent, { browserName = 'Brave' })
runLinkedinTitleCapture({
  agent, bridge, prepare, resolveAiBatch, persistAliases,
  finalize, merge, rebuild, persistFailure, cleanup, now, deadlineMs,
})
```

The bridge may reuse or create one Connections tab. `goto` accepts only the exact normalized Connections URL. Every operation receives remaining deadline time. Reports contain counts only and always set `profileNavigations: 0`.

- [ ] **Step 5: Run GREEN**

Expected: serialized production functions pass and navigation logs contain only the Connections URL.

---

### Task 7: Update builder and localhost enrichment for schema v3

**Files:**
- Modify: `data/tools/build-sunny-job-search-index.mjs`
- Modify: `local/sunny-job-search/tests/builder.test.mjs`

- [ ] **Step 1: Write schema-v3 builder tests**

Cover valid v3 contacts, v1/v2 copied fallback, missing/malformed/stale state, bounded cache, fresh unrelated jobs, URL dedup, retention, atomic failure, no temp leak, and `0600` output.

```js
test('v3 contacts enrich only exact date-qualified canonical jobs', () => {
  const snapshot = buildSnapshot(archive, now, titleOnlyReferralState);
  assert.equal(snapshot.rows.find(x => x.company === 'Capital One').referralContacts.length, 1);
  assert.equal(snapshot.rows.find(x => x.company === 'Capital Onee').referralContacts.length, 0);
});
```

- [ ] **Step 2: Run RED**

Run `node --test local/sunny-job-search/tests/builder.test.mjs`.

- [ ] **Step 3: Implement v3 enrichment and safe fallback**

Read only validated, retained v3 matches. Missing/invalid referral input publishes fresh jobs with empty contacts and a non-success referral status; it never carries stale PII. Preserve atomic replacement and cleanup.

- [ ] **Step 4: Run GREEN**

Expected: builder and website tests pass.

---

### Task 8: Update the automation protocol and user rules

**Files:**
- Modify: `profiles/sunny-linkedin-referral-browser.md`
- Modify: `modes/_custom.md`
- Create: `local/sunny-job-search/tests/linkedin-title-only-golden.test.mjs`

- [ ] **Step 1: Add protocol assertions**

Assert the protocol contains the exact Connections URL, 50-card limit, 10-request AI limit, strict decision JSON, alias-store step, schema-v3 merge, rebuild, source-stop behavior, and PII-free summary. Assert it contains no Experience URL, profile-navigation instruction, screenshot, accessibility snapshot, full HTML export, message, connect, apply, or challenge recovery.

- [ ] **Step 2: Replace only referral-specific custom rules**

Preserve all other `modes/_custom.md` bytes. The new block says:

```text
- Use the authenticated named Brave Connections page only.
- Parse company evidence from visible connection-card headlines.
- Never open a person's LinkedIn profile or Experience page.
- Resolve locally first; use at most 10 catalog-bounded AI title cases; persist only validated company-only mappings.
- If unresolved, skip. Never guess outside the candidate catalog.
- Keep referral-person data local; never write it to Google Sheet.
```

- [ ] **Step 3: Write the executable handoff protocol**

Document prepared request schema v1, durable ledger schema v3, alias mapping/revisions, exact AI decision schema, local validation, atomic writes, timeout/cleanup, compact summary, and fail-soft continuation. The protocol never instructs profile navigation.

- [ ] **Step 4: Run protocol assertions**

Expected: protocol checks pass; end-to-end golden remains RED until Task 9.

---

### Task 9: Add the zero-profile production golden

**Files:**
- Modify: `local/sunny-job-search/tests/linkedin-title-only-golden.test.mjs`

- [ ] **Step 1: Build a 20-card semantic fixture**

Include 9 exact resolutions, 2 accepted AI resolutions, 4 no-candidate cases, 3 ambiguous/former-only cases, 2 AI-unresolved cases, 11 matched people across 9 date-qualified jobs, and one fuzzy near-match job that must not match. Names/profile URLs remain inside private fixtures and never appear in AI requests or summaries.

- [ ] **Step 2: Execute the first run through production modules**

Use serialized `extractConnectionCards` in real headless Playwright, `runLinkedinTitleCapture`, title preparation, AI decision validation, temporary alias-store persistence, schema-v3 matcher, and atomic builder.

```js
assert.deepEqual(first.summary, {
  cardsRead: 20,
  resolvedExact: 9,
  resolvedAi: 2,
  reusedResolved: 0,
  reusedUnresolved: 0,
  unresolved: 9,
  aiRequests: 4,
  aiDeferred: 0,
  aliasesLearned: 2,
  profileNavigations: 0,
  matchedPeople: 11,
  matchedJobs: 9,
});
```

- [ ] **Step 3: Execute an identical second run**

```js
assert.equal(second.summary.aiRequests, 0);
assert.equal(second.summary.aliasesLearned, 0);
assert.equal(second.summary.profileNavigations, 0);
assert.equal(second.summary.matchedPeople, 11);
assert.equal(second.summary.matchedJobs, 9);
assert.equal(second.browserCalls.some(x => /\/in\/|details\/experience/.test(x)), false);
```

Assert fuzzy-zero, mapping idempotence, no PII in AI/summary, and no temp leak.

- [ ] **Step 4: Run GREEN**

Run `node --test local/sunny-job-search/tests/linkedin-title-only-golden.test.mjs`.

Expected: first run produces the specified counts; second run has zero AI and zero profile navigation.

---

### Task 10: Preserve copied live state and run the final gate

**Files:**
- Verify all files above; never modify the live private ledger in tests.

- [ ] **Step 1: Capture aggregate live privacy evidence**

Record only counts, SHA-256, and mode for `data/sunny-linkedin-referrals.json`; never print person data.

- [ ] **Step 2: Audit migration on a mode-0700 temporary copy**

Migrate the copied ledger to v3, validate it, build a temporary website snapshot, and at fixed audit time confirm 20 connections, 16 match rows, 12 people, 9 jobs, and exact original match-key equality. Copied private outputs remain `0600`.

- [ ] **Step 3: Run the complete gate**

```bash
node --test local/sunny-job-search/tests/*.test.mjs
node --check local/sunny-job-search/linkedin-capture.mjs
node --check local/sunny-job-search/company-identities.mjs
node --check local/sunny-job-search/linkedin-title-resolver.mjs
node --check local/sunny-job-search/company-alias-store.mjs
node --check local/sunny-job-search/referrals.mjs
node --check local/sunny-job-search/linkedin-dom-extractors.mjs
node --check local/sunny-job-search/linkedin-browser-adapter.mjs
node --check data/tools/build-sunny-job-search-index.mjs
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 4: Audit prohibited behavior**

```bash
rg -n 'details/experience|profilesToInspect|inspectionResults|extractCurrentExperience|verificationAttempts|nextVerificationAt' \
  local/sunny-job-search profiles/sunny-linkedin-referral-browser.md modes/_custom.md
```

Expected: no production-path matches; test/migration rejection text may mention removed legacy fields only to reject or migrate them.

- [ ] **Step 5: Verify preservation**

Confirm live-ledger hash/mode equal Step 1, tests did not populate the live alias file, no temp files remain, unrelated user rules/files are unchanged, staged diff remains unchanged, and no commit/push/merge/deploy/schedule/browser/Sheet action occurred.

---

## Completion criteria

Independent review must confirm:

1. Production performs zero profile/Experience navigation by construction and in adversarial installed-interface tests.
2. Exact identities resolve locally; fuzzy similarity alone never matches.
3. AI is PII-minimized, candidate-bounded, capped at 10, locally gated at `0.95`, and unable to invent companies.
4. Accepted aliases persist atomically with provenance and are reused without AI; conflicts quarantine without overwrite.
5. Unchanged unresolved cards do not repeatedly consume AI; catalog/mapping/card revisions invalidate cache deterministically.
6. Schema-v3 migration, strict validation, and retention preserve copied baseline data and reject malformed state.
7. The production golden reaches the specified first-run counts and identical second-run zero-AI/zero-navigation behavior.
8. Local website enrichment, privacy modes, cleanup, and fail-soft daily workflow remain correct.
9. Live private data and unrelated user changes remain untouched.

No commit step is included because approved-execute does not authorize commits without separate user authorization.
