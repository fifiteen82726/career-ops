# High-Density Resume Generation Design

**Date:** 2026-09-10

## Goal

Change Sunny's U.S. resume workflow so a one-page tailored resume contains more relevant evidence without becoming a keyword dump or losing ATS readability. The workflow should be fast and deterministic enough to run later as a scheduled Codex automation.

## What Changes

The previous Fivetran draft used ten experience bullets because it applied a fixed `4/2/2/1/1` allocation. That rule is removed. Future tailoring starts with the complete `cv.md` fact bank and selects the strongest distinct evidence for the job.

The two historical resumes are layout-density references only. Their 15-16 bullet count establishes the target density, but their wording and claims are not copied automatically. Candidate claims still come only from `cv.md`, other primary career-ops sources, or facts the user states directly.

## Content Selection

For each job, build an internal pool of 18-20 candidate bullets from `cv.md`. Rank each bullet using these dimensions:

- JD relevance: 0-3
- Quantified or concrete outcome: 0-2
- Recency: 0-2
- Distinct evidence not already represented: 0-2
- Truthful keyword value: 0-1

Select 14-16 bullets with the highest total value. Employer allocation is dynamic rather than fixed. The current role usually receives four or five bullets, but an older employer may receive additional space when its evidence is unusually relevant to the target job.

Each retained bullet should normally occupy no more than two rendered lines. Combine bullets only when they describe the same project or evidence chain. Do not merge unrelated metrics into one sentence solely to save space.

## Page-Fit Strategy

For Sunny's current U.S. search, the default remains one US Letter page, single column, pure black on white, with no Core Competencies section and Technical Skills at the bottom.

When content does not fit, reduce space in this order:

1. Remove the Professional Summary or reduce it to one line.
2. Shorten repeated context and tool lists inside bullets.
3. Consolidate Technical Skills into two or three compact lines.
4. Tighten vertical spacing while keeping the body at or above 9.3 pt and margins within 0.45-0.6 inches.
5. Remove the lowest-ranked bullet only after the preceding options are exhausted.

For the revised shared Fivetran resume, omit the summary and target approximately 15 experience bullets. Use `Senior Data Analyst` for American Airlines. Choose the final employer allocation from the ranking results rather than forcing a predetermined count.

## ATS Scoring

Report two separate measurements instead of describing either as a universal ATS score:

- Parseability score from `verify-ats.mjs`: target at least 90/100 with no critical issue.
- Truthful JD keyword coverage: target at least 80% for supported requirements.

Also enforce:

- Exactly one US Letter page
- Selectable text and a logical single-column reading order
- No image-based content, hidden text, or standalone keyword block
- Technical Skills is the final section
- Every claim passes the career-ops fact gate or is manually traced to an allowed primary source when the deterministic extractor cannot classify it

A high parseability score does not prove that the resume contains enough evidence. The final report must include the selected experience-bullet count so sparse output is visible.

## Scheduled-Run Architecture

Brainstorming, spec writing, implementation planning, and template design are one-time setup work. A scheduled resume run must not repeat them.

Each scheduled run should perform only this bounded pipeline:

1. Fetch or read the JD once.
2. Load `cv.md`, `config/profile.yml`, `modes/_profile.md`, `modes/_custom.md`, and the required career-ops mode instructions.
3. Run the skill-gap check.
4. Rank the candidate evidence and write one compact payload.
5. Build HTML with the already-approved monochrome template.
6. Run the fact gate and ATS checks.
7. Render once with a strict one-page limit.
8. Retry content fitting once only if the page count or an acceptance threshold fails.

Do not load historical PDFs, old generated resumes, specs, or implementation plans during normal scheduled runs. Do not run broad company research when the scheduled task is only tailoring a resume for a JD already in scope.

Target wall time is roughly three to seven minutes per resume under normal local conditions. Deterministic HTML, ATS, and PDF commands should take seconds; most remaining time is the model's evidence selection and rewriting pass.

## Model and Reasoning Recommendation

Use `gpt-5.6-sol` with `low` reasoning effort for the scheduled final-resume task. The work requires judgment, source grounding, compact rewriting, and a few local tool calls, but it does not normally require frontier-level research or deep software architecture reasoning.

Use `medium` only when the JD is unusually ambiguous, the role spans materially different functions, or evaluation data shows that `low` omits relevant evidence. Use `gpt-5.6-luna` with `low` reasoning for inexpensive scanning or preliminary classification, not for the final resume unless a representative quality evaluation shows parity. `gpt-6-astra` is reserved for difficult, high-value exceptions; it is not the default scheduled choice.

This follows the official model guidance to start latency-sensitive, tool-using workflows at low reasoning and increase effort only when evaluations show a measurable quality gain.

## Performance and Token Controls

- Use one model pass for evidence ranking and copy generation.
- Keep tool output compact and avoid rereading long files after they have been loaded.
- Use the approved template without redesigning it per job.
- Run visual inspection only after a layout-affecting template change or when deterministic page checks fail; normal scheduled runs rely on the already-verified template plus one-page and ATS gates.
- Do not create per-run specs, implementation plans, or Git commits.
- Record validation results concisely: bullet count, page count, fact-gate verdict, parseability score, and keyword coverage.

## Persistent Configuration

Update `modes/_custom.md` so the high-density behavior survives future sessions and scheduled runs. Replace the fixed sparse allocation with the ranking and page-fit rules above. Do not modify the system-layer `modes/_shared.md` or shared templates.

## Deliverable for the Current Fivetran Roles

Regenerate the existing shared Fivetran resume using the approved all-black one-page template and the new selection method. Produce a comparison-safe Markdown, JSON, HTML, and PDF set. Keep the earlier ten-bullet version available until the user approves the denser version.

## Acceptance Criteria

- 14-16 distinct, job-relevant experience bullets
- One US Letter page
- Parseability score at least 90 with no critical issue
- Supported JD keyword coverage at least 80%
- No Core Competencies section
- Technical Skills at the bottom
- Pure-black authored visual styles on white
- No unsupported or conflicting candidate claim
- Normal scheduled workflow does not repeat design/planning steps
- Recommended schedule configuration is `gpt-5.6-sol` with `low` reasoning effort
