# Sunny Daily H-1B Company Expansion Design

**Date:** 2026-09-08
**Status:** Approved for implementation after independent review
**Scope:** Company discovery and ATS admission for Sunny's Greater New York and U.S.-remote job search

## 2026-09-09 reviewed amendment — supersedes the original Q3-only gate below

The active evidence index is now `profiles/sunny-company-discovery.yml`'s validated eight-quarter index, FY2024 Q4 through FY2026 Q3. Tier A has positive CHANGE_EMPLOYER in the current disclosure; Tier B has it only in the earlier part of the window. Both are historical evidence, not current-job transfer guarantees. Case-number dedup, observed-quarter validation and exact legal/DBA collision checks apply before admission. Original Q3 counts below describe the design's earlier baseline only.

State is keyed by company + provider + board, not company alone. Each board needs independent identity verification; aliases of an identical board share anchored backfill completion. Known identity holds override matching owner names. Offline ATS datasets supply hints, not permission to append: use the bounded reviewed probe/resolver and staged portal validation/CAS. All scan candidates survive in the shared durable job queue until a verified disposition; scan history is not publication state. Current implementation and operational acceptance gates are tracked in `docs/superpowers/plans/2026-09-08-sunny-coverage-recovery.md` and `modes/_custom.md`.

## Problem

Sunny's daily job scan can only inspect companies already represented in `portals.yml`. The current pool is large, but public ATS directories, legal-employer names, hiring brands, and current job-market sources do not line up perfectly. A company may have certified FY2026 Q3 H-1B `CHANGE_EMPLOYER` filings and a relevant New York or U.S.-remote opening while still being absent because its legal name, brand, parent, or ATS owner differs.

Company discovery and job processing therefore need separate state and responsibilities. Job-search sources provide current company leads; DOL data provides immigration evidence; official ATS ownership provides the safe scanner coordinate. A job listing alone never proves H-1B support or ATS identity.

## Goals

1. Discover companies currently advertising roles plausibly aligned with Sunny in the practical NYC metropolitan commuting area or as fully U.S.-remote work.
2. Admit a new company only after current FY2026 Q3 `CHANGE_EMPLOYER > 0` evidence and an identity-safe official ATS/careers resolution.
3. Run company discovery daily for now without coupling cadence to implementation, so it can later move to weekly by changing only the automation schedule.
4. Backfill newly admitted companies for 20 days, then include them in the normal overlapping 3-day daily job scan.
5. Preserve fail-closed identity rules, deterministic deduplication, low token use, and an auditable reason for every accepted, rejected, deferred, or failed lead.

## Non-goals

- Preloading every one of the 17,495 national FY2026 Q3 H-1B employers.
- Treating Indeed's `sponsored` field, an aggregator sponsor badge, company size, PERM history, or an old LCA job title as an admission gate.
- Automatically resolving ambiguous parent/subsidiary or brand/legal-entity relationships without evidence.
- Scraping application forms, applying to jobs, or messaging contacts.
- Replacing the existing daily job scoring and Google Sheet schema.
- Claiming near-100% coverage of private, custom, inaccessible, or non-indexed careers systems.

## Architecture

The system has two separate pipelines joined only at a validated `portals.yml` write.

### Pipeline A: Company discovery and admission

```text
current job-market sources
  -> normalized company leads
  -> company-lead dedup/state
  -> DOL legal name / DBA / reviewed alias gate
  -> official ATS identity + health gate
  -> atomic portals.yml append
  -> 20-day scan of newly admitted companies
```

### Pipeline B: Daily job processing

```text
all verified portals.yml entries
  -> overlapping 3-day scan
  -> job history dedup
  -> title/location/date/sponsorship hard gates
  -> JD semantic qualification against Sunny's two role families
  -> score only newly qualified roles
  -> Google Sheet
```

Pipeline A can fail without stopping Pipeline B. Pipeline A and Pipeline B run as separate automations and commands. Changing company-discovery cadence must not change Pipeline B or its dedup state.

## Discovery Sources

All source output is untrusted external data and can create only a lead.

### Daily backfill and increment sources

1. **Indeed NYC:** one `New York, NY` search pass with a 50-mile radius.
2. **Indeed U.S. remote:** a separate `remote_only: true` pass.
3. **Built In NYC:** the existing Built In NYC provider.
4. **Built In remote:** the existing national remote provider.
5. **freehire NYC Metro:** keyless public API, `us-h1b-sponsor` collection, first-party ATS rows only, limited to New York City, Jersey City, and Newark.
6. **freehire U.S. remote:** the same first-party ATS boundary, limited to U.S. remote jobs.
7. **Himalayas U.S. remote:** public API searched through bounded high-recall data/analyst query pages.
8. **Jobicy U.S. remote:** public API with `geo=usa`, `tag=data`, and the documented 200-row request ceiling.
9. **OpenJobs and public ATS directories:** offline company/board candidates, including BambooHR, Paylocity, Recruitee, Breezy, Teamtailor, Personio, Rippling, and Jobvite tenants omitted by the original five-provider sweep. Greenhouse, Ashby, Lever, Workday, and iCIMS directories are also processed owner-first: the ATS-published owner is joined to DOL before checking for a current first-party job, so non-obvious board slugs are recoverable without fuzzy identity guesses.
10. **The Muse NYC and U.S. remote:** keyless public jobs API, paginated independently for each scope and used as a company-lead source only.
11. **Open Jobs Fleet:** daily CC0 exports of live ATS boards across 36 providers. High-confidence company identities are company leads only; DOL, first-party ATS owner, and active-board verification still gate admission.
12. **newgrad-jobs / JobRight:** the public U.S. Data Analyst and Data Engineer dashboards (`?k=da` and `?k=de`) are read through their embedded structured JobRight feed. Rows explicitly marked `H1b Sponsored: No` are discarded; NYC Metro and U.S.-remote scope filters are applied before ingestion. This is company-lead evidence only, never ATS-owner or H-1B proof.
13. **Google:** bounded resolution queries only for a new DOL-approved company whose official ATS remains unknown. Google is not rerun globally every day.

Indeed's one-location-per-reply constraint is honored by running NYC and remote in two independent automation turns, not merely two calls in one turn. Connector failures are recorded per source. A successful source returning zero leads is distinct from a failed or truncated source.

Each source turn has an explicit mode:

- **`backfill`:** used for the first implementation run or an intentional historical refresh. freehire walks bounded pages of live first-party ATS jobs; Himalayas walks bounded query pages; Jobicy requests its current 200-row U.S.-data feed. Built In uses bounded historical pagination and the same local cutoff. Indeed has no equivalent date argument, so it returns its available ranked results; dates are retained when supplied and no unsupported completeness claim is made for undated results.
- **`incremental`:** used by the daily automations. freehire restricts to jobs first observed by that source within three days; Built In, Indeed, The Muse, newgrad-jobs/JobRight, Himalayas, and Jobicy rerun bounded current searches and rely on the source-lead ledger to retain only unseen lead keys.

Run receipts name the mode and the effective date capability of each source. A source backfill is never described as complete when that connector does not expose a reliable posting date or exhaustive pagination.

### Broad role vocabulary

Lead discovery uses high recall rather than final qualification. Queries cover:

- data engineer, senior data engineer
- analytics engineer
- business intelligence engineer, BI engineer, BI analyst
- data analyst, senior data analyst, finance/financial data analyst
- data platform, infrastructure, warehouse, pipeline, automation
- data management, operations, quality, governance
- ETL, ELT, SQL developer, reporting developer

Titles containing `data`, `analyst`, or `analytics` may become leads. This does not qualify the underlying job. Forward Deployed Engineer, Meta, internships, Data Entry, and clearly unrelated jobs remain excluded by Sunny's existing policy.

## Durable Data and Interfaces

The implementation keeps operational data in the User Layer so system updates cannot overwrite it.

### Code root and Data Root

Sunny-specific executables follow the existing `data/tools/` convention in the checkout and import the canonical root-level `path-resolver.mjs`. Every user-layer path is resolved from `getCareerOpsRoot()`, which honors `CAREER_OPS_ROOT`, `CAREER_OPS_DATA_DIR`, `.career-ops-data`, and the repository fallback in that order. This includes `profiles/`, `portals.yml`, `data/`, connector inbox files, receipts, review files, job history, pipeline, and Sheet configuration.

The code root is used only to locate shipped executable dependencies. No implementation may derive user-layer state from `process.cwd()` or a hard-coded repository path. Tests must exercise both the default root and an external Data Root.

### Query configuration

`profiles/sunny-company-discovery.yml` stores source enablement, query families, location scopes, backfill window, retry cooldown, and DOL dataset reference. It contains no credentials.

### Connector ingestion contract

Indeed remains a connector call made by the automation agent; credentials and private session state never enter a local script. The Muse, newgrad-jobs/JobRight, freehire, Himalayas, Jobicy, OpenJobs, Built In, Paylocity, BambooHR, and public ATS owner directories use public or offline collectors. Every source is converted into the same compact lead schema and passed to a local ingestion command through a dated JSON input artifact under `{DATA_ROOT}/data/company-discovery/inbox/`. The ingestion command accepts exactly one `source` and one `scope` per invocation, validates every record, appends only new lead keys, and reports rejected malformed rows.

This boundary lets company resolution run deterministically from saved inputs, makes connector failures replayable without re-querying the service, and prevents connector-specific fields such as Indeed's promotional `sponsored` flag from leaking into H-1B decisions.

### Raw normalized lead ledger

`{DATA_ROOT}/data/sunny-company-leads.tsv` is append-only and records one row per unique source job lead:

```text
source_run_id, discovered_at, source, scope, source_company,
normalized_source_company, job_title, job_location, job_url, posted_at
```

Dedup key: canonical source job URL when available; otherwise `source + normalized company + normalized title + normalized location + posted date`.

Source leads never write to `{DATA_ROOT}/data/sunny-scan-history.tsv`, `Seen Jobs`, the job pipeline, or qualified-job Sheet tabs. A source URL remains evidence for company discovery only. Only an ATS backfill or the normal ATS scan may establish that a job was formally seen by the job pipeline.

### Company-resolution state

`{DATA_ROOT}/data/sunny-company-resolution.tsv` stores the latest state for each normalized lead identity while retaining source evidence:

```text
normalized_lead, preferred_name, first_seen, last_seen, source_count,
status, dol_legal_name, dol_dba, transfer_positions, match_type,
provider, board_identifier, careers_url, board_owner, health_status,
last_attempt_at, next_retry_at, backfill_status, backfill_window_start,
backfill_window_end, backfill_attempted_at, backfill_completed_at,
backfill_error, evidence, reason
```

Allowed statuses:

- `already_tracked`
- `dol_rejected`
- `dol_ambiguous`
- `ats_unresolved`
- `official_careers_only`
- `identity_review`
- `verification_error`
- `accepted`

This is current state, written atomically. The append-only lead ledger preserves history. An unresolved record is retried only when its cooldown expires or new first-party URL/alias evidence arrives.

Allowed `backfill_status` values are `not_applicable`, `pending`, `running`, `retry_error`, `retry_partial`, and `complete`. Acceptance creates an anchored 20-day window ending at `accepted_at` and sets `pending`. A timeout, source error, or partial/truncated board keeps the original window and becomes retryable; it never silently becomes complete. A complete full-board or provider-bounded scan records `backfill_completed_at`. The normal 3-day scan may run while an older backfill remains pending, but it does not replace that pending work.

### Review queue

Ambiguous legal-name/brand/parent relationships are exported to a dated review file under `{DATA_ROOT}/profiles/`. New reviews use `{DATA_ROOT}/profiles/sunny-company-identity-reviews-v2.yml` with `schema_version: 2` and explicitly separate the three identities:

```yaml
schema_version: 2
reviews:
  - source_brand: Example Brand
    dol_legal_name: Example Holdings, Inc.
    dol_dba: Example Brand
    dol_evidence_urls: []
    ats_provider: greenhouse
    board_identifier: example
    board_owner: Example Brand
    careers_url: https://job-boards.greenhouse.io/example
    official_evidence_urls: []
    verdict: accept
    reviewed_at: 2026-09-08
    reason: Human-readable evidence summary
```

The resolver validates source brand to DOL employer, DOL/brand to ATS owner, and ATS URL to the official careers source as separate gates. New non-exact admissions require a v2 review. The existing `sunny-h1b-ats-identity-reviews.yml` remains a read-only legacy input for already-tracked mappings; it is not silently upgraded, and its shorter schema cannot approve a new non-exact company automatically. Automatic jobs never fabricate or approve a review.

### Run receipt

Each discovery run writes a compact JSON receipt containing source counts, new/deduplicated leads, DOL outcomes, ATS outcomes, portal additions, backfill counts, per-source errors, partial/truncated warnings, and timing. Zero additions is trustworthy only when required sources completed and their coverage status is explicit.

## Company Admission Rules

### Stage 1: Existing-company check

Normalize the source brand and compare it with tracked company names, accepted aliases, and ATS board identities. If already covered, mark `already_tracked`. Retain the source job only in the company-lead ledger; do not pre-mark it in job history and do not duplicate the company or board.

### Stage 2: DOL H-1B gate

Match against the national FY2026 Q3 employer/DBA universe with certified or certified-withdrawn `CHANGE_EMPLOYER > 0` positions.

Automatic acceptance is limited to a collision-free exact normalized legal-name or DBA match. A non-exact brand match requires accepted evidence connecting the brand to the filing employer, such as:

- official DBA disclosure;
- official parent/subsidiary statement;
- matching first-party employer domain and address;
- an existing accepted review entry.

Historical LCA role titles affect priority only and never reject the company. Meta is rejected explicitly. PERM and employee count are not gates.

### Stage 3: ATS identity gate

- **Greenhouse, Ashby, Lever:** the live board must publish an owner whose canonical identity matches the accepted company/brand identity.
- **Workday, iCIMS, Paylocity, Paycom, UKG/UltiPro, Dayforce, BambooHR, SmartRecruiters, Gem, and Workable:** use the provider's official owner endpoint, page metadata, or first-job structured hiring-organization data and require an exact accepted DOL/DBA identity.
- **Other ATS providers:** the board must be linked from an official careers page or be covered by an accepted v2 alias review.
- **Custom official careers search:** first-party careers URLs are retained as resolution evidence, but a company without a supported scannable provider remains `official_careers_only` and is not appended to `portals.yml`. Building a persistent bounded websearch collector is a separate future feature.
- **Health:** only live or explicitly partial/truncated boards are admitted. Dead boards are rejected. Transient timeouts remain retryable and are never treated as proof of no jobs.

The board identity is the scanner dedup unit. Multiple legal employers using one corporate board map to the existing entry instead of creating duplicate scans.

### Exact-board backfill selector

Backfill never uses the existing substring-style `scan.mjs --company` selector. A Sunny-specific wrapper receives the canonical `provider + board_identifier`, creates a temporary portals document containing the global Sunny filters and exactly that one verified board, and launches `scan.mjs` with `CAREER_OPS_PORTALS` pointing at the temporary document plus the normal isolated Sunny history/pipeline paths.

A backfill changes to `complete` only when the run receipt corresponds to that exact provider and board identifier and reports a complete provider-bounded scan. A receipt for a similarly named company, another board, a partial/truncated board, or an error cannot complete the target's backfill. The temporary portals document is removed after the receipt has been recorded.

### Sunny scan-run coordination

All commands that invoke `scan.mjs` against Sunny's isolated history use a Sunny-specific serialized scan wrapper. The wrapper acquires `{DATA_ROOT}/data/.sunny-scan-run.lock` before reading pre-run history/run counts, holds it for the complete provider/network scan and the history/pipeline/`scan-runs.tsv` commit, captures the run receipt and exact appended-row range, and releases it only after attribution is durable.

Both exact-board 20-day backfills and the normal noon 3-day scan must use this wrapper. A waiting noon scan never runs concurrently or treats another run's appended rows as its own; it waits for the active scan lock and then starts from the newly committed history snapshot. Backfill workers stop starting new board scans before a configured pre-noon guard window and leave remaining boards `pending` for the next available backfill run. Staggering and the guard window improve timeliness, but the run-level lock is the correctness mechanism.

The lock records run ID, scan kind, start time, and process identity and supports bounded stale-lock recovery only after verifying the recorded process is no longer active. The wrapper's local receipt supplies run attribution without changing the append-only job-history schema.

## Daily Orchestration

Company discovery and job scanning use three independent, staggered automations:

1. **NYC company discovery turn:** Built In NYC, Indeed `New York, NY` within 50 miles, The Muse NYC, newgrad-jobs/JobRight NYC Metro, freehire NYC Metro, then bounded Google resolution for only new DOL-approved NYC leads.
2. **U.S.-remote company discovery turn:** Built In remote, Indeed `remote_only: true`, The Muse U.S. remote, newgrad-jobs/JobRight U.S.-remote, freehire U.S.-remote, Himalayas, Jobicy, then bounded Google resolution for only new DOL-approved remote leads.
3. **Existing noon job-scan turn:** the current 3-day `portals.yml` scan, downstream gates, scoring, and Sheet update.

The two company-discovery automations are separate replies, use different schedule times, and each covers exactly one location scope. They both call the same location-parameterized company-discovery command. Moving company discovery to weekly changes only those two schedules. The noon job automation remains unchanged except that it consumes any portal entries safely committed before it starts.

Each company-discovery turn performs these steps:

1. Record source scope, pre-run lead counts, portal checksum, and run ID.
2. Collect the scope's Built In, Indeed, The Muse, newgrad-jobs/JobRight, freehire, and scope-appropriate Himalayas/Jobicy leads, plus refreshed offline ATS-directory candidates when due.
3. Normalize genuinely new source-job leads for the company ledger only.
4. Resolve only new or retry-eligible company identities through the DOL and ATS gates.
5. Build a proposed `portals.yml` in a temporary file in the same filesystem.
6. Run the canonical portal validator against the staged file before touching the live file.
7. Acquire the shared company-expansion lock, compare the live checksum with the pre-run checksum, and atomically rename the staged file only when the compare-and-swap check succeeds. A changed checksum aborts the commit and reruns the merge from current live state; it never overwrites concurrent work.
8. Under the same shared state lock, reread current lead and resolution state, merge the run's changes without replacing unrelated identities, append only still-new lead keys, persist resolution/backfill transitions, and release the lock.
9. Run or resume anchored 20-day backfills for newly accepted and retry-eligible boards through the serialized Sunny scan wrapper. Do not start another board inside the configured pre-noon guard window.
10. Emit a run summary separating source health, DOL/ATS outcomes, portal additions, and backfill state.

The company-expansion lock has an owner/run ID and bounded stale-lock recovery. It serializes commits to the lead ledger, resolution state, backfill state, and `portals.yml`; connector and network work occurs outside it. Every commit rereads the latest files under lock and merges by lead key and normalized identity, so a slow NYC turn cannot overwrite a newer remote turn. Backfill status updates use the same locked reread/merge/write cycle. Atomic rename prevents partial files; locked merging prevents lost updates. The staggered schedules reduce contention but are not treated as a correctness mechanism.

The company-expansion state lock and Sunny scan-run lock have separate purposes. Resolution may continue while a job scan is running, but no two Sunny ATS scans may overlap. A noon scan waits for an already-running backfill; it is never skipped and never uses line-count deltas from another run.

## Failure Handling

- Source errors, authentication failures, rate limits, timeouts, and truncation are reported independently.
- One source failure does not block other company sources or the existing daily job scan.
- DOL ambiguity fails closed into `identity_review`.
- Wrong-owner ATS boards fail closed and are never written.
- A board HTTP timeout becomes `verification_error` with cooldown, not `dead`.
- Partial/truncated boards remain visible in receipts and scan warnings.
- Every file write is atomic. Portal changes are staged, validated, and compare-and-swap committed under a shared lock. They are idempotent by normalized company plus provider board identity.
- Lead-ledger, resolution, and backfill updates are reread and merged under that same lock; atomic rename alone is not considered sufficient concurrency control.
- Exact-board backfills and the noon scan are serialized from dedup snapshot through receipt commit by the shared Sunny scan-run lock.
- A Sheet failure leaves a local payload/receipt available for retry and does not roll back valid company admission.
- A zero-company or zero-job result never hides source failures.

## Backfill and Dedup Semantics

- Initial implementation uses source mode `backfill`: freehire walks bounded first-party ATS result pages, Himalayas walks bounded query pages, Jobicy requests its current U.S.-data feed, Built In uses bounded historical pagination, and Indeed is retained with an explicit date-coverage limitation. Daily runs use source mode `incremental`; public owner-directory successes are cached for 30 days and failures use a cooldown so a daily company run does not re-crawl the full universe.
- Each newly admitted company receives an anchored 20-day ATS backfill. Error or partial results remain retryable against that same window until complete.
- Existing companies remain on the 3-day overlapping scan.
- Only ATS backfill and normal ATS scans write `{DATA_ROOT}/data/sunny-scan-history.tsv` and `Seen Jobs`; source discovery never does. Those two scanner paths share history, so the same ATS job cannot appear twice.
- Company-lead dedup and job dedup are separate. A repeated source lead can update `last_seen` and evidence without marking the underlying job seen or duplicating the company.

## Testing Strategy

### Unit tests

- Lead normalization and deterministic lead keys.
- Exact legal-name and DBA DOL joins.
- Collision and ambiguous-alias rejection.
- Accepted manual alias review.
- Provider board-identity dedup.
- Cooldown and new-evidence retry behavior.
- Anchored backfill state transitions and retry of error/partial boards.
- Exact `provider + board_identifier` backfill selection, including collision fixtures such as Clear versus Clear Street/ClearView/Clearwater.
- Atomic state rendering and deterministic reruns.
- Default-root and external-Data-Root path resolution.
- Concurrent NYC/remote state commits retain both scopes' lead and resolution updates.
- Concurrent backfill/noon attempts serialize cleanly, produce disjoint appended-row ranges, and attribute each receipt to the correct run.

### Provider and contract tests

- Greenhouse/Ashby/Lever published-owner mismatch is rejected.
- Workday/other ATS without first-party linkage is withheld.
- Live, live-empty, partial, transient, and dead states remain distinct.
- Existing tracked boards are never appended twice.
- Portal validator failure prevents a batch from being retained.
- A concurrent portal checksum change aborts or safely rebases the staged merge.
- A receipt for a similarly named board cannot complete another board's backfill.
- A noon scan started during a backfill waits, rereads the committed history snapshot, and does not duplicate or claim the backfill's rows.
- An official careers URL without a supported provider remains `official_careers_only` and is not appended.
- Source lead ingestion cannot write Sunny job history or Seen Jobs.
- A v2 review must prove source-brand, DOL-employer, and ATS-owner gates separately.

### End-to-end fixtures

- One known tracked company lead becomes `already_tracked`.
- One exact DOL + exact owner company is accepted once and is idempotent on rerun.
- One parent/brand mismatch enters `identity_review`.
- One explicit no-sponsorship JD is rejected by the downstream job gate.
- One NYC Metro role and one fully U.S.-remote role reach downstream scoring.
- The supplied CLEAR Greenhouse URL is used as a real-world lead fixture: it must be recognized as a Greenhouse board/job, deduplicated if already tracked, and admitted only if its DOL/legal-brand evidence passes the same rules as every other company.

## Observability and Success Criteria

The first run is successful when:

1. All configured company sources have explicit success, zero, partial, or error states.
2. NYC and remote leads are independently counted.
3. Every new company has an auditable terminal or deferred status.
4. No company reaches `portals.yml` without DOL and ATS identity evidence.
5. The second identical resolution run adds zero duplicate portal entries.
6. Newly admitted companies receive an anchored 20-day backfill without duplicating Sunny's prior history; incomplete backfills remain visibly retryable.
7. The existing 3-day scan and Sheet workflow still run even if company discovery partially fails.
8. The portal validator and targeted tests pass.

Coverage reporting must distinguish:

- source job leads;
- unique employer brands;
- DOL-accepted identities;
- verified ATS boards;
- new portal entries;
- companies already covered;
- unresolved/ambiguous/error states.

No single count is described as “companies covered” without naming its denominator.

## Rollout

1. Implement deterministic files, Data Root handling, shared state locking, run-level Sunny scan serialization, exact-board backfill selection, and local-source processing first.
2. Add connector-output ingestion for Indeed and public collectors for The Muse, freehire, Himalayas, Jobicy, OpenJobs, BambooHR, and Paylocity directories.
3. Run a dry-run backfill and inspect all proposed portal writes.
4. Run the identity-safe staged write, validate, and rerun for idempotency.
5. Backfill new companies for 20 days and verify retry state for forced error/partial fixtures.
6. Run the normal 3-day job scan and verify downstream artifacts.
7. Create separate, staggered NYC and U.S.-remote company-discovery automations. Keep the noon job automation separate.
8. After observing daily cost and yield, change only the two company-discovery schedules to weekly if desired.
