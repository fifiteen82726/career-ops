# One-Page Monochrome Fivetran Resume Design

**Date:** 2026-09-10

## Goal

Replace the current Fivetran resume presentation with one concise US-English resume that can be submitted to either of these roles:

- Senior Data Analyst, People (Greenhouse job 7918612003)
- Senior Data Analyst, Revenue (Greenhouse job 7918614003)

The finished PDF must be exactly one US Letter page, entirely black and white, and easy for both recruiters and applicant-tracking systems to read.

## Scope and Source Boundaries

- Use `cv.md` as the sole source for candidate facts.
- Use the two archived Fivetran job descriptions only to prioritize truthful evidence and terminology.
- Do not change `cv.md`, any file under `cv-template/`, or the repository-wide template under `templates/`.
- Keep the American Airlines title as `Senior Data Analyst` for this application.
- Do not add unsupported experience with HRIS/ATS platforms, NetSuite, CRM or billing systems, LookML, Sigma, or Hex.
- Preserve unrelated working-tree changes.

## Visual Direction

The resume uses a restrained, traditional professional style:

- Single-column layout on US Letter paper
- White background; all authored text, links, and rules use pure black
- No gradients, colored accents, icons, profile image, charts, sidebars, or decorative blocks
- One readable sans-serif type family with a standard local fallback
- Compact name and contact header with black link text
- Clear hierarchy created only through font size, weight, spacing, and thin black rules
- Consistent left alignment and compact, readable bullet spacing
- No content clipping, overlap, or unusually narrow margins

The implementation will use a Fivetran-specific HTML template stored with the generated output. This keeps the one-page treatment isolated and avoids altering career-ops' shared system template.

## Information Architecture

The content order is fixed:

1. Name and contact details
2. Two-line professional summary
3. Professional Experience
4. Education
5. Technical Skills

There will be no `Core Competencies` heading or keyword block anywhere in the document. Truthful job keywords will instead appear naturally in the summary, experience bullets, and the compact skills section at the bottom.

## Content Budget

The resume is edited for evidence density rather than retaining every fact from `cv.md`. The canonical file remains the complete fact bank for future tailoring.

- American Airlines: four bullets
- PACCAR: two bullets
- Shopee: two bullets
- Cathay Financial Holdings: one bullet
- Finatext: one bullet
- Education: two compact entries
- Technical Skills: two or three compact lines at the bottom

The summary will position the candidate as a senior data analyst with an analytics-engineering foundation and experience supporting both workforce and revenue decisions. Bullets will prioritize verified scope, business outcomes, financial and workforce reporting, forecasting, data modeling, pipeline reliability, experimentation, and self-service BI.

If the first render exceeds one page, content will be shortened in this order:

1. Remove lower-priority wording and repeated tool names.
2. Tighten bullet phrasing without combining unrelated metrics.
3. Reduce summary length.
4. Make small spacing adjustments while preserving comfortable readability.

Font size and margins will not be reduced to an obviously cramped or recruiter-hostile result merely to force a page count.

## ATS Treatment

ATS compatibility comes from semantic HTML, selectable text, conventional headings, a single reading column, and truthful keyword placement. It does not require a visible keyword-dump section.

Supported terms such as SQL, Python, Databricks, Snowflake, dbt, forecasting, data modeling, financial reporting, workforce analytics, Tableau, Power BI, experimentation, and stakeholder partnership may be woven into the summary, evidence bullets, and bottom skills section. Unsupported systems remain absent even when they appear in a Fivetran posting.

## Output Files

Generate a new comparison-safe set of artifacts rather than deleting the earlier version:

- `output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page.md`
- `output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page.json`
- `output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page.html`
- `output/cv-yi-yun-liao-fivetran-senior-data-analyst-one-page-2026-09-10.pdf`
- `output/cv-template-monochrome-one-page.html`

The earlier two-page artifacts remain available for comparison until the user decides they are no longer useful.

## Validation and Acceptance Criteria

The redesign is complete only when all of the following are true:

- PDF page size is US Letter and page count is exactly one.
- All authored visual styles use only pure black and white; there are no gray or colored accents. Normal PDF text antialiasing is not treated as a design color.
- `Core Competencies` does not appear anywhere.
- `Technical Skills` is the final section on the page.
- Text remains selectable and follows a single logical reading order.
- Contact email is `yiyunliao21@gmail.com`.
- American Airlines title is `Senior Data Analyst`.
- Every candidate claim passes the career-ops fact check against `cv.md`.
- ATS validation passes with no layout-dependent or image-based content.
- A rendered page image is visually inspected for legibility, spacing, alignment, clipping, and awkward wrapping.
- `cv-template/` and the shared `templates/` files remain unchanged.
