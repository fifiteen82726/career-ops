# Sunny LinkedIn Referral Matching Completion and Bugfix Plan

> **For the Terra implementation task:** Execute in the existing saved-project local environment only. Use test-driven development and complete every checkbox. Do not activate `sunny-24` until every local verification and the bounded smoke pass.

**Goal:** Close the parent-review gaps in the initial referral implementation, prove the privacy and fail-soft contracts, complete the real browser UI coverage, and perform a verified single-writer scheduler cutover.

## Root-cause evidence

1. `local/sunny-job-search/tests/ui-browser.test.mjs` does not exist. The earlier aggregate verification used `;`, so later successful commands masked the missing-test exit code.
2. The 90-day purge in `referrals.mjs` still retains `profileUrl` inside `connections`; `seenProfileHashes` is not implemented. This violates the approved PII contract.
3. `build-sunny-job-search-index.mjs` treats malformed JSON as an empty error state and does not validate a syntactically valid malformed schema or carry bounded cached contacts from the prior snapshot.
4. The matcher produces one match for every eligible duplicate date+URL row instead of selecting the newest eligible scan date for a repeated canonical application URL.
5. Company-map validation accepts only four headers and does not validate `linkedin_people_url` consistency or the full reviewed-map contract.
6. Required CLI/root-precedence, strict candidate/match schema, 20/20/10 drain, complete partial-merge, and repeated-URL regressions are missing.
7. The live process on port 4173 predates the new server code; its actual response lacks `Referrer-Policy` despite the source change.
8. The smoke observed a connection card but wrote zero connections when Experience was unavailable, so the candidate cannot rotate through the pending queue.
9. `sunny-24` remains paused with its old prompt. This is correct fail-closed behavior, but the feature is not scheduled.

---

### Task 1: Finish the strict private-state and matcher contract

**Files:**
- Modify `local/sunny-job-search/referrals.mjs`
- Modify `local/sunny-job-search/tests/referrals.test.mjs`
- Create `local/sunny-job-search/tests/fixtures/referrals/*.json`

- [ ] Add RED tests for strict state, match, candidate, worklist, and employment schemas. Reject undeclared fields and malformed URLs/dates/statuses at every nesting level.
- [ ] Add `timeZone`, `lastSuccessfulScanAt`, and `seenProfileHashes` to the versioned state schema. `connections` contains full PII only while `lastObservedAt` is at most 90 days old. At expiry, remove the entire connection object and retain only `{sha256,lastSeenAt}`; purge that fingerprint after 365 days. Never retain a profile URL in the hash ledger.
- [ ] Add exact day-90/day-91 and day-365/day-366 retention tests. Verify the serialized state contains neither name nor profile URL after PII expiry.
- [ ] Validate the exact seven company-map headers: `company_key`, `company_display`, `linkedin_company_url`, `linkedin_people_url`, `verification_source`, `verified_on`, `status`. Require canonical company/people URLs to share the same company slug, valid verification dates, and accepted status. Reject one key/display mapped to different URLs while allowing multiple reviewed keys to share one parent URL.
- [ ] Group eligible archive rows by canonical application URL and derive matches only for the newest eligible scan date. Add recent+expired and two-recent-date fixtures; only the newest eligible date receives a match.
- [ ] Add safe merge tests for: partial incomplete over prior verified; partial complete new verified; completed employer change; completed `not_current`; skipped source; and incomplete attempted pending rotation.
- [ ] Implement and test strict `worklist` candidate input. Prove 50 pending candidates drain through real select→capture merge cycles as 20/20/10 with no starvation. Every attempt updates `lastVerificationAttemptAt`; incomplete attempts rotate behind never/least-recently attempted work.
- [ ] Add end-to-end `runCli` tests for repository default, `CAREER_OPS_ROOT`, `CAREER_OPS_DATA_DIR`, and `.career-ops-data`. Relative private paths resolve against `getCareerOpsRoot()`; temporary candidate/worklist/capture paths remain absolute and mode `0600`.
- [ ] Run `node --test local/sunny-job-search/tests/referrals.test.mjs` and require zero failures.

---

### Task 2: Complete builder validation and bounded invalid-state fallback

**Files:**
- Modify `data/tools/build-sunny-job-search-index.mjs`
- Modify `local/sunny-job-search/tests/builder.test.mjs`

- [ ] Add RED tests distinguishing all three cases: missing state → fresh jobs, empty contacts, `not_configured`; valid state → exact date-qualified enrichment; existing invalid JSON/schema → fresh base jobs plus only prior cached contacts that pass strict schema, exact date+URL identity, both 14-day gates, and 90-day PII TTL.
- [ ] Validate referral state and prior snapshot contact records before use. A syntactically valid but structurally invalid state is `error`, not `not_configured`.
- [ ] Preserve the whole previous snapshot only for a malformed job archive or failed atomic output replacement. Invalid optional referral data must never freeze unrelated base jobs.
- [ ] Add repeated application-URL tests proving an expired/older snapshot row never inherits a recent contact.
- [ ] Test atomic replacement and file mode `0600` for both first creation and replacement.
- [ ] Run `node --test local/sunny-job-search/tests/builder.test.mjs` and require zero failures.

---

### Task 3: Add executable browser UI and HTTP privacy tests

**Files:**
- Create `local/sunny-job-search/tests/ui-browser.test.mjs`
- Modify `local/sunny-job-search/tests/server.test.mjs`
- Modify UI/server source only if the RED tests expose a defect

- [ ] Create a temporary static root containing the real HTML/CSS/JS plus a fixture `data/jobs.json` with one matched and one unmatched job. Start `serve.mjs` on an ephemeral localhost port.
- [ ] In Playwright Chromium, assert both rows initially render; `#referrals-only` leaves exactly the matched row; referral-name search works; the contact link has the canonical URL and `referrerpolicy="no-referrer"`; name/link copy buttons write exact clipboard payloads; partial/error status is nonblocking.
- [ ] Make an actual HTTP request to the ephemeral server and assert `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and localhost-only binding behavior.
- [ ] Do not accept a missing test file. Start final verification with `test -f local/sunny-job-search/tests/ui-browser.test.mjs`.
- [ ] Run `node --test local/sunny-job-search/tests/app.test.mjs local/sunny-job-search/tests/builder.test.mjs local/sunny-job-search/tests/server.test.mjs local/sunny-job-search/tests/ui-browser.test.mjs` and require zero failures.

---

### Task 4: Repeat the bounded Brave smoke without losing pending work

**Private runtime files only:**
- `data/sunny-linkedin-referrals.json`
- `local/sunny-job-search/data/jobs.json`

- [ ] Snapshot exact pre-smoke files and hashes. Keep `sunny-24` paused.
- [ ] Use the existing Brave Connections tab only. If logged out/challenged, write the skip status and stop browser work. Never authenticate or mutate LinkedIn.
- [ ] If a recent card is observed but its full current Experience cannot be read, store it as `pending_verification`, `profileInspectionComplete: false`, with no current-employer assertion. Do not drop it and do not match it. A later run must be able to select it fairly.
- [ ] Run the real candidate→worklist→capture→merge pipeline and rebuild `jobs.json`. Delete temporary files after merge.
- [ ] Restart the localhost server so it runs the new source. Verify `curl -I http://127.0.0.1:4173/` includes `Referrer-Policy: no-referrer`, and manually inspect the filter/status without opening or messaging any profile.
- [ ] On any schema/UI failure, restore exact prior files or remove exact newly created files and keep `sunny-24` paused.

---

### Task 5: Complete the automation prompt update and exclusive cutover

**External state:** Codex automation `sunny-24`; Grok status only as allowed below.

- [ ] Read the full current `sunny-24` automation and preserve its name, heartbeat kind, RRULE, target thread, notification policy, and complete existing job/Sheet prompt.
- [ ] Verify no overlapping Grok Sunny job writer is active. Do not change Grok prompt or feature logic; if a proven overlapping writer is active, only pause it and read back the status.
- [ ] Append the reviewed Brave referral phase to the full prompt: exact Connections URL; skip logout/challenge; untrusted page content; deterministic worklist; 50-card, 20-profile, 10-minute limits; dual 14-day gate; verified current Experience URL matching; no Sheet person data; no external actions; private state; snapshot rebuild and validation.
- [ ] Update `sunny-24` through the automation API while it remains `PAUSED`, then read back and prove all invariant fields and the original prompt body remain intact.
- [ ] Only after Tasks 1–4 pass, set `sunny-24` to `ACTIVE` through the automation API. Read back status and next run. Do not edit `sunny-nyc` or `sunny-remote`.

---

### Task 6: Final parent-verifiable gate

- [ ] Run the following with `&&`, not semicolons, so any missing file or failed test stops the gate:

```bash
test -f local/sunny-job-search/tests/ui-browser.test.mjs && \
node --test local/sunny-job-search/tests/referrals.test.mjs \
  local/sunny-job-search/tests/app.test.mjs \
  local/sunny-job-search/tests/builder.test.mjs \
  local/sunny-job-search/tests/server.test.mjs \
  local/sunny-job-search/tests/ui-browser.test.mjs && \
node --test tests/sunny-job-queue.test.mjs tests/sunny-serialized-scan.test.mjs && \
node --check local/sunny-job-search/referrals.mjs && \
node --check data/tools/build-sunny-job-search-index.mjs && \
git diff --check
```

- [ ] Audit: state/snapshot/temp files mode `0600`; state and local implementation remain ignored; no PII in tracked diffs/logs; no Sheet referral data; no message/connect/apply/login path; one active scheduler owner only.
- [ ] Report exact test counts, Brave source status, pending/verified/match counts, live localhost header check, automation status/next run, and any remaining blocker. Do not claim completion if any checkbox or readback is missing.

