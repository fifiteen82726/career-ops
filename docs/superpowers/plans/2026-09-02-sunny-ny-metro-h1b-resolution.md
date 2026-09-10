# Sunny NY / NYC Metro H-1B Company Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every FY2026 Q3 New York H-1B `CHANGE_EMPLOYER` identity, add the practical NYC Metropolitan NJ/CT worksite identities, and admit as many identity-safe, live ATS boards as possible to Sunny's tracked-company pool.

**Architecture:** Preserve two geographic signals in one compact employer universe: all New York State change-employer evidence and Sunny's narrower practical NYC Metro worksite allowlist. Reuse the existing public ATS caches for collision-safe exact legal-name/DBA matches, then run checkpointed slug-vendor discovery only for unresolved identities; every company ends in a durable resolved, already-tracked, ambiguous, unresolved, or error state.

**Tech Stack:** Bundled Python/pandas for the cached DOL XLSX extraction, Node.js ESM and `js-yaml` for ATS identity matching/discovery, TSV/YAML/JSONL user-layer artifacts, career-ops provider APIs.

---

### Task 1: Geographic employer universe

**Files:**
- Create: `data/tools/sunny_ny_metro_h1b.py`
- Create: `tests/test_sunny_ny_metro_h1b.py`
- Generate: `data/cache/dol/sunny-ny-metro-h1b-employers-fy2026q3.tsv`

- [ ] Write tests proving New York City, Jersey City, Newark, Hoboken, Secaucus, Weehawken, Fort Lee, Yonkers, White Plains, and Stamford are practical Metro worksites; Buffalo remains NY State but not Metro; Trenton and Hartford are neither.
- [ ] Run the focused Python test and verify it fails because the extractor module does not exist.
- [ ] Implement pure worksite classification and employer/DBA aggregation helpers plus a CLI that reads the cached DOL XLSX and writes one row per employer/DBA with total, NY State, and practical Metro transfer-position counts and observed Metro locations.
- [ ] Run the focused test and generate the full TSV; reconcile NY State normalized identities against the existing 2,359 count and report any source-definition difference.

### Task 2: Resolution-state builder

**Files:**
- Create: `data/tools/build-sunny-ny-metro-resolution.mjs`
- Create: `tests/sunny-ny-metro-resolution.test.mjs`
- Generate: `profiles/sunny-ny-metro-h1b-seeds.yml`
- Generate: `data/cache/dol/sunny-ny-metro-resolution-2026-09-02.tsv`

- [ ] Write tests proving the builder retains both geographic flags, excludes Meta, deduplicates normalized legal/DBA identities, recognizes existing tracked ATS identities, and emits unresolved seeds without losing DOL evidence.
- [ ] Run the Node test and verify the missing module/API failure.
- [ ] Implement the pure resolution-state join over the Metro employer TSV, `portals.yml`, and refreshed public ATS caches/audit.
- [ ] Generate the seed YAML and baseline resolution TSV with one terminal/current state per identity.

### Task 3: Checkpointed live ATS discovery

**Files:**
- Create: `data/tools/run-sunny-ny-metro-discovery.mjs`
- Create: `tests/sunny-ny-metro-discovery.test.mjs`
- Generate/update: `data/cache/dol/sunny-ny-metro-discovery.jsonl`
- Modify: `portals.yml`

- [ ] Write tests for deterministic batching, resume-from-JSONL, duplicate suppression, and preservation of unresolved/error records.
- [ ] Run the Node test and verify the missing implementation failure.
- [ ] Implement a wrapper around the existing provider resolution functions with bounded concurrency and append-only JSONL checkpoints.
- [ ] Preview all newly resolved boards; require current DOL evidence, collision-safe identity, and at least one live ATS job.
- [ ] Append the verified preview set to `portals.yml`, preserving existing comments and idempotent board/name deduplication.

### Task 4: Unsupported and alias gaps

**Files:**
- Update: `data/cache/dol/sunny-ny-metro-resolution-2026-09-02.tsv`
- Update: `profiles/sunny-h1b-company-coverage-audit-2026-09-02.md`
- Modify: `portals.yml`

- [ ] Rank unresolved identities by Metro transfer positions, then total transfer positions.
- [ ] Resolve official domains, DBA/parent aliases, Workday coordinates, and supported non-directory providers from official careers pages; use `websearch` only when no supported public provider exists.
- [ ] Record ambiguous ownership and dead/empty boards instead of adding unsafe matches.
- [ ] Re-run until every input identity has a durable resolution state and no unprocessed rows remain.

### Task 5: Completion verification

**Files:**
- Verify all generated artifacts and `portals.yml`.

- [ ] Run both focused Python/Node test suites, `node validate-portals.mjs`, `node discover-ats.mjs --self-test`, and `git diff --check`.
- [ ] Reconcile input identity count to the sum of resolved, already-tracked, websearch, ambiguous, unresolved, and error states.
- [ ] Dry-run the expanded company pool and report successful, empty, error, and partial-board counts without claiming unresolved companies are covered.
- [ ] Update the dated audit with exact NY State, practical Metro, live ATS, added, and unresolved counts.
