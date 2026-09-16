# Resume-to-Application Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist an exact, append-only pairing between each job application reference and the verified PDF resume prepared for it, beginning with the two existing NBCUniversal resumes.

**Architecture:** Keep all personalized state in the career-ops user layer. Store mappings in a five-column TSV under `data/`, and store the future write/lookup behavior as a house rule in `modes/_custom.md`. Do not add tracker state, infer submission, or modify system-layer resume-generation code.

**Tech Stack:** Markdown house rules, tab-separated values, Node.js read-only validation, Git.

---

## Task 1: Create and seed the resume/application map

**Files:**
- Create: `data/resume-application-map.tsv`
- Read: `jds/nbcuniversal-sr-analyst-content-forecasting-2026-09-14.md`
- Read: `jds/nbcuniversal-analyst-people-analytics-reporting-2026-09-11.md`
- Read: `output/pdf/cv-yi-yun-liao-nbcuniversal-sr-analyst-content-forecasting-balanced-a4-2026-09-16.pdf`
- Read: `output/pdf/cv-yi-yun-liao-nbcuniversal-analyst-people-analytics-reporting-balanced-a4-2026-09-16.pdf`

- [ ] **Step 1: Confirm the new map does not already exist**

Run:

```bash
test ! -e data/resume-application-map.tsv
```

Expected: exit 0. If the file exists, inspect it and merge only missing rows instead of replacing user data.

- [ ] **Step 2: Confirm every seed target exists before writing**

Run each command separately:

```bash
test -f jds/nbcuniversal-sr-analyst-content-forecasting-2026-09-14.md
test -f jds/nbcuniversal-analyst-people-analytics-reporting-2026-09-11.md
test -f output/pdf/cv-yi-yun-liao-nbcuniversal-sr-analyst-content-forecasting-balanced-a4-2026-09-16.pdf
test -f output/pdf/cv-yi-yun-liao-nbcuniversal-analyst-people-analytics-reporting-balanced-a4-2026-09-16.pdf
```

Expected: every command exits 0.

- [ ] **Step 3: Create the TSV with the approved schema and seed rows**

Use `apply_patch` to create `data/resume-application-map.tsv` with literal tab separators and exactly this data:

```text
created_at\tcompany\tjob_title\tapplication_ref\tpdf_resume
2026-09-16\tNBCUniversal\tSr. Analyst, Content Forecasting\tjds/nbcuniversal-sr-analyst-content-forecasting-2026-09-14.md\toutput/pdf/cv-yi-yun-liao-nbcuniversal-sr-analyst-content-forecasting-balanced-a4-2026-09-16.pdf
2026-09-16\tNBCUniversal\tAnalyst, People Analytics & Reporting\tjds/nbcuniversal-analyst-people-analytics-reporting-2026-09-11.md\toutput/pdf/cv-yi-yun-liao-nbcuniversal-analyst-people-analytics-reporting-balanced-a4-2026-09-16.pdf
```

The displayed `\t` markers above mean one literal tab in the file, not two characters.

- [ ] **Step 4: Validate the schema, row count, and duplicate invariant**

Run:

```bash
node -e 'const fs=require("fs"); const p="data/resume-application-map.tsv"; const lines=fs.readFileSync(p,"utf8").trimEnd().split(/\r?\n/); const expected="created_at\tcompany\tjob_title\tapplication_ref\tpdf_resume"; if(lines[0]!==expected) throw new Error("wrong header"); if(lines.length!==3) throw new Error(`expected 2 rows, got ${lines.length-1}`); const rows=lines.slice(1).map((line,i)=>{const f=line.split("\t"); if(f.length!==5) throw new Error(`row ${i+2} has ${f.length} fields`); if(f.some(v=>!v.trim())) throw new Error(`row ${i+2} has an empty field`); return f;}); const keys=rows.map(r=>r.slice(1).join("\t")); if(new Set(keys).size!==keys.length) throw new Error("exact duplicate mapping"); for(const r of rows){for(const i of [3,4]) if(!fs.existsSync(r[i])) throw new Error(`missing path: ${r[i]}`);} console.log("resume map valid: 2 rows");'
```

Expected: `resume map valid: 2 rows`.

## Task 2: Make the behavior persistent for future resume and interview runs

**Files:**
- Modify: `modes/_custom.md`

- [ ] **Step 1: Prove the workflow rule is not already present**

Run:

```bash
rg -n "resume-application-map\.tsv|Resume-to-application mapping" modes/_custom.md
```

Expected before the edit: no matches, exit 1.

- [ ] **Step 2: Add the approved house rule**

Use `apply_patch` to add this subsection under `## Custom Workflows`, before the existing Sunny workflows:

```markdown
### Resume-to-application mapping

- After a tailored resume PDF passes its final page, extraction, fact, ATS, and visual checks, append one five-field row to `data/resume-application-map.tsv`: local ISO creation date, company, exact job title, application reference, and project-relative PDF path.
- Use the official job URL as the application reference when known; otherwise use the canonical archived JD path under `jds/`. Replace tabs and embedded newlines in field values with spaces before writing.
- Require all fields and the PDF path to exist. Do not append an exact duplicate of company + job title + application reference + PDF path.
- When a new PDF version is created for the same application, append it and retain all older mappings. Never overwrite the prior resume history.
- This mapping records artifact identity only. Never infer or change application status and never mark a role submitted because a PDF was generated.
- Before interview preparation, look up the company and job title in this map and use the application reference to disambiguate openings. If several PDF versions remain, show all of them instead of guessing which one was submitted.
```

- [ ] **Step 3: Verify both write and lookup behavior are persisted**

Run:

```bash
rg -n -A8 "^### Resume-to-application mapping$" modes/_custom.md
```

Expected: the subsection includes final-verification timing, exact duplicate prevention, append-only version history, no submission inference, and interview lookup behavior.

## Task 3: Run focused end-to-end verification

**Files:**
- Verify: `data/resume-application-map.tsv`
- Verify: `modes/_custom.md`
- Verify: `data/applications.md`

- [ ] **Step 1: Validate every mapped reference and PDF and print the seeded pairings**

Run:

```bash
node -e 'const fs=require("fs"); const p="data/resume-application-map.tsv"; const [header,...lines]=fs.readFileSync(p,"utf8").trimEnd().split(/\r?\n/); if(header!=="created_at\tcompany\tjob_title\tapplication_ref\tpdf_resume") throw new Error("schema mismatch"); const rows=lines.map(line=>line.split("\t")); if(rows.some(r=>r.length!==5)) throw new Error("non-five-column row"); const exact=new Set; for(const r of rows){const key=r.slice(1).join("\u0000"); if(exact.has(key)) throw new Error("duplicate tuple"); exact.add(key); if(!fs.existsSync(r[3])) throw new Error(`missing application ref ${r[3]}`); if(!fs.existsSync(r[4])) throw new Error(`missing PDF ${r[4]}`); console.log(`${r[1]} | ${r[2]} | ${r[3]} | ${r[4]}`);} if(rows.length!==2) throw new Error(`expected 2 seeded rows, got ${rows.length}`);'
```

Expected: two NBCUniversal pairings print and the command exits 0.

- [ ] **Step 2: Confirm the tracker was not modified by this implementation**

Run:

```bash
git diff -- data/applications.md
```

Expected: no output.

- [ ] **Step 3: Check patch quality and the exact scoped changes**

Run each command separately:

```bash
git diff --check
git status --short -- data/resume-application-map.tsv modes/_custom.md data/applications.md
```

Expected: `git diff --check` exits 0; only the mapping file and custom rules may appear, while `data/applications.md` remains unchanged. User-layer files may be gitignored by design.

- [ ] **Step 4: Re-run the career-ops health check**

Run:

```bash
node doctor.mjs --json
```

Expected: valid JSON and no new missing prerequisite caused by this change.

- [ ] **Step 5: Report the durable lookup path**

Provide clickable links to `data/resume-application-map.tsv` and `modes/_custom.md`. State that both NBCUniversal job/resume pairs are recorded, historical PDF versions will be retained, and no application was marked submitted.

## Self-review checklist

- [ ] Every requirement in `docs/superpowers/specs/2026-09-16-resume-application-map-design.md` is represented by an implementation or verification step.
- [ ] No task changes `data/applications.md`, application state, or submission status.
- [ ] The map stays in the user layer and the workflow preference stays in `modes/_custom.md`.
- [ ] There are no placeholder paths, invented URLs, or unverified job identifiers.
- [ ] The five TSV fields and duplicate key are consistent across creation, validation, and future workflow rules.

