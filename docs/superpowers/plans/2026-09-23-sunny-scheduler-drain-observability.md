# Sunny Scheduler Drain and Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Sunny daily runs resumable and visibly terminal, repair queue identities, enforce per-batch closeout, and then drain the current backlog with truthful exception reporting.

**Architecture:** Add a lock-protected run-state controller around the existing normal-first planner. Keep semantic candidate evaluation and Sheet operations in the existing workflow, but require evidence-bearing batch checkpoints before advancing. Normalize canonical identities at reconciliation boundaries and update the heartbeat prompt to loop on the controller contract.

**Tech Stack:** Node.js ESM, `node:test`, JSON user-state files, existing pipeline locks, Codex heartbeat automation, Google Sheets connector/browser workflow, existing Sunny queue/exception scripts.

---

## Baseline and constraints

- Repository: `/Users/coda/Documents/ChatGPT/career-ops`
- Initial implementation baseline HEAD: record immediately before Terra starts; preserve `.gitignore`, the existing modified `data/sunny-linkedin-company-map.tsv`, and all unrelated untracked files.
- Current evidence: 522 `pending`, 13 canonical candidate exceptions stored as 14 rows, and 28 source exceptions.
- Functional correctness is the review priority. Cosmetic and extra security hardening are non-blocking.
- Do not update career-ops system version, apply jobs, contact people, or redesign scoring.
- All production changes use TDD. Do not stage unrelated user changes.

### Task 1: Canonical URL and exception-key reconciliation

**Files:**
- Modify: `data/tools/sunny-company-leads.mjs`
- Modify: `data/tools/sunny-job-queue.mjs`
- Modify: `data/tools/sunny-exception-store.mjs`
- Modify: `data/tools/sunny-scan-exception-queue.mjs`
- Test: `tests/sunny-company-leads.test.mjs`
- Test: `tests/sunny-job-queue.test.mjs`
- Test: `tests/sunny-exception-store.test.mjs`
- Test: `tests/sunny-scan-exception-queue.test.mjs`

- [ ] **Step 1: Add failing URL identity tests**

Add assertions that `canonicalLeadUrl()` returns the same value for `%7C` and `%7c`, and that reconciling two queue rows differing only by percent-escape case produces one row with the union of sources. Add a conflicting-terminal test that must throw instead of guessing.

- [ ] **Step 2: Run the URL/queue tests and verify RED**

Run: `node --test tests/sunny-company-leads.test.mjs tests/sunny-job-queue.test.mjs`

Expected: the percent-escape identity assertion and reconciliation API tests fail because normalization/reconciliation do not exist.

- [ ] **Step 3: Implement URL and job-queue reconciliation**

Uppercase serialized `%xx` escapes in `canonicalLeadUrl()`. Export a lock-protected `reconcileJobQueueIdentities()` that groups by the new canonical URL, unions sources, preserves the most complete fields, merges compatible pending/exception copies, and refuses conflicting terminal outcomes. Canonicalize `exception_key` URL suffixes while merging.

- [ ] **Step 4: Add failing exception/source-key tests**

Test that two candidate exception records whose URL suffix differs only by `%7C/%7c` merge to one item with unique failure timestamps and preserved maximum lifecycle state. Test that the Jibe warning `Costco Wholesale Corporation has more postings than max_pages allows` maps to `source|costcowholesalecorporation|coverage`.

- [ ] **Step 5: Run exception tests and verify RED**

Run: `node --test tests/sunny-exception-store.test.mjs tests/sunny-scan-exception-queue.test.mjs`

Expected: reconciliation and correct Jibe-key assertions fail.

- [ ] **Step 6: Implement exception reconciliation and Jibe parsing**

Add a lock-protected reconciliation export that rebuilds candidate keys from canonical evidence URLs and source keys from stored evidence. Merge only equivalent queue/stage identities, union timestamps, preserve latest evidence, and derive `attempt_count` from unique timestamps without reducing `needs_diagnosis` or `closed`. Parse `jibeapply: <company> has more postings than max_pages` before generic warning parsing.

- [ ] **Step 7: Verify Task 1 GREEN**

Run: `node --test tests/sunny-company-leads.test.mjs tests/sunny-job-queue.test.mjs tests/sunny-exception-store.test.mjs tests/sunny-scan-exception-queue.test.mjs`

Expected: all selected tests pass.

### Task 2: Durable daily-run state controller

**Files:**
- Create: `data/tools/sunny-daily-run-state.mjs`
- Create: `tests/sunny-daily-run-state.test.mjs`
- Modify: `.gitignore` only if the state path is not already covered by a user-data ignore rule; stage only the exact new ignore hunk.

- [ ] **Step 1: Write failing lifecycle tests**

Cover: start a run; resume the same New York calendar day; report current counts; mark partial/failed; reject `complete` while pending work exists; identify stale-running without rewriting it; and report `continue_required` plus `next_action`.

- [ ] **Step 2: Run the controller test and verify RED**

Run: `node --test tests/sunny-daily-run-state.test.mjs`

Expected: module-not-found or missing-export failure.

- [ ] **Step 3: Implement the atomic state store and CLI**

Use the existing pipeline lock and temp-file rename pattern. Export pure status derivation plus lock-protected mutations. CLI commands must include `status [--summary]`, `stop --status partial|failed --reason <text>`, and the internal start/checkpoint functions used by the planner. `complete` must validate zero normal pending, zero due exception work/diagnosis, and no unclosed current batch.

- [ ] **Step 4: Run lifecycle tests and verify GREEN**

Run: `node --test tests/sunny-daily-run-state.test.mjs`

Expected: all tests pass.

### Task 3: Batch checkpoint and closeout gate

**Files:**
- Modify: `data/tools/sunny-daily-run-state.mjs`
- Modify: `tests/sunny-daily-run-state.test.mjs`

- [ ] **Step 1: Add failing batch tests**

Test deterministic batch IDs, idempotent checkpoint replay, refusal to advance while any batch URL is still pending, refusal when any of `excluded`, `seen_jobs`, `scan_summary`, or `local_archive` lacks `updated|not_applicable` evidence, and successful advance when all conditions are met.

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/sunny-daily-run-state.test.mjs`

Expected: batch-closeout tests fail because the API is absent.

- [ ] **Step 3: Implement batch/open/close operations**

Store only bounded current/recent batch metadata. The close command accepts a JSON receipt file so shell escaping does not corrupt references. Validate queue dispositions by canonical URL before accepting closeout. Update per-disposition counters idempotently from the batch snapshot.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test tests/sunny-daily-run-state.test.mjs`

Expected: all controller tests pass.

### Task 4: Integrate the controller with the planner

**Files:**
- Modify: `data/tools/run-sunny-daily-work-plan.mjs`
- Modify: `tests/sunny-daily-work-plan.test.mjs`
- Modify: `data/tools/sunny-routine-runtime.mjs`
- Modify: `tests/sunny-routine-runtime.test.mjs`

- [ ] **Step 1: Add failing planner-contract tests**

Test that the first call scans once and starts a run, a resumed call with `--no-scan` keeps the same run ID, normal work returns before exceptions, an unclosed batch is reissued rather than skipped, and a run cannot be complete while normal pending remains. Test waiting future exceptions separately from due work.

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/sunny-daily-work-plan.test.mjs tests/sunny-routine-runtime.test.mjs`

Expected: new run-state fields and closeout behavior are missing.

- [ ] **Step 3: Integrate normalization and lifecycle state**

Before selecting work, reconcile job and exception identities. Start/resume the run, preserve at-most-one scan receipt ID, open/reissue the current batch, and return `run_id`, `run_status`, `remaining`, `continue_required`, `next_action`, and `batch`. Include the run-state file in checkpoints when it exists without making older data roots invalid.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test tests/sunny-daily-work-plan.test.mjs tests/sunny-routine-runtime.test.mjs`

Expected: all tests pass.

### Task 5: Update the heartbeat contract and user-facing status

**Files:**
- Modify through automation API: automation `sunny-24`
- Test/verify: `/Users/coda/.codex/automations/sunny-24/automation.toml`

- [ ] **Step 1: Save the existing prompt in the approved-execute run directory**

Preserve the full prior TOML as execution evidence; do not add it to the repository.

- [ ] **Step 2: Update only the operational contract**

Keep eligibility, Sheet, and referral rules. Replace the ambiguous fixed-batch instructions with: loop on `continue_required`; checkpoint all four sinks before requesting the next batch; never return with state `running`; on time limit/blocker record `partial` or `failed`; lead every final report with status, processed counts, remaining counts, source partials/errors, and next action. Correct the local archive email check to `yiyunliao21@gmail.com`.

- [ ] **Step 3: Read the automation back and verify exact invariants**

Verify: active schedule/time unchanged; no `yiyunliao0321@gmail.com`; controller/status commands present; fixed batch is a unit of work rather than a terminal condition; terminal report contract present.

### Task 6: Full regression verification and implementation commit

**Files:**
- All files modified in Tasks 1-5.

- [ ] **Step 1: Run focused suites**

Run:

```bash
node --test tests/sunny-company-leads.test.mjs tests/sunny-job-queue.test.mjs tests/sunny-exception-store.test.mjs tests/sunny-scan-exception-queue.test.mjs tests/sunny-daily-run-state.test.mjs tests/sunny-daily-work-plan.test.mjs tests/sunny-routine-runtime.test.mjs tests/sunny-serialized-scan.test.mjs
```

Expected: zero failures.

- [ ] **Step 2: Run local-site regression suites**

Run: `node --test local/sunny-job-search/tests/*.test.mjs`

Expected: zero failures and no regression to archive/index/referral data handling.

- [ ] **Step 3: Inspect diff and state**

Run: `git status --short`, `git diff --check`, and targeted `git diff -- <task files>`. Confirm unrelated existing changes remain unstaged.

- [ ] **Step 4: Commit the implementation**

Stage only the task code/tests/docs and exact `.gitignore` hunk if needed. Commit with: `fix: make Sunny daily runs resumable and observable`.

### Task 7: Independently reviewed one-time recovery drain

**Files/Data:**
- Update operational state under `data/` using existing canonical commands.
- Update the configured Google Sheet and `data/sunny-job-search-archive.json` through the existing workflow.
- Do not commit private queue, Sheet, or referral data.

- [ ] **Step 1: Create and verify a checkpoint**

Run the existing Sunny checkpoint function/command and verify the archive hash before mutating operational queues.

- [ ] **Step 2: Reconcile current identities**

Run the new reconciliation path and verify candidate exception rows change from 14 stored rows to 13 canonical items, with one SIG record retaining both failure timestamps/evidence as applicable. Verify corrected Jibe company keys.

- [ ] **Step 3: Start/resume a catch-up run without a duplicate daily scan**

Use the latest valid scan receipt already reconciled. Record the initial exact counts in run state.

- [ ] **Step 4: Drain normal work batch by batch**

For each returned batch, apply current Sunny hard gates, fetch/read authoritative JD when required, score only eligible roles, write/read-back qualified Sheet rows, record exclusions and seen jobs, update Scan Summary and localhost archive/index, mark each queue disposition, write the closeout receipt, and request the next batch. Continue until normal pending is zero or a genuine external blocker is recorded as partial/failed.

- [ ] **Step 5: Retry exception work once for this catch-up**

Use official/API retry and browser fallback for candidate JD fetches. Rerun or probe source failures according to provider evidence. Record the attempt under the same canonical key. On third failure, generate the diagnosis dossier; never guess a terminal state. Treat Jibe/Workday partials as partial coverage unless the cap is actually cleared.

- [ ] **Step 6: Finalize and verify downstream data**

Read back the date tab/Master/Excluded/Seen Jobs/Scan Summary ranges changed by the last batch. Rebuild and parse `local/sunny-job-search/data/jobs.json`; verify canonical URL/date uniqueness and `yiyunliao21@gmail.com` in generated referral messages.

- [ ] **Step 7: Publish the final run status**

Run `node data/tools/sunny-daily-run-state.mjs status --summary`. The report must state processed and remaining normal jobs, candidate/source retryable and diagnosis counts, source partial/error count, final sink closeout, and exact next action. Do not say full coverage if source exceptions remain.

### Task 8: Commit only the verified Faire/Figma mapping hunks

**Files:**
- Modify: `data/sunny-linkedin-company-map.tsv`

- [ ] **Step 1: Identify exact pre-existing versus task rows**

Compare the working file to HEAD and isolate only the verified Faire and Figma additions. If either row cannot be unambiguously isolated, leave the entire file uncommitted and report that fact.

- [ ] **Step 2: Stage only those two rows**

Use an index-only patch; do not stage the rest of the modified file.

- [ ] **Step 3: Verify and commit the staged patch**

Run `git diff --cached -- data/sunny-linkedin-company-map.tsv` and confirm it contains exactly the two intended rows. Commit with: `data: add verified Faire and Figma LinkedIn mappings`.

## Final acceptance evidence

- Fresh focused and local-site test output with zero failures.
- Independent implementation-review PASS for the exact code snapshot.
- Automation read-back showing unchanged schedule and corrected loop/status/email contract.
- Run-state summary proving no false completion and showing exact remaining work.
- Queue/exception identity counts proving SIG deduplication and corrected Jibe keys.
- Git log/status proving scoped commits and preserved unrelated changes.
