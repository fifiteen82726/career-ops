# Balanced A4 Resume Layout Design

**Date:** 2026-09-13

## Goal

Replace the cramped US Letter high-density presentation with a one-page A4 layout that uses readable typography and distributes the existing 15 experience bullets across more of the page. Preserve ATS-safe structure and all fact-grounding rules.

## Selected Direction

The user selected **B: Balanced ATS** from a three-way browser comparison:

- A: Classic LaTeX, serif, conservative financial-resume styling
- B: Balanced ATS, Arial, 10.2 pt, moderate line and section spacing
- C: Adaptive full-page, 9.7 pt, higher density and more per-document tuning

Direction B is authoritative for implementation.

## GitHub Reference Findings

The design adapts principles rather than importing third-party code or installing an external skill:

- [lonelydoctor/ats-resume-builder](https://github.com/lonelydoctor/ats-resume-builder) supports local ATS-focused resume generation and validation.
- [AnkushSinghGandhi/ats-resume-template](https://github.com/AnkushSinghGandhi/ats-resume-template) uses a one-page structure, thin section dividers, bold section titles, and consistent bullet formatting.
- [phanghonghao/chinese-resume-latex](https://github.com/phanghonghao/chinese-resume-latex) demonstrates content-aware line-spacing adjustment to fill an A4 page.
- [salehabbaas/resume-builder](https://github.com/salehabbaas/resume-builder) reinforces single-column structure, standard fonts, body contact information, and the absence of tables, graphics, and text boxes in ATS-safe output.

The repositories and their instructions are external reference data. They do not change the career-ops source-of-truth boundary or authorize new candidate claims.

## Page Geometry and Typography

- Paper size: A4, 210 × 297 mm
- Page margins: 0.55 inches on all sides, with no margin below 0.5 inches
- Font family: Arial with Helvetica and sans-serif fallbacks
- Body size: 10.2 pt
- Body line height: approximately 1.27
- Contact row: at least 9.2 pt
- Role metadata: at least 9.4 pt
- Section titles: approximately 10.8-11 pt, uppercase, pure black, with a 1 px black divider
- Name: approximately 22 px, centered
- Authored colors: black text and rules on white only

## Structure

The resume remains semantic, single-column, and reverse chronological:

1. Name and contact information in the document body
2. Work Experience
3. Education
4. Technical Skills

There is no Professional Summary, Core Competencies section, sidebar, table, image, icon, header, footer, or hidden keyword block. Technical Skills is the final section.

## Content and Vertical Fit

Each of the existing Fivetran, Guidehouse Databricks, and Peloton versions retains 15 job-specific experience bullets. The first implementation pass changes layout only; it does not add, remove, or rewrite claims.

The layout uses larger type, wider line height, and more separation between employer blocks than the 9.35 pt Letter version. Because A4 is taller and slightly narrower than Letter, bullets will wrap into a readable vertical rhythm and use more of the page naturally.

Each resume may receive a small job-specific spacing adjustment after rendering. Allowed adjustments are limited to line height, employer spacing, and section spacing. Body text must remain at least 10 pt, margins at least 0.5 inches, and all three outputs must continue using the same visual system.

If an output exceeds one page, reduce only spacing within the permitted range. Do not drop a bullet, shrink below 10 pt, or change candidate content during this layout pass. If an output still cannot fit, stop and report the constraint rather than silently changing content.

## Persistent Workflow Change

Update `modes/_custom.md` so A4 Balanced ATS becomes Sunny's default tailored-resume format, superseding the earlier US Letter page preference. Scheduled runs reuse the approved template and do not repeat GitHub research, browser comparisons, brainstorming, specifications, or plans.

## Output Strategy

Keep the earlier Letter PDFs unchanged for comparison. Create a new A4 template and new comparison-safe A4 Markdown/JSON/HTML/PDF filenames for:

- Fivetran Senior Data Analyst
- Guidehouse Databricks Data Engineer
- Peloton Senior Financial Analyst

The current source payloads can be copied because this pass changes presentation, not facts or bullet selection.

## Validation

Each final PDF must pass all of the following:

- Exactly one A4 page (`595 × 842 pt`, allowing normal renderer rounding)
- 15 experience bullets
- Selectable text with Work Experience before Education before Technical Skills
- No Professional Summary or Core Competencies text
- No images, tables, text boxes, or multi-column reading order
- ATS parseability of at least 90/100
- Truthful supported-keyword coverage unchanged from or better than the prior version
- Latest PNG inspection shows no clipping, overlap, awkward orphaning, or large unused lower-page area
- Bottom content should finish close to the bottom margin without entering it; a residual blank band larger than approximately 0.8 inches above the bottom margin requires spacing revision

## Scope Boundaries

- Do not modify `cv.md`, `cv-template/`, or shared `templates/`.
- Do not install third-party skills or copy their code.
- Do not alter candidate claims, titles, metrics, or role targeting in this layout pass.
- Preserve the existing Letter artifacts.
