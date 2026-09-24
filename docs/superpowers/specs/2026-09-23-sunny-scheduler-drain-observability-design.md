# Sunny Scheduler Drain and Observability Design

## Goal

Make every Sunny daily run externally understandable and resumable: it must say whether it is running, partial, complete, or failed; show remaining normal and exception work; continue through fixed-size batches while work remains; and never claim completion before the current batch has completed every required sink update. After the repair is independently approved, use the same mechanism to drain the current backlog.

## Approved scope

This design addresses the six failures reported on 2026-09-23:

1. 522 normal jobs remain because a turn processes a fixed batch and does not reliably continue.
2. Candidate JD-fetch exceptions need retry/browser fallback and SIG percent-escape deduplication.
3. Source exceptions and Jibe partial-board warnings must remain visible rather than being reported as complete coverage.
4. HTTP 404/401/403/429 and fetch failures need durable retry evidence and third-failure diagnosis.
5. Every processed batch must close out Excluded, Seen Jobs, Scan Summary, and the localhost archive/index before the run advances.
6. Only the verified Faire and Figma mapping rows may be committed from the pre-existing modified LinkedIn map.

The review gate is functional. Cosmetic preferences and additional security hardening are explicitly non-blocking for this local MVP.

## Root cause

`run-sunny-daily-work-plan.mjs` selects `pendingJobs.slice(0, normalLimit)` and returns JSON, but it owns no durable daily-run lifecycle. The automation prompt asks the model to rerun the planner after dispositions, so continuation depends on one model turn voluntarily looping. A completed/idle Codex task therefore does not imply a drained queue. There is also no terminal receipt distinguishing complete, partial, failed, or stale-running work.

Two identity bugs make the exception counts unreliable:

- `canonicalLeadUrl()` preserves the case of percent escapes, so `%7C` and `%7c` become different identities.
- the Jibe warning parser includes `has more postings than` in the normalized company name, so a warning cannot be joined back to its portal.

## Approaches considered

### A. Increase the batch size

This is the smallest prompt-only change, but it still has no durable status, no recovery after a stopped turn, and no proof that downstream closeout completed. Rejected.

### B. Rewrite candidate evaluation as a fully deterministic daemon

This would remove model-turn dependence, but Sunny scoring and JD semantic decisions are intentionally model-assisted. It is much larger than the reported failure. Rejected.

### C. Durable run controller around the existing planner (selected)

Keep the scanner, queue, exception store, and semantic evaluation workflow. Add a small run-state controller that records each run and batch, makes continuation explicit, validates batch closeout, and gives the automation an unambiguous loop contract. This fixes observability and recovery without rewriting evaluation.

## Components

### 1. URL and exception identity reconciliation

`canonicalLeadUrl()` will uppercase every percent escape after URL serialization. A reconciliation helper will normalize existing Sunny job and candidate-exception identities, merge only identities that become equal after canonicalization, preserve all source/failure timestamps, and refuse conflicting terminal dispositions.

The source-exception adapter will extract Jibe company names before the phrase `has more postings than max_pages`. Existing source exception keys will be reconciled from their stored evidence.

### 2. Durable daily run state

`data/sunny-daily-run-state.json` is a local user-data file written atomically under a lock. It contains:

- `run_id`, `started_at`, `updated_at`, and latest scan receipt ID;
- `status`: `running`, `partial`, `complete`, or `failed`;
- `phase`: `scan`, `normal`, `exceptions`, `closeout`, or `done`;
- starting/current counts for normal pending, retryable candidate/source exceptions, and diagnoses;
- processed counts by published/rejected/duplicate/closed/deferred;
- current batch ID, candidate URLs, terminal/deferred count, and closeout evidence;
- `continue_required`, `stop_reason`, and `last_error`.

A `running` state whose update time exceeds the configured stale interval is displayed as stale-running and is resumable; it is never silently converted to complete.

### 3. Planner contract

The planner starts or resumes the New York calendar-day run, performs at most one scan for that run, reconciles queue identities, and returns:

- the current batch;
- exact remaining counts;
- `continue_required`;
- `run_status` and `run_id`;
- the command required to checkpoint the batch.

Normal work remains strictly ahead of exception work. Future-dated retryable exceptions do not prevent today's run from completing, but their waiting count is reported.

### 4. Batch checkpoint and atomic closeout

A batch can advance only when every batch URL is terminal or deferred and a closeout receipt records the four required sinks:

- Excluded;
- Seen Jobs;
- Scan Summary;
- localhost archive/index.

Each sink is recorded as `updated` or `not_applicable` with a reason/reference. Published jobs already retain verified Sheet range references through `sunny-job-queue.mjs`. The controller does not pretend to perform Google Sheet work; it validates and records the evidence produced by the existing workflow.

### 5. Automation behavior

The heartbeat prompt will:

1. start/resume one daily run;
2. process the returned batch;
3. complete downstream closeout and checkpoint it;
4. request the next batch;
5. repeat while `continue_required=true` and the turn has operating time;
6. before returning, explicitly record `complete`, `partial`, or `failed` and print counts plus the next action.

It must not return while the state is `running`. If the host interrupts it, the stale-running state makes that interruption visible and resumable on the next invocation.

The stale localhost referral email in the prompt will be corrected to `yiyunliao21@gmail.com`.

### 6. One-time recovery drain

After independent implementation review passes:

1. create a verified state checkpoint;
2. normalize existing queue/exception identities (14 stored candidate rows must become 13 canonical items);
3. drain newest normal jobs in bounded batches until normal pending is zero or an external prerequisite genuinely blocks progress;
4. close out each batch before requesting the next;
5. retry current candidate/source exceptions once immediately for this user-requested catch-up, recording new evidence; use browser fallback for candidate JD fetches;
6. after a third recorded failure, produce a per-item diagnosis rather than guessing;
7. publish a final run status and exact remaining counts.

Source partial coverage is not mislabeled as complete. A source may remain `retryable` or `needs_diagnosis` after the normal queue is drained; that state must be named explicitly.

## Acceptance criteria

1. A fixed-size batch cannot result in a false `complete` status while normal pending work remains.
2. Status output always distinguishes `running`, `partial`, `complete`, `failed`, and stale-running, with remaining counts and next action.
3. The same New York-day run performs no more than one daily scan when resumed.
4. The next batch is not issued until the prior batch jobs are terminal/deferred and all four closeout sinks have evidence.
5. `%7C` and `%7c` resolve to one canonical URL; the current SIG duplicate is merged without losing evidence.
6. Jibe coverage warnings produce company keys such as `costcowholesalecorporation`, not `costcowholesalecorporationhasmorepostingsthan`.
7. Normal jobs remain newer-first and ahead of exceptions. Future retry dates are reported but do not falsely block today's normal completion.
8. The automation prompt uses `yiyunliao21@gmail.com` and requires a terminal status summary.
9. Relevant unit tests and the existing Sunny queue/scan/routine/local-site suites pass.
10. Code/spec changes are committed without including unrelated pre-existing modifications. Only the Faire/Figma hunks are staged from the LinkedIn map when that data commit is made.
11. The one-time recovery reports the exact final normal pending, candidate retryable/diagnosis, source retryable/diagnosis, and closeout state; it does not claim full coverage while source partials remain.

## Exclusions

- No job applications, messages, connection requests, or LinkedIn profile visits.
- No career-ops v1.33.0 system update/reapply in this repair.
- No redesign of Sunny scoring or job eligibility rules.
- No new security framework, credential work, or generalized distributed-job system.
- No automatic disabling of a portal on its first or second source failure.
