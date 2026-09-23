# Sunny Dual-Queue Recovery Design

## Goal

Keep Sunny's daily discovery running while isolating transient or unresolved
failures. Normal candidates must be evaluated before exception work. A failed
candidate or ATS source must retain diagnostic evidence, retry at most three
times, and then receive an individual diagnosis instead of blocking new work
or being silently discarded.

## Problem and evidence

`run-sunny-serialized-scan.mjs` persists every valid `added_urls` receipt even
when the scan is partial or errors. This is intentional: a partial board can
still yield valid new jobs. `sunny-job-queue.mjs` then returns every `pending`
job with no batch, retry, claim, or exception state.

The result is a single unbounded queue shared by ordinary work and failures.
From 2026-09-18 through 2026-09-20, 319 new URLs were added while only 158
were terminally handled. The durable queue now has 163 pending jobs: two from
2026-09-16, 56 from 2026-09-18, 103 from 2026-09-19, and two from 2026-09-20.

## Chosen approach

Use two durable exception queues alongside the existing normal job queue:

1. The existing `data/sunny-job-queue.json` remains the normal candidate
   queue. Its `pending` state means ready for ordinary hard gates, JD review,
   scoring, and publication. Existing 163 items remain here until an actual,
   recorded error occurs; they must not be relabelled as errors merely because
   they are old.
2. `data/sunny-job-exception-queue.json` stores candidate-specific failures:
   missing or unparseable JD, temporary ATS failures while opening a candidate,
   missing required evidence, Sheet publication failures, and archive/index
   failures.
3. `data/sunny-scan-exception-queue.json` stores board/provider failures from
   a scan receipt, such as 429, 404, timeout, abort, fetch failure, or a
   truncated provider. It is independent of candidate review so a failed board
   never blocks valid findings from another board.

An exception is identified by a stable key: canonical job URL plus stage for a
candidate, or normalized provider/company plus error class for a source. Each
record stores first failure time, last failure time, the latest evidence,
attempt count, `next_retry_at`, and one of `retryable`, `needs_diagnosis`, or
`resolved`.

## Error policy

| Error class | Initial route | Automatic retry | Third failure |
|---|---|---|---|
| 429, 5xx, timeout, abort, fetch failure | matching exception queue | 1 day, then 2 days, then 4 days | `needs_diagnosis`; inspect the provider/candidate individually |
| 404, explicitly closed/expired job | normal job terminal `closed` | none | none |
| JD/evidence unavailable but no negative evidence | candidate exception | same three-attempt schedule | individual evidence/JD diagnosis; remains unresolved if proof is unavailable |
| explicit no sponsorship or a hard eligibility miss | normal job terminal `rejected` | none | none |
| Google Sheet/archive/index write failure | candidate exception at `publish` or `archive` stage | same schedule | individual repair; never lose a verified evaluation |

Retry attempts occur no sooner than `next_retry_at`; an exception is never
retried repeatedly in a single scheduler run. A successful retry marks the
exception resolved and puts the candidate back into normal `pending` only when
ordinary evaluation still remains. Publication-stage recovery instead resumes
the stored verified result, avoiding another evaluation.

## Daily orchestration

The new daily routine has this fixed order:

1. Reconcile historical scan receipts and import source errors from the last
   receipt without treating a partial scan as a successful full-coverage scan.
2. Run the serialized daily scan. Always preserve valid `added_urls`; import
   its provider errors into the scan exception queue.
3. Process ordinary `pending` candidates, newest first, through deterministic
   gates, official JD, DOL/sponsorship evidence, scoring, Sheet readback,
   durable disposition, and local archive/index. Normal work is never blocked
   by exception count.
4. Only after the normal candidate batch is drained, process retry-eligible
   candidate and source exceptions in oldest-due order. Record every attempt.
5. Emit a compact receipt containing normal completion counts, exception retry
   counts, third-attempt diagnoses due, and scan errors/partial boards.

The routine can accept explicit normal and exception batch limits for a bounded
automation turn. Limits never discard work: unprocessed normal items retain
`pending`, and exception work retains its due time. Fresh daily candidates sort
before older normal candidates so daily updates remain current. The scheduler
must not skip discovery because exceptions exist.

## Individual diagnosis

`needs_diagnosis` is an actionable state, not a dead letter. A diagnosis
command reads one exception, its receipt/job provenance, and all recorded
attempt evidence; it produces a structured recommendation:

- retry after a documented configuration/pacing fix;
- close/reject with explicit official evidence;
- release the candidate to normal evaluation; or
- keep it unresolved with a stated missing fact.

No diagnosis command submits an application, contacts a person, or makes a
terminal candidate disposition without evidence.

## Migration and operational recovery

Existing 163 `pending` records are normal candidates, because their durable
records do not say which evaluation stage failed. The recovery routine handles
them using ordinary gates. It creates a candidate exception only at the exact
stage that fails and seeds source exceptions from the historical scan receipts.
This preserves the distinction between "not processed yet" and "could not be
processed".

The automation prompt will be shortened to invoke the durable routine and
report its receipt. The detailed eligibility and Sheet rules remain the same;
the worker is no longer asked to perform an unbounded queue drain plus a full
scan plus ad-hoc retry work in one opaque turn.

## Files and responsibilities

- `data/tools/sunny-job-queue.mjs`: normal queue state transitions and release
  from a resolved candidate exception.
- `data/tools/sunny-job-exception-queue.mjs`: candidate exception schema,
  transition, retry scheduling, and diagnosis state.
- `data/tools/sunny-scan-exception-queue.mjs`: source exception schema and
  receipt-error ingestion.
- `data/tools/run-sunny-daily-routine.mjs`: bounded, ordered orchestration and
  machine-readable daily receipt.
- `data/tools/sunny-exception-diagnose.mjs`: one-record evidence pack and
  safe recommendation interface.
- `tests/sunny-job-queue.test.mjs`: normal/exception transitions.
- `tests/sunny-exception-queue.test.mjs`: error classification, retry timing,
  three-attempt escalation, and idempotence.
- `tests/sunny-daily-routine.test.mjs`: normal-first ordering, valid findings
  after partial scan, and exceptions not blocking a subsequent scan.

## Acceptance criteria

1. A daily scan runs and queues valid new jobs even while both exception queues
   contain retryable and diagnosis-required records.
2. A 429/fetch/timeout failure is recorded once, becomes retryable at the
   prescribed time, and reaches `needs_diagnosis` only after its third failed
   retry attempt.
3. A 404/closed job becomes `closed`, not retryable.
4. A normal candidate is processed before a due exception; no candidate is
   terminally marked without the existing reason/Sheet evidence invariants.
5. Receipt replay, concurrent queue updates, and existing 163 pending jobs
   remain safe and idempotent.
6. Tests cover the red-green cases above and existing Sunny scanner/queue tests
   remain green.
