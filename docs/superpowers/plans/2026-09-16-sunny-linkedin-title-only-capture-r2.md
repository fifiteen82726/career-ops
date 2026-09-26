# Sunny LinkedIn Title-Only Capture Implementation Plan — Revision 2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved Connections-headline-only workflow using the authenticated Brave session, exact reviewed company resolution first, bounded Codex classification second, durable validated company aliases, unresolved skip/cache, deterministic recent-job matching, and zero profile/Experience navigation.

**Architecture:** Browser collection and local mutation are split. The trusted browser runtime writes one private compact capture; the local CLI prepares a private authoritative context plus a PII-minimized request batch; the running Codex automation produces strict decisions; a local finalize command independently validates decisions, persists aliases under lock, merges a schema-v3 ledger, and rebuilds the website. Legacy data uses a bounded employers array so migration is lossless without fabricating headline evidence.

**Tech Stack:** Node.js ES modules, Node test runner, real offline Playwright serialization tests, installed browser Agent API through the trusted Node REPL runtime, TSV/JSON atomic storage, SHA-256 revisions, Codex automation prompt.

**Approved spec:** `docs/superpowers/specs/2026-09-16-sunny-linkedin-title-only-capture-design.md`

**Mandatory golden:** First run reads 20 cards, resolves 9 exactly and 2 through accepted AI decisions, leaves 9 unresolved, sends 4 requests, learns 2 aliases, matches 11 people to 9 jobs, and navigates zero profiles. The identical second run sends zero requests, writes zero aliases, preserves identical match keys, and navigates zero profiles.

**Exclusions:** No live LinkedIn sweep, external model API client, login/challenge recovery, LinkedIn mutation, Google Sheet referral data, schedule activation/manual run, commit, push, merge, deploy, or publish. Preserve unrelated edits, normal job processing, scheduler ownership rules, and Grok behavior.

---

## Ownership

The Terra implementer owns only:

- `local/sunny-job-search/linkedin-capture.mjs`
- `local/sunny-job-search/company-identities.mjs`
- New `local/sunny-job-search/linkedin-title-resolver.mjs`
- New `local/sunny-job-search/company-alias-store.mjs`
- `local/sunny-job-search/referrals.mjs`
- `local/sunny-job-search/linkedin-dom-extractors.mjs`
- `local/sunny-job-search/linkedin-browser-adapter.mjs`
- `data/tools/build-sunny-job-search-index.mjs`
- Their tests/fixtures, including new resolver/store/CLI/golden tests
- `profiles/sunny-linkedin-referral-browser.md`
- Referral-specific lines in `modes/_custom.md`
- Header-only `data/sunny-linkedin-company-aliases.tsv`

The parent owns one prompt-only update to the existing `sunny-24` automation through the app tool after implementation. Preserve status, schedule, destination, target, notifications, model/reasoning and all non-referral prompt content. Do not activate or manually run it.

---

### Task 1: Freeze and verify initial state

- [ ] Verify the supplied hashes for every owned file and record aggregate-only live ledger evidence.
- [ ] Record hashes/modes for the live ledger, website snapshot, alias file, company map, archive, portals, custom rules, and current scheduler prompt.
- [ ] Use fixed copied-audit time `2026-09-16T16:01:01.000Z`.
- [ ] Create only mode-`0700` temporary test roots and mode-`0600` copied private files.
- [ ] Make every test provide state, mapping, archive, and output paths explicitly; no test may rely on production write defaults.
- [ ] Preserve the initial `.gitignore` diff, staged state, unrelated untracked files, and old run artifacts.

Expected baseline: schema 1, 20 connections, 16 match rows, 12 matched people, 9 matched jobs, 21 current-employment records, three current-employment records without company URLs, and exact match-key recomputation at the fixed time.

---

### Task 2: Implement strict compact-card normalization

**Files:** `linkedin-capture.mjs`, `linkedin-capture.test.mjs`

- [ ] Write RED tests for exact current headlines, former/current combinations, multiple-current ambiguity, role-only text, client/agency text, hostile/instruction-like strings, tracking-query profile links, credential/port/path URL attacks, impossible/future dates, New York/DST boundaries, and cross-day relative-date stability.
- [ ] Limit raw extraction input to exactly `profileUrl`, `fullName`, `headline`, and `connectedLabelRaw` with bounded strings.
- [ ] Canonicalize only HTTPS LinkedIn `/in/<slug>/` identity URLs, stripping query/hash after host/path validation; reject credentials, unexpected ports, malformed encoding, and all other paths.
- [ ] Classify relation clauses independently. Only one explicit current employer is eligible. Former-only, client/agency, missing, unsafe, or multiple-current text remains unresolved.
- [ ] Parse conservative New York connection-date ranges. Unknown visible labels cannot match jobs.
- [ ] Compute stable fingerprints without including the person’s name in company evidence.
- [ ] Run the focused test GREEN.

The normalized card has exactly:

```js
{
  profileUrl, fullName, headline, connectedLabelRaw,
  connectedAtEarliest, connectedAtLatest, connectedDatePrecision,
  stableDateIdentity, cardFingerprint, classification, employerLabel,
}
```

---

### Task 3: Implement the reviewed company catalog and deterministic candidates

**Files:** `company-identities.mjs`, `company-identities.test.mjs`

- [ ] Write RED tests for legal suffixes, same-URL map aliases, cross-namespace key/display/slug/alias conflicts, contradictory URLs, unverified/unknown tracked rows, AMEX candidate generation through production code, and unrelated-company preservation.
- [ ] Preserve the canonical key convention: the canonical LinkedIn company URL slug. Map `company_key`, display labels, and URL slugs are aliases, not separate identities. Multiple reviewed rows for one company URL form one identity.
- [ ] Build one `normalized token -> Set<canonical identity>` relation across reviewed keys, displays, slugs, accepted aliases, and explicitly verified tracked labels.
- [ ] Resolve only an unquarantined singleton with consistent URL evidence.
- [ ] Add strict loaders for reviewed company-map TSV, new alias TSV, `portals.yml` through existing `js-yaml`, and Sunny archive company/LinkedIn People fields.
- [ ] Permit tracked rows to enrich an existing reviewed identity only through exact, nonconflicting joins. `enabled`, ATS presence, guessed slug, or fuzzy similarity is not verification.
- [ ] Compute deterministic catalog revision from sorted canonical company-only evidence and alias revision from sorted alias/status data.
- [ ] Generate at most five unique candidates with bounded ranking signals: token overlap, acronym, slug overlap, edit distance, and compound token-prefix abbreviation. `AMEX` may rank American Express through `am` + `ex`; ranking never resolves.
- [ ] Recompute acceptance compatibility locally; caller/model compatibility fields are untrusted. Edit distance alone cannot support durable alias acceptance.
- [ ] Run identity tests GREEN.

Production exports:

```js
parseCompanyMapRows(tsvText)
parseCompanyAliases(tsvText)
loadVerifiedTrackedCompanyRows({ portalsText, archive })
buildCompanyIdentityIndex({ companyMapRows, aliasRows, trackedCompanyRows })
resolveCompanyIdentity(index, evidence)
generateCompanyCandidates(index, observedText, { limit: 5 })
computeCatalogRevision(index)
computeAliasMappingRevision(aliasRows)
```

---

### Task 4: Implement strict private context and PII-minimized AI contracts

**Files:** new `linkedin-title-resolver.mjs`, new `linkedin-title-resolver.test.mjs`

- [ ] Define a private prepared context containing cards, state/catalog/mapping hashes, request-to-card references, deadline and dispositions.
- [ ] Define a separate AI request batch containing only schema version, batch ID, and at most ten PII-minimized entries.
- [ ] Each entry contains request ID, minimized current-employer evidence, observed employer label, `explicit_employer`, and one to five `{canonicalCompanyKey, companyDisplay, linkedinCompanyUrl}` candidates.
- [ ] Strip unrelated headline clauses and reject/redact person names, profile URLs, other URLs, emails, and phone-like text before export. Unsafe labels become unresolved.
- [ ] Derive request IDs without profile identifiers. Hash alias provenance from normalized company evidence, candidates, and validated decision only—not card/profile/name/full headline.
- [ ] Define a strict decision envelope keyed by batch/request IDs. Resolved responses include exact version, decision, candidate key, finite confidence and allowed reason. Unresolved responses include an allowed unresolved reason and no company.
- [ ] Reject unknown fields, wrong types, duplicate/unknown IDs, mismatched batch, malformed JSON, ambiguous/multiple decisions.
- [ ] Accept only a currently valid supplied candidate, confidence `>=0.95`, explicit single current employer, safe label, locally recomputed compatibility, and no quarantine conflict. Invalid output normalizes to unresolved.
- [ ] Sort request IDs deterministically and cap at ten. Cases beyond ten remain `deferred`, never “attempted unresolved.”
- [ ] Add tests for PII embedded inside headline/company text, real AMEX candidates, outside candidates, low confidence, malformed/duplicate decisions, no compatibility, and revision-bound cache identity.

No module calls a live model or external model API.

---

### Task 5: Implement atomic aliases and durable quarantine

**Files:** new `company-alias-store.mjs`, new `company-alias-store.test.mjs`, header-only alias TSV

- [ ] Replace the alias header with the approved nine-column schema:

```tsv
alias_normalized	canonical_company_key	linkedin_company_url	resolution_source	confidence	evidence_fingerprint	catalog_revision	resolved_on	status
```

- [ ] Validate exact headers, calendar dates by round-trip, confidence, keys/URLs, sources/statuses, and 64-character hashes.
- [ ] Support `accepted` and `quarantined`. Preserve an accepted row’s original target/provenance. A conflict makes the alias durably unavailable without overwriting the target. If no accepted row exists, store a bounded company-only quarantined proposal.
- [ ] Make quarantined tokens unavailable in the unified relation on reload.
- [ ] Pass authoritative catalog context into the store. Under an exclusive lock, reload mapping, validate target membership and namespace conflicts, validate the full next TSV, write an exclusive mode-`0600` sibling temp, fsync and rename.
- [ ] Return persisted/reused/quarantined/rejected results plus final mapping revision.
- [ ] Make semantic replay byte-identical even when later evidence/timestamps differ.
- [ ] Preserve bytes on lock/validation/write/rename failure; affected decisions stay unresolved.
- [ ] Finalization consumes the store result and reloaded mapping, never a caller assertion.
- [ ] Test idempotence, concurrent/cross-namespace conflict, persistent quarantine, unknown target, malformed TSV, contention, injected failures, mode and cleanup.

---

### Task 6: Implement a strict schema-v3 ledger with lossless legacy support

**Files:** `referrals.mjs`, `referrals.test.mjs`

- [ ] Define exact schemas for state, connection, employer, match, retained hash, private prepared context and finalized context.
- [ ] Keep one connection per canonical profile URL and a bounded `employers` array. New title-resolved cards have exactly one employer; unresolved cards have none; migrated legacy records may retain multiple minimal employers.
- [ ] Employer records contain company label, nullable canonical key/URL, role title, allowed resolution source, company-only evidence hash and verification timestamp.
- [ ] Allow null canonical identity only for migrated legacy evidence; it cannot match. Preserve URL-less history without promoting it to a reviewed company.
- [ ] Permit null card/resolved-card fingerprints and `legacy` classification only for legacy records. Never fabricate a headline fingerprint. First actual card observation follows title-only rules.
- [ ] Define `resolved`, completed `unresolved`, and `deferred` states explicitly. Completed unresolved state has revision-bound cache metadata; deferred work has no completed-attempt cache.
- [ ] Source-wide skips do not fabricate observations or refresh PII retention timestamps.
- [ ] Export pure migration, validation, preparation, finalization, merge, retention and atomic writer functions. Identity context is explicit.
- [ ] Retain v1/v2 only as strict migration readers. Remove production profile worklists/inspection operations.
- [ ] Migrate the copied baseline without loss: 20 connections, all 21 minimal current legacy employers including URL-less entries, and 16 exact match keys at the fixed time.
- [ ] Add adversarial schema, date, bounds, uniqueness, state-membership, retention and invalid-write tests.

---

### Task 7: Implement cache, freshness, matching and transaction semantics

**Files:** `referrals.mjs`, `referrals.test.mjs`, resolver/store modules

- [ ] Preparation performs: retain/validate state; validate source/cards; recheck resolved identities against current catalog/quarantine; reuse valid unchanged resolutions; exact resolution; reuse completed unresolved cache for same revisions; candidate generation; queue ten; defer remaining.
- [ ] A changed complete card clears prior title/legacy match evidence and reclassifies. Source-wide skips preserve prior good evidence subject to retention.
- [ ] Finalization reloads current state/catalog/mapping, rejects stale prepared state, and uses a documented consistent ledger/alias lock order.
- [ ] Alias persistence may survive later ledger failure as valid configuration, but the run cannot report a successful ledger merge.
- [ ] Rebuild the identity index after alias persistence and settle every card locally.
- [ ] Cache unresolved decisions against final revisions only when exact/candidate evidence is unchanged. If evidence changed, resolve exactly or remain deferred.
- [ ] Deferred cases remain eligible. Test at least 12 cases across multiple runs to prove progress.
- [ ] Match only when both connection-date endpoints and job scan date are within latest 14 New York days and canonical companies are equal. Use the newest eligible row per application URL; deduplicate keys; fuzzy-only never matches.
- [ ] Apply 90-day PII and 365-day hash retention at load, migration, merge and rebuild. Skips do not refresh timestamps. Retained hashes contain no PII.
- [ ] Make identical second-run decisions zero-AI even after first-run alias revision changes.

---

### Task 8: Implement Connections-only collection through the installed browser API

**Files:** `linkedin-dom-extractors.mjs`, `linkedin-browser-adapter.mjs`, their tests/fixtures

- [ ] Remove Experience exports, profile loops, retry/cooldown machinery and profile-cap reporting.
- [ ] Implement `createInstalledLinkedinBridge(agent, selection)` and a browser-only capture function. It returns/writes compact Connections capture and never waits for a model callback.
- [ ] Bootstrap production `agent` through `setupBrowserRuntime` in the trusted Node REPL. Document module path/prerequisite. Do not pretend ordinary Node CLI can import the runtime.
- [ ] Select one explicit existing Brave descriptor through real browser ID/profile metadata. Missing/ambiguous selection skips; never choose arbitrary browser or create a browser profile.
- [ ] Reuse exact Connections tab or create one tab and navigate only to the exact approved URL. Validate URLs with URL parsing and expose no unrestricted navigation.
- [ ] Use actual signatures: `tabs.list/get/new`, `goto(url)`, `playwright.evaluate(function, argument, {timeoutMs})`. Wrap operations lacking native timeout with an absolute deadline guard. Late operations cannot start/write later stages.
- [ ] Serialized extractor validates page URL/security/ordering before cards. Reject wrong URL, unconfirmed Recently added, login/challenge/security verification/CAPTCHA, loading/expansion, unknown structure and unsuccessful empty capture.
- [ ] Extract only visible semantic Connections-list cards, excluding hidden ancestors/sidebars, max 50.
- [ ] Never call screenshot, accessibility/full DOM, HTML export, whole-page text, click, scroll, message or profile APIs. Return fixed codes/counts only.
- [ ] Test with a fake matching installed docs and real offline Playwright serialization. Instrument real navigation calls and prove every destination is Connections-only.

---

### Task 9: Implement the real split-phase CLI and automation handoff

**Files:** `referrals.mjs`, new CLI integration tests, browser protocol

- [ ] Replace old worklist/inspection commands with:

```text
prepare-title --capture <absolute-private-capture> --run-dir <absolute-private-run-dir>
finalize-title --run-dir <same-run-dir> --decisions <absolute-private-decisions>
status
cleanup-owned-run
```

- [ ] Support validated optional state/catalog/archive/time overrides. Model JSON cannot choose arbitrary paths.
- [ ] Preparation writes mode-`0600` private context and minimized `requests.json` under verified mode-`0700` run directory, storing immutable request membership, deadline and input hashes. Stdout is aggregate-only.
- [ ] Running Codex sequence is: collect compact browser cards; prepare; read only requests; write strict decisions to fixed private path; finalize; rebuild; report counts; cleanup.
- [ ] Finalization independently validates decisions against private context and current state/catalog/mapping. Missing/malformed submitted decisions become unresolved; deferred cases remain unattempted. Reject stale/replayed/expired batches.
- [ ] Use data-root precedence for defaults. Validate flags, absolute paths, containment, symlinks and input sizes.
- [ ] Clean on success, skip, failure, timeout and handled interruption. Recover securely from owned expired leftovers later; do not claim survival of uncatchable kill without recovery.
- [ ] Add subprocess CLI tests exercising actual files/modes. Do not bypass CLI with injected AI callbacks.

---

### Task 10: Preserve localhost builder behavior

**Files:** `data/tools/build-sunny-job-search-index.mjs`, `builder.test.mjs`

- [ ] Use actual `snapshot.jobs`, not `snapshot.rows`.
- [ ] Validate/migrate/retain state before enrichment, including direct `buildSnapshot` calls.
- [ ] Preserve fresh unrelated jobs despite referral errors.
- [ ] Missing referral file produces empty contacts and `not_configured`, never cache resurrection.
- [ ] Existing invalid referral file produces fresh jobs, `error`, and only strictly validated prior cached contacts for matching date-qualified job identities within both windows/retention.
- [ ] Invalid archive or atomic output failure preserves prior valid snapshot bytes.
- [ ] Preserve `0600`, temp cleanup, no-referrer links and website interface.
- [ ] Test v1/v2/v3, migration, missing/invalid/stale input, valid bounded cache, rejected cache, repeated URLs, unrelated jobs, atomic failures and retention.

---

### Task 11: Update every operative instruction surface

**Files:** browser protocol, referral lines in `modes/_custom.md`; parent updates current `sunny-24` prompt

- [ ] Replace only referral-specific repo instructions. Preserve scheduler ownership/no-dual-writer rules, privacy, no-referrer links, normal job processing and unrelated bytes.
- [ ] Document exact trusted browser bootstrap, split CLI, schemas, five-candidate limit, ten-request cap, acceptance, aliases, caches, deadline, errors and cleanup.
- [ ] Write a minimal replacement for the active automation’s inline referral section that delegates to the protocol and explicitly prohibits profile/Experience navigation.
- [ ] Parent uses the automation tool to update the existing automation with all existing fields preserved; prompt-only change. Do not activate, run or change another automation.
- [ ] Read back the automation and verify no affirmative legacy profile instruction or obsolete command remains.
- [ ] Protocol tests distinguish a prohibition from an instruction; do not ban necessary words merely because they appear in “never” rules.

---

### Task 12: Run offline golden and preservation gates

- [ ] Route the 20-card semantic fixture through serialized production extractor, installed-interface fake, actual prepare/finalize CLI files, production candidate generator, strict decisions, temporary atomic alias store, v3 matcher and atomic builder.
- [ ] Partition: 9 exact; 2 accepted AI; 4 no-candidate; 3 ambiguous/former-only; 2 AI-unresolved. Four requests, two learned aliases, 11 people, 9 jobs, one fuzzy non-match.
- [ ] Assert first-run prescribed counts and every instrumented navigation destination.
- [ ] Reload alias/state files and rerun identical cards; assert zero requests, zero alias writes, identical match keys, and zero profile navigation.
- [ ] Cover malformed/unknown/duplicate decisions, PII in headline, alias failure, persistent quarantine, catalog invalidation, changed headline clearing matches, exact Acme zero-AI, deferred progression, stale batch, source failure, deadline and cleanup.
- [ ] Mandatory Playwright/golden tests fail clearly if Playwright/browser is unavailable; they may not skip.
- [ ] On the copied ledger at fixed time, require 20 connections, all 21 minimal current legacy employers, 16 exact match keys, 12 people, 9 jobs and correct modes. Print aggregates only.
- [ ] Run:

```bash
node --test local/sunny-job-search/tests/*.test.mjs
node --check local/sunny-job-search/linkedin-capture.mjs
node --check local/sunny-job-search/company-identities.mjs
node --check local/sunny-job-search/linkedin-title-resolver.mjs
node --check local/sunny-job-search/company-alias-store.mjs
node --check local/sunny-job-search/referrals.mjs
node --check local/sunny-job-search/linkedin-dom-extractors.mjs
node --check local/sunny-job-search/linkedin-browser-adapter.mjs
node --check data/tools/build-sunny-job-search-index.mjs
git diff --check
```

- [ ] Audit production modules, protocol, custom rules and read-back scheduler referral block for affirmative profile navigation and unrestricted AI callbacks. Legacy names may appear only in migration/rejection code and fixtures.
- [ ] Verify initial live ledger/website hashes and modes, live alias header-only state, cleanup, unrelated rules/files and staged state. Confirm no excluded action occurred.
- [ ] Supply a full snapshot of changed and ignored files plus scheduler prompt diff to independent implementation review.

## Completion gate

Do not claim completion until a fresh independent implementation reviewer passes the exact snapshot and every mandatory acceptance item above.
