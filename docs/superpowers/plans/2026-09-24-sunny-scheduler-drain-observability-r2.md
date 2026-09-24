# Sunny Scheduler Drain and Observability R2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Sunny daily runs resumable and visibly terminal, repair queue identities, enforce recoverable typed batch closeout, then drain all current normal work and retry the frozen exception backlog once without falsely claiming complete source coverage.

**Architecture:** Add a lock-protected run controller around the existing scanner, normal-first planner, job queue, and exception adapters. The controller persists scan ownership, immutable typed batches, exact semantic/Sheet/archive payloads, operation progress, closeout evidence, and terminal status. Existing candidate/source writers remain authoritative; new outcome APIs complete their missing lifecycle transitions.

**Tech Stack:** Node.js ESM, `node:test`, atomic JSON files under ignored `data/`, existing pipeline locks, Codex heartbeat automation, current Google Sheet and localhost archive workflows.

---

## Baseline, approval, and constraints

- Repository: `/Users/coda/Documents/ChatGPT/career-ops`
- Approved-execute evidence directory: `/tmp/career-ops-approved-execute.7T5YGy`
- Initial HEAD: `fe2a34ee68c9ea8afca32869ab002811de6d6a96`
- Initial operational counts: 522 normal pending; 13 canonical candidate exceptions stored as 14 rows; 28 source exceptions.
- Preserve all pre-existing tracked and untracked user changes. The existing `.gitignore` edit is unrelated. Only Faire/Figma may be index-staged from the modified LinkedIn company map.
- Functional correctness is the review priority. Cosmetic issues and additional security hardening are non-blocking.
- Do not apply jobs, contact people, redesign scoring, or perform the v1.33.0 system update.
- Every production behavior change follows RED → GREEN TDD.

### Task 1: Preserve run evidence and add identity reconciliation

**Files:**
- Modify: `data/tools/sunny-company-leads.mjs`
- Modify: `data/tools/sunny-job-queue.mjs`
- Modify: `data/tools/sunny-exception-store.mjs`
- Modify: `data/tools/sunny-job-exception-queue.mjs`
- Modify: `data/tools/sunny-scan-exception-queue.mjs`
- Test: `tests/sunny-company-leads.test.mjs`
- Test: `tests/sunny-job-queue.test.mjs`
- Test: `tests/sunny-exception-store.test.mjs`
- Create: `tests/sunny-scan-exception-queue.test.mjs`

- [ ] **Step 1: Snapshot evidence before code changes**

Record current HEAD, task-file hashes, complete automation TOML, queue counts, exception keys, latest receipt path, working/index diffs, and untracked inventory in the approved-execute directory.

- [ ] **Step 2: Write failing percent-escape and replay tests**

Test that `%7C` and `%7c` canonicalize identically, old receipt replay cannot reintroduce the lowercase identity, compatible queue copies merge sources/windows, and contradictory terminal dispositions fail rather than being guessed.

- [ ] **Step 3: Verify RED**

Run: `node --test tests/sunny-company-leads.test.mjs tests/sunny-job-queue.test.mjs`

Expected: the new canonicalization/reconciliation assertions fail.

- [ ] **Step 4: Implement canonical URL and job reconciliation**

Uppercase serialized percent escapes without decoding path separators. Add idempotent job reconciliation that unions sources/windows, preserves complete fields and terminal evidence, merges only compatible copies, and rejects contradictory terminal outcomes. Invoke it before receipt append/replay.

- [ ] **Step 5: Write failing exception identity tests**

Cover candidate identity `queue + stage + canonical URL`, SIG evidence/timestamp union, attempt-count and retry-date recomputation, resolved/closed lifecycle preservation, third-failure escalation, and interruption-safe rerun. Cover the emoji-prefixed Jibe warning and require `source|costcowholesalecorporation|coverage`.

- [ ] **Step 6: Verify exception RED**

Run: `node --test tests/sunny-exception-store.test.mjs tests/sunny-scan-exception-queue.test.mjs`

Expected: the new merge/Jibe assertions fail.

- [ ] **Step 7: Implement cross-file-safe exception reconciliation**

Rebuild candidate keys from canonical evidence URLs and source keys from stored company/error/coverage evidence. Store merged historical evidence explicitly, deduplicate timestamps, recompute attempts/retry dates, and never downgrade diagnosis/closure/resolution. Use the existing candidate-transition outer lock and one documented lock order; avoid recursive acquisition. Make rerunning reconciliation recover from an interruption between atomic file replacements.

- [ ] **Step 8: Verify Task 1 GREEN**

Run: `node --test tests/sunny-company-leads.test.mjs tests/sunny-job-queue.test.mjs tests/sunny-exception-store.test.mjs tests/sunny-scan-exception-queue.test.mjs`

Expected: zero failures.

### Task 2: Complete typed candidate/source/diagnosis outcome APIs

**Files:**
- Modify: `data/tools/sunny-job-exception-queue.mjs`
- Modify: `data/tools/sunny-scan-exception-queue.mjs`
- Modify: `data/tools/sunny-exception-diagnose.mjs`
- Modify: `tests/sunny-job-queue.test.mjs`
- Modify: `tests/sunny-exception-diagnose.test.mjs`
- Modify: `tests/sunny-scan-exception-queue.test.mjs`

- [ ] **Step 1: Write failing lifecycle tests**

Test JSON-file outcome inputs with stable attempt IDs/timestamps and idempotent replay. Required transitions: candidate recovery to pending normal evaluation; verified publish/archive/index repair to terminal disposition from matching exception state; official closed posting to `closed`; repeated failure on the same canonical key; source resolution only with exact-board/window coverage evidence; third-failure dossier acknowledgement that prevents duplicate dossier work without pretending the issue is resolved.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/sunny-job-queue.test.mjs tests/sunny-scan-exception-queue.test.mjs tests/sunny-exception-diagnose.test.mjs`

Expected: missing outcome/acknowledgement APIs fail.

- [ ] **Step 3: Implement candidate outcome CLI**

Keep the existing adapter as the only cross-file writer. Support:

```text
node data/tools/sunny-job-exception-queue.mjs failure --input FILE
node data/tools/sunny-job-exception-queue.mjs resolve --input FILE
```

Differentiate fresh retry results from receipt replay. Publication repair must require verified date-tab/Master references; normal recovery returns to pending; confirmed official expiry closes with evidence.

- [ ] **Step 4: Implement source outcome and diagnosis acknowledgement CLIs**

Support:

```text
node data/tools/sunny-scan-exception-queue.mjs outcome --input FILE
node data/tools/sunny-exception-diagnose.mjs --queue candidate|source --key KEY
node data/tools/sunny-exception-diagnose.mjs acknowledge --input FILE
```

Connectivity alone cannot clear a coverage failure. Acknowledged unresolved diagnoses remain partial/unresolved but are not repeatedly regenerated. `needs_diagnosis` is never automatically retried.

- [ ] **Step 5: Verify Task 2 GREEN**

Run the Task 2 test command and expect zero failures.

### Task 3: Add durable run state and interruption-safe daily scan ownership

**Files:**
- Create: `data/tools/sunny-daily-run-state.mjs`
- Create: `tests/sunny-daily-run-state.test.mjs`
- Modify: `data/tools/run-sunny-serialized-scan.mjs`
- Modify: `tests/sunny-serialized-scan.test.mjs`
- Modify: `data/tools/sunny-routine-runtime.mjs`
- Modify: `tests/sunny-routine-runtime.test.mjs`

- [ ] **Step 1: Write failing run lifecycle tests**

Cover start/resume by New York date, running/partial/failed/complete, stale-running display, exact current counts, future-wait counts and next due time, actionable `continue_required`, acknowledged blockers, separate source coverage status, and rejection of complete when a normal/due/diagnosis/open-batch/unaccounted-scan action remains.

- [ ] **Step 2: Write failing scan-claim tests**

Cover default repeated invocation scanning once, persisted claim before child start, adoption of an existing matching receipt after interruption, explicit partial for claim-without-receipt, and day rollover that permits one new scan but preserves the old open batch.

- [ ] **Step 3: Verify RED**

Run: `node --test tests/sunny-daily-run-state.test.mjs tests/sunny-serialized-scan.test.mjs tests/sunny-routine-runtime.test.mjs`

Expected: missing controller/claim behavior fails.

- [ ] **Step 4: Implement the atomic controller and CLI**

Persist run ID/mode, New York day, scan claim/receipt, starting/current counts, processed counters, current typed batch, retry ledger, diagnosis acknowledgements, stop reason, last error, coverage, and next action. Use existing lock/temp-rename patterns. Expose:

```text
status [--summary]
reconcile
checkpoint --input FILE
close --receipt FILE
complete
stop --status partial|failed --reason TEXT
```

Status derives queue counts from durable files instead of trusting cached counters. Future waits alone do not block completion; unresolved diagnosed items make the result partial. Include state/payload files in checkpoints when present without breaking older data roots.

- [ ] **Step 5: Implement durable scan claim**

Allocate and persist a run/day scan ID before starting the child, pass it into the serialized scanner, adopt a matching receipt on resume, and never silently launch a second scan when the claimed scan has no recoverable receipt. Preserve routine/scan lock order without reacquiring an already held routine lease.

- [ ] **Step 6: Verify Task 3 GREEN**

Run the Task 3 test command and expect zero failures.

### Task 4: Persist recoverable typed batches and exact closeout payloads

**Files:**
- Modify: `data/tools/sunny-daily-run-state.mjs`
- Modify: `tests/sunny-daily-run-state.test.mjs`

- [ ] **Step 1: Write failing typed-batch tests**

Cover immutable deterministic batch IDs and the five types: normal candidates, candidate retries, source retries, diagnoses, and no-work/final closeout. Source/diagnosis membership uses exception keys. Test reissuing an open batch unchanged across restart/day rollover.

- [ ] **Step 2: Write failing recovery payload tests**

Persist exact semantic decision/evidence, intended 14 Sheet fields, archive fields, and per-operation progress before external writes. Test resume after scoring, date-tab write, Master write, queue marking, and archive/index sync. Verify already-completed writes by canonical identity and never rescore terminal items.

- [ ] **Step 3: Write failing sink applicability tests**

Require Excluded for new rejected/closed decisions, Seen Jobs for processed normal/candidate items, Scan Summary for every batch and zero-result closeout, and archive/index for published items. Published items also require date-tab and Master read-back. Reject inappropriate `not_applicable`, wrong batch IDs, dangling exception keys, missing evidence, and pending batch candidates.

- [ ] **Step 4: Verify RED**

Run: `node --test tests/sunny-daily-run-state.test.mjs`

Expected: typed payload/closeout assertions fail.

- [ ] **Step 5: Implement typed batch and closeout state machine**

Keep bounded current/recent batch metadata plus a private payload artifact. Candidate retry success enters a normal-evaluation subphase and cannot close until terminal or evidenced deferral. Count outcomes only on first successful closure; idempotent replay verifies references and advances only unfinished operations.

- [ ] **Step 6: Verify Task 4 GREEN**

Run the Task 4 test command and expect zero failures.

### Task 5: Integrate planner selection and explicit catch-up mode

**Files:**
- Modify: `data/tools/run-sunny-daily-work-plan.mjs`
- Modify: `tests/sunny-daily-work-plan.test.mjs`

- [ ] **Step 1: Write failing selection/resume tests**

Selection order must be: reconcile/adopt receipt; reissue current batch/unfinished closeout; newest normal; eligible candidate/source retries; unacknowledged diagnoses; final closeout. Preserve compatibility fields while adding `run_id`, `run_status`, exact `remaining`, `continue_required`, `next_action`, typed `batch`, artifact paths, and exact checkpoint/close commands.

- [ ] **Step 2: Write failing forced catch-up tests**

At catch-up creation, freeze the canonical current exception keys and once-per-run retry ledger. `--retry-current-once` selects those future-dated baseline exceptions exactly once across restarts and does not auto-select newly deferred exceptions. An adopted historical receipt retains its original New York date/provenance.

- [ ] **Step 3: Verify RED**

Run: `node --test tests/sunny-daily-work-plan.test.mjs`

Expected: run contract and catch-up assertions fail.

- [ ] **Step 4: Implement planner integration**

Add the explicit recovery command:

```text
node data/tools/run-sunny-daily-work-plan.mjs \
  --catch-up --no-scan --scan-receipt FILE \
  --retry-current-once --normal-limit 20 --exception-limit 20
```

Ordinary continuation remains `--no-scan`. Batch limit is never a terminal condition. Reissue unfinished closeout before selecting new work.

- [ ] **Step 5: Verify Task 5 GREEN**

Run the Task 5 test command and expect zero failures.

### Task 6: Update the heartbeat contract

**Files:**
- Modify via automation API: `sunny-24`
- Verify read-back: `/Users/coda/.codex/automations/sunny-24/automation.toml`

- [ ] **Step 1: Preserve the full old TOML outside source**

Save the pre-change automation text and hash in the approved-execute directory.

- [ ] **Step 2: Replace only conflicting operational instructions**

Keep schedule, target, eligibility, scoring, Sheet, and referral behavior. Require persisted per-item progress, all required closeout evidence, and loop while `continue_required=true`. Before deliberate return, record complete/partial/failed; partial reports an exact resume command. Remove stale `exception_work` naming and correct the archive email to `yiyunliao21@gmail.com`.

- [ ] **Step 3: Read back and verify**

Confirm the daily noon schedule and target thread are unchanged; no old email remains; field/command names match the implemented CLI; the final report begins with status and includes processed/remaining/coverage/next-action counts.

### Task 7: Full verification, independent implementation review, repair, and code commit

**Files:**
- All Task 1–6 code/tests/docs.

- [ ] **Step 1: Run focused suites**

Run:

```bash
node --test \
  tests/sunny-company-leads.test.mjs \
  tests/sunny-job-queue.test.mjs \
  tests/sunny-exception-store.test.mjs \
  tests/sunny-scan-exception-queue.test.mjs \
  tests/sunny-exception-diagnose.test.mjs \
  tests/sunny-daily-run-state.test.mjs \
  tests/sunny-daily-work-plan.test.mjs \
  tests/sunny-routine-runtime.test.mjs \
  tests/sunny-serialized-scan.test.mjs
```

Expected: zero failures.

- [ ] **Step 2: Run all localhost suites**

Run: `node --test local/sunny-job-search/tests/*.test.mjs`

Expected: zero failures.

- [ ] **Step 3: Inspect task-only changes**

Run `git diff --check`, `git status --short`, and targeted diffs. Confirm unrelated baseline changes remain untouched/unstaged.

- [ ] **Step 4: Submit exact snapshot for fresh implementation review**

Provide HEAD, changed-file hashes, complete test output, automation read-back, and acceptance mapping. Apply only reviewer-authored in-scope repair plans through fresh Terra agents until PASS.

- [ ] **Step 5: Commit the reviewed implementation**

Stage only task code/tests/spec/plan. Commit: `fix: make Sunny daily runs resumable and observable`.

### Task 8: Perform the approved one-time recovery drain

**Files/Data:**
- Operational state under ignored `data/`
- Configured Google Sheet
- `data/sunny-job-search-archive.json` and generated local snapshot

- [ ] **Step 1: Create and verify recovery artifacts**

Call `createSunnyCheckpoint()` and verify its archive hash. Preserve archive/snapshot recovery artifacts and manifest outside tracked source.

- [ ] **Step 2: Reconcile identities and verify counts**

Run `sunny-daily-run-state.mjs reconcile`. Verify candidate store 14 → 13, SIG retains both evidence/timestamps with recomputed schedule, and all eight malformed Jibe keys join to real companies.

- [ ] **Step 3: Start catch-up with the latest valid historical receipt**

Use the explicit Task 5 command. Do not start a duplicate daily scan or relabel the September 23 New York receipt as September 24.

- [ ] **Step 4: Drain every normal batch**

For each batch: apply existing hard gates and source-window rules; obtain authoritative JD text/date with `node fetch-jd.mjs URL` and browser fallback where needed; semantically evaluate/score only eligible jobs; persist the exact payload before Sheet writes; write/read-back date tab and Master; update Excluded, Seen Jobs, Scan Summary, archive/index; mark queue outcomes through canonical adapters; close the batch; request the next. Continue until normal pending is zero or an evidenced external blocker is recorded partial/failed.

- [ ] **Step 5: Retry the frozen candidate/source set once**

Process every frozen future-dated baseline exception at most once in this catch-up. Candidate retry success completes its normal subphase. For source failures, use exact-board/window evidence; a probe alone cannot clear coverage. Record each fresh result under its canonical key. Diagnose each third failure and acknowledge the dossier conclusion/next action.

- [ ] **Step 6: Verify downstream state and publish terminal status**

Read back affected Sheet ranges; rebuild/parse local jobs JSON; verify URL/date uniqueness, new published presence, and `yiyunliao21@gmail.com`. Run `status --summary` and report exact normal, candidate, source, diagnosis, coverage, closeout, and next-action counts. Do not call coverage complete while partial sources remain.

### Task 9: Commit only verified Faire/Figma map rows

**Files:**
- Modify: `data/sunny-linkedin-company-map.tsv`

- [ ] **Step 1: Isolate the two task rows**

Confirm Faire/Figma are the first independent hunk and the seven older user additions remain separate.

- [ ] **Step 2: Stage only Faire/Figma with an index patch**

Do not stage the rest of the file or `.gitignore`.

- [ ] **Step 3: Verify cached diff and commit**

The cached diff must contain exactly two rows. Commit: `data: add verified Faire and Figma LinkedIn mappings`.

## Acceptance evidence

- A batch limit cannot yield false complete while normal pending remains.
- Status distinguishes running, stale-running, partial, failed, complete, future waits, unresolved diagnosis, and source coverage.
- Repeated ordinary invocation owns at most one daily scan; interrupted claim is visible and not silently rerun.
- Exact saved payload resumes every external-write boundary without duplicate publication.
- Typed exception batches have executable success/failure/diagnosis transitions.
- Catch-up selects the frozen future-dated exception set once across restarts.
- SIG and Jibe identity repairs retain evidence and produce verified canonical counts.
- Automation read-back proves loop/status/email contract and unchanged schedule.
- Fresh tests and independent reviewer PASS cover the exact code snapshot.
- Operational drain reports exact remaining work rather than equating source partials with zero jobs.
- Scoped commits preserve every unrelated user change.
