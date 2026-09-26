# Balanced Education Two-Row Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render each Education entry in Sunny's Balanced A4 resume as two compact rows: school plus date, then degree/GPA plus location, while keeping the school name on one line and preserving a one-page ATS-safe PDF.

**Architecture:** Keep the existing semantic education payload (`title` = degree, `org` = institution) and built-in HTML renderer. Change only the user-owned Balanced A4 template's CSS so the institution is visually ordered above the degree and a normal-flow grid aligns date and location at the right. Update the Zuora payload with the approved abbreviated NYU name, complete date ranges, and locations; persist the layout rule in `modes/_custom.md` for future Balanced resumes.

**Tech Stack:** Node.js, deterministic `build-cv-html.mjs`, Playwright PDF generation, Poppler/pdfplumber PDF inspection, CSS flex/grid layout.

---

### Task 1: Lock the Education layout contract

**Files:**
- Create: `tests/balanced-education-layout.test.mjs`
- Read: `output/cv-template-balanced-a4.html`
- Read: `output/cv-yi-yun-liao-zuora-sr-analyst-revenue-operations-analytics-balanced-a4.json`

- [x] **Step 1: Write the failing regression test**

Create a Node test that asserts the Balanced template reverses the institution and degree visual order without changing their semantic HTML order, prevents institution wrapping, right-aligns the location on the second row, and that the Zuora payload contains the approved institution labels, date ranges, and locations.

- [x] **Step 2: Run the test to verify it fails**

Run: `node tests/balanced-education-layout.test.mjs`

Expected: non-zero exit because the current template lacks the two-row CSS contract and the payload contains graduation dates only.

### Task 2: Implement the approved layout

**Files:**
- Modify: `output/cv-template-balanced-a4.html`
- Modify: `output/cv-yi-yun-liao-zuora-sr-analyst-revenue-operations-analytics-balanced-a4.json`
- Modify: `modes/_custom.md`

- [x] **Step 1: Apply minimal template CSS**

Make `.edu-item` a two-column, two-row CSS Grid, render `.edu-title` as a reversed column spanning both rows, style `.edu-org` as the bold first row with `white-space: nowrap`, remove the generated pipe separator, and place `.edu-location` in the lower-right grid cell. Keep both rows at the existing 9.2 pt Education size and avoid absolute positioning so ATS reading order remains intact.

- [x] **Step 2: Update the Zuora education facts**

Use `New York University, Stern | Courant`, `Jan 2021 - May 2023`, and `New York, NY`; use `Fu Jen Catholic University`, `Sep 2015 - Jun 2019`, and `New Taipei City, Taiwan`. Preserve the existing degrees, GPAs, and Dean's List fact.

- [x] **Step 3: Persist the future-resume rule**

Add a house rule requiring the approved two-row Education layout for Sunny's Balanced A4 resumes and the same compact institution names and full date ranges.

- [x] **Step 4: Run the regression test to verify it passes**

Run: `node tests/balanced-education-layout.test.mjs`

Expected: exit 0 with all Education layout and payload assertions passing.

### Task 3: Rebuild and verify the Zuora resume

**Files:**
- Regenerate: `output/cv-yi-yun-liao-zuora-sr-analyst-revenue-operations-analytics-balanced-a4.html`
- Regenerate: `output/pdf/cv-yi-yun-liao-zuora-sr-analyst-revenue-operations-analytics-balanced-a4-2026-09-16.pdf`
- Create temporarily: `tmp/pdfs/zuora-education-layout-1.png`

- [x] **Step 1: Build the HTML and run deterministic gates**

Run the HTML builder with the Zuora payload and Balanced template, then run `verify-cv-facts.mjs` and `verify-ats.mjs` on the result.

Expected: the fact gate passes and ATS parseability remains at least 90/100.

- [x] **Step 2: Generate a strict one-page A4 PDF**

Run `generate-pdf.mjs` with `--format=a4 --report=001 --max-pages=1 --strict-pages` after marking the PDF edit operation once.

Expected: exit 0 and exactly one page.

- [x] **Step 3: Inspect extracted text and geometry**

Use `pdfinfo` and pdfplumber text/coordinate extraction to confirm one A4 page, both complete Education rows, and the NYU institution text on a single visual line.

- [x] **Step 4: Render and visually inspect the page**

Render the PDF with `pdftoppm -png -r 160`, inspect the page image, and confirm no Education wrapping, overlap, clipping, excessive bottom whitespace, or regression elsewhere.

- [x] **Step 5: Run final verification**

Run the regression test, fact gate, ATS check, PDF page-count check, and text checks again against the final artifacts.

Expected: all commands exit 0; one-page output; zero unresolved placeholders; Education matches the approved screenshot structure.
