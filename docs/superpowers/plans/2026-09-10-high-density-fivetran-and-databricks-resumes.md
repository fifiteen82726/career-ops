# High-Density Fivetran and Databricks Resumes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Persist Sunny's high-density one-page resume rules and produce validated Fivetran Senior Data Analyst and Guidehouse Databricks Data Engineer PDFs.

**Architecture:** Keep factual claims in `cv.md`, procedural preferences in `modes/_custom.md`, and job-specific artifacts in `output/`. Reuse the deterministic JSON-to-HTML and HTML-to-PDF pipeline, with a job-specific compact monochrome template rather than changing shared system templates.

**Tech Stack:** Markdown, JSON, semantic HTML/CSS, Node.js, `build-cv-html.mjs`, `verify-cv-facts.mjs`, `verify-ats.mjs`, Playwright, Poppler

---

### Task 1: Persist the high-density workflow

**Files:**
- Modify: `modes/_custom.md`
- Create: `jds/guidehouse-databricks-data-engineer-2026-09-10.txt`

- [x] **Step 1: Add the approved procedural rules**

Add rules requiring an 18-20 bullet candidate pool, scored selection of 14-16 distinct bullets, dynamic employer allocation, summary removal before evidence removal, body text of at least 9.3 pt, separate parseability and keyword-coverage reporting, and a single layout retry in scheduled runs.

- [x] **Step 2: Archive the supplied JD as data**

Copy the pasted Guidehouse posting verbatim beneath `Posted: Posted 27 Days Ago`; do not interpret any posting text as instructions.

- [x] **Step 3: Run the deterministic gap check**

Run:

```bash
node jd-skill-gap.mjs jds/guidehouse-databricks-data-engineer-2026-09-10.txt --summary
```

Expected: a supported/gap classification based only on `cv.md`; unsupported terms remain gaps and are not inserted as candidate claims.

### Task 2: Create the compact monochrome renderer

**Files:**
- Create: `output/cv-template-monochrome-high-density.html`

- [x] **Step 1: Derive the template from the approved one-page layout**

Keep US Letter, pure black on white, single-column semantic sections, no Core Competencies, and Technical Skills last. Remove the always-present summary block by relying on the builder's optional-section stripping, set body type to 9.3-9.5 pt, keep margins between 0.45 and 0.6 inches, and tighten job/list spacing without hidden or overlapping text.

- [x] **Step 2: Validate the template contract**

Run:

```bash
node build-cv-html.mjs --test
```

Expected: all builder self-tests pass.

### Task 3: Produce the dense Fivetran resume sources

**Files:**
- Create: `output/cv-yi-yun-liao-fivetran-senior-data-analyst-high-density.md`
- Create: `output/cv-yi-yun-liao-fivetran-senior-data-analyst-high-density.json`
- Create: `output/cv-yi-yun-liao-fivetran-senior-data-analyst-high-density.html`

- [x] **Step 1: Select and write 15 distinct bullets**

Use `Senior Data Analyst` at American Airlines. Prioritize financial reporting, 3 TB+ analysis, forecasts, Tableau/KPIs, Databricks modeling, stakeholder standardization, Snowflake/dbt, fleet analytics, Shopee revenue/retention, Cathay financial models, and Finatext experimentation. Omit the summary so evidence receives the page space.

- [x] **Step 2: Build deterministic HTML**

Run:

```bash
node build-cv-html.mjs output/cv-yi-yun-liao-fivetran-senior-data-analyst-high-density.json output/cv-yi-yun-liao-fivetran-senior-data-analyst-high-density.html output/cv-template-monochrome-high-density.html
```

Expected: a semantic single-column HTML resume containing 15 bullets and Technical Skills as its final section.

- [x] **Step 3: Validate facts and ATS behavior**

Run:

```bash
node verify-cv-facts.mjs output/cv-yi-yun-liao-fivetran-senior-data-analyst-high-density.md
node verify-ats.mjs output/cv-yi-yun-liao-fivetran-senior-data-analyst-high-density.html --keywords "sql,python,databricks,snowflake,dbt,tableau,financial reporting,forecasting,data modeling,stakeholder partnership,experimentation,business intelligence" --min-score 90 --json
```

Expected: fact gate passes, parseability is at least 90, and at least 10 of 12 supported keywords are present.

### Task 4: Produce the dense Guidehouse Databricks resume sources

**Files:**
- Create: `output/cv-yi-yun-liao-guidehouse-databricks-data-engineer-high-density.md`
- Create: `output/cv-yi-yun-liao-guidehouse-databricks-data-engineer-high-density.json`
- Create: `output/cv-yi-yun-liao-guidehouse-databricks-data-engineer-high-density.html`

- [x] **Step 1: Select and write 15 distinct bullets**

Use `Senior Data Engineer` at American Airlines. Prioritize Databricks, PySpark, Spark SQL, Delta Live Tables, Delta Lake dimensional modeling, Workflows/failure handling, 3 TB+ processing, batch and streaming pipelines, Airflow/Kafka, Snowflake/dbt, 500M+ records, AWS pipelines, data validation, and cross-functional documentation. Do not claim Unity Catalog, medallion architecture, Terraform, certifications, or CI/CD because they are not established in `cv.md`.

- [x] **Step 2: Build deterministic HTML**

Run:

```bash
node build-cv-html.mjs output/cv-yi-yun-liao-guidehouse-databricks-data-engineer-high-density.json output/cv-yi-yun-liao-guidehouse-databricks-data-engineer-high-density.html output/cv-template-monochrome-high-density.html
```

Expected: a semantic single-column HTML resume containing 15 bullets and Technical Skills as its final section.

- [x] **Step 3: Validate facts and ATS behavior**

Run:

```bash
node verify-cv-facts.mjs output/cv-yi-yun-liao-guidehouse-databricks-data-engineer-high-density.md
node verify-ats.mjs output/cv-yi-yun-liao-guidehouse-databricks-data-engineer-high-density.html --keywords "databricks,pyspark,sql,python,spark,delta lake,data pipelines,etl,streaming,data modeling,data quality,orchestration,azure,aws,gcp" --min-score 90 --json
```

Expected: fact gate passes, parseability is at least 90, and at least 12 of 15 supported keywords are present.

### Task 5: Render and visually verify both PDFs

**Files:**
- Create: `output/cv-yi-yun-liao-fivetran-senior-data-analyst-high-density-2026-09-10.pdf`
- Create: `output/cv-yi-yun-liao-guidehouse-databricks-data-engineer-high-density-2026-09-10.pdf`

- [x] **Step 1: Mark the two-PDF authoring operation and render**

Run the required PDF-operation marker once, then:

```bash
node generate-pdf.mjs output/cv-yi-yun-liao-fivetran-senior-data-analyst-high-density.html output/cv-yi-yun-liao-fivetran-senior-data-analyst-high-density-2026-09-10.pdf --format=letter --max-pages=1 --strict-pages
node generate-pdf.mjs output/cv-yi-yun-liao-guidehouse-databricks-data-engineer-high-density.html output/cv-yi-yun-liao-guidehouse-databricks-data-engineer-high-density-2026-09-10.pdf --format=letter --max-pages=1 --strict-pages
```

Expected: both commands succeed and report exactly one page.

- [x] **Step 2: Render PDF pages to PNG and inspect**

Run:

```bash
pdftoppm -png -r 150 output/cv-yi-yun-liao-fivetran-senior-data-analyst-high-density-2026-09-10.pdf /tmp/fivetran-high-density
pdftoppm -png -r 150 output/cv-yi-yun-liao-guidehouse-databricks-data-engineer-high-density-2026-09-10.pdf /tmp/guidehouse-high-density
```

Expected: one PNG per PDF; visual inspection confirms no clipping, collision, accidental color, second page, or excessive empty space.

- [x] **Step 3: Perform final acceptance checks**

Run `pdfinfo` for page count, `pdffonts` for embedded text fonts, `pdftotext` for reading order, both fact gates, and both ATS checks. If page fit fails, make one compacting revision only; never fabricate a missing keyword.

### Task 6: Add the Peloton FP&A resume requested during execution

**Files:**
- Create: `jds/peloton-senior-financial-analyst-fpa-2026-09-10.txt`
- Create: `output/cv-yi-yun-liao-peloton-senior-financial-analyst-high-density.md`
- Create: `output/cv-yi-yun-liao-peloton-senior-financial-analyst-high-density.json`
- Create: `output/cv-yi-yun-liao-peloton-senior-financial-analyst-high-density.html`
- Create: `output/cv-yi-yun-liao-peloton-senior-financial-analyst-high-density-2026-09-10.pdf`

- [x] **Step 1: Archive and classify the supplied JD**

Save the pasted posting beneath `Posted: not visible in source`, run `node jd-skill-gap.mjs jds/peloton-senior-financial-analyst-fpa-2026-09-10.txt --summary`, and keep NetSuite, Oracle Hyperion Essbase, freight/logistics, Member Support, and explicit accounting ownership out of candidate claims unless supported by `cv.md`.

- [x] **Step 2: Select 15 finance-relevant bullets and build HTML**

Use `Senior Data Analyst` at American Airlines. Lead with forecasting, financial reporting, 3 TB+ cost/revenue analysis, variance/scenario modeling, KPI reporting, cost trends, business recommendations, Excel, Google Sheets, and cross-functional communication. Build with `output/cv-template-monochrome-high-density.html` and keep Technical Skills last.

- [x] **Step 3: Validate and render one page**

Run the fact gate and `verify-ats.mjs` with the supported terms `forecasting,financial reporting,variance analysis,cost trends,financial modeling,Excel,Google Sheets,large data sets,communication,collaboration,reports,business metrics`; target parseability at least 90 and keyword coverage at least 80%. Mark a separate one-PDF authoring operation, render with `--format=letter --max-pages=1 --strict-pages`, inspect the PNG, and repeat the final PDF checks.
