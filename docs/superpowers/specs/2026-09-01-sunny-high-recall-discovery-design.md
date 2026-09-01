# Sunny High-Recall Job Discovery Design

**Date:** 2026-09-01  
**Scope:** Sunny's H-1B-first NYC Metro / U.S.-remote discovery, daily scan, reporting, and one-time backfill

## Context

The 2026-09-01 run reported zero qualified jobs, but audit examples proved that zero was a pipeline artifact rather than a market fact:

- Datadog had a current NYC Senior Data Engineer opening but was absent from the tracked-company pool even though FY2026 Q3 DOL data contains certified H-1B `CHANGE_EMPLOYER` activity for Datadog.
- Weights & Biases was tracked and had a current NYC/U.S.-remote Senior Data Platform Engineer opening, but the exact substring `Data Engineer` did not match `Data Platform Engineer`.
- Bloomberg's `Data Automation Engineer` variant failed the same exact-substring title filter.
- LinkedIn repost dates can differ from ATS publication dates, as shown by Harvey.
- The 2026-09-01 automation summary reported zero ATS errors while `data/scan-runs.tsv` recorded 11.

The current 500-company pool is a national H-1B / stable-ATS subset, not complete NYC Metro coverage. A conservative exact offline join found at least 1,229 public ATS candidates with FY2026 Q3 H-1B `CHANGE_EMPLOYER` evidence that were not tracked; 235 of those had NY worksite transfer evidence. These are candidates for identity and liveness verification, not automatic additions.

## Goals

1. Admit every company with credible, legally matched H-1B transfer evidence and a live, stable public ATS, regardless of the historical LCA job title.
2. Use target-role LCA history only as a ranking signal, never as a company eligibility gate.
3. Maximize title recall before using the JD and Sunny's resumes for semantic fit decisions.
4. Make daily scans resilient to ATS timestamp delays by using a rolling three-day lookback with durable deduplication.
5. Report ATS errors and partial/truncated boards from authoritative run evidence.
6. Run a one-time 20-day backfill after the new company and title rules are active.

## Non-Goals

- Detecting LinkedIn-only repost timestamps when the ATS does not expose them.
- Treating employer-level DOL evidence as a guarantee that a particular requisition sponsors.
- Applying to jobs or contacting employees.
- Removing the existing Meta, Forward Deployed Engineer, location, or explicit no-sponsorship exclusions.

## Design

### 1. Company universe

Build the discovery seed from FY2026 Q3 certified or certified-withdrawn H-1B employers with positive `CHANGE_EMPLOYER` positions across **all** historical job titles.

For every employer:

- Normalize and match the legal employer name and DBA to the public Greenhouse, Lever, Ashby, Workday, and iCIMS caches.
- Accept exact and reviewed alias matches only when the ATS identity resolves to the same employer or confirmed subsidiary.
- Verify the ATS board is live and stably fetchable before adding it to `portals.yml`.
- Preserve the DOL legal employer, transfer count, NY transfer count, role-history count, provider, ATS identifier, match method, and verification result in a user-layer audit artifact.
- Keep Meta excluded.

Company priority is determined by NY worksite transfer evidence, total transfer evidence, current target-role openings, and ATS reliability. Historical target-role LCA titles affect this priority only; an employer such as Datadog remains eligible even when its historical LCA titles use `Software Engineer` or `Staff Engineer`.

There is no arbitrary 600-company cap. The operational pool contains all identity-verified, live ATS boards that pass the H-1B company gate. Ambiguous aliases and dead/unstable boards remain in an audit queue and are not silently added.

### 2. High-recall title discovery

Use career-ops' existing `word:`, `stem:`, and `+` matcher features. Discovery positives are OR-ed:

```yaml
- "word:data"
- "word:analyst"
- "word:analytics"
- "word:etl"
- "word:elt"
- "word:bi + stem:engineer"
- "word:bi + stem:developer"
- "word:business + stem:intelligen"
- "word:database + stem:engineer"
- "word:reporting + stem:developer"
- "word:sql + stem:developer"
```

This intentionally admits Data Platform, Data Automation, Data Warehouse, Data Infrastructure, Data Pipeline, Data Intelligence/Intelligent, Data Management, Data Operations, Data Quality, Data Governance, Analytics, ETL/ELT, BI, Database Engineering, Reporting Development, SQL Development, and all Analyst titles.

Existing hard-negative title signals remain:

- Forward Deployed
- intern / internship
- Data Entry
- Machine Learning Engineer
- AI Engineer
- Software Engineer
- Clinical Data

The title layer only discovers candidates. A title containing `data` or `analyst` is not automatically qualified.

### 3. JD semantic qualification

After deterministic company, freshness, location, and explicit-negative checks, Terra reads the JD and maps it to one of two resume families:

- Data Engineering / Analytics Engineering / BI Engineering
- Data / Finance / Business Analysis

Relevant responsibility signals include SQL, Python, Spark, Databricks, ETL/ELT, orchestration, dbt, Snowflake, dimensional modeling, warehouses, semantic layers, dashboards, BI, experimentation, finance analytics, data quality, governance, and operational analytics.

Pure data science/model-training, data-center operations, privacy/legal, sales, recruiting, and unrelated analyst roles are rejected or scored below the application threshold even when discovery admits them. No resume fact may be invented.

### 4. Freshness and deduplication

The daily automation runs `scan.mjs --since 3`, not `--since 1`.

- `data/sunny-scan-history.tsv` and the Sheet's Seen Jobs URL/Dedup Key remain the durable dedup sources.
- Only the first discovery of a URL/key is shown as new, so the overlapping three-day window does not duplicate daily results.
- ATS publication/update time and first-seen time remain separate concepts.
- `max_posting_age_days` is set to 20 so it does not block the one-time backfill; the daily `--since 3` argument remains the stricter daily bound.

### 5. Run reporting

The automation must read the newly appended row in `data/scan-runs.tsv` by header name after every scan. It must not infer an error count from quiet console output.

The final report and Scan Summary include:

- configured companies
- ATS boards attempted/successful where available
- raw jobs
- each filter count
- duplicates and new offers
- ATS errors from `scan-runs.tsv`
- every partial/truncated-board warning captured from scanner output
- semantic-qualified jobs

If console evidence and `scan-runs.tsv` disagree, the structured TSV counter wins and the discrepancy is reported.

### 6. One-time 20-day backfill

After company expansion, title changes, and verification pass:

1. Run `scan.mjs --since 20` against the expanded portals configuration.
2. Deduplicate against `data/sunny-scan-history.tsv` and Sheet Seen Jobs.
3. Apply the new location, H-1B, explicit sponsorship, and semantic JD gates.
4. Write newly qualified roles to a dedicated `Backfill 2026-09-01` tab and append them to Master.
5. Write exclusions to Excluded and all first-seen candidates to Seen Jobs.
6. Preserve the existing `2026-09-01` daily tab as the audit record of the original daily run.
7. Read back key Sheet ranges and verify row counts, URLs, hyperlinks, and formatting.

After the backfill, the active daily automation continues with the three-day overlapping window.

## Test and Verification Plan

### Title regression cases that must pass discovery

- Senior Data Engineer - Revenue Data Platform
- Senior Data Platform Engineer
- Data Intelligence Engineer
- Data Intelligent Engineer
- Data Automation Engineer
- Senior Data Management Professional - Data Automation Engineer - People Data
- Senior Analytics Engineer, Finance
- Advanced Forward Engineering - Data Engineer - Senior
- Senior Data Architect/Data Engineer
- ETL Developer
- ELT Engineer
- BI Developer
- Business Intelligence Engineer
- Finance Analyst

### Title regression cases that must fail discovery

- Forward Deployed Engineer
- Data Entry Operator
- Machine Learning Engineer
- AI Engineer
- Software Engineer
- Clinical Data Manager
- Data Engineering Intern

### Company-universe regression

- Datadog must enter the candidate company universe from all-title H-1B `CHANGE_EMPLOYER` evidence even though it has no target-title row in the previous derived table.
- Role-specific DOL evidence changes rank, not eligibility.
- An ambiguous ATS/legal-entity match must not be auto-added.

### Operational verification

- A three-day rescan produces no duplicate Seen Jobs or Master rows.
- The 2026-09-01 historical run is interpreted as 11 ATS errors from the structured TSV row.
- Partial Workday truncation is present in the run report when emitted.
- The 20-day backfill writes only previously unseen qualified URLs/keys.

## Risks and Controls

- **Higher candidate volume:** mitigated by deterministic hard negatives and JD semantic qualification before scoring/Sheet qualification.
- **False company identities:** mitigated by exact/reviewed aliases, legal-entity evidence, and live ATS verification.
- **ATS rate limits or truncation:** surfaced explicitly; partial boards are never reported as complete.
- **Model cost:** the ATS sweep and first-pass title/location/date filters remain local and zero-token; Terra evaluates only the much smaller surviving set.
