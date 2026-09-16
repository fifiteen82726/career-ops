# Resume-to-application mapping design

**Date:** 2026-09-16

## Goal

Persist a durable mapping between each company/job application and the exact PDF resume prepared for it, so a later interview-preparation workflow can retrieve the resume used for that role without relying on memory or filename inference.

## Storage

Create the user-layer file `data/resume-application-map.tsv`. It is append-only and therefore survives career-ops system updates.

The header is:

```text
created_at	company	job_title	application_ref	pdf_resume
```

- `created_at`: local ISO date when the final PDF passed verification.
- `company`: employer name shown in the job posting.
- `job_title`: exact role title shown in the job posting.
- `application_ref`: official job URL when available; otherwise the canonical archived JD path under `jds/`.
- `pdf_resume`: project-relative path to the verified final PDF.

## Write behavior

After a tailored PDF passes the page, extraction, fact, ATS, and visual checks, append its mapping before reporting completion.

- Require non-empty company, job title, application reference, and PDF path.
- Require the PDF path to exist.
- Prefer an official job URL as `application_ref`; use the archived JD path when no URL is available.
- Do not infer or change an application status. This file records artifact identity, not whether an application was submitted.
- Do not append an exact duplicate of `company + job_title + application_ref + pdf_resume`.
- Do not overwrite an older mapping when a new resume version is created. Append the new dated PDF path so prior versions remain recoverable.
- Replace tabs and embedded newlines in field values with spaces before writing a TSV row.

## Lookup behavior

When interview preparation starts, search the mapping by company and job title, then use `application_ref` to disambiguate multiple openings. Return the mapped PDF path and date. If several resume versions exist for the same application, show all versions instead of guessing which one was submitted.

## Persistent workflow rule

Add a house rule to `modes/_custom.md` requiring every future tailored-resume run to maintain `data/resume-application-map.tsv` after final PDF verification and requiring interview-preparation flows to consult it before selecting resume evidence.

## Initial data

Seed two rows for the verified NBCUniversal resumes created on 2026-09-16:

1. NBCUniversal - Sr. Analyst, Content Forecasting - archived JD reference - corresponding verified PDF.
2. NBCUniversal - Analyst, People Analytics & Reporting - archived JD reference - corresponding verified PDF.

## Verification

- The TSV header matches the defined five-column schema.
- Both seeded rows have five fields and point to existing JD and PDF files.
- Re-running the seeding logic would add zero exact duplicates.
- `modes/_custom.md` contains the persistent write and lookup rules.
- No tracker state is changed and no application is marked submitted.
