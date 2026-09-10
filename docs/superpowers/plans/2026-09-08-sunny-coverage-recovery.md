# Sunny coverage recovery and expansion

**Goal:** Increase measured, identity-verified NYC Metro / NY-eligible US remote coverage without losing already-discovered jobs. A nominal 3,500-board target is a milestone, not an estimate of the market or proof of completeness.

**Architecture:** Keep company discovery separate from job processing. Build a reproducible coverage-gap queue from existing portals, provider routing, health receipts and DOL resolution records. Repair existing coverage first, then resolve new employers in bounded daily batches. Persist scan candidates independently of scan-history dedup so morning backfills, partial runs and Sheet failures survive until a verified disposition.

**Tech stack:** Existing Node ESM, `node:test`, `js-yaml`, provider registry, Sunny state/scan locks, official DOL disclosure data and existing Codex automations. User-specific tooling stays under `data/tools`; policy stays in the user layer. Do not replace user data or auto-accept ambiguous aliases.

## Guardrails and measurement

- Keep Meta/FDE exclusions, NYC Metro/US remote eligibility and explicit no-sponsorship hard gate. No employer-size or PERM gate.
- A historical H-1B record is evidence, not a promise to transfer for the current job.
- Count portal rows, unique employers, unique ATS boards, routable boards and recently successful boards separately. Never describe `no-provider`, untested or partial boards as complete coverage.
- Broad historical LCA titles rank discovery; they never exclude an employer.
- Preserve ATS posting date, source publication date and observation timestamp separately. First seen is not publication; dates that cannot be reconciled remain review items.
- New company/board additions must retain DOL evidence, official owner/link evidence and an exact board key. Existing user changes remain untouched.

## First execution tranche — repair and make gaps actionable

### 1. Reproducible coverage baseline and priority queue

Files: `data/tools/audit-sunny-coverage.mjs`, `tests/sunny-coverage.test.mjs`; outputs in `data/company-discovery/coverage/`.

- [x] Test routing counts against real provider resolution, duplicate boards, unknown providers, legal/brand ambiguity, and latest health observations.
- [x] Build an offline audit using the same provider registry as the scanner. Include unresolved/revalidation Metro employers and current source observations/errors; retain distinct denominators.
- [x] Generate deterministic repair/discovery queues: ATS errors/partials, no-provider, Metro unresolved, broader national discovery. Dedupe by exact board or legal identity, not loose substring. Preserve unbound scan warning text for review.
- [x] Run the audit against current data and record measured counts. Baseline file is not a claim of live health.

Verify: `node --test tests/sunny-coverage.test.mjs`; `node data/tools/audit-sunny-coverage.mjs --write`.

### 2. Durable scan-to-evaluation handoff

Files: `data/tools/sunny-job-queue.mjs`, `data/tools/run-sunny-serialized-scan.mjs`, related tests.

- [x] Regression: morning 20-day backfill candidate survives a noon scan that adds zero URLs.
- [x] Append idempotent pending work from scan receipts, retaining original scan kind/window and history metadata. Do not mark a URL processed merely because it is in scan history.
- [x] Expose pending / reconcile receipts / mark disposition CLI operations; serialize and atomically persist mutations.
- [x] A Sheet-upload disposition needs a verified Sheet reference; a rejection needs a reason. Failed work remains pending. Caller must read back date tab and Master before marking publication.
- [x] Correct error/partial precedence and reject missing or malformed receipts as successful completion. Skipped boards also prevent a complete verdict.
- [x] Reconcile existing exact-board receipts and inspect pending work; do not blindly replay all historic applications. Six legacy candidates await verification of existing dispositions, not automatic re-publication.

Verify: `node --test tests/sunny-job-queue.test.mjs tests/sunny-serialized-scan.test.mjs`.

### 3. Preserve discovery identity and source evidence

Files: `data/tools/sunny-company-leads.mjs`, `tests/sunny-company-leads.test.mjs`.

- [x] Regression: `gh_jid` / provider requisition identifiers are not removed as tracking parameters.
- [x] Keep source observations across scopes; preserve raw date/provenance separately from an explicit source calendar date. Migrate the old TSV header without losing the 1,846 existing rows.
- [x] Aggregator date alone does not bypass an older authoritative ATS date. Missing/relative dates are retained as unresolved, not invented freshness. The broader reconciled aggregator-to-ATS fallback remains task 7, not enabled here.

Verify: `node --test tests/sunny-company-leads.test.mjs`.

### 4. Apply bounded repairs and wire existing daily jobs

Files: `modes/_custom.md`, `profiles/sunny-company-discovery.yml`; existing automations `sunny-nyc`, `sunny-remote`, `sunny-24`.

- [x] Review a bounded first batch using official careers links. Probed all 41 recent failed boards; repaired Trexquant; kept Squarepoint/LinkedIn/Jane Street follow-ups in review with evidence and cooldowns.
- [x] Company jobs consume a bounded priority queue in addition to source-led discovery. Each failure is isolated; unresolved does not mean no H-1B sponsorship.
- [x] Noon job is configured to drain durable pending work from all scan runs, using each job's original 3-day/20-day window. It must not limit processing to rows appended at noon. Prompt persistence verified; the next scheduled end-to-end Sheet run has not yet occurred.
- [x] Persist counters and pending blockers so future runs continue the queue instead of restarting broad Google searches. Each attempt retains audit history; round-robin batches avoid discovery starvation.
- [x] Validate portals and rerun focused Sunny regression suite. Record actual additions, remaining queue and verified Sheet outcomes separately.

Verify: `node validate-portals.mjs --summary` if supported; otherwise the repository's documented portal validator. Read back all changed automation fields. No new applications/messages.

## Subsequent tranches — dependencies and honest completion gates

### 5. Rolling H-1B evidence, not a single-quarter exclusion

- [x] Inventory official DOL releases for the latest eight available fiscal quarters. Record release URL, fiscal coverage, checksum and ingestion timestamp; do not invent unavailable quarters.
- [x] Implement case-number dedup across cumulative releases. Keep legal name and DBA as separate identifiers, never sum the same case twice.
- [x] Tier A = current disclosure evidence; Tier B = prior-window positive `CHANGE_EMPLOYER`, with explicit vintage; unknown remains review. Include H-1B and approved statuses consistently. Neither tier promises current sponsorship.
- [x] Diff against the current-Q3 universe; separately list employers recovered by history. Revalidate official ATS identity before portal writes.
- [x] Test overlapping quarterly/final disclosures, duplicates, withdrawals and multiple legal entities. Active v2 index is bound to its manifest, eight observed/declared quarters, row count and pinned SHA-256. Original incomplete three-file trial is not eligible for admission.

### 6. One employer may have multiple valid ATS boards

- [x] Replace strongest-board-only discovery with a many-to-many employer/brand/board inventory; migrate existing state without losing anchored backfills. All 860 pre-migration records preserved; legacy unsafe `--append` disabled.
- [x] Verify each board independently, including subsidiaries and regional boards. Reuse the job-level canonical dedup, not an employer-level suppression. Exact legal/board holds override matching brand names; preserve verified evidence during later source refreshes.
- [x] Regression: two verified boards under one employer both scan; same board via two aliases scans once; unrelated brand collisions never auto-merge. Concurrent portal commits, in-flight aliases and stale backfill updates covered.

### 7. Provider expansion and source freshness

- [x] Rank unsupported entries by observed Metro transfer volume before choosing adapters. Current priority starts Goldman Sachs (788), Morgan Stanley (494), Google (456), LinkedIn (179), TT Commerce/TikTok (120). These are historical positions, not open jobs; unknown vendor stays unknown until official resolution.
- [x] First adapter tranche: Workable multi-location/remote/dedup repaired and live-scanned; Avature branded result classes, actual 6/10-row pagination, invalid dates and explicit truncation repaired. Deloitte official two-page check returns 20 unique rows; missing dates/locations remain unknown, so this does not admit Deloitte or prove whole-board completion.
- [x] Source-health records distinguish all six source/scope combinations, observed jobs/companies and failures. Daily prompts require per-query counts, observed results and sampling method; absent historic query counts are not invented.
- [x] Add read-only aggregator-to-ATS identity/date reconciliation with conflict precedence and explicit direct-job verification; tested against same req ID/different URL, unknown dates, first-seen and reposts. It is diagnostic only: source-only jobs cannot bypass the authoritative ATS publication gate.
- [ ] Continue custom-provider / official-domain resolutions from the ranked daily queue. After the third tranche's two admissions, 343 no-provider rows and 41 earlier scan failures remain; Morgan's separately discovered pagination partial must be resolved before treating its window as complete.
- [ ] Independently sample date ordering / pinned-old-posting behavior on other Workday tenants. Morgan's explicit bounded-pagination opt-out is not a claim that the existing newest-first heuristic is sound globally.

### 8. Coverage acceptance and ongoing expansion

- [x] Initial independent NYC sample (10 source observations) labelled through DOL, board, health, history/date and unknown disposition; saved JSON/MD. Monday per-scope sampling is configured within existing company jobs, not a duplicate automation.
- [x] Separate metrics published: sample board coverage 7/10, 3 unresolved H-1B identities; strict exact-name DOL filing-volume linkage lower bound 28,578 / 298,425 (9.5763%) on the pre-expansion snapshot. Neither is actual eligible-job recall or market completeness; inferred aliases and unverified Sheet disposition are excluded/unknown.
- [ ] Operational acceptance: next Remote labelled sample, repeated weekly observations, exact job identity and Sheet disposition checks. The current ten-row sample cannot establish market recall.
- [ ] Ongoing milestone: toward 3,500 verified routable boards and fewer than 100 no-provider entries, only where evidence supports useful additions. Not reached; stop using numeric targets if they reward irrelevant firms or duplicate boards.
- [x] Company cadence remains daily until the user changes it; job scanning remains noon, last 3 days, shared dedup.

## Execution record

2026-09-08: plan authorized by the user. First tranche begins in the existing Sunny feature branch; no merge/push, destructive reset, mass re-scoring or unverified company admission. Tasks above are unchecked until supported by test results or run receipts. Subsequent tranches are explicitly not claimed complete by creating this plan.

2026-09-09: first execution tranche implemented. Snapshot: 2,000 portal rows, 1,649 unique routable boards (up from 1,648), 345 no-provider rows (down from 346), plus two existing shared Amazon query boards. One existing employer repaired; zero newly discovered employers admitted in this tranche. Trexquant's official widget has 48 location rows / 33 unique job URLs; the 20-day repaired-board backfill added zero candidates. Workable duplicate merging now preserves all disclosed cities and remote flags.

Live diagnostics: 41 previously failed boards probed with a one-page hint; 28 returned a response (including one empty board), 13 still failed. None is declared a complete full scan from that probe. All 41 attempts and four separate official-careers investigations are durably recorded. Original scan-health failures remain distinguishable from probe observations.

Verification: focused regression suite 41 passed / 0 failed; full `test-all.mjs` run 8,709 passed / 0 failed / 16 warnings; portals validator 0 errors / 0 warnings. A final independent review is pending at the time of this entry. No merge or push performed.

Automation read-back: `sunny-nyc` 09:00 daily and `sunny-remote` 10:00 daily retain gpt-5.6-terra / medium; each gets at most 12 coverage gaps per run, not a promise of 12 admissions. `sunny-24` retains the noon heartbeat and now consumes the shared pending queue. Model/time/kind/target fields preserved. The next scheduled end-to-end run, including Sheet verification, remains an operational acceptance check.

Task 5 preparation only: official annual/cumulative FY2024 Q4, FY2025 Q4 and FY2026 Q3 source URLs inventoried. Historical files passed ranged-GET XLSX signature checks despite HEAD returning 403. Existing FY2026 Q3 local archive SHA-256 recorded. Historical files are **not yet ingested**, eight-quarter case dedup is **not yet implemented**, and current admission still uses the existing FY2026 Q3 gate. Tasks 5–8 remain open; do not infer completion from the first-tranche checkmarks.

### Second tranche — completed after the preparation record above

2026-09-09 05:21 UTC: six official disclosure files cover FY2024 Q4 through FY2026 Q3. Actual observed dates showed that historical Q4 files were quarter-only, not annual despite the generic layout description; added FY2025 Q1/Q2/Q3 before activating the v2 build. 1,154,945 observations → 1,141,022 case IDs → 191,706 eligible cases → 34,384 exact legal/DBA groups (17,495 current-disclosure tier A; 16,889 historical-only tier B). 5,007 groups have a disclosed NY-state first worksite, not necessarily NYC Metro or a current open role. Source checksums, rejected cases and full case provenance are retained; SQLite quick_check is OK.

All-dataset offline match: 3,029 ATS hints, including 432 ambiguous identities and 1,057 already-tracked boards (categories overlap). No automatic admission from this match. Two bounded live/owner-verification batches processed 200 untracked owner-provider hints: 62 accepted and added, 116 verification errors, 18 identity-review outcomes, 4 DOL ambiguities. Known Warp payroll/terminal identity conflict was held rather than admitted. These 62 newly configured name keys increase portal rows from 2,000 to 2,062 and unique routable boards to 1,711, including the earlier Trexquant repair (+63 from the original 1,648). No-provider remains 345.

All 62 newly admitted boards completed anchored 2026-08-21–2026-09-09 backfills: 1,545 postings found, 1,538 filtered, 7 candidate URLs added, 0 errors/partials/skips. These are unscored candidates, NOT seven qualified jobs. The durable queue now has 13 pending items (6 legacy + 7 new); no new qualified Sheet rows were written in this turn. Noon must apply the normal hard gates, score, deduplicate against verified prior decisions and read back Sheet writes before final disposition.

Bounded offline probing (12 boards/scope/day) and weekly sample labelling were added to the two existing company jobs. Fresh read-back confirms prompt, model, reasoning, time, kind and target fields. The primary scan remains noon, independent of company cadence. Review passes obtained for core coverage/queue, historical ingestion, multiboard state, probe safety, read-only source reconciliation and final Avature fixes. Final focused regression: 124/124 Node tests; H-1B Python tests 31/31; portals validator 0 errors/0 warnings. Post-review full `test-all.mjs`: 8,721 passed, 0 failed, 16 warnings (Go/dashboard unavailable, upstream-author string checks, opt-in external API/mint tests skipped); log `/tmp/sunny-coverage-post-review.g6SwKG`. No merge or push.

Remaining work is explicitly operational/incremental: unresolved legal aliases and private/custom ATS, the 345 unsupported entries and 41 unhealthy boards, Remote/weekly sample validation, and actual scoring/Sheet disposition of pending work. No claim of 3,500 boards or near-100% coverage is made.

### Third tranche — official ATS repair and a discovered pagination defect

2026-09-09 08:10 UTC: Goldman Sachs and Morgan Stanley existing unsupported entries were repaired after separate official-evidence, spec and code-quality reviews. Goldman uses Oracle `hdpc.fa.us2.oraclecloud.com|LateralHiring|`, with exact `GOLDMAN SACHS SERVICES LLC` DOL evidence plus the Federal Reserve-published staffing-subsidiary relationship. Morgan uses Workday `ms|wd5|External`, with the exact `Morgan Stanley` DOL record (one positive transfer position, not a sum of subsidiaries). These are two repairs, not two new company rows. Accepted review details and staged/CAS repair receipts are saved.

Scoped Eightfold/Oracle board identity now follows provider API precedence and explicit domain/site/location overrides, preserves scope case and empty coordinates, and round-trips through state, portal admission and repair. A review found a contradictory-alias bypass; six RED→GREEN tests and authoritative review/candidate field projection close it. Final scoped suite: 25/25; combined focused suite: 88/88; full harness: 8,723 passed, 0 failed, 16 existing/environment warnings (`/tmp/sunny-scoped-identity-tests.FTcDiW`). This verification precedes the pagination fix below.

The initial 20-day run found Goldman 1,304 / filtered 1,294 / added 10 unscored candidates. Morgan returned only 20 and was incorrectly marked complete by the existing date early-stop heuristic. Direct public CXS probes at offsets 0/20/40 prove that page 0 has exact dated old jobs (20–30 days), but later pages contain Today/Yesterday jobs. The first total was 1,294 at probe time; the previous 1,295 was a live earlier observation, not a stable inventory. Therefore the Morgan zero-add result is not accepted as complete coverage.

#### Bounded date-order repair — implementation and acceptance

This implements the already-approved provider/pagination repair requirement. Options considered: globally disable Workday early-stop (unnecessary all-board traffic); infer global ordering from one or two pages (cannot prove unseen pages); or explicitly opt the observed affected board into bounded full pagination. Use the third option. Other boards retain their existing behavior and remain subject to independent coverage audits; this is not a global proof of reliable Workday ordering.

Files: `providers/workday.mjs`, `providers/_types.js`, `tests/providers/workday-date-order.test.mjs`, and the Morgan Stanley user-layer portal entry. Keep edits narrowly scoped, no commits/push or unrelated refactoring.

- [x] Add fixture-first regression with 20 page-0 jobs including an old dated job and 20 page-1 jobs including a fresh job. With `date_early_stop: false`, both pages must be fetched; default behavior remains covered. Run `node --test tests/providers/workday-date-order.test.mjs` and confirm RED before implementation.
- [x] In the Workday provider only, set its local early-stop threshold to `null` when `entry.date_early_stop === false`; otherwise preserve the existing `ctx.sinceMs` handling. Document this optional boolean in the provider and `PortalEntry` type. This does not change scanner-level posting-date eligibility, derive publication dates, or disable caps/retries/warnings. Include first-page-undated/later-page-dated and max-pages/fetch-error regression cases.
- [x] Run the new suite and existing Workday contracts. Obtain independent spec review, then code-quality review before live use. Do not assume the earlier scoped-identity review covers this new fix.
- [x] Preserve the original Morgan scan payload; annotate its wrapper completion as a reviewed partial with evidence. Restore only that exact board to `retry_partial`, preserving 2026-08-21..2026-09-09. Do not delete history or reopen unrelated completed jobs.
- [x] Add `date_early_stop: false` only to Morgan Stanley using a staged, validated YAML edit with checksum/CAS under the existing company-state lock. Run the serialized pending backfill once; only Morgan is eligible. The provider must reach all current advertised pages, or emit an honest partial/error with its anchored retry intact.
- [x] Verify fresh exact-board receipt, dedup/queue delta and coverage audit; report machine counts separately from unscored candidates. No scoring, Sheet publication or applications in this company turn. Update the execution record with the actual outcome.

2026-09-09 08:26 UTC: Morgan-only retry after independent spec/quality PASS found 1,294 / filtered 1,251 / duplicate 2 / added 41, with zero errors/warnings/skips. Public boundary checks: offset 0 reports 1,294 with 20 rows, offset 1,280 returns 14, and offset 1,300 repeats the first 20 rather than returning empty. The finite scan count agrees with reported total and tail; 65 pages is an inference from page size, not a claim of a second full manual crawl. Original partial wrapper and untouched scanner payload remain distinguishable from the successful retry.

Combined Goldman/Morgan valid runs add 51 unscored candidates: 28 have window-date data, 23 are undated and must not qualify without authoritative resolution. Total queue is 64 pending; history is 2,700 lines; no pending/retry/running backfills remain. Final audit: 2,062 enabled portal rows, 2,060 configured name keys, 1,713 unique routable boards, 343 no-provider rows, and 41 earlier scan failures. No new company names were added in this repair tranche. Source-only observations, DOL subsidiaries and gap records still are not interchangeable company counts.

Fresh final full harness: 8,725 passed / 0 failed / 16 existing/environment warnings (`/tmp/sunny-workday-order-tests.or75Lk`). New Workday ordering tests 14/14, with health 18/18; existing Workday/facet assertions 122/0/0. Portal validation and diff whitespace checks pass. No score, Sheet write, application, merge or push occurred. The still-unchecked broader coverage and Workday-ordering audit tasks remain open.
