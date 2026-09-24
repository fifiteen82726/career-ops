# Sunny Scan Status Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show durable per-day scan health at the bottom of Sunny's local job-search site and make a rolling 24-hour Today view the default for jobs and Connections.

**Architecture:** A focused Node builder derives a versioned `scan-status.json` from durable scan receipts, run state, queue state, and exception stores. The existing job snapshot gains evidence-backed `scannedAt` timestamps. Pure browser helpers own rolling/calendar time windows and status-row synthesis, while the existing app coordinates two independent JSON fetches so status failures never break job search.

**Tech Stack:** Node.js ESM, browser-native ES modules and DOM APIs, static JSON, `node:test`, Playwright browser tests, existing atomic file-write conventions.

---

## File Structure

- Create `data/tools/build-sunny-scan-status.mjs`: parse durable operational files, classify each New York day, preserve historical rows, and atomically write the status snapshot.
- Create `tests/sunny-scan-status.test.mjs`: unit and file-level tests for classification, preservation, receipt selection, and atomic output.
- Modify `data/tools/build-sunny-job-search-index.mjs`: add `scannedAt`, build a URL-to-receipt timestamp index, and refresh scan status whenever the local snapshot is refreshed.
- Modify `local/sunny-job-search/tests/builder.test.mjs`: cover receipt-backed and legacy fallback timestamps plus status refresh integration.
- Modify `data/tools/run-sunny-serialized-scan.mjs`: refresh the status snapshot immediately after a daily receipt and exception ingestion are durable.
- Modify `data/tools/sunny-daily-run-state.mjs`: refresh status after missing-receipt, partial, batch-close, and terminal state transitions.
- Modify `tests/sunny-serialized-scan.test.mjs` and `tests/sunny-daily-run-state.test.mjs`: verify operational transitions request a snapshot refresh without weakening existing controller tests.
- Create `local/sunny-job-search/scan-status.js`: pure time-window, status-day synthesis, tooltip, and DOM rendering helpers.
- Modify `local/sunny-job-search/app.js`: default to rolling Today, timestamp-filter jobs/Connections, load status independently, and render the status table.
- Modify `local/sunny-job-search/index.html`: add the Today button and bottom status section.
- Modify `local/sunny-job-search/styles.css`: status table, colored dots, tooltip, focus, and responsive layout.
- Modify `local/sunny-job-search/tests/app.test.mjs` and `local/sunny-job-search/tests/ui-browser.test.mjs`: cover rolling 24 hours, midnight, gray rows, status independence, and tooltip content.
- Modify `modes/_custom.md`: require the daily closeout to refresh both local snapshots; this is user-layer workflow configuration and may be ignored by Git.

### Task 1: Build the durable daily status snapshot

**Files:**
- Create: `tests/sunny-scan-status.test.mjs`
- Create: `data/tools/build-sunny-scan-status.mjs`

- [ ] **Step 1: Write failing classification and preservation tests**

Create fixtures in temporary directories and import these intended exports:

```js
import {
  buildScanStatusSnapshot,
  classifyScanDay,
  refreshScanStatusSnapshot,
} from '../data/tools/build-sunny-scan-status.mjs';

test('usable results with durable blockers are yellow rather than red', () => {
  const row = classifyScanDay({
    date: '2026-09-24',
    receipt: {
      completion_status: 'error',
      started_at: '2026-09-24T16:00:00.000Z',
      finished_at: '2026-09-24T16:20:00.000Z',
      warnings: ['truncated'],
      scan_receipt: { version: 'careerops.scan.receipt@1', scanned: 3500, found: 100, added: 5, added_urls: ['https://example.test/job'], errors: [{ company: 'A', error: 'HTTP 429' }] },
    },
    runState: { status: 'partial', counts: { normal_pending: 0 } },
    candidateExceptions: 2,
    sourceExceptions: 1,
  });
  assert.equal(row.status, 'yellow');
  assert.match(row.summary, /2.*JD/);
  assert.ok(row.issues.some(issue => /1.*source|1.*來源/i.test(issue)));
});

test('missing usable receipt after a claim is red', () => {
  const row = classifyScanDay({
    date: '2026-09-24',
    receipt: null,
    runState: { status: 'partial', scan_claim: { status: 'missing_receipt' }, counts: { normal_pending: 0 } },
    candidateExceptions: 0,
    sourceExceptions: 0,
  });
  assert.equal(row.status, 'red');
});

test('clean completed receipt and run are green', () => {
  const row = classifyScanDay({
    date: '2026-09-24',
    receipt: { completion_status: 'complete', started_at: '2026-09-24T16:00:00.000Z', finished_at: '2026-09-24T16:10:00.000Z', warnings: [], scan_receipt: { version: 'careerops.scan.receipt@1', scanned: 10, found: 2, added: 1, added_urls: ['https://example.test/job'], errors: [] } },
    runState: { status: 'complete', counts: { normal_pending: 0 } },
    candidateExceptions: 0,
    sourceExceptions: 0,
  });
  assert.equal(row.status, 'green');
});

test('refresh preserves prior daily rows while replacing the current date', t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-status-'));
  const receipts = join(dataRoot, 'data/company-discovery/receipts');
  const outputPath = join(dataRoot, 'local/sunny-job-search/data/scan-status.json');
  mkdirSync(receipts, { recursive: true });
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify({
    schemaVersion: 1,
    updatedAt: '2026-09-23T18:00:00.000Z',
    timeZone: 'America/New_York',
    days: [{ date: '2026-09-23', status: 'green', label: '已完成', issues: [] }],
  }));
  writeFileSync(join(receipts, 'daily-current.json'), JSON.stringify({
    kind: 'daily', run_id: 'daily-current', started_at: '2026-09-24T16:00:00.000Z',
    finished_at: '2026-09-24T16:10:00.000Z', completion_status: 'complete', warnings: [],
    scan_receipt: { version: 'careerops.scan.receipt@1', scanned: 10, found: 2, added: 1, added_urls: ['https://example.test/job'], errors: [] },
  }));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const snapshot = refreshScanStatusSnapshot({ dataRoot, outputPath, now: new Date('2026-09-24T18:00:00.000Z') });
  assert.deepEqual(snapshot.days.map(day => day.date), ['2026-09-24', '2026-09-23']);
  assert.equal(snapshot.days.filter(day => day.date === '2026-09-24').length, 1);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test tests/sunny-scan-status.test.mjs
```

Expected: FAIL because `build-sunny-scan-status.mjs` does not exist.

- [ ] **Step 3: Implement the builder and deterministic classification**

Implement the following public contract:

```js
export function classifyScanDay({ date, receipt, runState, candidateExceptions, sourceExceptions })
export function buildScanStatusSnapshot({ receipts, previous, runState, candidateExceptions, sourceExceptions, now, timeZone })
export function refreshScanStatusSnapshot({ dataRoot, outputPath, now = new Date() })
```

Use `Intl.DateTimeFormat(..., { timeZone: 'America/New_York' })` to assign `receipt.started_at` to a day. Consider a receipt usable only when `scan_receipt.version === 'careerops.scan.receipt@1'` and `scan_receipt.added_urls` plus `scan_receipt.errors` are arrays. Select the latest daily receipt per New York day by `started_at`; do not use company backfill receipts as the daily status row.

Apply this ordered classifier:

```js
const usable = receipt?.scan_receipt?.version === 'careerops.scan.receipt@1'
  && Array.isArray(receipt.scan_receipt.added_urls)
  && Array.isArray(receipt.scan_receipt.errors);
const normalPending = Number(runState?.counts?.normal_pending || 0);
const missingReceipt = runState?.scan_claim?.status === 'missing_receipt';
const stoppedWithPending = ['partial', 'failed'].includes(runState?.status) && normalPending > 0;
const hasProblems = receipt?.completion_status !== 'complete'
  || receipt?.warnings?.length > 0
  || receipt?.scan_receipt?.errors?.length > 0
  || candidateExceptions > 0
  || sourceExceptions > 0
  || ['partial', 'failed', 'running'].includes(runState?.status);
const status = (!usable || missingReceipt || stoppedWithPending) ? 'red' : hasProblems ? 'yellow' : 'green';
```

Populate `issues` only from evidenced non-zero values. Preserve earlier rows from a valid prior snapshot, replace same-date rows, sort newest first, write through a sibling temporary file, validate it, then rename. A corrupt prior snapshot must not prevent rebuilding from receipts.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run `node --test tests/sunny-scan-status.test.mjs`.

Expected: all status-builder tests pass with zero failures.

- [ ] **Step 5: Commit the isolated builder**

```bash
git add data/tools/build-sunny-scan-status.mjs tests/sunny-scan-status.test.mjs
git commit -m "feat: build Sunny daily scan status snapshot"
```

### Task 2: Add evidence-backed `scannedAt` timestamps

**Files:**
- Modify: `data/tools/build-sunny-job-search-index.mjs`
- Modify: `local/sunny-job-search/tests/builder.test.mjs`

- [ ] **Step 1: Write failing timestamp tests**

Add a test fixture receipt whose `scan_receipt.added_urls` contains a canonicalized archive URL. Assert the generated job uses the receipt's `started_at`. Add a legacy row with no matching receipt and assert it receives a valid ISO timestamp that falls on the row's `scanDate` in `America/New_York`.

```js
assert.equal(byCompany.get('Receipt Co').scannedAt, '2026-09-24T16:13:07.825Z');
assert.equal(new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(byCompany.get('Legacy Co').scannedAt)), '2026-09-23');
```

- [ ] **Step 2: Run the builder test and verify RED**

Run `node --test local/sunny-job-search/tests/builder.test.mjs`.

Expected: FAIL because snapshot rows do not contain `scannedAt`.

- [ ] **Step 3: Implement receipt lookup and zone-safe fallback**

Add:

```js
export function scanTimesFromReceipts(receiptsDir) // Map<canonicalUrl, earliest started_at>
export function zonedDayEndIso(day, timeZone)      // ISO instant for 23:59:59.999 in that zone
```

Read valid `daily-*.json` and `backfill-*.json` receipts, canonicalize every `added_url`, and retain the earliest trustworthy `started_at` for each URL. Extend `buildSnapshot` with an optional fourth argument `{ scanTimes = new Map() }`; set `job.scannedAt` to the matching receipt timestamp or `zonedDayEndIso(job.scanDate, timeZone)`. Use a two-pass `Intl.DateTimeFormat` offset calculation rather than a hard-coded `-04:00`, so DST is correct.

In `refreshSnapshot`, default the receipt directory to `${dataRoot}/data/company-discovery/receipts` and pass its map to `buildSnapshot`. Keep existing three-argument `buildSnapshot` calls valid.

- [ ] **Step 4: Run builder tests and verify GREEN**

Run `node --test local/sunny-job-search/tests/builder.test.mjs`.

Expected: all builder tests pass.

- [ ] **Step 5: Commit timestamps**

```bash
git add data/tools/build-sunny-job-search-index.mjs local/sunny-job-search/tests/builder.test.mjs
git commit -m "feat: timestamp Sunny scan results"
```

### Task 3: Refresh status at durable operational transitions

**Files:**
- Modify: `data/tools/run-sunny-serialized-scan.mjs`
- Modify: `data/tools/sunny-daily-run-state.mjs`
- Modify: `tests/sunny-serialized-scan.test.mjs`
- Modify: `tests/sunny-daily-run-state.test.mjs`
- Modify: `data/tools/build-sunny-job-search-index.mjs`
- Modify: `modes/_custom.md`

- [ ] **Step 1: Write failing integration tests**

Inject a `refreshStatus` spy with the default value `refreshScanStatusSnapshot` into `runSerializedScan`, `markMissingScanReceipt`, `markRunPartial`, `closeBatch`, and `stopRun`. Assert it is called only after the receipt/state mutation is readable and that refresh failure is returned as a warning field rather than rolling back durable scan/queue state.

```js
const refreshed = [];
const result = await runSerializedScan({
  kind: 'daily', dataRoot, now,
  runChild: async () => ({ exitCode: 0, stdout: JSON.stringify(validReceipt), stderr: '' }),
  refreshStatus: async args => refreshed.push(args),
});
assert.equal(refreshed.length, 1);
assert.equal(refreshed[0].dataRoot, dataRoot);
assert.equal(result.status_snapshot_warning, undefined);
```

- [ ] **Step 2: Run integration tests and verify RED**

Run:

```bash
node --test tests/sunny-serialized-scan.test.mjs tests/sunny-daily-run-state.test.mjs
```

Expected: FAIL because the functions do not accept or invoke `refreshStatus`.

- [ ] **Step 3: Add best-effort refresh hooks**

Import `refreshScanStatusSnapshot` and add a helper that catches only snapshot-refresh errors:

```js
async function refreshStatusSafely(refreshStatus, options) {
  try { await refreshStatus(options); return null; }
  catch (error) { return String(error?.message || error); }
}
```

Call it after the daily receipt, exception ingestion, and queue replay are durable. In controller functions, call it after the state update lock has completed so the builder reads the new file rather than the prior state. Preserve existing return shapes and add `status_snapshot_warning` only on failure. Backfills may update job timestamps but must not replace a calendar day's daily-run status.

At the end of the `build-sunny-job-search-index.mjs` CLI path, refresh `scan-status.json` as well as `jobs.json`, so final candidate outcomes update the same day's counts. Update `modes/_custom.md` so every daily closeout runs the local snapshot builder even when zero jobs qualify.

- [ ] **Step 4: Run integration tests and verify GREEN**

Run the two test files from Step 2.

Expected: all pass; an injected refresh failure leaves receipt/run-state evidence intact and reports the warning.

- [ ] **Step 5: Commit operational integration**

```bash
git add data/tools/run-sunny-serialized-scan.mjs data/tools/sunny-daily-run-state.mjs tests/sunny-serialized-scan.test.mjs tests/sunny-daily-run-state.test.mjs data/tools/build-sunny-job-search-index.mjs
git commit -m "feat: persist Sunny scan health after daily transitions"
```

Do not stage `modes/_custom.md` if it is ignored; confirm its local content separately.

### Task 4: Implement rolling Today and calendar range helpers

**Files:**
- Create: `local/sunny-job-search/scan-status.js`
- Modify: `local/sunny-job-search/app.js`
- Modify: `local/sunny-job-search/tests/app.test.mjs`

- [ ] **Step 1: Write failing pure-function tests**

Define the intended filter shape and verify New York midnight behavior:

```js
test('Today is a rolling 24-hour window across New York midnight', () => {
  const now = new Date('2026-09-25T04:30:00.000Z'); // 00:30 New York
  const filters = defaultFilters(now, 'America/New_York');
  assert.equal(filters.rangeMode, 'today');
  assert.equal(filters.windowStart, '2026-09-24T04:30:00.000Z');
  assert.equal(filters.windowEnd, '2026-09-25T04:30:00.000Z');
  assert.deepEqual(filterJobs([
    { ...jobs[0], scannedAt: '2026-09-24T16:00:00.000Z' },
    { ...jobs[1], scannedAt: '2026-09-24T03:00:00.000Z' },
  ], filters).map(job => job.company), [jobs[0].company]);
});

test('status days for Today include both New York dates crossed by 24 hours', () => {
  const filters = defaultFilters(new Date('2026-09-25T04:30:00.000Z'), 'America/New_York');
  assert.deepEqual(calendarDaysForFilters(filters, 'America/New_York'), ['2026-09-25', '2026-09-24']);
});
```

Retain tests proving 7/14/21/30 are inclusive calendar windows.

- [ ] **Step 2: Run app tests and verify RED**

Run `node --test local/sunny-job-search/tests/app.test.mjs`.

Expected: FAIL because the default is seven days and filters ignore `scannedAt`.

- [ ] **Step 3: Implement pure time and status-row helpers**

In `scan-status.js`, export:

```js
export function todayWindow(now, timeZone)
export function calendarRange(now, days, timeZone)
export function calendarDaysForFilters(filters, timeZone)
export function statusRowsForFilters(days, filters, timeZone)
export function statusTooltip(row)
export function renderScanStatus(container, rows)
```

`statusRowsForFilters` must synthesize `{ date, status: 'gray', label: '未執行', summary: '這個紐約日期沒有掃描紀錄。', issues: [] }` for absent dates. It must not accept query or priority inputs.

In `app.js`, change `defaultFilters` to accept a `Date` and time zone and return `rangeMode: 'today'`, precise `windowStart/windowEnd`, and display `start/end` dates. In `filterJobs`, use `scannedAt` for Today and `scanDate` for calendar/custom modes. Manual date edits set `rangeMode: 'calendar'`.

- [ ] **Step 4: Run app tests and verify GREEN**

Run `node --test local/sunny-job-search/tests/app.test.mjs`.

Expected: all pure filtering and status-row tests pass.

- [ ] **Step 5: Commit filtering helpers**

```bash
git add local/sunny-job-search/scan-status.js local/sunny-job-search/app.js local/sunny-job-search/tests/app.test.mjs
git commit -m "feat: add rolling Today filter for Sunny jobs"
```

### Task 5: Render the bottom status table and accessible tooltip

**Files:**
- Modify: `local/sunny-job-search/index.html`
- Modify: `local/sunny-job-search/app.js`
- Modify: `local/sunny-job-search/styles.css`
- Modify: `local/sunny-job-search/tests/ui-browser.test.mjs`

- [ ] **Step 1: Write the failing browser behavior test**

Extend the browser fixture server with a valid `scan-status.json` containing a yellow prior day and no current-day row. Assert:

```js
await page.goto(baseUrl);
assert.equal(await page.locator('[data-range="today"]').getAttribute('aria-pressed'), 'true');
assert.equal(await page.locator('#scan-status-body tr').count(), 2);
await expectText(page.locator('#scan-status-body tr').nth(0), /未執行/);
await page.locator('.status-dot.yellow').focus();
await expectText(page.locator('.scan-status-tooltip:visible'), /21 個來源錯誤/);
await page.locator('#query').fill('no matching company');
assert.equal(await page.locator('#scan-status-body tr').count(), 2);
```

Also return HTTP 404 for status JSON in a second test and assert the jobs table remains usable while the status section reports its own load problem.

- [ ] **Step 2: Run the browser test and verify RED**

Run `node --test --test-concurrency=1 local/sunny-job-search/tests/ui-browser.test.mjs`.

Expected: FAIL because the Today button and scan-status section do not exist.

- [ ] **Step 3: Add markup and independent loading**

Insert this quick control before 7 days and make it active:

```html
<button type="button" data-range="today" class="active" aria-pressed="true">今天</button>
```

Remove the initial active state from 7 days. Add this section after Recent Connections and before the dialog:

```html
<section id="scan-status" class="scan-status" aria-labelledby="scan-status-title">
  <div class="result-heading">
    <div><h2 id="scan-status-title">每日掃描狀態</h2><p>以紐約日期記錄每日進度</p></div>
    <output id="scan-status-count"></output>
  </div>
  <p id="scan-status-error" class="status-load-error" role="status" hidden></p>
  <div class="scan-status-table-wrap"><table class="scan-status-table">
    <thead><tr><th>日期</th><th>狀態</th><th>進度</th><th>範圍</th><th>例外</th></tr></thead>
    <tbody id="scan-status-body"></tbody>
  </table></div>
</section>
```

Fetch `jobs.json` as the required resource and `scan-status.json` as an independent optional resource. Invalid/missing status data sets `#scan-status-error`, supplies an empty day list, and still renders synthesized gray rows for the selected dates. Range-button changes rerender jobs, Connections, and status; query/priority/referral changes rerender jobs and Connections only.

- [ ] **Step 4: Add status and tooltip styles**

Add four token colors and a focusable tooltip pattern:

```css
.status-dot.green{--status:#1f8a5b}.status-dot.yellow{--status:#d59a16}
.status-dot.red{--status:#c6473b}.status-dot.gray{--status:#8a989e}
.status-dot{position:relative;display:inline-block;width:14px;height:14px;border:0;border-radius:50%;background:var(--status);padding:0}
.scan-status-tooltip{visibility:hidden;opacity:0;position:absolute;z-index:8;bottom:calc(100% + 8px);left:0;width:min(360px,80vw);padding:10px 12px;border-radius:8px;background:#17262f;color:#fff;white-space:normal;transition:opacity .12s ease}
.status-dot:hover .scan-status-tooltip,.status-dot:focus-visible .scan-status-tooltip{visibility:visible;opacity:1}
```

Keep the table usable on mobile and do not reuse the 1720px minimum width from the job table.

- [ ] **Step 5: Run browser and unit tests and verify GREEN**

Run:

```bash
node --test local/sunny-job-search/tests/app.test.mjs
node --test --test-concurrency=1 local/sunny-job-search/tests/ui-browser.test.mjs
```

Expected: both commands exit 0 with no failures.

- [ ] **Step 6: Commit the UI**

```bash
git add local/sunny-job-search/index.html local/sunny-job-search/app.js local/sunny-job-search/styles.css local/sunny-job-search/tests/ui-browser.test.mjs
git commit -m "feat: show Sunny daily scan health"
```

### Task 6: Generate today's state and run full verification

**Files:**
- Generate: `local/sunny-job-search/data/jobs.json` (operational, possibly ignored)
- Generate: `local/sunny-job-search/data/scan-status.json` (operational, possibly ignored)
- Verify: all task files and repository status

- [ ] **Step 1: Refresh real local snapshots**

Run:

```bash
node data/tools/build-sunny-job-search-index.mjs
```

Expected: `jobs.json` contains ISO `scannedAt` fields and `scan-status.json` contains a 2026-09-24 yellow row with the currently durable candidate/source exception counts.

- [ ] **Step 2: Validate generated data directly**

Run a Node assertion script that checks schema versions, unique dates, valid status enum, valid `scannedAt`, and the current day row. It must also confirm `jobs.json` and `scan-status.json` parse cleanly.

- [ ] **Step 3: Run all relevant tests serially**

```bash
node --test \
  tests/sunny-scan-status.test.mjs \
  tests/sunny-serialized-scan.test.mjs \
  tests/sunny-daily-run-state.test.mjs \
  local/sunny-job-search/tests/app.test.mjs \
  local/sunny-job-search/tests/builder.test.mjs
node --test --test-concurrency=1 local/sunny-job-search/tests/*.test.mjs
```

Expected: both commands exit 0; zero failed tests.

- [ ] **Step 4: Check syntax, whitespace, and accidental changes**

```bash
node --check data/tools/build-sunny-scan-status.mjs
node --check data/tools/build-sunny-job-search-index.mjs
node --check local/sunny-job-search/app.js
node --check local/sunny-job-search/scan-status.js
git diff --check
git status --short
```

Expected: syntax and whitespace checks pass. Pre-existing `.gitignore`, `data/sunny-linkedin-company-map.tsv`, and unrelated untracked files remain untouched and unstaged.

- [ ] **Step 5: Commit any final in-scope test or documentation adjustment**

If Task 6 required an in-scope tracked adjustment, stage only that exact file and commit it with `test: verify Sunny scan status dashboard`. Do not stage generated ignored data or unrelated baseline files.
