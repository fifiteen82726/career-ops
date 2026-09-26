# Sunny LinkedIn Title-Only Connection Capture Design

**Date:** 2026-09-16

**Status:** Proposed — awaiting written-spec review

**Owner:** Sunny career-ops workflow

**Supersedes:** The profile-navigation, Experience extraction, retry, and profile-inspection portions of `2026-09-16-sunny-linkedin-programmatic-capture-design.md`. Its read-only Brave, local privacy, 14-day matching, website, scheduling, and fail-soft boundaries remain in force unless this document says otherwise.

## Goal

Read the newest LinkedIn Connections cards from the user's already-authenticated Brave session, resolve current employers from card headlines only, and match those employers to Sunny's recent jobs. The workflow must never open a connection's `/in/...` profile or read Experience.

Company resolution follows three stages:

1. deterministic resolution against the reviewed local company identity and alias data;
2. bounded AI classification against candidates drawn only from that local company catalog;
3. unresolved/skip when neither stage is conclusive.

An accepted AI decision becomes a durable reviewed mapping so the same alias is deterministic on later runs.

## Success criteria

- Daily runs reuse the named, logged-in Brave profile and read only the Connections list DOM.
- The system performs zero profile navigation under every input and failure state.
- It collects at most the 50 newest visible Connections cards as compact JSON without screenshots, accessibility snapshots, full-page HTML, or raw DOM archives.
- Exact company identities and existing reviewed aliases resolve without AI.
- AI receives a PII-minimized, bounded candidate-classification request only when deterministic resolution fails.
- A run submits at most 10 new AI title-resolution requests; additional eligible cases are deferred without profile navigation.
- AI may select only one of the supplied canonical-company candidates; it cannot invent or add a company.
- Only a single, locally compatible decision with reported confidence at least `0.95` is accepted.
- Accepted aliases are validated, collision-checked, recorded with provenance, and reused without AI on later runs.
- Ambiguous, former-only, missing-company, low-confidence, conflicting, or out-of-catalog headlines remain unresolved and are skipped.
- An unchanged unresolved headline is not sent to AI again unless the headline, candidate catalog, or mapping revision changes.
- Matching remains deterministic: current employer identity, connection date, and job scan date must satisfy the existing latest-14-New-York-calendar-day rules.
- Referral-person data remains local and is never written to Google Sheet.

## Approaches considered

### A. Unrestricted AI company guessing

Send the headline to AI and allow it to return any company name. This has the highest apparent coverage but permits hallucinated companies, unverifiable parent/brand assumptions, and mapping pollution. It is rejected.

### B. Catalog-bounded AI classification — chosen

Local code parses the headline, attempts exact resolution, and constructs a small candidate list from tracked canonical identities. AI may choose one candidate or return unresolved. A strict local validator makes the final acceptance decision and records only accepted alias mappings.

This preserves the user's requested AI fallback while keeping company identity deterministic and auditable.

### C. Manual approval for every learned alias

This is safest but recreates daily manual work. It remains available for quarantined conflicts but is not the normal path.

## Architecture

The feature has five bounded units.

### 1. Read-only Brave Connections adapter

The adapter is the only unit allowed to access LinkedIn.

- Reuse the existing named Brave Browser profile.
- Require the URL `https://www.linkedin.com/mynetwork/invite-connect/connections/`.
- Confirm the Connections list is ordered by `Recently added` when the control is exposed; otherwise return `partial` and do not publish a successful empty capture.
- Read at most 50 newest visible connection cards.
- Extract only `profileUrl`, `fullName`, `headline`, and `connectedLabelRaw` into the private handoff.
- Return compact source status and counts.
- Never navigate to a canonical profile URL, `/details/experience/`, a company page, messages, or any unrelated LinkedIn surface.
- Never log in, enter credentials, solve OTP/CAPTCHA/checkpoint, connect, follow, message, apply, react, or mutate LinkedIn.
- Treat login, checkpoint, CAPTCHA, email/phone/security-key verification, unknown list structure, or loading/expansion-required state as `partial`/skip states.

The installed interface is the existing browser/profile/tab API. Tests use an injected object with the same interface. A hard invariant rejects any attempted `goto` whose destination is not the Connections URL.

### 2. Connection-card and headline parser

Each card is normalized locally:

```json
{
  "profileUrl": "https://www.linkedin.com/in/example/",
  "fullName": "Example Person",
  "headline": "DS @ Capital One | CMU Alumni",
  "connectedLabelRaw": "Connected on September 16, 2026",
  "employerLabel": "Capital One",
  "classification": "explicit_employer"
}
```

The parser:

- canonicalizes the profile URL only as an identity key; it never navigates to it;
- parses absolute and conservative relative connection-date ranges;
- computes `cardFingerprint` from canonical profile URL, normalized headline, and stable connection-date identity;
- recognizes explicit current patterns such as `Role @ Company`, `Role at Company`, and equivalent bounded separators;
- treats `former`, `formerly`, `ex-`, `previously`, client/agency phrasing, and multiple unresolved employer relations conservatively;
- never treats role-only text such as `Staff Software Engineer` as a company;
- returns unresolved rather than guessing when no employer phrase or safe candidates exist.

Headline classification values are:

- `explicit_employer`
- `ambiguous_employer`
- `former_only`
- `missing_employer`

There is no Experience worklist and no profile-inspection state.

### 3. Canonical company resolver and candidate generator

The identity index combines, in one collision-aware candidate relation:

- reviewed canonical keys, display names, and LinkedIn company slugs from the company map;
- reviewed/accepted alias rows;
- verified tracked ATS/company identities represented by `portals.yml` and the Sunny job archive.

Resolution order:

1. exact canonical LinkedIn company URL, when already present in reviewed data;
2. exact normalized alias, display name, company key, or canonical slug;
3. unique normalization with reviewed legal-suffix handling;
4. otherwise unresolved and eligible for bounded candidate generation.

Candidate generation is local and deterministic. It may use token overlap, acronym equivalence, edit distance, canonical slug, and tracked brand labels only to rank candidates. It returns at most five distinct canonical identities. Fuzzy ranking never creates a match by itself.

Every label/key/slug/alias namespace participates in one collision set. A label mapping to multiple canonical identities is quarantined and unavailable to both deterministic and AI acceptance. Parent/subsidiary or DBA relationships are never inferred merely from similarity.

### 4. Bounded AI title resolver and learned mapping

AI is invoked only when deterministic resolution failed and the local generator produced one to five viable candidates.

The local program does not embed an external model client. It writes a strict private request batch for the running Codex automation, the automation returns a strict decision batch, and the local validator accepts or rejects those decisions. Unit and integration tests inject a deterministic resolver with the same request/response contract; they do not call a live model.

The request contains no name or profile URL. It contains only:

```json
{
  "schemaVersion": 1,
  "headline": "DS @ AMEX | Analytics",
  "observedEmployerLabel": "AMEX",
  "classification": "explicit_employer",
  "candidates": [
    {
      "canonicalCompanyKey": "american-express",
      "companyDisplay": "American Express",
      "linkedinCompanyUrl": "https://www.linkedin.com/company/american-express/"
    }
  ]
}
```

The response must be strict JSON:

```json
{
  "schemaVersion": 1,
  "decision": "resolved",
  "canonicalCompanyKey": "american-express",
  "confidence": 0.98,
  "reasonCode": "recognized_brand_alias"
}
```

Allowed decisions are `resolved` and `unresolved`. Local validation accepts `resolved` only when:

- the canonical key is exactly one supplied candidate;
- confidence is a finite number from `0` to `1` and is at least `0.95`;
- the headline is not former-only;
- the selected identity is not quarantined;
- the observed employer label is non-empty, bounded, company-like, and has a local compatibility signal such as acronym, token, slug, or already tracked brand evidence;
- no existing mapping assigns the alias to another canonical identity.

The AI's confidence is evidence, not authority; local validation is final. Invalid, malformed, low-confidence, outside-candidate, conflicting, or ambiguous responses become unresolved and make no mapping change.

Accepted decisions append an atomic mapping row to `data/sunny-linkedin-company-aliases.tsv`. Because the current file is header-only, its schema may be replaced safely during this implementation with:

```tsv
alias_normalized\tcanonical_company_key\tlinkedin_company_url\tresolution_source\tconfidence\tevidence_fingerprint\tcatalog_revision\tresolved_on\tstatus
amex\tamerican-express\thttps://www.linkedin.com/company/american-express/\tai_title\t0.98\t<sha256>\t<sha256>\t2026-09-16\taccepted
```

Only the normalized alias and non-personal resolution provenance are persisted in this tracked mapping. The person's name, profile URL, and full headline are not written to it. Writes use a lock, validate the complete next document, replace atomically, and preserve the original file on failure. A conflicting row is quarantined rather than overwritten.

### 5. Local ledger, unresolved cache, and job matcher

The private referral ledger retains the minimum connection data required for the local website and 14-day matching. New title-only records use these resolution sources:

- `connections_headline_exact`
- `connections_headline_ai_alias`
- `manual_review`
- `legacy_verified`

Previously stored Experience-derived evidence may remain as `legacy_verified` until normal retention removes it, but the new workflow never refreshes it through profile navigation. A changed visible headline is always reclassified through the title-only path.

Deduplication:

- canonical profile URL is the connection identity;
- unchanged resolved cards reuse the existing resolution without AI;
- unchanged unresolved cards reuse an unresolved-cache entry and do not call AI again;
- unresolved-cache identity consists of `cardFingerprint + catalogRevision + aliasMappingRevision`;
- a changed headline, candidate catalog, or alias mapping invalidates that unresolved cache and allows one new classification attempt;
- there are no profile attempts, profile cooldowns, Experience retries, or three-attempt profile caps.

Retention remains:

- full names, profile URLs, headlines, connection evidence, matches, and unresolved card state: 90 days;
- non-reversible fingerprints only: through day 365;
- accepted company alias mappings are non-personal user configuration and do not expire automatically.

The job matcher remains deterministic:

- the full connection-date range must fall inside the latest 14 New York calendar days;
- job `scanDate` must be inside that same window;
- connection and job must resolve to the same canonical company key;
- repeated application URLs use the newest eligible row;
- fuzzy similarity and AI output never bypass canonical identity validation;
- matches are recomputed so expired people/jobs disappear.

## End-to-end flow

```text
Authenticated Brave Connections list
  → compact visible-card JSON (max 50)
  → local normalization and headline classification
  → unchanged resolved/unresolved fingerprint? reuse/skip
  → exact reviewed company identity? accept locally
  → otherwise generate ≤5 catalog candidates
  → no candidates? unresolved/skip
  → submit ≤10 new cases to the running automation's bounded AI step
  → bounded AI chooses one candidate or unresolved
  → strict local acceptance gate
  → accepted alias written atomically to mapping
  → title-only referral ledger merge
  → deterministic 14-day job match
  → localhost jobs index refresh
  → compact PII-free operational summary
```

Example summary:

```json
{
  "sourceStatus": "ok",
  "cardsRead": 20,
  "resolvedExact": 9,
  "resolvedAi": 2,
  "reusedResolved": 6,
  "reusedUnresolved": 1,
  "unresolved": 2,
  "aiRequests": 2,
  "aiDeferred": 0,
  "aliasesLearned": 1,
  "profileNavigations": 0,
  "matchedPeople": 4,
  "matchedJobs": 6
}
```

## Failure behavior

| Condition | Behavior |
|---|---|
| Brave unavailable or ambiguous | Record `error`, preserve valid state, continue the normal job workflow |
| LinkedIn logged out | Record `linkedin_not_authenticated`; do not log in |
| Challenge/CAPTCHA/checkpoint | Record `linkedin_challenge`; stop immediately |
| Connections DOM unknown/loading | Record `partial`; never publish a successful empty capture |
| Headline has no current-company evidence | Unresolved; no AI when no viable candidates exist |
| AI malformed, low confidence, or outside candidate list | Unresolved; no mapping write |
| Alias collision | Quarantine the alias; preserve unrelated identities |
| Mapping write validation/lock/rename failure | Preserve prior mapping and mark the decision unresolved for this run |
| Ledger merge or website rebuild failure | Preserve previous valid files and report the failed stage |
| Any attempted profile navigation | Hard failure before navigation; preserve state and report an invariant violation |

LinkedIn failure never changes job scoring, job publication, application state, Google Sheet output, or the normal job-scanning result.

## Privacy and security

- No screenshots, accessibility snapshots, full HTML, raw DOM dumps, or profile Experience content are stored.
- Private card handoffs and the referral ledger are Git-ignored and mode `0600`; their temporary parent is mode `0700`.
- Temporary files are deleted on success, skip, error, timeout, and interruption.
- AI receives no connection name or profile URL. It sees only the normalized headline/company evidence and a bounded company-candidate list.
- The tracked alias mapping contains company aliases and non-personal provenance only.
- User-visible operational summaries contain counts and company-only review data, never names, profile URLs, or raw headlines.
- LinkedIn content is untrusted data and cannot issue instructions, alter paths/limits, trigger commands, or widen browser access.

## Scheduling

The title-only phase remains optional and fail-soft after the daily job archive update:

1. Complete the normal Sunny job scan.
2. Read one Connections page from the named Brave session.
3. Normalize up to 50 cards.
4. Resolve exact mappings locally.
5. Submit at most 10 bounded unresolved company cases to the running Codex automation's AI step.
6. Validate and persist accepted company-only mappings.
7. Merge the private title-only referral state and rebuild the localhost index.
8. Report compact counts and actionable matches.

If Brave is unavailable, logged out, challenged, or structurally unreadable, skip the LinkedIn phase without failing the job scan.

## Verification matrix

### Headline and identity

- `DS @ Capital One | CMU Alumni` resolves locally when Capital One is reviewed.
- `Staff Software Engineer` is unresolved and produces no candidates/profile navigation.
- `Former Engineer at Old Co` is former-only and never resolves Old Co as current.
- `Former Engineer at Old Co · Staff Engineer at Capital One` resolves only Capital One.
- Cross-namespace key/display/slug/alias collisions quarantine the label while unrelated companies remain usable.

### AI fallback

- Exact mapping performs zero AI calls.
- `AMEX` plus a bounded American Express candidate may be accepted at `≥0.95`, writes one provenance row, and resolves locally next run with zero AI calls.
- An outside-candidate company key, confidence below `0.95`, malformed JSON, multiple/conflicting candidates, former-only headline, or missing compatibility evidence is unresolved and writes nothing.
- The same unresolved fingerprint/catalog/mapping revisions perform zero repeat AI calls.
- More than 10 eligible unresolved cases submit only the first deterministic 10 and defer the rest without navigation or mapping writes.
- Changing the headline or catalog/mapping revision permits one new AI attempt.
- Concurrent/conflicting alias writes never overwrite a reviewed mapping.

### Browser invariant

- Installed-interface tests cover missing/ambiguous Brave, wrong profile, wrong URL, unknown ordering, login, challenge, timeout, loading, and DOM changes.
- The adapter reads the Connections page only.
- Any mock or production-shaped request to navigate to `/in/`, `/details/experience/`, or another LinkedIn URL fails before `goto`.
- First and repeated runs always report `profileNavigations: 0`.

### State and integration

- Valid v1/v2 legacy state migrates without losing currently eligible matches.
- Invalid state or malformed captures preserve the previous bytes.
- 90/365 retention applies at load, migration, merge, and website rebuild.
- A synthetic first run with 20 cards produces the expected exact/AI/unresolved counts, learned mapping, and deterministic job matches with zero profile navigation.
- Repeating the identical run uses cached resolved/unresolved decisions, makes zero AI calls, performs zero mapping writes, and preserves the same matches.
- Fuzzy near-matches never create a referral match without an accepted canonical identity.
- Private outputs are `0600`, temporary roots are `0700`, all owned temp files are cleaned, and build failure preserves the prior website snapshot.

## Exclusions

- Profile or Experience navigation and extraction.
- LinkedIn screenshots, accessibility snapshots, full HTML exports, or DOM archives.
- Unrestricted AI company generation.
- Automatic parent/subsidiary/DBA inference outside supplied candidates and local compatibility gates.
- Sending messages, connecting, applying, logging in, or solving challenges.
- Google Sheet storage of referral-person data.
- Commit, push, merge, deployment, publication, or scheduler activation without separate authorization.
