# Sunny Scan Status Dashboard Design

## Goal

Add a daily scan-health table to the bottom of the local Sunny job-search website so the user can immediately see whether each day ran, whether it completed cleanly, and what went wrong. The same change adds a rolling 24-hour **Today** filter and makes it the default view.

## Scope

This feature covers:

- a durable, static JSON snapshot of daily scan status;
- status derivation from existing scan receipts, daily run state, job queue, and exception queues;
- a bottom-of-page daily status table with green, yellow, red, and gray states;
- hover and keyboard-accessible issue details;
- a rolling 24-hour Today filter shared by jobs and Connections;
- date-range filtering of the status table;
- tests for the snapshot builder, classification rules, date handling, and UI rendering.

It does not add a live API, change Sunny's job qualification rules, or change the scan schedule.

## Chosen Architecture

Use a generated static snapshot at:

`local/sunny-job-search/data/scan-status.json`

This matches the existing static-site architecture. The browser reads one stable file instead of interpreting operational files or requiring a new server API.

A dedicated builder owns scan-status derivation. It reads the existing durable sources and atomically rewrites the snapshot. The builder is invoked by the normal website snapshot refresh and by the daily run closeout path so status stays current after scans and queue processing.

## Snapshot Schema

The document has a version, update timestamp, timezone, and an ordered list of daily rows:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-09-24T17:12:11.897Z",
  "timeZone": "America/New_York",
  "days": [
    {
      "date": "2026-09-24",
      "status": "yellow",
      "label": "有問題",
      "startedAt": "2026-09-24T16:13:07.825Z",
      "finishedAt": "2026-09-24T16:39:23.356Z",
      "scannedPortals": 3541,
      "found": 300636,
      "added": 75,
      "published": 9,
      "rejected": 75,
      "normalPending": 0,
      "candidateExceptions": 19,
      "sourceExceptions": 33,
      "sourceErrors": 21,
      "warnings": 39,
      "summary": "掃描完成並產生結果，但仍有 19 個 JD 與 33 個來源例外。",
      "issues": ["21 個來源錯誤", "39 個來源警告", "19 個 JD 無法讀取"],
      "receiptPath": "data/company-discovery/receipts/daily-....json"
    }
  ]
}
```

Counters are included only when supported by durable evidence. Missing values are `null`, not fabricated as zero. The status builder preserves prior daily rows when updating a new day.

## Status Rules

Status classification is deterministic and ordered from most severe to least severe:

1. **Red — major error**
   - a daily run was claimed but no usable receipt was produced;
   - the controller or scan terminated as failed without usable scan results;
   - normal candidate work remains pending after the run stopped;
   - the snapshot itself is invalid or cannot reconcile the day's run identity.
2. **Yellow — ran with problems**
   - a usable receipt exists and work produced durable outcomes, but the run is partial;
   - source errors, truncation warnings, candidate JD exceptions, source exceptions, or cooldown retries remain;
   - the normal queue drained, but durable blockers still prevent a clean completion.
3. **Green — ran cleanly**
   - a usable receipt exists;
   - the day's run completed;
   - normal pending work is zero;
   - there are no unresolved candidate/source exceptions or coverage warnings attributed to that run.
4. **Gray — did not run**
   - synthesized by the UI for a date in the selected range with no daily snapshot row.

The 2026-09-24 row is yellow because the scan produced results and the normal queue drained, while 19 candidate JD exceptions and 33 source exceptions remain.

## Time Semantics

All daily state identities use `America/New_York`.

The **Today** quick filter means the rolling interval from the current instant back exactly 24 hours. This prevents the page from becoming empty just after midnight before the next noon schedule.

Job and Connection filtering uses a precise `scannedAt` timestamp when present. The snapshot builder adds `scannedAt` to newly generated website rows. For legacy rows that only contain `scanDate`, it derives the best available timestamp from the matching scan receipt. If no trustworthy timestamp exists, the row receives a documented end-of-day fallback for its `scanDate` so it is not silently discarded.

The 7, 14, 21, and 30 day buttons continue to represent inclusive New York calendar-date ranges.

The status table remains calendar-day based. A rolling 24-hour Today selection may cross two New York dates, so the table displays both dates. A date with no run is shown as gray even when the adjacent date has a successful run.

## Website UI

The existing range controls gain a **Today** button before 7 days. Today is active by default.

At the bottom of the page, after Recent Connections, add a **每日掃描狀態** section containing:

- date;
- colored status dot and localized label;
- a compact progress summary;
- counts for scanned portals, newly found jobs, published jobs, pending jobs, and exceptions when available.

Each non-gray status dot supports hover and keyboard focus. Its tooltip lists the day's `summary` followed by concrete `issues`. The same text is available to assistive technology through an ARIA description. Gray rows explain that no run record exists for that New York date.

The status table follows only the active time range. Company search, priority filters, and referral-only filters do not hide operational status rows.

## Data Flow

1. A daily or catch-up scan writes its existing receipt.
2. Queue processing and closeout update the existing run, job, and exception states.
3. The status builder reads the durable sources and atomically updates `scan-status.json`.
4. The website snapshot builder refreshes job data, including `scannedAt` where evidence exists.
5. The browser fetches `jobs.json` and `scan-status.json` independently.
6. A missing or malformed status snapshot does not break job search; the status section shows an explicit load error and synthesizes gray rows for the selected interval.

## Error Handling

- Snapshot writes use a temporary file plus rename.
- Unsupported or corrupt receipts are skipped and reported as builder warnings rather than converted into green rows.
- Missing counters render as an em dash.
- Failure to load scan status leaves jobs and Connections usable.
- The browser never infers green from the absence of errors; green requires positive completion evidence.

## Tests

Test-driven implementation must cover:

- red, yellow, green, and gray classification;
- usable partial scan maps to yellow, not red;
- missing receipt after a scan claim maps to red;
- no record in a selected date maps to gray;
- Today defaults to a rolling 24-hour interval;
- Today remains populated across New York midnight when the last scan occurred the prior date;
- 7/14/21/30 remain inclusive calendar-day ranges;
- status table follows the selected interval but ignores company/priority filters;
- tooltip content includes concrete issue counts;
- malformed or missing status JSON does not break jobs or Connections;
- builder updates one date without deleting prior daily rows;
- generated JSON and website build pass existing regression tests.

## Acceptance Criteria

- Opening the website defaults to Today and displays jobs scanned within the prior 24 hours.
- The bottom table displays every New York calendar date touched by the selected interval.
- A missing day is visibly gray.
- Hovering or focusing a non-green status explains the exact recorded problems.
- Today's current durable state appears yellow with its current JD and source exception counts.
- Refreshing the daily snapshot preserves historical status rows.
- No Google Sheet or external service is required.
