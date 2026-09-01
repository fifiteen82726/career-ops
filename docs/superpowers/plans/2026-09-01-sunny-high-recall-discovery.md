# Sunny High-Recall Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Sunny's narrow 500-company/exact-title daily scan with an all-title H-1B-transfer company universe, high-recall title discovery, three-day overlapping scans, reliable run reporting, and a deduplicated 20-day backfill.

**Architecture:** Keep discovery deterministic and zero-token: derive legal employers from DOL, exact/alias-match them to cached public ATS boards, verify live boards, and filter titles/locations/dates locally. Send only surviving candidates to Terra for JD-to-resume semantic qualification and Sheet output. Preserve user personalization in user-layer files and keep the recurring automation as the workflow orchestrator.

**Tech Stack:** Node.js ESM, `js-yaml`, career-ops provider APIs, bundled Python/pandas for read-only DOL XLSX extraction, TSV/Markdown user-layer artifacts, Codex automation, Google Sheets connector.

---

### Task 1: High-recall title discovery

**Files:**
- Create: `tests/sunny-high-recall-title-filter.test.mjs`
- Modify: `portals.yml:4-42`
- Modify: `profiles/sunny-search-criteria.md:17-34`
- Modify: `modes/_profile.md:3-20`

- [ ] Write a regression test that loads `portals.yml`, builds the real shared title predicate, and asserts that Data Platform/Intelligence/Automation/Analytics/ETL/ELT/BI/SQL variants pass while Forward Deployed, intern, Data Entry, ML/AI/Software Engineer, and Clinical Data variants fail.
- [ ] Run `node --test tests/sunny-high-recall-title-filter.test.mjs` and verify the positive variants fail under the old exact-substring configuration.
- [ ] Replace both `title_filter.positive` and `title_filter_full.positive` with `word:data`, `word:analyst`, `word:analytics`, `word:etl`, `word:elt`, BI-engineer/developer, Business Intelligence/Intelligent, database-engineer, reporting-developer, and SQL-developer discovery expressions. Preserve the existing negatives.
- [ ] Add a documented high-recall discovery layer to Sunny's criteria/profile and state that JD semantic qualification, not title presence, decides final eligibility.
- [ ] Run the regression test, `node validate-portals.mjs`, and `node discover-ats.mjs --self-test`; require zero failures.

### Task 2: All-title H-1B transfer company universe

**Files:**
- Create: `data/tools/build-sunny-h1b-ats-universe.mjs`
- Create: `data/cache/dol/sunny-all-title-h1b-employers-fy2026q3.tsv`
- Create: `data/cache/dol/sunny-all-title-ats-candidates-2026-09-01.tsv`
- Create: `profiles/sunny-all-title-h1b-ats-audit-2026-09-01.md`
- Modify: `portals.yml:tracked_companies`
- Test: `tests/sunny-h1b-ats-universe.test.mjs`

- [ ] Extract certified/certified-withdrawn H-1B rows with `CHANGE_EMPLOYER > 0` from the cached DOL workbook into a compact TSV containing legal employer, DBA, transfer positions, and NY transfer positions.
- [ ] Write a failing universe test proving Datadog is absent from the old target-title table but must match the cached `greenhouse/datadog` board from the all-title employer TSV; also prove ambiguous normalized collisions are not auto-approved.
- [ ] Implement a user-layer builder that normalizes legal names/DBAs and cached ATS identifiers, emits exact/explicit-alias matches with evidence, rejects collisions, and constructs provider-specific careers URLs for Greenhouse, Ashby, Lever, Workday, and only verifiable iCIMS coordinates.
- [ ] Run the test and verify Datadog plus other exact matches enter the candidate universe regardless of historical LCA job title.
- [ ] Live-verify candidate boards with bounded concurrency through career-ops providers; append only live, identity-safe, non-duplicate boards to `portals.yml`, and write unresolved/dead/error rows to the audit artifact.
- [ ] Run `node validate-portals.mjs` and a dry scan; report configured boards, live-empty boards, network errors, and partial/truncated boards.

### Task 3: Three-day daily workflow and reliable reporting

**Files:**
- Modify: `portals.yml:max_posting_age_days`
- Modify: `modes/_custom.md`
- Modify: `profiles/sunny-search-criteria.md`
- Update automation: `sunny-24`

- [ ] Set `max_posting_age_days: 20`; document that daily `--since 3` remains stricter while permitting the one-time `--since 20` backfill.
- [ ] Update the custom workflow so the deterministic discovery layer is broad, Terra reads each surviving JD, pure Data Science/model-training/data-center/privacy/legal/sales/recruiting/unrelated analyst roles are excluded, and the two Sunny resumes remain the only factual source.
- [ ] Update automation `sunny-24` without changing its name, noon ET schedule, Terra model, Medium reasoning, project, Sheet schema, or no-submit/no-contact safety boundary.
- [ ] Change the command to `scan.mjs --since 3`; process only newly appended history rows; read the newly appended `scan-runs.tsv` row by header name; capture partial/truncated warnings from scanner output; use the structured TSV error count when evidence disagrees.
- [ ] View the automation and inspect its saved TOML to verify the full prompt, model, reasoning, schedule, and active status.

### Task 4: Twenty-day backfill and Google Sheet update

**Files:**
- Update: `data/sunny-scan-history.tsv`
- Update: `data/sunny-pipeline.md`
- Update connected Google Sheet from `data/sunny-job-sheet.json`

- [ ] Record pre-run history/run-row counts, then run `scan.mjs --since 20` against the expanded portals configuration while capturing stdout and stderr.
- [ ] Parse only newly appended history rows, deduplicate against existing Seen Jobs URL/Dedup Key, and apply title, NYC Metro/U.S.-remote, DOL legal-entity, explicit no-sponsorship, and JD semantic gates.
- [ ] Score qualified roles against the correct Sunny resume using the existing 100-point rubric; do not invent facts.
- [ ] Create or incrementally update `Backfill 2026-09-01`, append qualified rows to Master, append exclusions to Excluded, append all first-seen rows to Seen Jobs, and update Scan Summary with authoritative counters and warnings.
- [ ] Preserve the 13-column qualified schema, ATS hyperlinks, LinkedIn People hyperlinks, referral-message template, native table, date formats, and conditional formatting.
- [ ] Read back the Backfill, Master, Excluded, Seen Jobs, and Scan Summary key ranges; reconcile row counts to the local run evidence.

### Task 5: Final verification

**Files:**
- Verify all modified user-layer files and automation state.

- [ ] Run the focused title and company-universe tests, `node validate-portals.mjs`, `node discover-ats.mjs --self-test`, and `git diff --check`.
- [ ] Confirm Datadog and Weights & Biases no longer fail at their previous discovery layer; classify Harvey/Oscar/SentiLink/Bloomberg examples by current ATS date/location/JD outcomes.
- [ ] Report final tracked/live board counts, newly added companies, ATS errors, partial boards, 20-day raw/new/qualified/excluded counts, top-scored jobs, and the Google Sheet link.
