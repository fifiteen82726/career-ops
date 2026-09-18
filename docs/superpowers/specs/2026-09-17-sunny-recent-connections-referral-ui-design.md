# Sunny Recent Connections Referral UI Design

**Approved:** 2026-09-17

## Goal

Add a people-first referral section directly below the existing `適合職缺` table. It shows recent LinkedIn Connections whose resolved current company has at least one currently visible suitable job, lets Sunny select one or more jobs at that company, and produces one editable referral message containing every selected job.

## Data boundary

- Use only the existing `jobs.json` snapshot and each job's `referralContacts` array.
- Do not add another browser request or change LinkedIn capture, matching, scheduling, or persistence.
- Invert the existing job-centric relationship in the browser: group visible jobs by connection profile URL and company.
- Deduplicate jobs within each connection group by canonical application URL plus scan date.

## Filtering

- The existing query, priority checkboxes, and inclusive date range filter both the job table and the Connections section.
- A query matching a connection name, current title, or employer keeps that connection and all of their jobs that pass date and priority filters.
- A query matching only job fields keeps only the matching jobs within that connection.
- A connection card disappears when no jobs remain.
- The `只看有內推人` toggle continues to affect the main table only because the Connections section inherently contains only jobs with referral contacts.
- When filtering hides a selected job, remove it from the selection so it cannot enter a later message invisibly.

## Layout

- Section heading: `最近 Connections`.
- Subtitle: `最近 14 天連線，且目前公司有適合職缺`.
- Each card shows the LinkedIn profile link, current title and employer, connected label, and the count of currently visible referral-ready jobs.
- Each job row shows a checkbox, title/application link, priority, score, location, posted date, and recommended resume.
- Cards sort by newest connection date, then person name. Jobs follow the main table's active sort order.

## Message interaction

- Each connection card owns its selection; jobs from different companies cannot be combined.
- `產生內推訊息` is disabled until at least one visible job is selected.
- Clicking it opens an accessible modal with an editable textarea.
- One selected job uses singular wording; multiple jobs use plural wording.
- Each selected job contributes its title and direct application URL.
- The message always uses `yiyunliao21@gmail.com`.
- `複製訊息` copies the textarea's current edited value, not a regenerated value.
- The modal supports close button, cancel button, backdrop click, and Escape.

## Empty state

When the active filters produce no referral-ready Connections, show `目前的篩選條件下沒有可內推職缺。` rather than an empty container.

## Verification

- Unit tests cover grouping, person/company/job-aware search, hidden-selection pruning, singular/plural message generation, and the corrected email.
- Browser tests cover checkbox selection, disabled/enabled generation, modal editing, copy, and synchronized query filtering.
- Existing job-table behavior remains unchanged.
