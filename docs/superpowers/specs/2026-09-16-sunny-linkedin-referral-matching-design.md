# Sunny LinkedIn Referral Matching Design

**Date:** 2026-09-16  
**Status:** Approved for planning  
**Owner:** Sunny career-ops workflow

## Goal

Extend Sunny's existing daily Codex job scan so it uses the already-authenticated Brave Browser session to inspect newly added LinkedIn connections, confirms each person's current employer, matches those people to suitable jobs discovered in the last 14 days, stores the result privately, and displays referral contacts in the existing localhost job-search website.

## Explicit boundaries

- Use Brave Browser only. Do not use Grok Bot for this feature.
- Open `https://www.linkedin.com/mynetwork/invite-connect/connections/` only during the daily job-scan workflow.
- Never enter credentials, complete a verification challenge, send a message, connect, follow, apply, or modify LinkedIn.
- If Brave is not authenticated, immediately skip the LinkedIn step and continue the job scan and website refresh.
- LinkedIn is a referral-contact source only. It is not a job-discovery or company-discovery source.
- Do not write referral matches to Google Sheet.
- Only a person currently employed by the job's company qualifies. Former employees do not qualify.
- Keep all connection PII in ignored user-layer files. Never commit it to Git or expose it through the public repository.

## Chosen approach

Use a daily incremental ledger and enrich the existing local `jobs.json` snapshot.

The first successful run considers LinkedIn connections added in the last 14 days. Later runs consider newly observed connections since the last successful LinkedIn scan while retaining the ledger for deduplication. The matcher compares verified current-employer evidence to jobs whose `scanDate` falls in the most recent 14 calendar days. The localhost table gains a `近期內推人` column and a `只看有內推人` filter.

This approach is preferred over repeatedly scraping the same 14-day window or requiring manual `Connections.csv` exports because it is incremental, reviewable, fail-soft, and integrated into the existing daily workflow.

## Components

### 1. Browser capture protocol

The daily automation controls the user's existing Brave session through computer-use UI automation:

1. Select Brave without launching a separate browser profile.
2. Open or reuse a dedicated tab at the Connections URL.
3. Detect authentication before reading any data.
4. Select `Recently added` ordering when the page exposes a sort control.
5. Read at most the 50 newest connection cards per run.
6. On the first successful run, retain cards whose displayed connection date is within 14 days.
7. On later runs, retain unseen profile URLs and stop after the bounded page has no unseen connections.
8. Open at most 20 candidate profiles per run to verify current employment. Unprocessed candidates remain `pending_verification` for a later run.

Authentication succeeds only when the Connections list and connection-card semantics are visible. Any redirect or prompt for login, checkpoint, CAPTCHA, email/phone verification, security key, or one-time code produces `linkedin_not_authenticated` or `linkedin_challenge`. The automation must not attempt recovery.

The capture step records minimal operational data only. It must not archive profile HTML, screenshots, posts, messages, email addresses, phone numbers, or unrelated experience entries.

### 2. Current-employer verification

A person qualifies only when the currently active Experience entry explicitly indicates `Present` or has no end date and is marked current.

Evidence priority:

1. Exact LinkedIn company-page URL from the active Experience entry equals the verified `linkedin_company_url` in `data/sunny-linkedin-company-map.tsv`.
2. An explicitly reviewed company alias maps both names to the same verified LinkedIn company-page URL.
3. If LinkedIn exposes no company URL, an exact normalized current-employer name may match the job company. This is recorded as `exact_text` and must not use substring or fuzzy matching.

Headline text alone is never sufficient. A former Experience entry, education entry, client mention, or headline phrase cannot establish current employment.

### 3. Private referral state

Create one ignored user-layer file:

`data/sunny-linkedin-referrals.json`

Schema version 1:

```json
{
  "schemaVersion": 1,
  "timeZone": "America/New_York",
  "lastAttemptAt": "2026-09-16T16:00:00.000Z",
  "lastSuccessfulScanAt": "2026-09-16T16:01:00.000Z",
  "sourceStatus": "ok",
  "sourceWarning": "",
  "connections": [
    {
      "profileUrl": "https://www.linkedin.com/in/example/",
      "fullName": "Example Person",
      "connectedAt": "2026-09-15",
      "connectedDatePrecision": "day",
      "firstSeenAt": "2026-09-16T16:00:30.000Z",
      "verificationStatus": "verified_current",
      "currentEmployer": "Example Company",
      "currentEmployerLinkedinUrl": "https://www.linkedin.com/company/example-company/",
      "currentTitle": "Data Engineer",
      "employmentVerifiedAt": "2026-09-16T16:00:50.000Z",
      "employmentEvidence": "Current Experience entry marked Present"
    }
  ],
  "matches": [
    {
      "matchKey": "https://apply.example/job-1|https://www.linkedin.com/in/example/",
      "applyUrl": "https://apply.example/job-1",
      "jobScanDate": "2026-09-15",
      "jobCompany": "Example Company",
      "profileUrl": "https://www.linkedin.com/in/example/",
      "fullName": "Example Person",
      "currentTitle": "Data Engineer",
      "currentEmployer": "Example Company",
      "connectedAt": "2026-09-15",
      "matchQuality": "company_url_exact",
      "matchedAt": "2026-09-16T16:01:00.000Z"
    }
  ]
}
```

Allowed `sourceStatus` values are `ok`, `partial`, `linkedin_not_authenticated`, `linkedin_challenge`, and `error`. Allowed verification states are `pending_verification`, `verified_current`, `not_current`, and `unresolved`. Allowed match qualities are `company_url_exact`, `reviewed_alias`, and `exact_text`.

Profile URL is the connection identity. `matchKey` is canonical application URL plus canonical profile URL. Updates are atomic: validate a temporary file, then rename it over the prior valid file. A failed capture or validation preserves the last successful `connections` and `matches`, updates only attempt status through an atomic valid document, and never replaces the file with empty data.

### 4. Deterministic matcher and snapshot enrichment

Create a zero-network module that:

- validates the referral state schema;
- canonicalizes LinkedIn profile/company URLs and application URLs;
- selects archive jobs with `scanDate` in the inclusive latest 14-day window;
- excludes people not marked `verified_current`;
- matches only through the three approved evidence tiers;
- deduplicates by `matchKey`;
- sorts contacts by newest `connectedAt`, then name;
- returns each job's `referralContacts` array.

`data/tools/build-sunny-job-search-index.mjs` reads `data/sunny-linkedin-referrals.json` when present. It adds these top-level fields to `local/sunny-job-search/data/jobs.json`:

```json
{
  "referralDataStatus": "ok",
  "referralDataUpdatedAt": "2026-09-16T16:01:00.000Z"
}
```

Each enriched job receives:

```json
{
  "referralContacts": [
    {
      "fullName": "Example Person",
      "profileUrl": "https://www.linkedin.com/in/example/",
      "currentTitle": "Data Engineer",
      "currentEmployer": "Example Company",
      "connectedAt": "2026-09-15",
      "matchQuality": "company_url_exact"
    }
  ]
}
```

Jobs without a match receive an empty array. Invalid referral data must not destroy the last valid website snapshot; the builder fails closed and preserves the existing `jobs.json`.

### 5. Local website behavior

Modify the existing single-page table rather than creating a second page.

- Add a `近期內推人` column immediately after `LinkedIn People`.
- Render every matched person as a separate line with:
  - name hyperlinked to the LinkedIn profile;
  - current title;
  - connected date;
  - independent copy-name and copy-profile controls.
- Show `—` for jobs without matches.
- Add a `只看有內推人` checkbox to the existing filter controls. It is off by default.
- Include referral name, employer, title, and profile URL in global search.
- Display `內推資料更新：<time>` when the latest referral source status is `ok` or `partial`.
- Display a nonblocking warning when the source was skipped or failed, while continuing to show the last valid contacts.
- Preserve all current date, priority, score, global-search, hyperlink, copy, and responsive behaviors.

### 6. Daily automation order

The existing `sunny-24` Codex automation is updated, not replaced:

1. Run the normal three-day job scan, deterministic gates, evaluation, and queue processing.
2. Update the private local job archive as it already does.
3. Attempt the Brave LinkedIn connection step.
4. If authenticated, merge new connection observations, process up to 20 pending current-employer verifications, and rebuild 14-day matches.
5. If unauthenticated/challenged, skip without changing the last successful connections or matches.
6. Rebuild the localhost `jobs.json` with referral enrichment.
7. Verify JSON schema, unique `matchKey` values, canonical URLs, and presence of newly matched contacts.
8. Report source status, new connections, profiles verified, pending verifications, matched people, matched jobs, and website refresh status.

Google Sheet behavior remains unchanged by this feature. No referral contact is written to the Sheet.

## Failure behavior

| Condition | Behavior |
|---|---|
| Brave unavailable | `error`; preserve previous referral data; continue job workflow |
| LinkedIn logged out | `linkedin_not_authenticated`; do not log in; preserve data |
| LinkedIn challenge/CAPTCHA | `linkedin_challenge`; stop LinkedIn actions; preserve data |
| UI layout cannot be parsed | `partial` or `error`; preserve prior verified contacts |
| Profile lacks verifiable current Experience | mark `unresolved`; do not match |
| Former employer only | mark `not_current`; do not match |
| Ambiguous company identity | no match; record unresolved evidence |
| Referral JSON invalid | preserve previous file and website snapshot |
| Website rebuild fails | preserve previous `jobs.json`; report failure |

LinkedIn failure never changes job qualification, score, priority, queue disposition, or Sheet publication.

## Testing strategy

- Unit-test referral schema validation, URL canonicalization, current-only filtering, exact company URL matching, reviewed aliases, exact-text fallback, former-employee rejection, 14-day inclusivity, and `matchKey` deduplication.
- Unit-test snapshot enrichment and preservation when referral JSON is absent or invalid.
- Unit-test the `只看有內推人` filter, global referral search, referral rendering, and copy/link behavior.
- Add browser-capture fixtures for authenticated Connections, logged-out redirect, challenge page, `Present` Experience, former Experience, and ambiguous employer.
- Run the existing local website, builder, server, Sunny scan, and automation-related regression tests.
- Perform one manual Brave smoke run without sending messages or changing LinkedIn.

## Acceptance criteria

1. The daily Codex scan uses the existing Brave session and never attempts login or challenge recovery.
2. Logged-out LinkedIn is a skipped optional step, not a failed daily job scan.
3. Only verified current employees can appear as referral contacts.
4. Only suitable jobs discovered within the inclusive latest 14 days receive matches.
5. One private atomic referral file provides durable dedup state.
6. Google Sheet receives no referral-person data or schema changes.
7. The localhost site shows linked referral contacts and supports filtering to matched jobs.
8. LinkedIn and website failures preserve the last valid data and never cause job loss or duplicate publication.
9. No automation sends a LinkedIn message, connection request, application, or other external action.
