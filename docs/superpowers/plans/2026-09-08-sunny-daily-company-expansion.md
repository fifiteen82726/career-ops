# Sunny Daily H-1B Company Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a demand-driven company-discovery pipeline that admits current NYC Metro and U.S.-remote employers only after DOL H-1B and exact ATS identity verification, then backfills each new board safely.

**Architecture:** Two independent location-scoped discovery turns ingest source-job leads into a company-only ledger, resolve new brands against the national FY2026 Q3 DOL universe, and stage identity-safe portal additions. A separate run-level wrapper serializes exact-board 20-day backfills with the existing noon 3-day scan, while a state lock protects lead, resolution, backfill, and portal commits.

**Tech Stack:** Node.js ESM, `node:test`, `js-yaml`, existing `path-resolver.mjs`, existing directory-lock protocol, existing ATS providers and `scan.mjs`, Codex Indeed/LinkedIn connectors, Codex local cron automations.

---

## File Map

- Create `profiles/sunny-company-discovery.yml`: user-layer source, scope, backfill, retry, and scheduling policy.
- Create `profiles/sunny-company-identity-reviews-v2.yml`: explicit source-brand → DOL employer → ATS owner review schema.
- Create `data/tools/sunny-company-leads.mjs`: connector/local-source normalization, canonical lead keys, append-only ingestion.
- Create `data/tools/sunny-company-state.mjs`: Data Root paths, company-state lock, TSV fold/merge, atomic writes, cooldown and backfill transitions.
- Create `data/tools/sunny-company-expansion.mjs`: DOL join, v2 review gate, ATS candidate resolution, staged portal CAS commit, run receipt.
- Create `data/tools/run-sunny-serialized-scan.mjs`: run-level Sunny scan lock and exact-board temporary-portals scan.
- Create `tests/sunny-company-leads.test.mjs`: lead ingestion contract tests.
- Create `tests/sunny-company-state.test.mjs`: concurrency, path, cooldown, and backfill-state tests.
- Create `tests/sunny-company-expansion.test.mjs`: DOL/ATS/review/portal admission tests.
- Create `tests/sunny-serialized-scan.test.mjs`: exact-board and run-level serialization tests.
- Modify `modes/_custom.md`: persist the separated daily company-discovery workflow and scan-run coordination rule.
- Update Codex automations: create separate NYC and remote discovery jobs; wrap the existing noon scan.
- Update `profiles/sunny-h1b-company-coverage-audit-2026-09-02.md`: record the first backfill with explicit denominators and errors.

### Task 1: Add user-layer configuration and v2 review schema

**Files:**
- Create: `profiles/sunny-company-discovery.yml`
- Create: `profiles/sunny-company-identity-reviews-v2.yml`
- Test: `tests/sunny-company-state.test.mjs`

- [ ] **Step 1: Write the failing configuration-contract test**

```js
test('discovery config separates NYC and remote scopes and both run modes', () => {
  const cfg = yaml.load(readFileSync(join(ROOT, 'profiles/sunny-company-discovery.yml'), 'utf8'));
  assert.equal(cfg.schema_version, 1);
  assert.equal(cfg.source_modes.backfill.days, 20);
  assert.equal(cfg.source_modes.incremental.linkedin_date_posted, 'past_24_hours');
  assert.equal(cfg.scopes.nyc.indeed.location, 'New York, NY');
  assert.equal(cfg.scopes.nyc.indeed.radius, 50);
  assert.equal(cfg.scopes.remote.indeed.remote_only, true);
});

test('v2 review schema carries all three identities', () => {
  const cfg = yaml.load(readFileSync(join(ROOT, 'profiles/sunny-company-identity-reviews-v2.yml'), 'utf8'));
  assert.equal(cfg.schema_version, 2);
  assert.deepEqual(cfg.reviews, []);
});
```

- [ ] **Step 2: Run the test and verify it fails because the files do not exist**

Run: `node --test tests/sunny-company-state.test.mjs`

Expected: FAIL with `ENOENT` for `profiles/sunny-company-discovery.yml`.

- [ ] **Step 3: Add the concrete configurations**

```yaml
schema_version: 1
dol_employers: data/cache/dol/sunny-all-title-h1b-employers-fy2026q3.tsv
ats_candidates: data/cache/dol/sunny-all-title-ats-candidates-2026-09-02.tsv
source_modes:
  backfill: { days: 20, linkedin_date_posted: past_month }
  incremental: { days: 1, linkedin_date_posted: past_24_hours }
retry: { unresolved_days: 7, transient_minutes: 180 }
scan: { backfill_days: 20, pre_noon_guard_minutes: 30 }
scopes:
  nyc:
    indeed: { location: "New York, NY", radius: 50, remote_only: false }
    linkedin: { location: "New York Metropolitan Area", work_type: "on_site,hybrid" }
  remote:
    indeed: { location: "remote", remote_only: true }
    linkedin: { location: "United States", work_type: "remote" }
```

Create `profiles/sunny-company-identity-reviews-v2.yml` with `schema_version: 2` and an empty `reviews` array. Do not rewrite the legacy review file.

- [ ] **Step 4: Run the configuration test and verify it passes**

Run: `node --test tests/sunny-company-state.test.mjs`

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add profiles/sunny-company-discovery.yml profiles/sunny-company-identity-reviews-v2.yml tests/sunny-company-state.test.mjs
git commit -m "feat: configure Sunny company discovery"
```

### Task 2: Implement deterministic company-lead ingestion

**Files:**
- Create: `data/tools/sunny-company-leads.mjs`
- Create: `tests/sunny-company-leads.test.mjs`

- [ ] **Step 1: Write failing tests for canonical keys and source isolation**

```js
test('canonicalLeadUrl removes tracking but preserves provider job identity', () => {
  assert.equal(
    canonicalLeadUrl('https://job-boards.greenhouse.io/clear/jobs/8148139?gh_src=x'),
    'https://job-boards.greenhouse.io/clear/jobs/8148139',
  );
  assert.equal(
    canonicalLeadUrl('https://www.linkedin.com/jobs/view/4458427653/?trackingId=x'),
    'https://www.linkedin.com/jobs/view/4458427653/',
  );
});

test('ingestLeadRows deduplicates without touching job history', async () => {
  const result = await ingestLeadRows([lead, lead], { dataRoot: tmp });
  assert.equal(result.appended, 1);
  assert.equal(existsSync(join(tmp, 'data/sunny-scan-history.tsv')), false);
});
```

- [ ] **Step 2: Run the tests and verify missing exports fail**

Run: `node --test tests/sunny-company-leads.test.mjs`

Expected: FAIL with module-not-found or missing named export.

- [ ] **Step 3: Implement lead normalization and locked ingestion**

```js
export function normalizeLead(row, { source, scope, runId, now = new Date() }) {
  const company = clean(row.company ?? row.source_company);
  const title = clean(row.title ?? row.job_title);
  const url = canonicalLeadUrl(row.url ?? row.job_url);
  if (!company || !title || !url) throw new Error('lead requires company, title, and url');
  return {
    source_run_id: runId,
    discovered_at: now.toISOString(),
    source, scope,
    source_company: company,
    normalized_source_company: normalizeCompanyIdentity(company),
    job_title: title,
    job_location: clean(row.location ?? row.job_location),
    job_url: url,
    posted_at: normalizePostedAt(row.posted_at ?? row.postedAt),
  };
}

export function leadKey(row) {
  return row.job_url || [row.source, row.normalized_source_company,
    normalizeText(row.job_title), normalizeText(row.job_location), row.posted_at].join('|');
}
```

Use `getCareerOpsRoot()` for the default Data Root and `acquirePipelineLock()` on the company-state sentinel. Under the lock, reread existing keys and append only unseen rows. Never import or write Sunny job-history helpers.

- [ ] **Step 4: Run lead tests**

Run: `node --test tests/sunny-company-leads.test.mjs`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add data/tools/sunny-company-leads.mjs tests/sunny-company-leads.test.mjs
git commit -m "feat: ingest company leads without job dedup side effects"
```

### Task 3: Implement resolution state, cooldown, and safe concurrent merges

**Files:**
- Create: `data/tools/sunny-company-state.mjs`
- Modify: `tests/sunny-company-state.test.mjs`

- [ ] **Step 1: Add failing tests for Data Root, merge, and backfill state**

```js
test('mergeResolutionRows retains unrelated concurrent scope updates', () => {
  const merged = mergeResolutionRows(
    [{ normalized_lead: 'alpha', status: 'ats_unresolved', last_seen: '2026-09-08' }],
    [{ normalized_lead: 'beta', status: 'accepted', last_seen: '2026-09-08' }],
  );
  assert.deepEqual(merged.map(x => x.normalized_lead).sort(), ['alpha', 'beta']);
});

test('partial backfill preserves its anchored window', () => {
  const accepted = startBackfill({ normalized_lead: 'alpha' }, '2026-09-08', 20);
  const retry = finishBackfill(accepted, { status: 'partial', error: 'page cap' }, '2026-09-08T10:00:00Z');
  assert.equal(retry.backfill_status, 'retry_partial');
  assert.equal(retry.backfill_window_start, '2026-08-20');
  assert.equal(retry.backfill_window_end, '2026-09-08');
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --test tests/sunny-company-state.test.mjs`

Expected: FAIL on missing state exports.

- [ ] **Step 3: Implement a focused state module**

```js
export const RESOLUTION_COLUMNS = [
  'normalized_lead', 'preferred_name', 'first_seen', 'last_seen', 'source_count',
  'status', 'dol_legal_name', 'dol_dba', 'transfer_positions', 'match_type',
  'provider', 'board_identifier', 'careers_url', 'board_owner', 'health_status',
  'last_attempt_at', 'next_retry_at', 'backfill_status', 'backfill_window_start',
  'backfill_window_end', 'backfill_attempted_at', 'backfill_completed_at',
  'backfill_error', 'evidence', 'reason',
];

export function mergeResolutionRows(current, incoming) {
  const byKey = new Map(current.map(row => [row.normalized_lead, row]));
  for (const row of incoming) byKey.set(row.normalized_lead, { ...byKey.get(row.normalized_lead), ...row });
  return [...byKey.values()].sort((a, b) => a.normalized_lead.localeCompare(b.normalized_lead));
}
```

Add atomic same-directory writes and `withCompanyStateLock()`, implemented with the repository's directory-lock protocol. Every updater must acquire, reread, merge, and write under the lock. Use `getCareerOpsRoot()` for all default user-layer paths.

- [ ] **Step 4: Run state tests under default and external roots**

Run: `node --test tests/sunny-company-state.test.mjs`

Expected: all tests pass, including a spawned-process or interleaved merge fixture that retains both NYC and remote rows.

- [ ] **Step 5: Commit**

```bash
git add data/tools/sunny-company-state.mjs tests/sunny-company-state.test.mjs
git commit -m "feat: add durable Sunny company resolution state"
```

### Task 4: Implement DOL and ATS admission with staged portal writes

**Files:**
- Create: `data/tools/sunny-company-expansion.mjs`
- Create: `tests/sunny-company-expansion.test.mjs`

- [ ] **Step 1: Write failing admission tests**

```js
test('exact DBA match is accepted but normalized collisions require review', () => {
  const joined = joinLeadToDol({ source_company: 'Example' }, employers);
  assert.equal(joined.status, 'dol_accepted');
  assert.equal(joinLeadToDol({ source_company: 'Acme' }, collidingEmployers).status, 'dol_ambiguous');
});

test('v2 review must prove source, DOL, and ATS identities', () => {
  assert.equal(validateV2Review(validReview).accepted, true);
  assert.equal(validateV2Review({ ...validReview, board_owner: 'Other Co' }).accepted, false);
});

test('official careers only is not a writable portal', () => {
  assert.equal(isScannableAdmission({ status: 'official_careers_only' }), false);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `node --test tests/sunny-company-expansion.test.mjs`

Expected: FAIL with missing module or exports.

- [ ] **Step 3: Implement deterministic joins and owner verification**

Reuse `normalizeCompanyIdentity()` from `build-sunny-h1b-ats-universe.mjs` and the published-owner helpers in `sunny-ats-identity-gate.mjs`. Read the national DOL and candidate TSVs from configuration. Permit automatic writes only for collision-free exact legal/DBA joins plus live/partial Greenhouse, Ashby, or Lever owner matches, or a complete accepted v2 review for another supported provider.

```js
export function isScannableAdmission(row) {
  return row.status === 'accepted'
    && ['live', 'partial'].includes(row.health_status)
    && Boolean(row.provider)
    && row.provider !== 'websearch';
}
```

- [ ] **Step 4: Implement staged validation and CAS portal commit**

Render the candidate portals document into a same-directory temporary file. Run:

```bash
node validate-portals.mjs --file /absolute/path/to/staged-portals.yml
```

Then acquire the company-state lock, compare the live SHA-256 with the pre-run checksum, reread/rebase if changed, and atomically rename only a successfully validated staged file. Never overwrite the live file and roll it back afterward.

- [ ] **Step 5: Run expansion and existing identity tests**

Run: `node --test tests/sunny-company-expansion.test.mjs tests/sunny-h1b-ats-universe.test.mjs`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add data/tools/sunny-company-expansion.mjs tests/sunny-company-expansion.test.mjs
git commit -m "feat: admit demand-driven H1B ATS companies safely"
```

### Task 5: Serialize Sunny scans and implement exact-board backfill

**Files:**
- Create: `data/tools/run-sunny-serialized-scan.mjs`
- Create: `tests/sunny-serialized-scan.test.mjs`

- [ ] **Step 1: Write failing serialization and exact-board tests**

```js
test('buildExactBoardPortals keeps exactly one provider board', () => {
  const staged = buildExactBoardPortals(fullConfig, { provider: 'greenhouse', identifier: 'clear' });
  assert.equal(staged.tracked_companies.length, 1);
  assert.match(staged.tracked_companies[0].careers_url, /greenhouse\.io\/clear$/);
});

test('two scan runs never overlap their critical section', async () => {
  const events = await runContendingFixtures(tmp);
  assert.deepEqual(events.map(e => e.phase), ['first-start', 'first-end', 'second-start', 'second-end']);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `node --test tests/sunny-serialized-scan.test.mjs`

Expected: FAIL on missing module/exports.

- [ ] **Step 3: Implement the scan-run wrapper**

Use `acquirePipelineLock(join(DATA_ROOT, 'data/.sunny-scan-run'))` and hold it from pre-run line counts through child-process completion and receipt capture. For `--kind backfill`, require `--provider`, `--board-identifier`, `--posted-after`, and `--posted-before`; build a one-board temporary portals file and run `scan.mjs` with:

```js
const env = {
  ...process.env,
  CAREER_OPS_ROOT: dataRoot,
  CAREER_OPS_PORTALS: stagedPortals,
  CAREER_OPS_SCAN_HISTORY: join(dataRoot, 'data/sunny-scan-history.tsv'),
  CAREER_OPS_PIPELINE: join(dataRoot, 'data/sunny-pipeline.md'),
};
```

For `--kind daily`, use the live portals file and `--since 3`. Persist a local receipt containing `run_id`, `kind`, exact board identity when applicable, pre/post row counts, exit code, and captured warnings.

- [ ] **Step 4: Verify exact identity and partial/error completion rules**

Add tests proving `clear` cannot select `clearstreet`, and `partial`/`error` receipts cannot set `backfill_status=complete`.

Run: `node --test tests/sunny-serialized-scan.test.mjs`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add data/tools/run-sunny-serialized-scan.mjs tests/sunny-serialized-scan.test.mjs
git commit -m "feat: serialize Sunny scans and exact-board backfills"
```

### Task 6: Integrate the daily command and persistent workflow rules

**Files:**
- Modify: `data/tools/sunny-company-expansion.mjs`
- Modify: `modes/_custom.md`
- Test: `tests/sunny-company-expansion.test.mjs`

- [ ] **Step 1: Add failing CLI contract tests**

```js
test('CLI requires exactly one scope and one mode', () => {
  assert.equal(parseArgs(['run', '--scope', 'nyc', '--mode', 'incremental']).scope, 'nyc');
  assert.throws(() => parseArgs(['run', '--scope', 'all']), /nyc or remote/);
});
```

- [ ] **Step 2: Run the CLI tests and verify the new contract fails**

Run: `node --test tests/sunny-company-expansion.test.mjs`

Expected: FAIL on `parseArgs` behavior.

- [ ] **Step 3: Add commands and receipts**

Support:

```text
node data/tools/sunny-company-expansion.mjs ingest --source indeed --scope remote --input <json>
node data/tools/sunny-company-expansion.mjs run --scope nyc --mode backfill --dry-run
node data/tools/sunny-company-expansion.mjs resolve --scope remote --write
node data/tools/sunny-company-expansion.mjs backfill --pending
```

Every command emits JSON with source states and exact denominators. `--dry-run` may write receipts and review queues but not `portals.yml`, job history, pipeline, or Sheets.

- [ ] **Step 4: Persist the user workflow**

Update `modes/_custom.md` so company discovery is explicitly separate from the noon job scan, source leads never touch job history, NYC and remote are separate turns, and all Sunny scans use the serialized wrapper.

- [ ] **Step 5: Run targeted tests and portal validation**

Run: `node --test tests/sunny-company-*.test.mjs tests/sunny-serialized-scan.test.mjs && npm run validate:portals`

Expected: all tests pass; portal validation reports 0 errors.

- [ ] **Step 6: Commit**

```bash
git add data/tools/sunny-company-expansion.mjs modes/_custom.md tests/sunny-company-expansion.test.mjs
git commit -m "feat: orchestrate Sunny company expansion"
```

### Task 7: Run the first source backfill and safe company admission

**Files:**
- Create: dated JSON inputs under `data/company-discovery/inbox/`
- Create/update: `data/sunny-company-leads.tsv`
- Create/update: `data/sunny-company-resolution.tsv`
- Create: dated receipts under `data/company-discovery/receipts/`
- Modify: `portals.yml` only for validated accepted boards

- [ ] **Step 1: Ingest existing Built In and NYC Indeed evidence**

Convert the existing dated Built In and NYC Indeed artifacts through the new ingestion boundary. Do not manually append TSV rows.

- [ ] **Step 2: Collect the current U.S.-remote Indeed backfill**

Use the Indeed connector once for `location: remote`, `remote_only: true`, country `US`, and broad Sunny role terms. Save the returned structured jobs as a dated input artifact and ingest it. This turn does not run a second Indeed location.

- [ ] **Step 3: Collect LinkedIn backfill in two location-scoped calls**

Use `past_month` and bounded pages for NYC Metro and U.S.-remote searches, preserve returned job IDs/URLs, and locally retain available posting dates inside the 20-day window. Save and ingest each scope separately.

- [ ] **Step 4: Resolve in dry-run mode**

Run:

```bash
node data/tools/sunny-company-expansion.mjs run --scope nyc --mode backfill --dry-run
node data/tools/sunny-company-expansion.mjs run --scope remote --mode backfill --dry-run
```

Expected: every new brand is classified as already tracked, DOL rejected/ambiguous, ATS unresolved, official-careers-only, identity review, verification error, or proposed accepted.

- [ ] **Step 5: Review proposed writes and commit idempotently**

Run each scope with `--write`, validate portals, then run the same writes again.

Expected: first run adds only identity-safe boards; second run adds 0 duplicates.

- [ ] **Step 6: Run pending exact-board backfills**

Run `node data/tools/sunny-company-expansion.mjs backfill --pending`. Each board uses the anchored 20-day window and serialized scan wrapper. Error/partial boards remain retryable.

- [ ] **Step 7: Commit durable user-layer changes**

```bash
git add portals.yml profiles/sunny-company-identity-reviews-v2.yml modes/_custom.md
git commit -m "data: expand Sunny H1B company coverage"
```

Do not force-add ignored lead ledgers, receipts, or connector data.

### Task 8: Configure the three independent automations

**Files:**
- Update through Codex automation APIs; do not hand-edit automation TOML.

- [ ] **Step 1: Inspect the existing noon automation**

Use the automation view API and preserve its project, model, reasoning, notification policy, timezone, and Sheet instructions.

- [ ] **Step 2: Update noon scanning to use the serialized wrapper**

Replace only the scan invocation with:

```text
node data/tools/run-sunny-serialized-scan.mjs --kind daily --since 3
```

Keep company discovery out of this automation.

- [ ] **Step 3: Create NYC discovery automation**

Schedule daily before noon America/New_York. Its prompt must invoke exactly the NYC company source scope, save connector results through the ingestion contract, resolve/write safely, and process pending backfills only outside the pre-noon guard.

- [ ] **Step 4: Create remote discovery automation**

Schedule at a different pre-noon time America/New_York. Its prompt must invoke exactly the U.S.-remote scope and otherwise use the same deterministic command contract.

- [ ] **Step 5: Verify automation separation**

View all three automations and verify the two company jobs each contain one Indeed location, while the noon job scan contains no company-discovery connector calls.

### Task 9: Final verification and coverage audit

**Files:**
- Modify: `profiles/sunny-h1b-company-coverage-audit-2026-09-02.md`

- [ ] **Step 1: Run targeted tests**

Run:

```bash
node --test \
  tests/sunny-company-leads.test.mjs \
  tests/sunny-company-state.test.mjs \
  tests/sunny-company-expansion.test.mjs \
  tests/sunny-serialized-scan.test.mjs \
  tests/sunny-h1b-ats-universe.test.mjs \
  tests/sunny-high-recall-title-filter.test.mjs
```

Expected: 0 failures.

- [ ] **Step 2: Run repository validation**

Run:

```bash
npm run validate:portals
npm run lint
node doctor.mjs --json
```

Expected: portal errors 0, syntax errors 0, `onboardingNeeded: false`.

- [ ] **Step 3: Run a no-write idempotency and lock smoke test**

Repeat both resolution commands and inspect receipts. Start one test backfill and one test daily wrapper concurrently against disposable fixtures.

Expected: 0 duplicate additions; scan critical sections are sequential; row ranges do not overlap.

- [ ] **Step 4: Update the coverage audit**

Record exact counts for source leads, unique brands, DOL-accepted identities, verified boards, existing coverage, new portal entries, unresolved/ambiguous/error states, source limitations, and backfill outcomes. Never collapse these denominators into one “covered companies” number.

- [ ] **Step 5: Commit verification evidence**

```bash
git add profiles/sunny-h1b-company-coverage-audit-2026-09-02.md
git commit -m "docs: audit daily company expansion rollout"
```

