# CV Fact Bank and Fivetran Resume Design

**Date:** 2026-09-09

## Goal

Consolidate the user's ten historical LaTeX resumes in `cv-template/` into the canonical `cv.md`, then generate one US-English resume tailored to both current Fivetran openings:

- Senior Data Analyst, People (Greenhouse job 7918612003)
- Senior Data Analyst, Revenue (Greenhouse job 7918614003)

The historical templates are read-only source material. Future career-ops resume generation uses `cv.md` as the primary source of truth.

## Source and Editing Boundaries

- Modify `cv.md` and resume artifacts only.
- Preserve the existing education facts.
- Do not modify any file under `cv-template/`.
- Keep unrelated working-tree changes untouched.
- Use only facts contained in the user-authored templates, the existing `cv.md`, or facts explicitly confirmed by the user in this conversation.
- Treat both job descriptions as targeting data, never as sources for candidate claims.

## Canonical Fact-Bank Structure

`cv.md` remains readable Markdown with these sections:

1. Contact details
2. Professional Summary
3. Professional Experience
4. Education
5. Technical Skills

Each employer entry may contain more evidence than would fit in a submitted resume. Distinct projects and outcomes remain separate bullets so later tailoring can select the strongest subset. Semantically duplicate bullets are combined without combining unrelated metrics.

American Airlines records both permitted title variants, `Senior Data Engineer` and `Senior Data Analyst`, with an explicit instruction that tailored resumes choose the title matching the target role. For the two Fivetran roles, the selected title is `Senior Data Analyst`.

## Conflict Resolution

Use the user's explicit confirmations as authoritative:

- Shopee repurchase-rate increase: 9%
- Shopee monthly average revenue per customer increase: 4%
- Cathay model outcome: 7%
- American Airlines title: select `Senior Data Engineer` or `Senior Data Analyst` according to the target job

Where historical templates offer conflicting variants that the user has not separately resolved, retain the most specific, consistently supported version and omit incompatible alternatives from generated output. Do not add numbers solely because they appear in a job-specific rewrite.

## Shared Fivetran Resume Strategy

Use one two-page-or-shorter, single-column, ATS-compatible US resume. Position the candidate as a senior analyst who can own both analytics engineering and decision support.

The shared narrative emphasizes:

- Large-scale SQL, Python, Databricks, Snowflake, dbt, and data modeling
- Reliable pipelines, reusable datasets, validation, monitoring, and governed KPI definitions
- Workforce/staffing analysis for the People Analytics opening
- Booking, channel, revenue, forecasting, and scenario analysis for the Revenue opening
- Executive-ready Tableau and Power BI reporting
- Experimentation, cross-functional collaboration, and measurable business results
- AI-assisted analytics tooling only where supported by the source material

The resume should naturally cover both roles without labeling itself as two separate applications or overstating direct HRIS, ATS, NetSuite, LookML, Sigma, or Hex experience.

## Deliverables

- Expanded and deduplicated `cv.md`
- One tailored US-English resume in Markdown/structured source form
- One HTML resume built with the repository's standard CV renderer
- One visually verified PDF resume, no more than two US Letter pages
- Archived copies of both job descriptions used for tailoring

## Validation

- Confirm `cv-template/` has no modifications.
- Confirm the contact email is `yiyunliao21@gmail.com`.
- Run the career-ops fact verifier on the tailored resume data.
- Render the PDF and inspect every page for clipping, overflow, awkward breaks, and legibility.
- Confirm the final resume includes the high-value shared keywords it truthfully supports and does not claim unsupported Fivetran-specific systems.
