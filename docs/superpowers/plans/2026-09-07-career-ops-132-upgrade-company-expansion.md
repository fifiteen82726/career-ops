# Career-Ops 1.32 Upgrade and Sunny Company Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely upgrade the fork to career-ops 1.32.0, retain Sunny's custom ATS coverage behavior, and run all newly available evidence-safe company discovery streams to increase verified H-1B company coverage.

**Architecture:** Apply the upstream system layer in preserve mode, then manually combine upstream Workday coverage improvements with the local `myworkdaysite.com` support while retaining the Ashby and MobiCloud extensions. After verification, rebuild the DOL identity state and enrich unresolved companies through Built In, the H-1B sponsor plugin, public ATS discovery, and official-site alias resolution; only verified boards enter `portals.yml`.

**Tech Stack:** Node.js ESM, Python/pandas, YAML/TSV/JSONL, career-ops provider APIs and plugin hooks, Git, DOL FY2026 Q3 LCA data.

---

### Task 1: Freeze the pre-upgrade baseline

**Files:**
- Create: `config/local-paths.txt`
- Modify: `.gitignore`
- Inspect: `cv.md`, `config/profile.yml`, `modes/_profile.md`, `modes/_custom.md`, `portals.yml`, `data/`, `profiles/`, `outputs/`

- [ ] **Step 1: Record repository and version state**

Run:

```bash
git status --short
git branch --show-current
node update-system.mjs check
```

Expected: local 1.29.0, remote 1.32.0, with the known provider/test modifications visible.

- [ ] **Step 2: Declare fork-only user paths**

Create `config/local-paths.txt` with:

```text
# Sunny-specific source and generated artifacts.
profiles/
outputs/
```

Add `/profiles/` and `/outputs/` to `.gitignore`. Do not add provider or test paths because they overlap the system layer and must be merged rather than hidden from updates.

- [ ] **Step 3: Save a non-private system customization patch**

Record the diffs for:

```text
providers/ashby.mjs
providers/workday.mjs
tests/providers/workday.test.mjs
providers/mcloud.mjs
tests/providers/ashby-page-fallback.test.mjs
tests/providers/mcloud.test.mjs
tests/sunny-*.test.mjs
tests/test_sunny_ny_metro_h1b.py
data/tools/
```

Do not include `cv.md`, profile data, DOL cache rows, scan history, reports, Sheet payloads, or credentials in a commit or public patch.

- [ ] **Step 4: Run the current focused baseline tests**

Run:

```bash
node tests/providers/workday.test.mjs
node tests/providers/ashby-page-fallback.test.mjs
node tests/providers/mcloud.test.mjs
node tests/sunny-high-recall-title-filter.test.mjs
node tests/sunny-ny-metro-discovery.test.mjs
node tests/sunny-ny-metro-resolution.test.mjs
```

Expected: all focused tests pass before the upgrade.

### Task 2: Apply career-ops 1.32 in preserve mode

**Files:**
- Modify: system-layer files listed by `update-system.mjs`
- Preserve: all paths listed in `USER_PATHS` and `config/local-paths.txt`

- [ ] **Step 1: Run the supported updater without force**

Run:

```bash
node update-system.mjs apply --confirm
```

Expected: the updater creates a backup branch/WIP ref, updates non-overlapping system paths, and reports local system files it preserved. Do not rerun with `--force`.

- [ ] **Step 2: Confirm the installed release and protected data**

Run:

```bash
node update-system.mjs check
git status --short
```

Expected: version 1.32.0 or current main with 1.32.0 as its release baseline; Sunny user files remain present. If `check` reports system drift only for intentionally preserved files, continue to Task 3.

### Task 3: Integrate the local ATS fixes with 1.32

**Files:**
- Modify: `providers/workday.mjs`
- Modify: `tests/providers/workday.test.mjs`
- Verify/preserve: `providers/ashby.mjs`
- Verify/preserve: `tests/providers/ashby-page-fallback.test.mjs`
- Verify/preserve: `providers/mcloud.mjs`
- Verify/preserve: `tests/providers/mcloud.test.mjs`

- [ ] **Step 1: Establish upstream Workday behavior**

Use the 1.32 `providers/workday.mjs` as the base. Confirm it retains facet-split recovery, CXS-form URL resolution, bounded retries, partial-board signals, and date-aware pagination.

- [ ] **Step 2: Write/retain the failing local URL-shape test**

The test must assert that:

```js
workday.detect({
  name: 'Brevan Howard',
  careers_url: 'https://wd3.myworkdaysite.com/recruiting/brevanhoward/BH_ExternalCareers',
})
```

resolves to:

```text
https://wd3.myworkdaysite.com/wday/cxs/brevanhoward/BH_ExternalCareers/jobs
```

Run it against the untouched upstream provider and verify that this local behavior fails before implementation.

- [ ] **Step 3: Reapply the minimal Workday URL support**

Extend the upstream endpoint resolver to accept only this anchored HTTPS shape:

```text
https://wd*.myworkdaysite.com/recruiting/{tenant}/{site}
```

Construct the CXS endpoint on the same host and the job base under `/recruiting/{tenant}/{site}`. Preserve the upstream CXS URL and legacy `myworkdayjobs.com` branches and their SSRF guards.

- [ ] **Step 4: Verify Ashby and MobiCloud extensions**

Retain the Ashby fallback only for a posting API 404 and only for `https://jobs.ashbyhq.com/{board}`. It must parse `window.__appData` without executing page JavaScript. Confirm `mcloud.mjs` loads through the dynamic provider registry and does not duplicate another provider id.

- [ ] **Step 5: Run provider verification**

Run:

```bash
node tests/providers/workday.test.mjs
node tests/providers/ashby-page-fallback.test.mjs
node tests/providers/ashby.test.mjs
node tests/providers/mcloud.test.mjs
node verify-portals.mjs --summary
```

Expected: all focused tests pass; portal verification reports no configuration errors.

### Task 4: Verify the complete upgraded pipeline

**Files:**
- Verify: all system and Sunny workflow files

- [ ] **Step 1: Run syntax and full regression checks**

Run:

```bash
node test-all.mjs
git diff --check
```

Expected: exit code 0 with no failing suite and no whitespace errors.

- [ ] **Step 2: Run Sunny-specific checks**

Run:

```bash
node tests/sunny-high-recall-title-filter.test.mjs
node tests/sunny-ny-metro-discovery.test.mjs
node tests/sunny-ny-metro-resolution.test.mjs
python3 tests/test_sunny_ny_metro_h1b.py
```

Expected: broad title discovery, hard exclusions, NYC Metro geography, identity resolution, and dedup all pass.

- [ ] **Step 3: Smoke-test representative boards**

Run bounded scans against one Greenhouse board, one Ashby hosted-page-fallback board, one legacy Workday board, one `myworkdaysite.com` board, and MobiCloud. Confirm the scan receipt distinguishes success, empty, error, dead, and partial states.

### Task 5: Enable and inspect the new expansion sources

**Files:**
- Modify: `config/plugins.yml` only through the supported plugin manager
- Modify: `portals.yml` only after verified preview
- Generate: `data/cache/dol/sunny-builtin-company-leads-2026-09-07.tsv`
- Generate: `data/cache/dol/sunny-expansion-candidates-2026-09-07.yml`

- [ ] **Step 1: Inspect installed 1.32 source interfaces**

Run:

```bash
node plugins.mjs list
node providers/builtin.mjs --help
node scan.mjs --help
```

If the Built In provider has no direct CLI, configure the documented `job_boards` entry in a scratch portals file and run `scan.mjs` against it.

- [ ] **Step 2: Enable the H-1B sponsor plugin if locally available**

Use `node plugins.mjs skill h1b-sponsor` to read its hook contract, then install/enable it through `plugins.mjs`. Do not allow it to overwrite the FY2026 Q3 DOL universe; persist its output as supplemental evidence only.

- [ ] **Step 3: Collect Built In employer leads**

Run broad New York Metropolitan and US-remote searches for the existing Sunny title families. Deduplicate employer brands and write a TSV containing source URL, company brand, title, location, publication date, and first-seen date.

- [ ] **Step 4: Join every lead to H-1B evidence**

Normalize the Built In brand against the DOL legal name, DBA, and reviewed parent/alias map. Emit only matched/reviewable companies to `sunny-expansion-candidates-2026-09-07.yml`; aggregator-only brands remain leads and are not added.

### Task 6: Replay all deterministic ATS discovery

**Files:**
- Regenerate: `profiles/sunny-ny-metro-h1b-seeds.yml`
- Update: `data/cache/dol/sunny-ny-metro-resolution-2026-09-02.tsv`
- Update: `data/cache/dol/sunny-ny-metro-discovery.jsonl`
- Modify: `portals.yml`

- [ ] **Step 1: Rebuild the current resolution baseline**

Run:

```bash
node data/tools/build-sunny-ny-metro-resolution.mjs
```

Record exact already-covered, unresolved, ambiguous, invalid, excluded, and error counts before adding companies.

- [ ] **Step 2: Run the checkpointed unresolved-company resolver**

Run the full unresolved set with bounded concurrency and resume support:

```bash
node data/tools/run-sunny-ny-metro-discovery.mjs --batch-size 50 --concurrency 8
```

Preview resolved entries, verify their DOL identity and live board, then use the already-authorized write path:

```bash
node data/tools/run-sunny-ny-metro-discovery.mjs --batch-size 50 --concurrency 8 --write
```

Continue from the JSONL checkpoint until no pending companies remain. Do not restart completed identities.

- [ ] **Step 3: Resolve Built In candidates**

Run:

```bash
node discover-ats.mjs --in data/cache/dol/sunny-expansion-candidates-2026-09-07.yml --summary
node discover-ats.mjs --in data/cache/dol/sunny-expansion-candidates-2026-09-07.yml --write
```

The user has pre-authorized the reviewed plan's writes. Still inspect the preview and withhold ambiguous identity matches before executing `--write`.

- [ ] **Step 4: Resolve Workday and unsupported-site gaps**

For unresolved high-volume Metro identities, obtain official careers URLs, extract Workday tenant/site coordinates when present, and rerun `discover-ats.mjs --vendors workday`. For supported non-slug providers, add only first-party URLs. Record custom/unsupported careers pages as durable handoff states rather than fabricating an ATS.

- [ ] **Step 5: Prove idempotency**

Repeat both write commands. Expected: `freshWritten: 0` and no change to `portals.yml`.

### Task 7: Final coverage audit and operational handoff

**Files:**
- Update: `profiles/sunny-h1b-company-coverage-audit-2026-09-02.md`
- Verify: `portals.yml`
- Verify: scheduled scan prompt and Google Sheet schema

- [ ] **Step 1: Rebuild identity counts and validate portals**

Run:

```bash
node data/tools/build-sunny-ny-metro-resolution.mjs
node validate-portals.mjs
node verify-portals.mjs --summary
```

Record final portal-entry, linked-identity, unresolved, ambiguous, live-empty, dead, error, and partial counts.

- [ ] **Step 2: Run a bounded three-day production-like scan**

Use the existing Sunny title/location/date filters and dedup history. Confirm that only first-seen matches enter the Sheet payload and the `使用履歷` column remains immediately after `主要缺口`.

- [ ] **Step 3: Update the coverage audit**

Document additions by source: Built In, H-1B sponsor enrichment, public ATS replay, Workday hints, official-site aliases, and manual high-volume Metro resolution. State the coverage ceiling honestly for employers without public ATS access.

- [ ] **Step 4: Report the new operating procedure**

Tell the user how to use 1.32 to increase companies: collect Built In/Indeed/LinkedIn leads, require DOL evidence, run `discover-ats` preview/write, run a three-day scan, inspect the scan receipt, and update the Sheet through the existing dedup path.
