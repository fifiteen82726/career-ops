# Balanced A4 Resume Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checklist syntax for tracking.

**Goal:** Build a reusable Balanced ATS A4 template and regenerate the Fivetran, Guidehouse Databricks, and Peloton resumes as readable one-page PDFs that use the lower page area.

**Architecture:** Preserve all existing Letter artifacts and job-specific content. Create A4 payload copies, render them through one new monochrome template, measure the last text baseline deterministically, and tune only layout variables until each document fits within the approved bottom-space band.

**Tech Stack:** JSON, semantic HTML/CSS, Node.js, `build-cv-html.mjs`, Playwright via `generate-pdf.mjs`, Poppler, `pdfplumber`, `pypdf`, `verify-cv-facts.mjs`, `verify-ats.mjs`

---

### Task 1: Persist the Balanced A4 preference

**Files:**
- Modify: `modes/_custom.md`

- [x] **Step 1: Replace the Letter default with the approved A4 rule**

Use `apply_patch` to replace the existing US Letter default with these requirements: A4, one page, Arial 10.2 pt baseline, at least 10 pt after any fit adjustment, at least 0.5-inch margins, no Summary or Core Competencies, Technical Skills last, and a target residual gap no larger than 0.8 inches above the bottom margin.

- [x] **Step 2: Preserve scheduled-run behavior**

Add that scheduled runs reuse `output/cv-template-balanced-a4.html`, skip GitHub research and design work, and may tune line height, employer spacing, and section spacing once after measuring the rendered page.

### Task 2: Create the shared Balanced A4 template

**Files:**
- Create: `output/cv-template-balanced-a4.html`
- Test: `build-cv-html.mjs --test`

- [x] **Step 1: Write the template**

Use `apply_patch` to create a semantic single-column template with `@page { size: A4; margin: 0; }`, a `210mm × 297mm` page, `0.55in` padding, Arial/Helvetica/sans-serif, `10.2pt` body text, `1.27` baseline line height, `9.2pt` contact text, `9.4pt` role metadata, `10.8pt` section titles, and `22px` name text. Define the tunable CSS variables `--body-leading`, `--job-gap`, `--section-gap`, and `--bullet-gap`; use pure `#000000` and `#ffffff` only.

- [x] **Step 2: Keep the approved section topology**

Render only Header, Work Experience, Education, and Technical Skills. Keep contact information in the body. Do not include placeholders or markup for Summary, Core Competencies, tables, sidebars, images, icons, headers, or footers.

- [x] **Step 3: Verify the renderer contract**

Run:

```bash
node build-cv-html.mjs --test
```

Expected: `status` is `self-test-passed`.

### Task 3: Create A4 sources without changing content

**Files:**
- Create: `output/cv-yi-yun-liao-fivetran-senior-data-analyst-balanced-a4.md`
- Create: `output/cv-yi-yun-liao-fivetran-senior-data-analyst-balanced-a4.json`
- Create: `output/cv-yi-yun-liao-guidehouse-databricks-data-engineer-balanced-a4.md`
- Create: `output/cv-yi-yun-liao-guidehouse-databricks-data-engineer-balanced-a4.json`
- Create: `output/cv-yi-yun-liao-peloton-senior-financial-analyst-balanced-a4.md`
- Create: `output/cv-yi-yun-liao-peloton-senior-financial-analyst-balanced-a4.json`

- [x] **Step 1: Copy the three approved Markdown sources**

Copy each `*-high-density.md` source to its matching `*-balanced-a4.md` path byte-for-byte. Verify with `cmp` so no candidate text changes during this layout pass.

- [x] **Step 2: Create A4 JSON payloads**

Use `jq '.page_format = "a4"'` on each approved `*-high-density.json` source and write the result to its matching `*-balanced-a4.json` path. Compare `jq 'del(.page_format)'` output between source and destination; the only semantic difference must be `page_format`.

- [x] **Step 3: Confirm content counts**

Run a Node.js assertion over all three A4 payloads requiring five experience entries, two education entries, three skill categories, and exactly 15 experience bullets.

### Task 4: Build and validate A4 HTML

**Files:**
- Create: `output/cv-yi-yun-liao-fivetran-senior-data-analyst-balanced-a4.html`
- Create: `output/cv-yi-yun-liao-guidehouse-databricks-data-engineer-balanced-a4.html`
- Create: `output/cv-yi-yun-liao-peloton-senior-financial-analyst-balanced-a4.html`

- [x] **Step 1: Build all three HTML files**

Run `build-cv-html.mjs` once per JSON payload with `output/cv-template-balanced-a4.html`. Expected for each: `valid: true`, five experience entries, two education entries, three skill categories, 15 bullets, and no warnings.

- [x] **Step 2: Run the fact gate**

Run `verify-cv-facts.mjs` on each HTML file. Percentages, currency, and multiplier checks must pass. Manually trace the extractor's known count warnings (`15+`, `300+`, and GPA denominators) to `cv.md`.

- [x] **Step 3: Run ATS checks**

Run the same supported-keyword lists used for the approved versions:

```text
Fivetran: SQL, Python, Databricks, Snowflake, dbt, Tableau, financial reporting, forecasting, data modeling, stakeholder partnership, experimentation, business intelligence
Guidehouse: Databricks, PySpark, SQL, Python, Spark, Delta Lake, data pipelines, ETL, streaming, data modeling, data quality, orchestration, Azure, AWS, GCP
Peloton: forecasting, financial reporting, variance analysis, cost trends, financial modeling, Excel, Google Sheets, large data sets, communication, collaboration, reports, business metrics
```

Expected: parseability at least 90/100 and supported-keyword coverage no lower than 92%, 94%, and 92%, respectively.

### Task 5: Render, measure, and tune the three PDFs

**Files:**
- Create: `output/cv-yi-yun-liao-fivetran-senior-data-analyst-balanced-a4-2026-09-13.pdf`
- Create: `output/cv-yi-yun-liao-guidehouse-databricks-data-engineer-balanced-a4-2026-09-13.pdf`
- Create: `output/cv-yi-yun-liao-peloton-senior-financial-analyst-balanced-a4-2026-09-13.pdf`
- Create temporarily: `tmp/pdfs/*-balanced-a4.png`

- [x] **Step 1: Register the authoring operation once**

Immediately before the first PDF render, run exactly:

```bash
node /Users/coda/.codex/plugins/cache/openai-primary-runtime/pdf/26.904.11930/skills/pdf/container_tools/mark_artifact_operation_started.mjs --operation-kind create --expected-output-count 3 --output-format pdf
```

Expected: exit code 0. Do not run this marker again during the same three-PDF authoring operation.

- [x] **Step 2: Render with a strict A4 one-page budget**

Run `generate-pdf.mjs` for each HTML/PDF pair with `--format=a4 --max-pages=1 --strict-pages`. Expected: three successful PDFs, each reporting one page.

- [x] **Step 3: Measure page utilization**

Use `pdfplumber` to read the last text character's `bottom` coordinate. Require:

```text
page_count == 1
page_width approximately 595 pt
page_height approximately 842 pt
last_text_bottom <= page_height - 0.5in
(page_height - 0.5in - last_text_bottom) <= 0.8in
```

- [x] **Step 4: Tune spacing when the measured gap is too large**

Keep font size at `10.2pt` initially. Increase `--body-leading` in `0.04` increments from `1.27` to at most `1.51`, then increase `--job-gap` from `5px` to at most `9px`, `--section-gap` from `7px` to at most `11px`, and `--bullet-gap` from `1.5px` to at most `3px`. Apply the smallest per-document override that reaches the accepted band; rerender after each adjustment. If a PDF overflows, back off the last increment. Never reduce body text below `10pt` or margins below `0.5in`.

- [x] **Step 5: Render PNGs and inspect visually**

Run `pdftoppm -png -r 150 -f 1 -singlefile` for all three PDFs. Inspect each image at original resolution for clipping, collisions, orphans, alignment, pure-black styling, readable line spacing, and balanced bottom space.

### Task 6: Run final acceptance checks and clean QA files

**Files:**
- Verify: the three `*-balanced-a4-2026-09-13.pdf` files
- Remove: only the three generated `tmp/pdfs/*-balanced-a4.png` files

- [x] **Step 1: Verify text structure and page geometry**

Use `pypdf` to assert one page, selectable text, Work Experience before Education before Technical Skills, and absence of Professional Summary and Core Competencies. Use `pdfinfo` to confirm A4 geometry.

- [x] **Step 2: Re-run fresh fact and ATS checks**

Repeat all three fact gates and ATS commands after the final layout changes. Expected: no unsupported metric failure, parseability at least 90, and keyword coverage at least 92%/94%/92%.

- [x] **Step 3: Confirm protected paths and preserve prior artifacts**

Run `git status --short -- cv.md cv-template templates output modes/_custom.md`. Confirm `cv.md`, `cv-template/`, and `templates/` were not changed by this work, and verify the earlier Letter PDFs still exist.

- [x] **Step 4: Remove only QA images**

Delete the three exact PNG paths with `unlink`, remove empty QA directories with `rmdir`, and leave all final Markdown, JSON, HTML, and PDF artifacts intact.
