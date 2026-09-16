# Sunny LinkedIn Referral Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fail-soft Brave LinkedIn Connections step to Sunny's daily Codex scan, persist verified current-employee referral matches privately, and display them in the existing localhost job-search table without changing Google Sheet.

**Architecture:** A pure zero-network module owns referral-state validation, atomic persistence, company matching, and 14-day job enrichment. The daily agent uses the already-authenticated Brave session to produce a bounded normalized capture under a strict no-login/no-action protocol, then feeds it to the module. The existing snapshot builder merges `referralContacts` into `jobs.json`, and the static UI renders/filter/searches them.

**Tech Stack:** Node.js ESM and built-in test runner, Codex computer-use with Brave, JSON user-layer state, existing vanilla HTML/CSS/JavaScript localhost site, Codex automation API.

---

## File map

**Create**

- `data/tools/sunny-linkedin-referrals.mjs` — pure schema validation, URL/company normalization, capture merge, current-only 14-day match derivation, atomic state writes, CLI.
- `tests/sunny-linkedin-referrals.test.mjs` — deterministic state/matching/atomic-preservation tests.
- `profiles/sunny-linkedin-referral-browser.md` — Brave-only browser protocol and normalized capture contract.
- Runtime-only ignored file: `data/sunny-linkedin-referrals.json` — minimal connection ledger plus current derived matches.

**Modify**

- `data/tools/build-sunny-job-search-index.mjs` — validate/read referral state and enrich each snapshot job.
- `local/sunny-job-search/tests/builder.test.mjs` — builder enrichment and invalid-state preservation tests.
- `local/sunny-job-search/app.js` — referral search/filter/render helpers and source-status presentation.
- `local/sunny-job-search/index.html` — `只看有內推人` control, referral status, and `近期內推人` column.
- `local/sunny-job-search/styles.css` — compact multi-contact presentation.
- `local/sunny-job-search/tests/app.test.mjs` — referral filter/search/summary tests.
- `local/sunny-job-search/README.md` — refresh inputs and fail-soft behavior.
- `modes/_custom.md` — durable Sunny procedural rule.
- Codex automation `sunny-24` — append the Brave capture/match/website step while preserving all existing job/Sheet behavior.

**Never modify**

- Google Sheet schema or referral-person cells.
- Grok Bot or Grok Routines.
- LinkedIn account/session/relationships/messages.

---

### Task 1: Build the pure referral-state and matching module

**Files:**
- Create: `tests/sunny-linkedin-referrals.test.mjs`
- Create: `data/tools/sunny-linkedin-referrals.mjs`

- [ ] **Step 1: Write failing schema, canonicalization, current-employment, and matching tests**

Create tests with fixtures shaped like this:

```js
const job = {
  scanDate: '2026-09-15', company: 'Datadog, Inc.',
  applyUrl: 'https://careers.example/jobs/123?utm_source=scan',
};

const capture = {
  observedAt: '2026-09-16T16:00:00.000Z',
  sourceStatus: 'ok',
  sourceWarning: '',
  connections: [{
    profileUrl: 'https://www.linkedin.com/in/example/?trk=connections',
    fullName: 'Example Person',
    connectedAt: '2026-09-15',
    connectedDatePrecision: 'day',
    verificationStatus: 'verified_current',
    currentEmployer: 'Datadog',
    currentEmployerLinkedinUrl: 'https://www.linkedin.com/company/datadog/?trk=profile',
    currentTitle: 'Data Engineer',
    employmentVerifiedAt: '2026-09-16T16:00:20.000Z',
    employmentEvidence: 'Current Experience entry marked Present',
  }],
};
```

Test all of these independently:

```js
assert.equal(canonicalLinkedinUrl('https://linkedin.com/in/example/?trk=x'), 'https://www.linkedin.com/in/example/');
assert.equal(canonicalLinkedinUrl('https://www.linkedin.com/company/datadog/?trk=x'), 'https://www.linkedin.com/company/datadog/');
assert.equal(matches[0].matchQuality, 'company_url_exact');
assert.equal(matches[0].matchKey, 'https://careers.example/jobs/123|https://www.linkedin.com/in/example/');
assert.deepEqual(buildReferralMatches({ jobs: [job({ scanDate: '2026-09-02' })], state, companyMap, now }), []);
assert.deepEqual(buildReferralMatches({ jobs, state: formerEmployeeState, companyMap, now }), []);
assert.deepEqual(buildReferralMatches({ jobs, state: headlineOnlyState, companyMap, now }), []);
assert.equal(buildReferralMatches({ jobs, state: reviewedAliasState, companyMap, now })[0].matchQuality, 'reviewed_alias');
assert.equal(buildReferralMatches({ jobs, state: exactTextState, companyMap: [], now })[0].matchQuality, 'exact_text');
```

Also test inclusive day 1/day 14 boundaries, malformed dates, non-LinkedIn profile URLs, duplicate profile observations, duplicate `matchKey`, a company URL mismatch, substring false positives, and preservation of prior verified data when a new capture status is not authenticated/challenged/error.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test tests/sunny-linkedin-referrals.test.mjs
```

Expected: FAIL because `data/tools/sunny-linkedin-referrals.mjs` does not exist.

- [ ] **Step 3: Implement the schema and pure functions**

Export exactly:

```js
export const SOURCE_STATUSES = new Set(['ok', 'partial', 'linkedin_not_authenticated', 'linkedin_challenge', 'error']);
export const VERIFICATION_STATUSES = new Set(['pending_verification', 'verified_current', 'not_current', 'unresolved']);
export const MATCH_QUALITIES = new Set(['company_url_exact', 'reviewed_alias', 'exact_text']);

export function canonicalLinkedinUrl(raw) {}
export function validateReferralState(state) {}
export function validateCapture(capture) {}
export function mergeCapture(previous, capture, { now = new Date() } = {}) {}
export function parseCompanyMap(tsvText) {}
export function buildReferralMatches({ jobs, state, companyMap, now = new Date(), windowDays = 14 }) {}
export function writeReferralStateAtomic(path, state) {}
```

Implementation rules:

- Canonical LinkedIn URLs must be HTTPS `www.linkedin.com/in/<slug>/` or `/company/<slug>/`, with query/hash removed.
- A successful/partial capture may merge observations. `linkedin_not_authenticated`, `linkedin_challenge`, or `error` updates attempt status/warning but retains prior connections and matches.
- `verified_current` requires nonempty employer, title, evidence, and `employmentVerifiedAt`.
- Match order is verified company URL, reviewed alias sharing one verified company URL, then exact normalized employer text. Never substring/fuzzy match.
- Filter jobs using New York calendar dates and inclusive `windowDays`.
- Canonicalize job URLs using the existing builder's tracking-parameter behavior.
- Sort contacts by descending `connectedAt`, then `fullName`.
- Validate the complete next state before an atomic temp-file rename.

- [ ] **Step 4: Run the test and verify GREEN**

Run:

```bash
node --test tests/sunny-linkedin-referrals.test.mjs
```

Expected: all referral module tests PASS.

- [ ] **Step 5: Add atomic-preservation tests**

Use `mkdtempSync` to prove a malformed next document and a simulated temporary-write failure do not replace a known-good state file. Run the same test command and require PASS.

---

### Task 2: Add the Brave browser capture contract and CLI

**Files:**
- Modify: `data/tools/sunny-linkedin-referrals.mjs`
- Modify: `tests/sunny-linkedin-referrals.test.mjs`
- Create: `profiles/sunny-linkedin-referral-browser.md`

- [ ] **Step 1: Write failing CLI/capture tests**

Test these commands through exported `runCli(args, io)` rather than spawning a shell:

```text
merge --capture /tmp/capture.json --archive data/sunny-job-search-archive.json --company-map data/sunny-linkedin-company-map.tsv --state data/sunny-linkedin-referrals.json --now 2026-09-16T16:00:00.000Z
status --state data/sunny-linkedin-referrals.json
```

Assert the `merge` result includes `sourceStatus`, `observed`, `newConnections`, `verifiedCurrent`, `pendingVerification`, `matchedPeople`, and `matchedJobs`. Assert `status` never prints raw profile HTML or unrelated personal data.

- [ ] **Step 2: Run the focused tests and verify RED**

Run the exact Task 1 command. Expected: FAIL because `runCli` and CLI parsing do not exist.

- [ ] **Step 3: Implement strict CLI parsing**

Add:

```js
export async function runCli(args, io = { stdout: process.stdout, stderr: process.stderr }) {}
```

Reject unknown flags, missing values, non-absolute temporary capture paths, invalid status values, and a state path outside the resolved career-ops data root. `merge` reads the normalized capture, merges it, derives matches from the private job archive, writes atomically, and emits counters only.

- [ ] **Step 4: Write the complete Brave protocol**

`profiles/sunny-linkedin-referral-browser.md` must say:

1. Use the named Brave browser surface and its existing profile/session only.
2. Open/reuse a dedicated tab at the exact Connections URL.
3. Treat connection-list semantics as authenticated; treat login/checkpoint/CAPTCHA/OTP/security-key prompts as skip states.
4. Never enter credentials or click actions that change LinkedIn state.
5. Sort by Recently added where available; inspect no more than 50 cards.
6. On first run keep displayed dates within 14 days; later prioritize unseen canonical profile URLs.
7. Open no more than 20 candidate profiles and only read the current Experience entry.
8. Headline alone is insufficient; former employment is `not_current`.
9. Produce only the normalized capture schema in a temporary JSON file; no screenshots/HTML/contact details.
10. Delete the temporary capture after a successful merge.
11. Always run the CLI and report counters; never manually edit the durable referral file.

- [ ] **Step 5: Run tests and inspect the protocol for prohibited actions**

Run:

```bash
node --test tests/sunny-linkedin-referrals.test.mjs
rg -n "send|message|connect request|password|OTP|login" profiles/sunny-linkedin-referral-browser.md
```

Expected: tests PASS; every prohibited term appears only in a negative instruction.

---

### Task 3: Enrich the localhost snapshot

**Files:**
- Modify: `data/tools/build-sunny-job-search-index.mjs`
- Modify: `local/sunny-job-search/tests/builder.test.mjs`

- [ ] **Step 1: Write failing builder tests**

Add tests proving:

```js
const snapshot = buildSnapshot(archive, now, referralState);
assert.equal(snapshot.referralDataStatus, 'ok');
assert.equal(snapshot.referralDataUpdatedAt, '2026-09-16T16:01:00.000Z');
assert.equal(snapshot.jobs[0].referralContacts[0].fullName, 'Example Person');
assert.deepEqual(snapshot.jobs[1].referralContacts, []);
```

Also test missing referral file returns empty arrays and `not_configured`, while a present malformed referral file causes `refreshSnapshot` to throw before replacing an existing valid `jobs.json`.

- [ ] **Step 2: Run builder tests and verify RED**

Run:

```bash
node --test local/sunny-job-search/tests/builder.test.mjs
```

Expected: FAIL because the builder has no referral input/enrichment.

- [ ] **Step 3: Implement optional referral input**

Change signatures to:

```js
export function buildSnapshot(archive, now = new Date(), referralState = null) {}
export function refreshSnapshot({ archivePath, referralPath, outputPath, now = new Date() }) {}
```

When `referralPath` is absent, emit `not_configured` and empty contact arrays. When the file exists, validate it and join its `matches` by canonical `applyUrl`. Copy only `fullName`, `profileUrl`, `currentTitle`, `currentEmployer`, `connectedAt`, and `matchQuality` into the public-to-local snapshot. Deduplicate by canonical profile URL per job.

Default CLI paths:

```js
const referralPath = resolve(process.argv[4] || `${root}/data/sunny-linkedin-referrals.json`);
```

Keep the existing archive and output positional arguments intact.

- [ ] **Step 4: Run builder tests and verify GREEN**

Run the Task 3 test command. Expected: PASS and existing snapshot-preservation tests remain green.

---

### Task 4: Add referral UI, search, and filter

**Files:**
- Modify: `local/sunny-job-search/app.js`
- Modify: `local/sunny-job-search/index.html`
- Modify: `local/sunny-job-search/styles.css`
- Modify: `local/sunny-job-search/tests/app.test.mjs`

- [ ] **Step 1: Write failing pure UI tests**

Extend fixture jobs with `referralContacts`. Add:

```js
assert.equal(filterJobs(jobs, { ...filters, referralsOnly: true }).length, 1);
assert.equal(filterJobs(jobs, { ...filters, query: 'Example Person' })[0].company, 'Datadog');
assert.match(referralSearchText(jobs[0]), /Data Engineer/);
assert.equal(defaultFilters('2026-09-16').referralsOnly, false);
```

- [ ] **Step 2: Run UI tests and verify RED**

Run:

```bash
node --test local/sunny-job-search/tests/app.test.mjs
```

Expected: FAIL because referral helpers/filter do not exist.

- [ ] **Step 3: Implement pure filtering/search helpers**

Export:

```js
export function referralSearchText(job) {
  return (job.referralContacts || []).flatMap(contact => [
    contact.fullName, contact.currentEmployer, contact.currentTitle, contact.profileUrl,
  ]).join(' ');
}

export function hasReferralContacts(job) {
  return Array.isArray(job.referralContacts) && job.referralContacts.length > 0;
}
```

Add `referralsOnly: false` to default filters. Apply the checkbox after priority/date gates. Include `referralSearchText(job)` in global search without mutating `searchableFields` into nested-property syntax.

- [ ] **Step 4: Implement DOM and markup**

Add to `index.html`:

```html
<label class="referral-filter"><input id="referrals-only" type="checkbox"> 只看有內推人</label>
<p id="referral-status" class="referral-status" aria-live="polite"></p>
```

Insert `<th>近期內推人</th>` immediately after LinkedIn People.

In `app.js`, create `referralCell(contacts, notice)`. For each contact render a profile link, title, connected date, `複製姓名`, and `複製連結` buttons. Use `textContent`, never `innerHTML`. Use `target="_blank"` and `rel="noopener noreferrer"`. Render `—` when empty.

Set status text from `snapshot.referralDataStatus` and `snapshot.referralDataUpdatedAt`. `ok`/`partial` shows the update time; skipped/error statuses show a nonblocking warning that cached matches remain.

- [ ] **Step 5: Add compact CSS**

Add focused classes `.referral-filter`, `.referral-status`, `.referral-list`, `.referral-contact`, `.referral-meta`, and `.copy-row`. Keep the table scrollable and do not make the new column sticky.

- [ ] **Step 6: Run UI, builder, and server tests**

Run:

```bash
node --test local/sunny-job-search/tests/app.test.mjs local/sunny-job-search/tests/builder.test.mjs local/sunny-job-search/tests/server.test.mjs
```

Expected: all local-site tests PASS.

---

### Task 5: Encode durable workflow rules and update documentation

**Files:**
- Modify: `modes/_custom.md`
- Modify: `local/sunny-job-search/README.md`

- [ ] **Step 1: Add the user-layer procedural rule**

Append a `Sunny LinkedIn referral matching` subsection to `modes/_custom.md` containing every boundary from the approved spec: Brave only, optional authenticated step, no login/challenge recovery, current Experience required, latest-14-day suitable jobs, exact/verified-alias matching only, private atomic state, no Sheet person data, no external actions, and fail-soft preservation.

- [ ] **Step 2: Document the refresh contract**

Update README commands to show:

```bash
node data/tools/sunny-linkedin-referrals.mjs status --state data/sunny-linkedin-referrals.json
node data/tools/build-sunny-job-search-index.mjs \
  data/sunny-job-search-archive.json \
  local/sunny-job-search/data/jobs.json \
  data/sunny-linkedin-referrals.json
```

Explain that missing LinkedIn authentication leaves cached referral matches intact and does not prevent the website from loading.

- [ ] **Step 3: Run a contradiction scan**

Run:

```bash
rg -n "LinkedIn.*discovery|LinkedIn.*登入|Google Sheet|referral|內推人" modes/_custom.md profiles/sunny-linkedin-referral-browser.md local/sunny-job-search/README.md
```

Expected: LinkedIn remains excluded from job/company discovery; login and Sheet referral writes appear only as prohibitions.

---

### Task 6: Update the daily Codex automation safely

**External state:** Codex automation `sunny-24` only.

- [ ] **Step 1: Read and preserve the current automation**

Use the Codex automation API `view` mode and save the full name, kind, status, RRULE, target thread, notification policy, model/reasoning if present, and prompt. Do not edit `sunny-nyc` or `sunny-remote`.

- [ ] **Step 2: Append the LinkedIn referral step to the full prompt**

Preserve every existing job scan, Google Sheet, queue, and localhost instruction. Append a clearly separated final phase that instructs the scheduled agent to:

1. Read `profiles/sunny-linkedin-referral-browser.md`.
2. Use Brave at the exact Connections URL.
3. Skip on logout/challenge without authentication attempts.
4. Capture at most 50 cards and verify at most 20 profiles.
5. Run the merge CLI against the 14-day private archive/mapping inputs.
6. Rebuild the localhost snapshot with the referral state path.
7. Verify unique profile/application match keys and the new UI data.
8. Report LinkedIn source status and counters separately from job-scan results.
9. Never write referral-person data to Sheet or send/contact anyone.

- [ ] **Step 3: Update through the automation API**

Call update with the full preserved fields and modified full prompt. Do not write raw automation files directly.

- [ ] **Step 4: Read back and diff the invariant fields**

Require the same schedule, status, target, notification policy, and original job-scan prompt content. Only the appended LinkedIn/website phase may differ.

---

### Task 7: Perform one bounded real Brave smoke run

**Files:**
- Create/update runtime-only: `data/sunny-linkedin-referrals.json`
- Modify generated: `local/sunny-job-search/data/jobs.json`

- [ ] **Step 1: Snapshot current private outputs**

Copy the existing referral file and `jobs.json`, if present, to a new `mktemp -d` location and record SHA-256. Never include them in Git.

- [ ] **Step 2: Use the Brave session according to the protocol**

Use computer-use to select Brave and open/reuse the Connections URL. If authenticated, perform the bounded capture; if logged out/challenged, produce only the skip capture and continue. Do not send messages or change LinkedIn.

- [ ] **Step 3: Merge capture and rebuild the snapshot**

Run the exact README commands. Delete the temporary capture after a successful merge.

- [ ] **Step 4: Validate real output**

Check:

```bash
node data/tools/sunny-linkedin-referrals.mjs status --state data/sunny-linkedin-referrals.json
node -e "const d=require('./local/sunny-job-search/data/jobs.json'); if(!Array.isArray(d.jobs)||!d.jobs.every(j=>Array.isArray(j.referralContacts))) process.exit(1)"
```

Require no duplicate `profileUrl` within one job and no duplicate `matchKey` in private state. If authenticated and matching connections exist, verify at least one profile link/current title appears in the corresponding job.

- [ ] **Step 5: Start and inspect the local site**

Run:

```bash
node local/sunny-job-search/serve.mjs
```

Open `http://127.0.0.1:4173`, verify the new column/status/filter, search a matched name, toggle `只看有內推人`, open one profile link without interacting, and test both copy controls. Restore the original tab afterward if practical.

- [ ] **Step 6: Roll back on smoke failure**

If any state/schema/UI verification fails, restore the pre-smoke files by exact path and hash. Do not leave a partially valid referral file or snapshot.

---

### Task 8: Final regression, privacy audit, and handoff

**Files:** all files above.

- [ ] **Step 1: Run all focused and relevant regressions**

```bash
node --test tests/sunny-linkedin-referrals.test.mjs \
  local/sunny-job-search/tests/app.test.mjs \
  local/sunny-job-search/tests/builder.test.mjs \
  local/sunny-job-search/tests/server.test.mjs
node --test tests/sunny-job-queue.test.mjs tests/sunny-serialized-scan.test.mjs
node --check data/tools/sunny-linkedin-referrals.mjs
node --check data/tools/build-sunny-job-search-index.mjs
git diff --check
```

Expected: all tests and checks PASS.

- [ ] **Step 2: Audit privacy and external-action boundaries**

Require:

- `data/sunny-linkedin-referrals.json` is ignored;
- no names/profile URLs occur in tracked diffs or logs;
- no Sheet schema/config changed for this feature;
- no code or prompt can enter credentials, message, connect, or apply;
- Grok files/routines are unchanged;
- the existing job scan still completes when referral status is skipped/error.

- [ ] **Step 3: Inspect the final diff without touching unrelated work**

Preserve all pre-existing untracked files. Stage only intended source/tests/docs that are appropriate for the repository; never stage generated/private referral data or `jobs.json`.

- [ ] **Step 4: Report in Traditional Chinese**

Report implementation files, automation status/next run, Brave smoke status, new/verified/pending connection counts, matched people/jobs, website URL, tests, and any LinkedIn skip warning. Do not print the full private contact ledger in the handoff.

---

## Acceptance checklist

- [ ] Brave-only capture uses the existing session and skips without login attempts.
- [ ] Current Experience, not headline/former employment, is required.
- [ ] Jobs are limited to the inclusive latest 14 calendar days.
- [ ] Private state is atomic, minimal, deduplicated, and Git-ignored.
- [ ] Google Sheet and Grok remain unchanged by referral matching.
- [ ] Localhost jobs expose `referralContacts`, source status, and update time.
- [ ] Website column, links, copy controls, search, and referral-only filter work.
- [ ] Daily `sunny-24` keeps all original behavior and gains only the optional referral phase.
- [ ] LinkedIn failure preserves cached referrals and never fails the job scan.
- [ ] No automation sends messages, connections, applications, or credentials.
