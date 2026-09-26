# Sunny Global Job Search Implementation Plan

> **For agentic workers:** Use test-driven implementation; each behavior below gets a failing test before code.

**Goal:** Provide Sunny a localhost-only searchable view over the durable, locally archived suitable-job results.

**Architecture:** An archive builder validates and deduplicates user-layer rows before atomically replacing a browser snapshot. A dependency-free static page loads that snapshot, performs filtering/sorting in memory, and is served only on loopback.

**Tech Stack:** Node.js ESM, plain HTML/CSS/browser JavaScript, Node test runner, Playwright browser verification.

---

### Task 1: Snapshot builder

**Files:** `data/tools/build-sunny-job-search-index.mjs`, `local/sunny-job-search/tests/builder.test.mjs`

- [ ] Write failing tests for 30-day retention, URL canonical deduplication, required-field validation, and failure-safe atomic refresh.
- [ ] Implement archive normalization, snapshot validation, retention, and atomic replacement.
- [ ] Run the builder tests.

### Task 2: Search interaction model

**Files:** `local/sunny-job-search/app.js`, `local/sunny-job-search/tests/app.test.mjs`

- [ ] Write failing tests for default dates/priority, quick and custom ranges, global search, combined filters, and stable sort toggles.
- [ ] Implement the pure data model and browser bindings.
- [ ] Run the UI model tests.

### Task 3: Static interface and localhost service

**Files:** `local/sunny-job-search/index.html`, `local/sunny-job-search/styles.css`, `local/sunny-job-search/serve.mjs`, `local/sunny-job-search/tests/server.test.mjs`

- [ ] Write failing tests for loopback-only serving and static assets.
- [ ] Implement accessible sheet-style controls, copy actions, safe links, error state, responsive layout, and the server.
- [ ] Run the focused test suite.

### Task 4: Bootstrap and verification

**Files:** `data/sunny-job-search-archive.json`, `local/sunny-job-search/data/jobs.json`, `local/sunny-job-search/README.md`

- [ ] Normalize the exported date-named sheet tabs into the user-layer archive and build the snapshot.
- [ ] Verify the browser at desktop and narrow widths plus all automated tests.
