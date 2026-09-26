# Sunny Scan Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the demonstrated Paylocity and Jobvite rate-limit failures, retry the demonstrated transient provider transport failures, and stop requesting the three confirmed-dead Greenhouse boards without hiding any remaining scan error.

**Architecture:** Keep `scan.mjs` at its existing global concurrency of 10; that concurrency is useful across independent hosts and is not the root cause. Add a small, testable process-local FIFO pacer for hosts that multiplex many tenants behind one rate limit, then use the existing bounded retry helpers so `Retry-After`, aborts, and connection failures retain their established semantics. Apply retry only at the primary listing requests that appeared in today’s receipt; leave `classifyScanCompletion()` unchanged so a remaining exhausted request still produces an honest `error` receipt.

**Tech Stack:** Node.js ESM (Node >=18), `node:test`, existing custom provider test harness, `js-yaml`, `providers/_http.mjs` retry primitives.

---

## Evidence, diagnosis, and non-goals

The two saved receipts establish a repeatable host-level pattern, rather than a one-off bad scan:

| Receipt | Total errors | Paylocity 429 | Jobvite 429 | Transport failures | Aborts | 404 |
|---|---:|---:|---:|---:|---:|---:|
| `daily-2026-09-11T12-04-19-632Z-560b82b4.json` | 190 | 167 | 4 | 9 | 7 | 3 |
| `daily-2026-09-13T12-03-22-503Z-833cedc6.json` | 193 | 172 | 3 | 10 | 5 | 3 |

`scan.mjs` fans work out through `parallelFetch(tasks, CONCURRENCY)` with `CONCURRENCY = 10`. `providers/paylocity.mjs` makes direct requests to the shared `recruiting.paylocity.com` host with neither serialization nor retry. `providers/jobvite.mjs` already honors `Retry-After`, but concurrent feed requests to shared `app.jobvite.com` can still collide. The current receipt’s transport failures are dispersed across Greenhouse, Lever, and individual iCIMS tenants; their primary listing fetches currently bypass the shared retry wrappers. Direct probes confirmed that Magic Leap, Sixth Street Partners, and City Storage Systems’ configured Greenhouse API/board routes return 404.

Do **not** lower global concurrency, change `classifyScanCompletion()`, rerun the daily job, or mark a result complete just because the queue received rows. The scheduler’s once-per-day rule remains in force. A later scheduled receipt is the production acceptance signal; tests prove behavior before that run.

## File map

| File | Responsibility |
|---|---|
| Create `providers/_host-pacer.mjs` | FIFO queue with a test-clock-aware minimum interval; errors cannot poison the following task. |
| Create `tests/providers/host-pacer.test.mjs` | Unit tests for one in-flight task, interval enforcement, and recovery after rejection. |
| Modify `providers/paylocity.mjs` | One shared-host queue, 1-second request spacing, and bounded retry around its listing request. |
| Modify `tests/providers/paylocity.test.mjs` | Regression test: a 429 with `Retry-After` is retried and parsed, without wall-clock sleep. |
| Modify `providers/jobvite.mjs` | Queue only `app.jobvite.com` XML feed requests; retain its existing `Retry-After: 30` behavior and redirect semantics. |
| Modify `tests/providers/jobvite.test.mjs` | Regression test: two direct-feed tenants cannot be in flight together. |
| Modify `providers/greenhouse.mjs` | Retry the primary `/jobs?content=true` listing request only. |
| Modify `tests/providers/greenhouse.test.mjs` | Regression test: transient primary-list failure retries and preserves normal mapping. |
| Modify `providers/lever.mjs` | Retry the primary postings-list request. |
| Modify `tests/providers/lever.test.mjs` | Regression test: aborted primary request retries and returns a normalized role. |
| Modify `providers/icims.mjs` | Retry each primary search-results page request; retain its per-tenant pacing and page-cap behavior. |
| Modify `tests/providers/icims.test.mjs` | Regression test: an initial transport failure on page 0 retries and pagination remains correct. |
| Modify `portals.yml` | Disable exactly the three confirmed stale Greenhouse entries, with a dated re-verification note. |
| Modify no files in `data/`, including `data/sunny-linkedin-company-map.tsv` | Preserve the user’s unrelated dirty LinkedIn mapping change. |

### Task 1: Implement the shared host pacer

**Files:**
- Create: `providers/_host-pacer.mjs`
- Test: `tests/providers/host-pacer.test.mjs`

- [ ] **Step 1: Write the failing tests for FIFO, spacing, and error recovery**

Before editing implementation files, record the branch baseline for the final range checks:

```bash
BASE_SHA="$(git rev-parse HEAD)"
printf '%s\n' "$BASE_SHA"
```

Keep `BASE_SHA` in the same terminal session through Task 6. It identifies this repair’s full change range even after the task-level commits below.

```js
// tests/providers/host-pacer.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostPacer } from '../../providers/_host-pacer.mjs';

test('host pacer allows only one in-flight task and preserves FIFO order', async () => {
  const pace = createHostPacer();
  const entered = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const first = pace(async () => { entered.push('first'); await firstGate; return 'one'; });
  const second = pace(async () => { entered.push('second'); return 'two'; });
  await Promise.resolve();
  assert.deepEqual(entered, ['first']);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ['one', 'two']);
  assert.deepEqual(entered, ['first', 'second']);
});

test('host pacer waits for the configured interval through ctx.sleep', async () => {
  let now = 10_000;
  const waits = [];
  const pace = createHostPacer({ minimumIntervalMs: 1_000, now: () => now });
  const ctx = { sleep: async ms => { waits.push(ms); now += ms; } };
  await pace(async () => 'first', ctx);
  await pace(async () => 'second', ctx);
  assert.deepEqual(waits, [1_000]);
});

test('a rejected task does not poison the following FIFO task', async () => {
  const pace = createHostPacer();
  const order = [];
  await assert.rejects(pace(async () => { order.push('bad'); throw new Error('boom'); }), /boom/);
  await pace(async () => { order.push('good'); });
  assert.deepEqual(order, ['bad', 'good']);
});
```

- [ ] **Step 2: Run the new test to verify it fails because the module does not exist**

Run: `node --test tests/providers/host-pacer.test.mjs`

Expected: failure with `ERR_MODULE_NOT_FOUND` for `providers/_host-pacer.mjs`.

- [ ] **Step 3: Implement the minimal generic, context-aware pacer**

```js
// providers/_host-pacer.mjs
import { sleep } from './_http.mjs';

/**
 * Serializes work aimed at one rate-limited shared host.
 * `ctx.sleep` makes the wait deterministic in provider tests.
 */
export function createHostPacer({ minimumIntervalMs = 0, now = () => Date.now() } = {}) {
  let tail = Promise.resolve();
  let lastStartedAt = -Infinity;

  return function pace(task, ctx) {
    const run = tail.then(async () => {
      const waitMs = Math.max(0, minimumIntervalMs - (now() - lastStartedAt));
      if (waitMs > 0) await sleep(waitMs, ctx);
      lastStartedAt = now();
      return task();
    });
    // Keep the tail fulfilled even when a board fails, or every later board
    // would inherit the same rejection without ever issuing its request.
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}
```

- [ ] **Step 4: Run the focused test and the established HTTP helper suite**

Run: `node --test tests/providers/host-pacer.test.mjs && node tests/providers/_http.test.mjs`

Expected: all three pacer tests pass; the established `_http` suite remains green.

- [ ] **Step 5: Commit the independently usable helper**

```bash
git add providers/_host-pacer.mjs tests/providers/host-pacer.test.mjs
git commit -m "feat: add shared-host request pacer"
```

### Task 2: Pace and retry Paylocity without lowering scan-wide concurrency

**Files:**
- Modify: `providers/paylocity.mjs:4-67`
- Modify: `tests/providers/paylocity.test.mjs:1-31`

- [ ] **Step 1: Add the failing 429 regression test**

Append this test after the parser test, using the same `guid` constant:

```js
test('Paylocity retries a rate-limited listing through the shared host pacer', async () => {
  let calls = 0;
  const waits = [];
  const html = `<script>window.pageData = ${JSON.stringify({ Jobs: [{
    JobId: 7, JobTitle: 'Data Engineer', PublishedDate: '2026-09-13T00:00:00Z',
  }] })};</script>`;
  const jobs = await paylocity.fetch(
    { name: 'Acme', careers_url: `https://recruiting.paylocity.com/recruiting/jobs/All/${guid}/` },
    {
      sleep: async ms => { waits.push(ms); },
      fetchText: async () => {
        calls += 1;
        if (calls === 1) {
          const error = new Error('HTTP 429 Too Many Requests');
          error.status = 429;
          error.retryAfter = '0';
          throw error;
        }
        return html;
      },
    },
  );
  assert.equal(calls, 2);
  assert.deepEqual(waits, [0]);
  assert.equal(jobs[0].title, 'Data Engineer');
});
```

- [ ] **Step 2: Verify the regression currently fails**

Run: `node --test tests/providers/paylocity.test.mjs`

Expected: failure because the current direct `ctx.fetchText()` propagates the first 429.

- [ ] **Step 3: Queue the shared host and route its listing request through the existing retry helper**

At the imports/constants section, add:

```js
import { fetchTextWithRetry } from './_http.mjs';
import { createHostPacer } from './_host-pacer.mjs';

const paylocityPacer = createHostPacer({ minimumIntervalMs: 1_000 });
const PAYLOCITY_RETRY_POLICY = { retries: 3, baseDelayMs: 1_000, maxDelayMs: 15_000 };
```

Replace the direct `ctx.fetchText` assignment in `fetch()` with:

```js
const html = await paylocityPacer(
  () => fetchTextWithRetry(ctx, url, {
    redirect: 'error',
    headers: { 'user-agent': 'Mozilla/5.0' },
    timeoutMs: 30_000,
    maxBytes: 2_000_000,
  }, PAYLOCITY_RETRY_POLICY),
  ctx,
);
```

Do not alter `boardUrl()`, the SSRF `redirect: 'error'` guard, page parsing, or the global scan concurrency. The first request starts immediately; subsequent Paylocity tenants run in insertion-order after at least one second, and a received `Retry-After` still wins inside `fetchTextWithRetry`.

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/providers/host-pacer.test.mjs tests/providers/paylocity.test.mjs`

Expected: both files pass; the new test observes two fetch attempts and no real-time wait.

- [ ] **Step 5: Commit the Paylocity repair**

```bash
git add providers/paylocity.mjs tests/providers/paylocity.test.mjs
git commit -m "fix: pace and retry Paylocity boards"
```

### Task 3: Serialize Jobvite XML feeds while preserving its specialized behavior

**Files:**
- Modify: `providers/jobvite.mjs:4, 248, 316-330`
- Modify: `tests/providers/jobvite.test.mjs:274-305`

- [ ] **Step 1: Add a failing concurrency test for two configured eIds**

Add this block after the existing rate-limit block (it uses configured eIds so it exercises only the shared XML-feed path):

```js
  {
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const entered = [];
    const ctx = {
      fetchText: async url => {
        entered.push(url);
        if (entered.length === 1) await firstGate;
        return '<result></result>';
      },
      fetchJson: async () => ({}),
      sleep: async () => {},
    };
    const first = jobvite.fetch({ name: 'First', company_eid: 'firstEid' }, ctx);
    const second = jobvite.fetch({ name: 'Second', company_eid: 'secondEid' }, ctx);
    await Promise.resolve();
    eq('fetch() serializes simultaneous Jobvite XML feeds', entered.length, 1);
    releaseFirst();
    await Promise.all([first, second]);
    eq('fetch() releases the following XML feed after the first completes', entered.length, 2);
  }
```

- [ ] **Step 2: Verify it fails on the current parallel feed requests**

Run: `node test-all.mjs --only providers/jobvite`

Expected: the new assertion reports two feed requests entered before `releaseFirst()`.

- [ ] **Step 3: Add a queue only around the XML-feed request**

Add this import and module-level queue beside `RETRY_POLICY`:

```js
import { createHostPacer } from './_host-pacer.mjs';

const jobviteFeedPacer = createHostPacer();
```

Replace the `const xml = await fetchTextWithRetry(...)` call inside the existing `try` block with:

```js
const xml = await jobviteFeedPacer(
  () => fetchTextWithRetry(
    ctx,
    feedUrl,
    { redirect: 'manual', timeoutMs: FEED_TIMEOUT_MS },
    RETRY_POLICY,
  ),
  ctx,
);
```

Do not queue `jobs.jobvite.com` discovery pages, introduce an arbitrary 30-second minimum interval, or change `redirect: 'manual'`. The queue holds while a `Retry-After: 30` retry occurs, so later XML feeds cannot immediately recreate the collision; `NoJobs.htm` handling remains in the existing catch block.

- [ ] **Step 4: Run Jobvite and shared pacer tests**

Run: `node test-all.mjs --only providers/jobvite && node --test tests/providers/host-pacer.test.mjs`

Expected: existing 429/`Retry-After: 30`, 404 no-retry, empty-board redirect tests and the new serialized-feed test all pass.

- [ ] **Step 5: Commit the Jobvite repair**

```bash
git add providers/jobvite.mjs tests/providers/jobvite.test.mjs
git commit -m "fix: serialize Jobvite XML feed requests"
```

### Task 4: Retry the observed transient listing failures by provider, not globally

**Files:**
- Modify: `providers/greenhouse.mjs:4,167`
- Modify: `tests/providers/greenhouse.test.mjs` near the primary fetch contract
- Modify: `providers/lever.mjs:6,82`
- Modify: `tests/providers/lever.test.mjs` near the primary fetch contract
- Modify: `providers/icims.mjs:12,124`
- Modify: `tests/providers/icims.test.mjs` near the pagination tests

- [ ] **Step 1: Add one deterministic, failing retry regression to each affected provider test**

Use injected `ctx.sleep` so the tests never wait in real time. Each error has no `status`, matching the saved receipt’s `fetch failed` / abort class and therefore the existing `isRetryableError()` contract.

```js
// Add in tests/providers/greenhouse.test.mjs
let greenhouseCalls = 0;
const greenhouseRetryRows = await greenhouse.fetch(
  { name: 'RetryCo', careers_url: 'https://job-boards.greenhouse.io/retryco' },
  { sleep: async () => {}, fetchJson: async () => {
    greenhouseCalls += 1;
    if (greenhouseCalls === 1) throw new Error('This operation was aborted');
    return { jobs: [{ title: 'Recovered', absolute_url: 'https://job-boards.greenhouse.io/retryco/jobs/1' }] };
  } },
);
if (greenhouseCalls === 2 && greenhouseRetryRows.length === 1) pass('greenhouse.fetch() retries a transient primary listing failure');
else fail(`greenhouse retry calls=${greenhouseCalls}, rows=${greenhouseRetryRows.length}`);

// Add in tests/providers/lever.test.mjs
let leverCalls = 0;
const leverRetryRows = await lever.fetch(
  { name: 'RetryCo', careers_url: 'https://jobs.lever.co/retryco' },
  { sleep: async () => {}, fetchJson: async () => {
    leverCalls += 1;
    if (leverCalls === 1) throw new Error('fetch failed');
    return [{ text: 'Recovered', hostedUrl: 'https://jobs.lever.co/retryco/1', categories: {} }];
  } },
);
if (leverCalls === 2 && leverRetryRows[0]?.title === 'Recovered') pass('lever.fetch() retries a transient primary listing failure');
else fail(`lever retry calls=${leverCalls}, rows=${JSON.stringify(leverRetryRows)}`);

// Add in tests/providers/icims.test.mjs
let icimsCalls = 0;
const icimsRetryRows = await icims.fetch(
  { name: 'RetryCo', careers_url: `${ORIGIN}/jobs/search?ss=1` },
  { sleep: async () => {}, fetchJson: async () => { throw new Error('unused'); }, fetchText: async () => {
    icimsCalls += 1;
    if (icimsCalls === 1) throw new Error('fetch failed');
    return page();
  } },
);
if (icimsCalls === 2 && icimsRetryRows.length === 0) pass('icims.fetch() retries a transient first search-page failure');
else fail(`icims retry calls=${icimsCalls}, rows=${icimsRetryRows.length}`);
```

- [ ] **Step 2: Run the three tests to prove the direct calls fail before implementation**

Run: `node test-all.mjs --only providers/greenhouse && node test-all.mjs --only providers/lever && node test-all.mjs --only providers/icims`

Expected: each new assertion fails because its provider issues one direct request and propagates the injected transport error.

- [ ] **Step 3: Replace only the primary listing calls with the shared retry wrappers**

```js
// providers/greenhouse.mjs
import { fetchJsonWithRetry } from './_http.mjs';
// Replace only the primary list call; retain best-effort /offices semantics.
const json = /** @type {any} */ (await fetchJsonWithRetry(ctx, listHref, { redirect: 'error' }));

// providers/lever.mjs
import { fetchJsonWithRetry } from './_http.mjs';
const json = await fetchJsonWithRetry(ctx, apiUrl, { redirect: 'error' });

// providers/icims.mjs
import { BROWSER_LIKE_USER_AGENT, fetchTextWithRetry } from './_http.mjs';
const html = await fetchTextWithRetry(ctx, searchUrl(origin, pageNum), {
  headers: HEADERS,
  redirect: 'error',
});
```

The retry helper already retries 429, 5xx, and no-status transport failures and refuses to retry a deterministic 404 or SSRF-refused redirect. Do not wrap Greenhouse `/offices` enrichment (it is intentionally best-effort), iCIMS `enrichDate()` (not in the daily-scan error path), or unrelated providers.

- [ ] **Step 4: Run the focused suites and syntax check**

Run: `node test-all.mjs --only providers/greenhouse && node test-all.mjs --only providers/lever && node test-all.mjs --only providers/icims && npm run lint`

Expected: all provider checks pass, including the new second-attempt assertions; syntax check exits 0.

- [ ] **Step 5: Commit the bounded transport recovery**

```bash
git add providers/greenhouse.mjs tests/providers/greenhouse.test.mjs \
  providers/lever.mjs tests/providers/lever.test.mjs \
  providers/icims.mjs tests/providers/icims.test.mjs
git commit -m "fix: retry transient ATS listing requests"
```

### Task 5: Disable only confirmed stale Greenhouse board sources

**Files:**
- Modify: `portals.yml:520-523` (Magic Leap, Inc.)
- Modify: `portals.yml:6334-6338` (Sixth Street Partners)
- Modify: `portals.yml:8268-8272` (City Storage Systems)
- Test: `validate-portals.mjs`

- [ ] **Step 1: Make the validation expectation explicit before changing the data**

Run: `node validate-portals.mjs`

Expected: it currently validates the YAML structure, but it does not prove that the three external API endpoints are live. The implementation must preserve this structural success after disabling them.

- [ ] **Step 2: Mark each exact entry disabled with the same evidence note**

For each of the three entries, replace only its `enabled: true` line with:

```yaml
    # Disabled 2026-09-13: configured Greenhouse API and public board both returned HTTP 404; verify an official replacement before re-enabling.
    enabled: false
```

Keep the company names, URLs, explicit `api`, `provider`, and Sixth Street `scan_query` intact. This is a reversible source quarantine, not deletion; a later official replacement can be substituted with evidence.

- [ ] **Step 3: Validate the edited configuration and inspect the exact diff**

Run: `node validate-portals.mjs && git diff --check && git diff -- portals.yml`

Expected: validator and whitespace check exit 0; the diff contains exactly three `enabled: true` → `false` changes plus three dated comments.

- [ ] **Step 4: Commit the stale-source cleanup separately from code**

```bash
git add portals.yml
git commit -m "chore: disable stale Greenhouse boards"
```

### Task 6: Verify the complete repair without running a second daily scan

**Files:**
- Verify: `providers/_host-pacer.mjs`
- Verify: `providers/paylocity.mjs`
- Verify: `providers/jobvite.mjs`
- Verify: `providers/greenhouse.mjs`
- Verify: `providers/lever.mjs`
- Verify: `providers/icims.mjs`
- Verify: `portals.yml`
- Verify: `data/tools/run-sunny-serialized-scan.mjs:46-52` (unchanged completion classification)

- [ ] **Step 1: Run all touched-provider regression tests in one command**

Run:

```bash
node --test tests/providers/host-pacer.test.mjs tests/providers/paylocity.test.mjs \
  && node test-all.mjs --only providers/jobvite \
  && node test-all.mjs --only providers/greenhouse \
  && node test-all.mjs --only providers/lever \
  && node test-all.mjs --only providers/icims
```

Expected: every command exits 0. This proves FIFO order, interval behavior, 429/`Retry-After` recovery, Jobvite feed serialization, and transient listing recovery.

- [ ] **Step 2: Run static and configuration verification**

Run: `npm run lint && node validate-portals.mjs && git diff --check "$BASE_SHA"..HEAD && git status --short`

Expected: all three verification commands exit 0. `git status --short` may still show the pre-existing `data/sunny-linkedin-company-map.tsv`, `.superpowers/`, `cv-template/`, and `tests/__pycache__/`; do not stage, discard, or claim ownership of them.

- [ ] **Step 3: Assert the honesty guard was not changed**

Run: `git diff "$BASE_SHA"..HEAD -- data/tools/run-sunny-serialized-scan.mjs scan.mjs`

Expected: no diff. A nonempty receipt `errors` array must continue to produce `completion_status: "error"`; this repair lowers terminal errors rather than converting them to a false success.

- [ ] **Step 4: Record production acceptance criteria for the next scheduled run**

After (not by manually rerunning) the next scheduled daily scan, inspect its new receipt with:

```bash
node -e "const fs=require('fs'); const d='data/company-discovery/receipts'; const f=fs.readdirSync(d).filter(x=>x.startsWith('daily-')).sort().at(-1); const j=JSON.parse(fs.readFileSync(`${d}/${f}`,'utf8')); const r=j.scan_receipt||j; const e=r.errors||[]; console.log({file:f, completion:j.completion_status, errors:e.length, errors:e.map(x=>x.error||x.message||String(x))});"
```

Expected acceptance: no terminal Paylocity 429, no terminal Jobvite 429, and no 404 for Magic Leap/Sixth Street/City Storage Systems. If a retry is exhausted, the receipt must remain `error` and its concrete host/error becomes a new, separately diagnosed follow-up—do not weaken the classifier.

## Plan self-review

- **Scope coverage:** Tasks 1–3 address the 172 Paylocity and 3 Jobvite rate limits. Task 4 addresses the receipt’s transient `fetch failed`/abort class only at affected primary requests. Task 5 removes the three externally confirmed 404 sources. Task 6 keeps daily scheduling and completion reporting honest.
- **Red-flag scan:** The plan has no unspecified implementation steps, no global-concurrency reduction, no retry of deterministic 404s, no deletion of user configuration, and no second daily scan.
- **Type/interface consistency:** `createHostPacer({ minimumIntervalMs, now })` consistently returns `pace(task, ctx)`; `fetchTextWithRetry(ctx, url, opts, policy)` and `fetchJsonWithRetry(ctx, url, opts)` use the existing helper signatures. All provider calls retain their existing `redirect` values.
