# Sunny Dual-Queue Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Sunny's daily scan running while routing candidate and ATS-source failures into durable, three-retry exception queues that never block normal candidate processing.

**Architecture:** `sunny-job-queue.json` remains the normal candidate queue and gains an explicit `exception` state. Two exception JSON files retain candidate-stage and ATS-source error evidence. A daily planner always runs/reconciles discovery, selects normal candidates first, and only exposes retryable exception work after normal work is empty.

**Tech Stack:** Node.js ESM, `node:test`, JSON state, and the existing atomic lock pattern.

---

## File map

- Modify `data/tools/sunny-job-queue.mjs` and `tests/sunny-job-queue.test.mjs` for normal-to-exception transitions and newest-first selection.
- Create `data/tools/sunny-exception-store.mjs` and `tests/sunny-exception-store.test.mjs` for atomic exception records and retry policy.
- Create `data/tools/sunny-job-exception-queue.mjs` and `data/tools/sunny-scan-exception-queue.mjs` to adapt candidate failures and scan receipts to that store.
- Modify `data/tools/run-sunny-serialized-scan.mjs` and `tests/sunny-serialized-scan.test.mjs` to persist source exceptions without losing valid URLs from partial scans.
- Create `data/tools/run-sunny-daily-work-plan.mjs` and `tests/sunny-daily-work-plan.test.mjs` for normal-first work selection.
- Create `data/tools/sunny-exception-diagnose.mjs` and `tests/sunny-exception-diagnose.test.mjs` for read-only third-failure dossiers.
- Modify `data/tools/sunny-routine-runtime.mjs`, `tests/sunny-routine-runtime.test.mjs`, and `modes/_custom.md`; update automation `sunny-24` after code verification.

## Task 1: Normal queue exception state

**Files:** `data/tools/sunny-job-queue.mjs`, `tests/sunny-job-queue.test.mjs`

- [ ] Write failing tests that defer `https://example.com/careers?gh_jid=123` with key `candidate|jd|https://example.com/careers?gh_jid=123`, assert `readPendingJobs()` returns no job, release it with the exact key, then assert the job returns as `pending` with its original source count. Add a second test that two pending records dated `2026-09-01` and `2026-09-02` return newest-first and a `closed` record rejects deferral.
- [ ] Run `node --test tests/sunny-job-queue.test.mjs`. Expected RED: `deferJobForException` and `releaseJobFromException` do not exist.
- [ ] Implement `deferJobForException({ url, exception_key }, options)` using `updateQueue`: find `canonicalLeadUrl(url)`, reject missing/terminal jobs, set `{ status: 'exception', exception_key: String(exception_key) }`, and return URL/status/key. Implement `releaseJobFromException({ url, exception_key }, options)`: require the exact stored key and status `exception`, then set `{ status: 'pending', exception_key: '' }`.
- [ ] Change `readPendingJobs` to filter only `status === 'pending'`, sort descending by `first_seen` then ascending URL, then apply `limit`.
- [ ] Re-run `node --test tests/sunny-job-queue.test.mjs`. Expected GREEN: all existing and new queue tests pass.
- [ ] Commit `data/tools/sunny-job-queue.mjs` and `tests/sunny-job-queue.test.mjs` as `feat: add Sunny job exception state`.

## Task 2: Atomic exception store and retry policy

**Files:** `data/tools/sunny-exception-store.mjs`, `tests/sunny-exception-store.test.mjs`

- [ ] Write failing tests that classify a candidate `HTTP 404 job no longer available` as `{ action: 'closed' }`, classify source `HTTP 429` as `{ action: 'retryable' }`, and record three timestamped failures for key `source|Example|transient`. Assert attempt one is retryable for +1 day, attempt two is retryable for +2 days, and attempt three is `needs_diagnosis` with no retry date. Add a `Promise.all` test for two different keys and assert both are persisted exactly once.
- [ ] Run `node --test tests/sunny-exception-store.test.mjs`. Expected RED: module not found.
- [ ] Create an atomic `{ schema_version: 1, items: [] }` JSON store protected by a dedicated `acquirePipelineLock` path. Export `RETRY_DELAYS_DAYS = [1, 2, 4]`, `classifyFailure`, `nextRetryAt`, `recordFailure`, `readExceptionQueue`, and `readDueExceptions`.
- [ ] `recordFailure` must upsert by stable key, preserve `first_failed_at`, update `last_failed_at`, evidence, and message, increment `attempt_count`, and set `status: 'needs_diagnosis'` on attempt three. Repeating the same failure with the same ISO timestamp must not increment again.
- [ ] Re-run `node --test tests/sunny-exception-store.test.mjs`. Expected GREEN: classifications, 1/2/4-day backoff, escalation, idempotence, and concurrent writes pass.
- [ ] Commit the two files as `feat: add Sunny exception retry store`.

## Task 3: Candidate/source adapters and partial-scan intake

**Files:** `data/tools/sunny-job-exception-queue.mjs`, `data/tools/sunny-scan-exception-queue.mjs`, `data/tools/run-sunny-serialized-scan.mjs`, `tests/sunny-job-queue.test.mjs`, `tests/sunny-serialized-scan.test.mjs`

- [ ] Write failing integration tests: a JD `fetch failed` invokes `deferCandidateFailure`, removes just that URL from normal selection, and creates one candidate exception. A partial scan fixture with one valid URL plus `{ company: 'Example', error: 'HTTP 429' }` must leave the URL `pending` and create exactly one source exception.
- [ ] Run `node --test tests/sunny-job-queue.test.mjs tests/sunny-serialized-scan.test.mjs`. Expected RED: adapter modules and receipt ingestion do not exist.
- [ ] Implement `deferCandidateFailure({ url, stage, message, evidence }, options)` with key `candidate|${stage}|${canonicalLeadUrl(url)}`. It records to `data/sunny-job-exception-queue.json` before calling `deferJobForException`; both steps must be replay-safe. Implement `resolveCandidateException` to mark the item resolved and release only a job that needs new normal evaluation.
- [ ] Implement `ingestScanReceiptExceptions(receipt, options)`: each `scan_receipt.errors[]` creates `source|${normalizedCompany}|${errorClass}` at `scan` stage; warnings containing partial, truncated, or max-pages create a normalized `coverage` item. Empty error/warning arrays create none.
- [ ] In `runSerializedScan`, call receipt ingestion after receipt persistence and valid URL enqueue, then include `{ recorded }` as `scan_exceptions` in the returned result. A receipt error must never erase `added_urls` or block their normal queue entry.
- [ ] Re-run the queue, serialized-scan, and exception-store suites. Expected GREEN: partial scan valid intake and source failure evidence coexist.
- [ ] Commit these modules, scanner, and tests as `feat: route Sunny scan failures to exception queues`.

## Task 4: Normal-first daily work planner

**Files:** `data/tools/run-sunny-daily-work-plan.mjs`, `tests/sunny-daily-work-plan.test.mjs`

- [ ] Write failing tests for three cases: (1) an ordinary pending job plus a due exception returns `{ phase: 'normal' }`, the job, and no exception work; (2) no normal job returns due retryable exception items ordered by `next_retry_at`, `first_failed_at`, then key; (3) a partial scan fixture returns both normal URL work and a source exception.
- [ ] Run `node --test tests/sunny-daily-work-plan.test.mjs`. Expected RED: planner module not found.
- [ ] Implement `buildDailyWorkPlan({ dataRoot, since = 3, now = new Date(), runScan = true, normalLimit = Infinity, exceptionLimit = Infinity, scan = runSerializedScan })`: reconcile receipts, optionally run one serialized daily scan, then return normal jobs if any. Only when normal jobs are empty may it return due retryable candidate/source exceptions. Include non-retryable third failures as `diagnoses_due` but never put them in automatic work.
- [ ] Add CLI flags `--since`, `--normal-limit`, `--exception-limit`, and `--no-scan`; stdout is exactly one JSON object. A scan receipt with exit code 2 remains an evidence-bearing result and does not prevent a valid normal plan.
- [ ] Re-run `node --test tests/sunny-daily-work-plan.test.mjs`. Expected GREEN: normal-first, ordered retry, and partial scan cases pass.
- [ ] Commit planner and tests as `feat: add Sunny normal-first daily work planner`.

## Task 5: Individual diagnosis and checkpoint inclusion

**Files:** `data/tools/sunny-exception-diagnose.mjs`, `tests/sunny-exception-diagnose.test.mjs`, `data/tools/sunny-routine-runtime.mjs`, `tests/sunny-routine-runtime.test.mjs`

- [ ] Write a failing test that seeds a third-failure candidate exception and asserts `diagnoseException({ queue: 'candidate', key })` returns its persisted evidence, `status: 'needs_diagnosis'`, and `recommendation: 'inspect_individually'`. Capture queue-file bytes before and after and assert they are identical.
- [ ] Run `node --test tests/sunny-exception-diagnose.test.mjs`. Expected RED: diagnosis module not found.
- [ ] Implement `diagnoseException({ dataRoot, queue, key })` plus CLI `--queue candidate|source --key <key>`. Reject absent or non-diagnosis records; return only persisted fields and `recommendation: 'inspect_individually'`; do not fetch network data or modify state.
- [ ] Add `data/sunny-job-exception-queue.json` and `data/sunny-scan-exception-queue.json` to `REQUIRED_STATE_PATHS`. Update checkpoint fixtures with valid empty documents and assert both paths appear in the archive manifest.
- [ ] Re-run `node --test tests/sunny-exception-diagnose.test.mjs tests/sunny-routine-runtime.test.mjs`. Expected GREEN: dossier read-only behavior and checkpoint coverage pass.
- [ ] Commit as `feat: add Sunny exception diagnosis recovery`.

## Task 6: Operating rule, automation handoff, and full verification

**Files:** `modes/_custom.md`, automation `sunny-24`, all targeted tests.

- [ ] Append a `Sunny dual-queue recovery` procedural section to `_custom.md`: always scan; process newest normal candidates before exceptions; retry transient/unresolved failures no more than three times; diagnose the third failure individually; close only official 404/expired jobs; never relabel an old pending job without a recorded stage error.
- [ ] Update automation `sunny-24` to start with `node data/tools/run-sunny-daily-work-plan.mjs --since 3`. On `phase=normal`, handle only `normal_jobs` under the existing eligibility, Sheet, archive, and no-contact rules, routing failures through exceptions. Re-run the planner after every normal disposition. On `phase=exceptions`, process each due exception once; use `sunny-exception-diagnose.mjs` for `diagnoses_due`. Preserve current hard gates and fail-soft LinkedIn rules.
- [ ] Run `node --test tests/sunny-job-queue.test.mjs tests/sunny-exception-store.test.mjs tests/sunny-serialized-scan.test.mjs tests/sunny-daily-work-plan.test.mjs tests/sunny-exception-diagnose.test.mjs tests/sunny-routine-runtime.test.mjs`; expected all named tests pass.
- [ ] Run `npm run lint` and `git diff --check`; expected exit 0. If lint reaches the host time limit, report it as unverified rather than passing.
- [ ] Commit only `_custom.md` as `docs: route Sunny daily work through dual queues`. Report the automation update separately because it is external state.

## Plan self-review

- Tasks 1 and 4 implement normal-first selection; tasks 2 and 3 implement independent candidate/source exception queues; tasks 2 and 5 implement the three-attempt and diagnosis policy; task 6 activates the safe orchestration only after tests pass.
- Every behavior has a red command, a green command, a stable key format, a schema version, and existing lock/atomic-write reuse. No migration relabels the current 163 jobs as failures without an actual recorded error.
