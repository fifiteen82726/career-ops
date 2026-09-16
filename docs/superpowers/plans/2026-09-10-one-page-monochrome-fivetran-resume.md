# One-Page Monochrome Fivetran Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce one polished, one-page, all-black US-English resume for both Fivetran Senior Data Analyst openings, with no Core Competencies section and Technical Skills at the bottom.

**Architecture:** Keep `cv.md` as the unchanged fact bank. Store the durable US-resume layout preference in `modes/_custom.md`, then create a compact job-specific JSON payload and Markdown mirror under `output/`. Render the payload through an isolated output-layer HTML template so the shared career-ops template remains untouched.

**Tech Stack:** Markdown, JSON, semantic HTML/CSS, `build-cv-html.mjs`, Playwright via `generate-pdf.mjs`, Poppler, `verify-cv-facts.mjs`, `verify-ats.mjs`

---

### Task 1: Persist the approved US-resume presentation rules

**Files:**
- Modify: `modes/_custom.md`

- [x] **Step 1: Add the durable resume-format rules**

Append these rules under `## House Rules`:

```markdown
- For Sunny's current U.S. search, default tailored resumes to one US Letter page unless the user explicitly requests a longer version.
- Use a white background with pure-black text, links, and rules; do not use colored or gray decorative accents.
- Do not include a Core Competencies section or a standalone keyword block. Place truthful role keywords in the summary, experience bullets, and skills.
- Keep Technical Skills as the final resume section.
```

- [x] **Step 2: Verify the rules are present once**

Run:

```bash
rg -n "one US Letter page|Core Competencies|Technical Skills as the final" modes/_custom.md
```

Expected: one match for each new rule and no duplicate block.

- [x] **Step 3: Preserve the user-layer privacy boundary**

Run:

```bash
git check-ignore -v modes/_custom.md
```

Expected: `.gitignore` identifies `modes/_custom.md` as user-layer data. Keep it local and do not force-add it.

### Task 2: Create the compact tailored resume sources

**Files:**
- Create: `output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page.md`
- Create: `output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page.json`

- [x] **Step 1: Write the Markdown resume mirror**

Write this exact source, using ASCII hyphens for date ranges:

```markdown
# Yi-Yun (Sunny) Liao

New York, NY | (929) 313-3362 | yiyunliao21@gmail.com | [linkedin.com/in/yi-yun-liao](https://www.linkedin.com/in/yi-yun-liao/)

## Professional Summary

Senior Data Analyst with an engineering foundation in SQL, Python, Databricks, Snowflake, and dbt. Builds workforce and revenue reporting, forecasts, data models, and BI from 3 TB+ datasets; improved forecast accuracy by 11% and surfaced $1M+ in revenue.

## Work Experience

### American Airlines | Senior Data Analyst

Dallas, TX | August 2023 - Present

- Built recurring financial reporting datasets with SQL and Databricks; reconciled booking, channel, and ancillary revenue metrics to source tables and improved forecast accuracy by 11% for quarterly planning.
- Analyzed 3 TB+ of booking, customer, revenue, channel, and workforce data with SQL and Python, reducing customer acquisition cost by 7% and surfacing $1M+ in incremental revenue.
- Designed and automated 15+ Tableau dashboards and self-service KPI workflows for booking conversion, channel productivity, and workforce planning; increased conversion by 3% and reduced metric disputes in executive reviews.
- Built Databricks and Spark ETL pipelines, automated failure detection and scheduling, and designed Delta Lake dimensional models; reduced job failures by 8% and improved query performance by 4%.

### PACCAR | Data Engineer

Dallas, TX | June 2022 - August 2022

- Built Snowflake and dbt ETL workflows with incremental models and partition pruning, reducing processing time by 6% and improving query efficiency by 4%.
- Analyzed 500M+ geofence, service, and telemetry records in Snowflake SQL, reducing unexpected truck breakdowns by 2% and operating costs by 3%.

### Shopee | Data Analyst

Taipei, Taiwan | July 2021 - August 2021

- Analyzed 100M+ customer records with Python and Presto SQL to identify repurchase drivers, discount sensitivity, and conversion friction, increasing repurchase rate by 9%.
- Built recurring Power BI views for purchasing, campaign, funnel, and monetization performance, increasing monthly average revenue per customer by 4%.

### Cathay United Bank | Data Engineer

Taipei, Taiwan | March 2021 - June 2021

- Built credit-risk classification, installment-propensity, and next-best-action models for credit-spend behavior, improving customer financial health outcomes by 7%.

### Finatext | Data Analyst

Taipei, Taiwan | August 2020 - January 2021

- Analyzed 20M+ subway transactions with Python and MySQL, translated monetization patterns into product recommendations, and led A/B tests that increased subway-card usage by 5%.

## Education

**New York University, Stern School of Business and Courant Institute** | M.S. in Information Systems, GPA: 3.59/4.0 | May 2023

**Fu Jen Catholic University** | B.A. in Economics, GPA: 3.76/4.0, Dean's List for three semesters | June 2019

## Technical Skills

- **Data and modeling:** SQL, Python, PySpark, Databricks, Spark, Delta Lake, Snowflake, dbt, BigQuery, Airflow, Kafka
- **Analytics:** Forecasting, financial reporting, workforce analytics, statistical modeling, A/B testing, causal inference, KPI frameworks
- **BI, cloud, and tools:** Tableau, Power BI, Looker, Excel, Google Sheets, Azure, AWS, GCP, Git
```

- [x] **Step 2: Write the renderer payload**

Create this exact JSON payload, matching the Markdown content:

```json
{
  "lang": "en",
  "page_format": "letter",
  "candidate": {
    "name": "Yi-Yun (Sunny) Liao",
    "phone": "(929) 313-3362",
    "email": "yiyunliao21@gmail.com",
    "linkedin": {
      "url": "https://www.linkedin.com/in/yi-yun-liao/",
      "display": "linkedin.com/in/yi-yun-liao"
    },
    "location": "New York, NY"
  },
  "sections": {
    "summary": "Professional Summary",
    "experience": "Work Experience",
    "education": "Education",
    "skills": "Technical Skills"
  },
  "summary": "Senior Data Analyst with an engineering foundation in **SQL, Python, Databricks, Snowflake, and dbt**. Builds workforce and revenue reporting, forecasts, data models, and BI from **3 TB+ datasets**; improved forecast accuracy by **11%** and surfaced **$1M+ in revenue**.",
  "experience": [
    {
      "company": "American Airlines",
      "role": "Senior Data Analyst",
      "location": "Dallas, TX",
      "dates": "August 2023 - Present",
      "bullets": [
        "Built recurring financial reporting datasets with **SQL and Databricks**; reconciled booking, channel, and ancillary revenue metrics to source tables and improved forecast accuracy by **11%** for quarterly planning.",
        "Analyzed **3 TB+** of booking, customer, revenue, channel, and workforce data with SQL and Python, reducing customer acquisition cost by **7%** and surfacing **$1M+ in incremental revenue**.",
        "Designed and automated **15+ Tableau dashboards** and self-service KPI workflows for booking conversion, channel productivity, and workforce planning; increased conversion by **3%** and reduced metric disputes in executive reviews.",
        "Built Databricks and Spark ETL pipelines, automated failure detection and scheduling, and designed Delta Lake dimensional models; reduced job failures by **8%** and improved query performance by **4%**."
      ]
    },
    {
      "company": "PACCAR",
      "role": "Data Engineer",
      "location": "Dallas, TX",
      "dates": "June 2022 - August 2022",
      "bullets": [
        "Built Snowflake and dbt ETL workflows with incremental models and partition pruning, reducing processing time by **6%** and improving query efficiency by **4%**.",
        "Analyzed **500M+** geofence, service, and telemetry records in Snowflake SQL, reducing unexpected truck breakdowns by **2%** and operating costs by **3%**."
      ]
    },
    {
      "company": "Shopee",
      "role": "Data Analyst",
      "location": "Taipei, Taiwan",
      "dates": "July 2021 - August 2021",
      "bullets": [
        "Analyzed **100M+ customer records** with Python and Presto SQL to identify repurchase drivers, discount sensitivity, and conversion friction, increasing repurchase rate by **9%**.",
        "Built recurring Power BI views for purchasing, campaign, funnel, and monetization performance, increasing monthly average revenue per customer by **4%**."
      ]
    },
    {
      "company": "Cathay United Bank",
      "role": "Data Engineer",
      "location": "Taipei, Taiwan",
      "dates": "March 2021 - June 2021",
      "bullets": [
        "Built credit-risk classification, installment-propensity, and next-best-action models for credit-spend behavior, improving customer financial health outcomes by **7%**."
      ]
    },
    {
      "company": "Finatext",
      "role": "Data Analyst",
      "location": "Taipei, Taiwan",
      "dates": "August 2020 - January 2021",
      "bullets": [
        "Analyzed **20M+ subway transactions** with Python and MySQL, translated monetization patterns into product recommendations, and led A/B tests that increased subway-card usage by **5%**."
      ]
    }
  ],
  "education": [
    {
      "title": "M.S. in Information Systems, GPA: 3.59/4.0",
      "org": "New York University, Stern School of Business and Courant Institute",
      "year": "May 2023"
    },
    {
      "title": "B.A. in Economics, GPA: 3.76/4.0, Dean's List for three semesters",
      "org": "Fu Jen Catholic University",
      "year": "June 2019"
    }
  ],
  "skills": [
    {
      "category": "Data and modeling",
      "items": "SQL, Python, PySpark, Databricks, Spark, Delta Lake, Snowflake, dbt, BigQuery, Airflow, Kafka"
    },
    {
      "category": "Analytics",
      "items": "Forecasting, financial reporting, workforce analytics, statistical modeling, A/B testing, causal inference, KPI frameworks"
    },
    {
      "category": "BI, cloud, and tools",
      "items": "Tableau, Power BI, Looker, Excel, Google Sheets, Azure, AWS, GCP, Git"
    }
  ]
}
```

Do not include a `competencies` key.

- [x] **Step 3: Check structure, language, and prohibited content**

Run:

```bash
jq -e '.lang == "en" and .page_format == "letter" and (.competencies | not) and ([.experience[].bullets | length] == [4,2,2,1,1]) and (.education | length == 2) and (.skills | length >= 2)' output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page.json
rg -n "Core Competencies|HRIS|ATS platform|NetSuite|LookML|Sigma|Hex" output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page.{md,json}
```

Expected: `jq` prints `true`; `rg` exits with no matches.

### Task 3: Build the isolated monochrome one-page template and HTML

**Files:**
- Create: `output/cv-template-monochrome-one-page.html`
- Create: `output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page.html`

- [x] **Step 1: Create the semantic one-column template**

Write this exact one-column template. It intentionally omits every competency, image, gradient, sidebar, and icon placeholder:

```html
<!doctype html>
<html lang="{{LANG}}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{NAME}} - Resume</title>
  <style>
    :root {
      --ink: #000000;
      --paper: #ffffff;
    }

    @page { size: letter; margin: 0; }

    * { box-sizing: border-box; }

    html,
    body {
      width: 8.5in;
      min-height: 11in;
      margin: 0;
      padding: 0;
      background: var(--paper);
      color: var(--ink);
      font-family: Arial, Helvetica, sans-serif;
      font-size: 10.4pt;
      line-height: 1.32;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    .page {
      width: {{PAGE_WIDTH}};
      min-height: 11in;
      padding: 0.48in 0.58in 0.44in;
      background: var(--paper);
      color: var(--ink);
    }

    .header {
      text-align: center;
      padding-bottom: 2px;
    }

    h1 {
      margin: 0 0 3px;
      color: var(--ink);
      font-size: 22px;
      line-height: 1.05;
      letter-spacing: 0.01em;
      font-weight: 700;
    }

    a {
      color: var(--ink);
      text-decoration: none;
      white-space: nowrap;
    }

    .contact-row {
      display: flex;
      justify-content: center;
      align-items: baseline;
      flex-wrap: wrap;
      gap: 0 5px;
      color: var(--ink);
      font-size: 9.3pt;
      line-height: 1.2;
    }

    .separator { color: var(--ink); }

    .section { margin-top: 8px; }

    .section-title {
      margin: 0 0 4px;
      padding: 0 0 2.5px;
      border-bottom: 1px solid var(--ink);
      color: var(--ink);
      font-size: 10.7pt;
      line-height: 1.1;
      font-weight: 700;
      letter-spacing: 0.055em;
      text-transform: uppercase;
    }

    .summary-text {
      margin: 0;
      color: var(--ink);
      line-height: 1.34;
    }

    strong { font-weight: 700; }

    .job {
      margin: 0 0 6px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .job-header,
    .edu-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 10px;
    }

    .job-company,
    .edu-title {
      color: var(--ink);
      font-weight: 700;
    }

    .job-company { font-size: 10.4pt; }

    .job-period,
    .edu-year {
      color: var(--ink);
      font-size: 9.2pt;
      white-space: nowrap;
    }

    .job-role,
    .job-location {
      display: inline;
      color: var(--ink);
      font-size: 9.4pt;
      line-height: 1.18;
    }

    .job-role {
      font-style: italic;
      font-weight: 700;
    }

    .job-location::before { content: " | "; }

    ul {
      margin: 2px 0 0 14px;
      padding: 0;
    }

    li {
      margin: 0 0 2px;
      padding-left: 1px;
    }

    .edu-item {
      margin: 0 0 3px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .edu-title { font-size: 9pt; }

    .edu-org {
      color: var(--ink);
      font-weight: 400;
    }

    .edu-org::before { content: " | "; }

    .skills-grid { margin: 0; }

    .skill-item {
      margin: 0 0 1px;
      color: var(--ink);
      font-size: 9.2pt;
      line-height: 1.25;
    }

    .skill-category {
      color: var(--ink);
      font-weight: 700;
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <h1>{{NAME}}</h1>
      <div class="contact-row">
        <span>contact</span>
      </div>
    </div>

    <main>
      <section class="section">
        <h2 class="section-title">{{SECTION_SUMMARY}}</h2>
        <div class="summary-text">{{SUMMARY_TEXT}}</div>
      </section>

      <section class="section">
        <h2 class="section-title">{{SECTION_EXPERIENCE}}</h2>
        {{EXPERIENCE}}
      </section>

      <section class="section">
        <h2 class="section-title">{{SECTION_EDUCATION}}</h2>
        {{EDUCATION}}
      </section>

      <section class="section">
        <h2 class="section-title">{{SECTION_SKILLS}}</h2>
        {{SKILLS}}
      </section>
    </main>
  </div>
</body>
</html>
```

- [x] **Step 2: Build the final HTML from JSON**

Run:

```bash
node build-cv-html.mjs \
  output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page.json \
  output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page.html \
  output/cv-template-monochrome-one-page.html
```

Expected: JSON report with `valid: true`, five experience entries, two education entries, ten bullets, and zero competencies.

- [x] **Step 3: Run source-of-truth and ATS checks**

Run:

```bash
node verify-cv-facts.mjs output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page.html
node verify-ats.mjs output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page.html \
  --role "Senior Data Analyst" \
  --keywords "SQL,Python,Databricks,Snowflake,dbt,forecasting,data modeling,financial reporting,workforce analytics,Tableau,Power BI,A/B testing,stakeholder partnership" \
  --min-score 85
```

Expected: no unsupported claim; ATS score at least 85 with no critical issue.

- [x] **Step 4: Check structural and visual constraints in source**

Run:

```bash
test -z "$(rg -n 'Core Competencies|gradient|<img|#[0-9a-fA-F]{6}' output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page.html | rg -v '#000000|#ffffff' || true)"
test "$(rg -n 'Technical Skills' output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page.html | cut -d: -f1)" -gt "$(rg -n 'Education' output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page.html | cut -d: -f1)"
```

Expected: both checks exit zero.

### Task 4: Render and visually verify the final PDF

**Files:**
- Create: `output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page-2026-09-10.pdf`
- Create temporarily: `tmp/pdfs/fivetran-one-page-1.png`

- [x] **Step 1: Register the PDF authoring operation once**

Run exactly once before rendering:

```bash
node "$CODEX_HOME/plugins/cache/openai-primary-runtime/pdf/26.904.11930/skills/pdf/container_tools/mark_artifact_operation_started.mjs" \
  --operation-kind create --expected-output-count 1 --output-format pdf
```

Expected: successful registration.

- [x] **Step 2: Render with a strict one-page budget**

Run:

```bash
node generate-pdf.mjs \
  output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page.html \
  output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page-2026-09-10.pdf \
  --format=letter --max-pages=1 --strict-pages
```

Expected: `Pages: 1` and a successful PDF path.

- [x] **Step 3: Verify PDF geometry, text, and lack of images**

Run:

```bash
pdfinfo output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page-2026-09-10.pdf
pdftotext -layout output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page-2026-09-10.pdf -
pdfimages -list output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page-2026-09-10.pdf
```

Expected: one 612 x 792 pt page, complete selectable text, Technical Skills last, and no embedded raster images.

- [x] **Step 4: Render a QA image and inspect it**

Run:

```bash
mkdir -p tmp/pdfs
pdftoppm -png -r 150 -f 1 -singlefile \
  output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page-2026-09-10.pdf \
  tmp/pdfs/fivetran-one-page
```

Inspect `tmp/pdfs/fivetran-one-page.png` at full-page and original resolution. Check black-only styling, readable type, consistent alignment and spacing, no collisions or clipping, no awkward orphan lines, and a balanced bottom margin. If any defect appears, edit the source or template, rebuild, rerender, and repeat all checks.

- [x] **Step 5: Confirm protected sources and final artifact set**

Run:

```bash
git status --short -- cv.md cv-template templates modes/_custom.md \
  output/cv-template-monochrome-one-page.html \
  output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page.md \
  output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page.json \
  output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page.html \
  output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page-2026-09-10.pdf
```

Expected: only `modes/_custom.md` and the new one-page output artifacts are changed by implementation; `cv.md`, `cv-template/`, and `templates/` have no implementation changes.
