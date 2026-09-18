# Sunny Recent Connections Referral UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a filter-synchronized recent Connections section where Sunny selects same-company jobs and generates an editable, copyable multi-job referral message.

**Architecture:** Keep `jobs.json` as the only browser data source. Add pure grouping/search/message helpers to `app.js`, render connection cards from the same filtered job set, and use one native dialog for message editing and copy. No LinkedIn capture or persistence code changes.

**Tech Stack:** Static HTML, CSS, browser JavaScript ES modules, Node's built-in test runner, Playwright browser tests.

---

### Task 1: Define pure referral-view behavior

**Files:**
- Modify: `local/sunny-job-search/tests/app.test.mjs`
- Modify: `local/sunny-job-search/app.js`

- [x] **Step 1: Write failing unit tests** for grouping visible jobs by connection/company, person-aware query behavior, deduplication, and singular/plural referral messages containing `yiyunliao21@gmail.com`.
- [x] **Step 2: Run `node --test local/sunny-job-search/tests/app.test.mjs`** and confirm failures are caused by missing exported helpers.
- [x] **Step 3: Add minimal pure helpers** `filterReferralJobs`, `groupReferralConnections`, and `buildReferralMessage` in `app.js`.
- [x] **Step 4: Re-run the unit test** and confirm all tests pass.
- [x] **Step 5: Defer commit** because this checkout contains user-owned uncommitted work and the user did not request a commit.

### Task 2: Render and interact with Connections

**Files:**
- Modify: `local/sunny-job-search/index.html`
- Modify: `local/sunny-job-search/styles.css`
- Modify: `local/sunny-job-search/app.js`
- Modify: `local/sunny-job-search/tests/ui-browser.test.mjs`

- [x] **Step 1: Write failing browser assertions** for synchronized search, connection cards, per-job checkboxes, disabled/enabled generation, editable modal content, plural job list, and copying the edited message.
- [x] **Step 2: Run `node --test local/sunny-job-search/tests/ui-browser.test.mjs`** and confirm the new assertions fail on missing UI.
- [x] **Step 3: Add semantic section and native dialog markup** below `適合職缺`.
- [x] **Step 4: Add rendering and selection state** in `app.js`, pruning selections whenever filtering hides a job.
- [x] **Step 5: Add responsive styling** matching the existing teal visual system.
- [x] **Step 6: Re-run the browser test** and confirm it passes.
- [x] **Step 7: Defer commit** because this checkout contains user-owned uncommitted work and the user did not request a commit.

### Task 3: Document and verify the workflow

**Files:**
- Modify: `local/sunny-job-search/README.md`
- Modify: `modes/_custom.md`

- [x] **Step 1: Document** that the Connections section is derived from `referralContacts`, shares the global filters, and generates same-company messages locally.
- [x] **Step 2: Record the user workflow** in `modes/_custom.md` so future UI refreshes preserve it.
- [x] **Step 3: Run the complete local website test suite** with `node --test local/sunny-job-search/tests/*.test.mjs`.
- [x] **Step 4: Run syntax checks** for `app.js` and inspect the final diff for unrelated changes.
- [x] **Step 5: Defer commit** until the user explicitly requests one.
