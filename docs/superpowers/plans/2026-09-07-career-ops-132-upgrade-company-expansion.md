# Career-Ops 1.32 Upgrade and Sunny Company Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely upgrade the fork to career-ops 1.32.0, retain Sunny's custom ATS coverage behavior, and run all newly available evidence-safe company discovery streams to increase verified H-1B company coverage.

**Architecture:** Apply the upstream system layer in preserve mode, then manually combine upstream Workday coverage improvements with the local `myworkdaysite.com` support while retaining the Ashby and MobiCloud extensions. After verification, rebuild the DOL identity state and enrich unresolved companies through Built In, the H-1B sponsor plugin, public ATS discovery, and official-site alias resolution; only verified boards enter `portals.yml`.

**Tech Stack:** Node.js ESM, Python/pandas, YAML/TSV/JSONL, career-ops provider APIs and plugin hooks, Git, DOL FY2026 Q3 LCA data.

---

### Task 1: Freeze the pre-upgrade baseline

**Files:**
- Create: `config/local-paths.txt`
- Modify: `.git/info/exclude`
- Create: `data/cache/upgrade/pre-1.32-user-sha256.tsv`
- Create outside repo: `/Users/coda/Documents/ChatGPT/career-ops-upgrade-backup-2026-09-07.tgz`
- Create outside repo: `/Users/coda/Documents/ChatGPT/career-ops-user-data-backup-2026-09-07.tgz`
- Create outside repo: `/Users/coda/Documents/ChatGPT/career-ops-backup-2026-09-07.sha256`
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

Add `/profiles/` and `/outputs/` to `.git/info/exclude`. Do not modify tracked `.gitignore` before the upgrade. Do not add provider or test paths to `config/local-paths.txt` because they overlap the system layer and must be merged rather than hidden from updates.

- [ ] **Step 3: Save a concrete backup of untracked custom code**

Create `/Users/coda/Documents/ChatGPT/career-ops-upgrade-backup-2026-09-07.tgz` containing:

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

- [ ] **Step 4: Save and verify a restorable private user-data archive**

Create `/Users/coda/Documents/ChatGPT/career-ops-user-data-backup-2026-09-07.tgz` containing exactly the current `portals.yml`, `config/profile.yml`, `modes/_profile.md`, `modes/_custom.md`, `profiles/`, `data/cache/dol/`, `data/scan-history.tsv`, `data/scan-runs.tsv`, and any current Sheet payload state under `outputs/`. Missing optional files are recorded in the backup log rather than treated as an empty successful archive. Store SHA-256 values for both dated archives in `/Users/coda/Documents/ChatGPT/career-ops-backup-2026-09-07.sha256`, list both archives, and test-extract each into its own `mktemp -d` directory before any updater or company write. The test extraction must contain `portals.yml` and `profiles/sunny-h1b-ats-identity-reviews.yml`.

- [ ] **Step 5: Write the immutable user-file checksum manifest**

Write tab-separated SHA-256 hashes for `cv.md`, `config/profile.yml`, `modes/_profile.md`, and `modes/_custom.md` into `data/cache/upgrade/pre-1.32-user-sha256.tsv`. Record `portals.yml` separately as the mutable pre-expansion baseline. The post-upgrade check must compare these four immutable files byte-for-byte before any company write.

- [ ] **Step 6: Run the current focused baseline tests**

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
git ls-remote https://github.com/career-ops-hq/career-ops.git refs/heads/main
node update-system.mjs apply
```

Expected: record the canonical main SHA first. The updater creates a backup branch/WIP ref, updates non-overlapping system paths, and reports local system files it preserved. Do not rerun with `--force`. The updater follows canonical `main`; the recorded SHA makes the exact target auditable even when `VERSION` remains 1.32.0.

- [ ] **Step 2: Confirm the installed release and protected data**

Run:

```bash
node update-system.mjs check
git status --short
```

Expected: version 1.32.0, with the installed commit traceable to the recorded main SHA. Recompute the four immutable hashes from Task 1 and require exact equality. If `check` reports system drift only for intentionally preserved files, continue to Task 3.

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

The tests must assert that:

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

It must also prove that a direct modern CXS URL resolves without corrupting the tenant/site, that returned job URLs use `/recruiting/brevanhoward/BH_ExternalCareers`, and that `workdayDedupKey()` collapses the same requisition across two sites on both `.myworkdayjobs.com` and `.myworkdaysite.com` hosts. For modern hosts the key must contain `{hostname}:{tenant-from-/recruiting/<tenant>/...}:{requisition-id}`. An inverse test must prove that the same requisition id under two different tenants on `wd3.myworkdaysite.com` does not deduplicate.

Run it against the untouched upstream provider and verify that this local behavior fails before implementation.

- [ ] **Step 3: Reapply the minimal Workday URL support**

Extend the upstream endpoint resolver to accept only this anchored HTTPS shape:

```text
https://wd*.myworkdaysite.com/recruiting/{tenant}/{site}
```

Construct the CXS endpoint on the same host and the job base under `/recruiting/{tenant}/{site}`. Extend the upstream direct-CXS and dedup host validation to the allowlisted `.myworkdaysite.com` shape without weakening its anchored HTTPS/host checks. The modern dedup parser must extract and include the tenant path segment because the host is shared across unrelated employers. Preserve the upstream legacy `myworkdayjobs.com` branches, facet splitting, partial markers, and SSRF guards.

- [ ] **Step 4: Verify Ashby and MobiCloud extensions**

Retain the Ashby fallback only for a posting API 404 and only for `https://jobs.ashbyhq.com/{board}`. It must parse `window.__appData` without executing page JavaScript. Confirm `mcloud.mjs` loads through the dynamic provider registry and does not duplicate another provider id.

- [ ] **Step 5: Run provider verification**

Run:

```bash
node tests/providers/workday.test.mjs
node tests/providers/ashby-page-fallback.test.mjs
node tests/providers/ashby.test.mjs
node tests/providers/mcloud.test.mjs
node validate-portals.mjs
```

Expected: all focused tests pass; portal validation reports no configuration errors.

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

- [ ] **Step 3: Smoke-test representative boards and separate health evidence**

Run bounded scans against one Greenhouse board, one Ashby hosted-page-fallback board, one legacy Workday board, one `myworkdaysite.com` board, and MobiCloud. Save the `careerops.scan.receipt@1` JSON and validate only its documented counters, `added_urls`, `errors`, and `dry_run` fields. Separately run `node verify-portals.mjs --strict` against a scratch portals file and save its log for live, live-empty, missing/dead, partial, and transient-error interpretation. A transient failure is retried once and remains an error if the retry fails; it is never rewritten as empty.

### Task 5: Enable and inspect the new expansion sources

**Files:**
- Modify: `config/plugins.yml` only through the supported plugin manager
- Modify: `portals.yml` only after verified preview
- Generate: `data/cache/dol/sunny-builtin-company-leads-2026-09-07.tsv`
- Generate: `data/cache/dol/sunny-expansion-candidates-2026-09-07.yml`
- Create: `data/tools/collect-sunny-builtin-leads.mjs`
- Create: `data/tools/join-sunny-builtin-h1b.mjs`
- Create: `tests/sunny-builtin-leads.test.mjs`
- Create: `tests/sunny-builtin-h1b-join.test.mjs`

- [ ] **Step 1: Inspect installed 1.32 source interfaces**

Run:

```bash
node plugins.mjs list
node scan.mjs --help
```

Confirm `providers/builtin.mjs` is a library provider with no CLI and inspect its exported `fetch()` contract. Do not treat `node providers/builtin.mjs --help` as a supported command.

- [ ] **Step 2: Enable the H-1B sponsor plugin if locally available**

Use `node plugins.mjs skill h1b-sponsor` to read its hook contract, then run exactly:

```bash
node plugins.mjs enable h1b-sponsor --confirm
node plugins/h1b-sponsor/install-h1b-index.mjs
```

The user's reviewed-plan authorization covers the approximately 8 MiB public index download. Do not use the plugin as a batch company-admission gate or include its results in added-company counts. It remains supplemental evidence for individual company evaluations; the FY2026 Q3 `CHANGE_EMPLOYER` table remains authoritative.

- [ ] **Step 3: Test and implement the Built In collector**

Create `collect-sunny-builtin-leads.mjs`, importing the Built In provider and `makeHttpCtx()`. Export `collectBuiltinLeads({hosts, queries, maxPages, fetchProvider, now})` and `dedupeBuiltinLeads(jobs)`. Configure `www.builtinnyc.com` and `builtin.com` with these explicit queries: `data engineer`, `analytics engineer`, `business intelligence engineer`, `data analyst`, `financial data analyst`, `data platform`, `data warehouse`, `ETL`, and `ELT`; use `scope: remote` on the national host. The TSV columns are `company`, `title`, `location`, `posted_at`, `url`, `source_host`, and `first_seen`. Tests must prove cross-query URL deduplication, company preservation, UTC date serialization, and rejection of rows with no company or URL.

Run:

```bash
node tests/sunny-builtin-leads.test.mjs
node data/tools/collect-sunny-builtin-leads.mjs --output data/cache/dol/sunny-builtin-company-leads-2026-09-07.tsv
```

- [ ] **Step 4: Test and implement the DOL/alias join**

Create `join-sunny-builtin-h1b.mjs`, exporting `joinBuiltinCompanies({leads, employers, reviews})`. Exact canonical legal-name/DBA equality is accepted. A non-exact brand is accepted only when `sunny-h1b-ats-identity-reviews.yml` contains an `accept` mapping for that identity and URL/domain evidence. Prefix and substring matches are never accepted. Tests must include Mercury versus Mercury Systems, Scale versus Scale AI, an accepted DBA, an ambiguous normalized collision, and an aggregator-only company. Emit accepted and needs-review sections separately; only accepted entries go into `sunny-expansion-candidates-2026-09-07.yml`.

Run:

```bash
node tests/sunny-builtin-h1b-join.test.mjs
node data/tools/join-sunny-builtin-h1b.mjs --leads data/cache/dol/sunny-builtin-company-leads-2026-09-07.tsv --output data/cache/dol/sunny-expansion-candidates-2026-09-07.yml
```

### Task 6: Replay all deterministic ATS discovery

**Files:**
- Regenerate: `profiles/sunny-ny-metro-h1b-seeds.yml`
- Update: `data/cache/dol/sunny-ny-metro-resolution-2026-09-02.tsv`
- Update: `data/cache/dol/sunny-ny-metro-discovery.jsonl`
- Create: `data/cache/dol/sunny-ny-metro-discovery-v2-2026-09-07.jsonl`
- Create: `data/tools/sunny-ats-identity-gate.mjs`
- Create: `tests/sunny-ats-identity-gate.test.mjs`
- Create: `data/tools/audit-sunny-workday-health.mjs`
- Create: `tests/sunny-workday-health.test.mjs`
- Generate: `data/cache/dol/sunny-workday-health-2026-09-07.jsonl`
- Modify: `data/tools/run-sunny-ny-metro-discovery.mjs`
- Modify: `data/tools/build-sunny-ny-metro-resolution.mjs`
- Modify: `portals.yml`

- [ ] **Step 1: Rebuild the current resolution baseline**

Run:

```bash
node data/tools/build-sunny-ny-metro-resolution.mjs
```

Record exact already-covered, unresolved, ambiguous, invalid, excluded, and error counts before adding companies.

- [ ] **Step 2: Implement the ownership and durable-state gate**

Create `sunny-ats-identity-gate.mjs`, exporting `canonicalIdentityTokens()`, `classifyPublishedOwner()`, `reviewedUrlVerdict()`, and `classifyDiscoveryCandidate()`. Reuse the strict equality semantics of `verify-portals.mjs`'s `boardIdentityMatches`: legal suffixes may be removed, but prefixes/substrings never match. Greenhouse/Ashby/Lever require a fetched published owner. All other providers require an exact accepted `identity + careers_url` review or an official-site link recorded in the reviews file. A guessed live long-tail slug receives `identity_status=review_required`; it is non-writable. Never return a writable identity status on timeout, missing owner, prefix match, or guessed long-tail slug.

Update `run-sunny-ny-metro-discovery.mjs` so `--write` requires `identity_status` in `owner_verified,reviewed_official_link` and `health_status` in `live,partial`. Add `schemaVersion: 2`, `runId`, `provider`, `careersUrl`, `boardOwner`, `evidence`, `identity_status`, and `health_status` to every checkpoint record. Add `--retry-identity-statuses unresolved,owner_unreachable` and `--retry-health-statuses transient_error,partial`; accepted/live records are never requeued. Update `build-sunny-ny-metro-resolution.mjs` to consume the v2 checkpoint and preserve both axes in the final TSV.

Tests must prove Mercury/Mercury Systems and Scale/Scale AI fail closed, an exact owner passes, a reviewed Workday URL passes, a guessed Workable slug receives the exact `review_required` identity status, old unresolved/error records can be replayed, accepted records are not replayed, malformed checkpoint tails are ignored, and only accepted identity plus live/partial health combinations reach `portals.yml`.

Run:

```bash
node tests/sunny-ats-identity-gate.test.mjs
node tests/sunny-ny-metro-discovery.test.mjs
node tests/sunny-ny-metro-resolution.test.mjs
```

- [ ] **Step 3: Run the checkpointed unresolved-company resolver**

Before the live run, create `audit-sunny-workday-health.mjs`. It loads only Workday entries through the provider registry and performs a full provider fetch without `ctx.maxPages=1`. Export `classifyWorkdayHealth(jobs, error)` so tests prove: a non-empty ordinary array is `live`; an empty complete array is `live_empty`; `jobs.workdayTruncated` is `partial`; a definitive gone response is `dead`; and retryable network/429/5xx failures are `transient_error`. The output is JSONL keyed by normalized careers URL and includes `jobCount`, `workdayTruncated`, `checkedAt`, and error evidence. Neither `scan.receipt@1`, `verify-portals`, nor `discover-ats` is used as evidence of partial coverage.

Run:

```bash
node tests/sunny-workday-health.test.mjs
node data/tools/audit-sunny-workday-health.mjs --portals portals.yml --output data/cache/dol/sunny-workday-health-2026-09-07.jsonl --concurrency 4
```

Join this health artifact into the v2 resolution/checkpoint by normalized careers URL before any write.

Run the full unresolved set with bounded concurrency and resume support:

```bash
node data/tools/run-sunny-ny-metro-discovery.mjs --checkpoint data/cache/dol/sunny-ny-metro-discovery-v2-2026-09-07.jsonl --batch-size 50 --concurrency 8
```

Preview resolved entries, verify their DOL identity and live board, then use the already-authorized write path:

```bash
node data/tools/run-sunny-ny-metro-discovery.mjs --checkpoint data/cache/dol/sunny-ny-metro-discovery-v2-2026-09-07.jsonl --batch-size 50 --concurrency 8 --write
```

The new checkpoint intentionally replays the 34 unresolved records in the old checkpoint. Continue until no first-pass pending companies remain. Retry only the explicitly named unresolved/unreachable or transient/partial axes; never restart accepted/live identities.

- [ ] **Step 4: Resolve Built In candidates through the same ownership gate**

Run:

```bash
node data/tools/run-sunny-ny-metro-discovery.mjs --in data/cache/dol/sunny-expansion-candidates-2026-09-07.yml --checkpoint data/cache/dol/sunny-builtin-ats-discovery-v2-2026-09-07.jsonl --batch-size 50 --concurrency 8
node data/tools/run-sunny-ny-metro-discovery.mjs --in data/cache/dol/sunny-expansion-candidates-2026-09-07.yml --checkpoint data/cache/dol/sunny-builtin-ats-discovery-v2-2026-09-07.jsonl --batch-size 50 --concurrency 8 --write
```

The same code-enforced ownership gate applies before `--write`; inspection cannot substitute for the gate. The user has pre-authorized the reviewed plan's verified writes.

- [ ] **Step 5: Resolve Workday and unsupported-site gaps**

For unresolved high-volume Metro identities, obtain official careers URLs, extract Workday tenant/site coordinates when present, and rerun `discover-ats.mjs --vendors workday`. For supported non-slug providers, add only first-party URLs. Record custom/unsupported careers pages as durable handoff states rather than fabricating an ATS.

- [ ] **Step 6: Prove idempotency**

Repeat both ownership-gated write commands. Expected: `added: 0` and no change to `portals.yml`.

- [ ] **Step 7: Re-audit every Workday board after writes**

Run the full-board auditor again against the updated `portals.yml` and write a distinct post-write artifact:

```bash
node data/tools/audit-sunny-workday-health.mjs --portals portals.yml --output data/cache/dol/sunny-workday-health-post-write-2026-09-07.jsonl --concurrency 4
```

Update `tests/sunny-workday-health.test.mjs` with an integration fixture in which a Workday URL absent from the baseline portals fixture is admitted by an ownership-gated write, appears in the post-write health artifact, returns an array carrying `jobs.workdayTruncated`, and becomes `health_status=partial`. Rejoin the post-write artifact into the v2 checkpoint/resolution and rebuild counts. The pre-write artifact is historical baseline evidence only and must not drive final Workday health counts.

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
node verify-portals.mjs --strict
```

Save the strict verification output as bounded liveness evidence. Use `data/cache/dol/sunny-workday-health-post-write-2026-09-07.jsonl`, not the bounded probe or pre-write artifact, for final Workday health/partial counts. If strict mode exits non-zero, separate definitive missing/dead boards from transient errors, retry only transient errors once, and report the remaining states instead of claiming a clean reachability sweep. Record final portal-entry, linked-identity, unresolved, ambiguous, review-required, live-empty, dead, transient-error, and partial counts from the rebuilt v2 resolution plus bounded liveness and post-write full-board health evidence.

- [ ] **Step 2: Run a bounded three-day production-like scan**

Use the existing Sunny title/location/date filters and dedup history. Confirm that only first-seen matches enter the Sheet payload and the `使用履歷` column remains immediately after `主要缺口`.

- [ ] **Step 3: Update the coverage audit**

Document additions by source: Built In, H-1B sponsor enrichment, public ATS replay, Workday hints, official-site aliases, and manual high-volume Metro resolution. State the coverage ceiling honestly for employers without public ATS access.

- [ ] **Step 4: Report the new operating procedure**

Tell the user how to use 1.32 to increase companies: collect Built In/Indeed/LinkedIn leads, require DOL evidence, run `discover-ats` preview/write, run a three-day scan, inspect the scan receipt, and update the Sheet through the existing dedup path.
