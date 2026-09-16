# Sunny Global Job Search — Design Specification

**Date:** 2026-09-16
**Status:** Approved interface design; implementation pending written-spec review
**Audience:** Sunny job-search workflow maintainers

## 1. Objective

Build a local-only static website that lets the user search suitable Sunny job results across recent daily scans without opening individual Google Sheet tabs.

The page must:

- search every retained field across the selected scan-date range;
- default to the most recent seven calendar days;
- offer one-click 7-, 14-, 21-, and 30-day ranges plus a custom start/end range;
- default to showing `優先投遞` and `建議投遞` results;
- keep `低優先` available but unchecked;
- show a Google-Sheets-like table with the existing 14 result columns plus a new `掃描日期` column;
- sort by scan date, priority, or recommendation score;
- preserve clickable hyperlinks;
- allow every cell to be copied independently, including the full referral message;
- run entirely on localhost and make no runtime call to Google Sheets or another cloud service.

## 2. Scope

### Included

- Jobs that passed the Sunny hard gates and were published as suitable results.
- The most recent 30 calendar days of locally archived result rows.
- A one-time bootstrap of the current 30-day history from existing Google Sheet daily tabs.
- Future local snapshot generation whenever the daily pipeline publishes Sheet rows.
- Search, priority filters, scan-date filters, sorting, links, and per-cell copy.
- Desktop-first responsive behavior for narrower browser windows.

### Excluded

- Rejected, closed, pending, and otherwise unsuitable jobs.
- `合格`, `已排除`, `已看過`, or `全部` status tabs.
- Editing jobs, application status, scores, or Google Sheet values from the website.
- Live Google authentication or Google Sheets API calls from the browser.
- A database or server-side search service.
- Public hosting or access outside the local machine.

## 3. Selected Architecture

Use a static site backed by a generated local JSON snapshot.

### User-layer locations

To avoid conflicts with career-ops system updates and to keep personal job-search data out of Git:

- `local/sunny-job-search/index.html` — page markup.
- `local/sunny-job-search/styles.css` — responsive table and controls.
- `local/sunny-job-search/app.js` — filtering, searching, sorting, links, and copying.
- `local/sunny-job-search/data/jobs.json` — generated 30-day browser snapshot.
- `local/sunny-job-search/serve.mjs` — dependency-free localhost static server.
- `local/sunny-job-search/tests/` — local unit/browser tests.
- `data/sunny-job-search-archive.json` — durable local archive containing exact published row data.
- `data/tools/build-sunny-job-search-index.mjs` — validates the archive and atomically regenerates `jobs.json`.

All locations above are in the user layer or already ignored personal-data locations. The implementation must not place Sunny-specific data in `web/`, `dashboard/`, templates, or other auto-updated system files.

### Runtime

The site is plain HTML, CSS, and browser JavaScript. A small Node script serves the files at `127.0.0.1` only. The browser performs all search, filtering, and sorting in memory. It makes no network requests after the static files have loaded.

### Data refresh

1. The one-time bootstrap reads the suitable rows from existing date-named Google Sheet tabs for the last 30 days.
2. Those rows are normalized into `data/sunny-job-search-archive.json`.
3. The snapshot builder retains only the latest 30 calendar days and writes `local/sunny-job-search/data/jobs.json` atomically.
4. Future daily publishing writes the same exact row payload to the local archive and then regenerates the snapshot.
5. If local snapshot generation fails, the previous valid `jobs.json` remains in place and the Sheet publishing result is not mislabeled as zero jobs.

The static page never treats a failed refresh as an empty dataset.

## 4. Data Contract

The snapshot root has this shape:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-16T17:00:00.000Z",
  "timeZone": "America/New_York",
  "windowDays": 30,
  "jobs": []
}
```

Each job contains:

| Field | Meaning |
|---|---|
| `id` | Stable dedup key derived from the canonical application URL. |
| `scanDate` | Daily tab / publication-run date in `YYYY-MM-DD`. |
| `priority` | Normalized `priority`, `suggested`, or `low`. |
| `priorityLabel` | `優先投遞`, `建議投遞`, or `低優先`. |
| `score` | Numeric recommendation score. |
| `recommendation` | Visible recommendation label from the Sheet row. |
| `recommendationUrl` | Hyperlink target used by the recommendation cell, when present. |
| `company` | Company name. |
| `title` | Job title. |
| `category` | Sunny role category. |
| `location` | Job location. |
| `workMode` | Remote / NYC Metro working-mode label. |
| `postedDate` | Verified publication date, when available. |
| `primaryGap` | Main role gap. |
| `resume` | `Data Engineer` or `Data Analyst`. |
| `applyUrl` | Direct application URL. |
| `linkedinPeopleUrl` | Verified LinkedIn company people-page URL, when available. |
| `referralMessage` | Complete referral message, not the visually truncated preview. |

Hyperlink labels and URLs are stored separately. Search indexes labels and visible text; copying a hyperlink cell copies its URL.

### Priority normalization

- Existing `立即投遞` rows map to the `優先投遞` filter.
- Existing `建議投遞` rows map to the `建議投遞` filter.
- Existing low-priority labels map to `低優先`.
- The source value wins. A score-based fallback is allowed only when a legacy row has no recommendation label:
  - score `>= 85`: `優先投遞`;
  - score `75–84`: `建議投遞`;
  - score `< 75`: `低優先`.

The filter label does not rewrite the historical recommendation text shown in the `建議` column.

## 5. Interface

### Header and controls

The top control area contains:

1. A global-search textbox.
2. Three independent priority checkboxes:
   - `優先投遞` — checked by default;
   - `建議投遞` — checked by default;
   - `低優先` — unchecked by default.
3. Scan-date start and end fields.
4. Quick-range buttons: `最近 7 天`, `14 天`, `21 天`, and `30 天`.

The default range is inclusive: today in `America/New_York` plus the preceding six calendar days. Choosing a quick range updates both date fields. Editing either date field clears the selected quick-range state and applies the custom range.

Search, priority, and date filters combine with logical AND. Results update immediately without submitting a form.

### Search

Search is case-insensitive and uses normalized Unicode text. It searches company, title, category, location, working mode, publication date, main gap, resume, recommendation text, referral message, and visible link labels/URLs.

Whitespace-only input is treated as no query. The page must remain responsive for the expected 30-day dataset without a backend.

### Table

Column order:

1. `掃描日期` — new global-search context column.
2. `優先序`.
3. `推薦分數`.
4. `建議`.
5. `公司`.
6. `職缺`.
7. `分類`.
8. `地點`.
9. `工作模式`.
10. `發布日期`.
11. `主要缺口`.
12. `使用履歷`.
13. `申請連結`.
14. `LinkedIn People`.
15. `內推訊息`.

The table uses horizontal scrolling where necessary. Scan date, priority, and recommendation remain sticky on desktop so the row stays understandable while scrolling.

The referral-message cell displays a shortened preview, but its copy action always uses the full value.

### Sorting

Sortable headers:

- `掃描日期` — newest/oldest;
- `優先序` — `優先投遞`, `建議投遞`, `低優先` or reverse;
- `推薦分數` — numeric high/low.

Default ordering is:

1. scan date descending;
2. recommendation score descending;
3. company ascending;
4. job title ascending.

Sorting is stable and applies after filtering. The active header shows direction and remains keyboard accessible.

### Copying and links

- Every data cell has an accessible copy action.
- Text cells copy their complete untruncated text.
- Hyperlink cells copy the actual URL, not only the visible label.
- A successful copy shows a short, non-blocking confirmation.
- Application and LinkedIn links open in a new tab with safe `noopener` behavior.
- Missing optional links render as an em dash and never create a broken anchor.

## 6. Deduplication and Retention

- Canonical application URL is the primary identity.
- Tracking parameters are removed only when doing so does not alter the ATS job identity.
- When the same job appears on multiple scan dates, retain its earliest first-seen date internally and its latest suitable row values, but expose the scan date corresponding to the published daily result.
- Do not show duplicate rows for the same canonical job and scan date.
- The browser snapshot contains at most the most recent 30 calendar days, while the durable local archive may retain older rows for future use.

## 7. Failure Handling

- Validate required fields and schema version before replacing `jobs.json`.
- Write to a temporary sibling file, validate it, then rename atomically.
- If the archive is absent, malformed, or empty unexpectedly, keep the last valid snapshot and print a clear error.
- If the page cannot load the snapshot, display an actionable local error rather than `0 results`.
- Invalid date ranges show a validation message and do not silently swap the dates.
- A range with genuinely no matching rows shows `0 個結果` and the active filters.

## 8. Local Operation

The local server binds only to `127.0.0.1`. The default URL is:

```text
http://127.0.0.1:4173
```

One command starts the site. A separate refresh command rebuilds the 30-day snapshot. The implementation documentation must state both commands without requiring the user to understand the internal file layout.

## 9. Verification

Automated checks must cover:

- default 7-day range;
- default checked priority filters;
- 7/14/21/30-day quick ranges;
- custom inclusive start/end ranges;
- case-insensitive company/title/global-field search;
- combined search + priority + date filtering;
- default stable ordering;
- scan-date, priority, and score sort toggles;
- full-text copy from truncated referral messages;
- URL copy from hyperlink cells;
- safe link attributes;
- missing-link rendering;
- duplicate suppression;
- 30-day snapshot retention;
- malformed archive / failed refresh preserving the last valid snapshot.

Browser verification must also confirm that the table is usable at desktop width and remains navigable at a narrow viewport.

## 10. Acceptance Criteria

The feature is complete when:

1. The localhost page starts successfully and loads a real 30-day Sunny snapshot.
2. The initial view covers the most recent seven days and shows only `優先投遞` and `建議投遞`.
3. Searching a company name returns all suitable matching jobs inside the active range.
4. Date, priority, and score sorting work in both directions.
5. Every cell can be copied, with full referral messages and real hyperlink URLs preserved.
6. All 15 columns are visible through the sheet-like table without data loss.
7. No runtime Google login, database, or external web service is required.
8. A failed data refresh cannot replace valid data with an empty or partial snapshot.
