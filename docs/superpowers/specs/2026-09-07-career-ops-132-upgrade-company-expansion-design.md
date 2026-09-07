# Career-Ops 1.32 Upgrade and Sunny Company Expansion Design

## Objective

Upgrade Sunny's career-ops fork from 1.29.0 to the 1.32.0 system layer without losing local ATS coverage fixes or any candidate/company data, then use the upgraded discovery capabilities to increase verified New York / NYC Metropolitan and US-remote H-1B company coverage.

## Baseline

- Local system version: 1.29.0.
- Target release: `career-ops-v1.32.0`.
- Current DOL universe: 2,663 normalized FY2026 Q3 `CHANGE_EMPLOYER` identities after combining New York State and practical NYC Metropolitan worksites.
- Current linked identities: 1,147.
- Current unresolved identities: 1,514.
- Current enabled company/board entries in `portals.yml`: 1,992.
- Local provider work that must survive: Ashby hosted-page fallback, Workday `myworkdaysite.com/recruiting/...` support, and MobiCloud provider support.

## Constraints

1. `cv.md`, `config/profile.yml`, `modes/_profile.md`, `modes/_custom.md`, `portals.yml`, `data/`, `reports/`, and `output/` remain authoritative user data and must not be replaced by upstream files.
2. No `--force` upgrade is allowed.
3. No company may enter the H-1B target pool solely because an aggregator lists a job. It needs current accepted DOL `CHANGE_EMPLOYER` evidence or an already reviewed legal-name/DBA/parent mapping.
4. Meta remains excluded. Explicit no-sponsorship language remains a hard reject.
5. A company is counted as ATS-covered only when the board identity is safe and the board is currently reachable. Empty-but-live boards may be tracked but must not be counted as current-job coverage.
6. Company additions must preserve idempotent deduplication and the compact Google Sheet schema already defined in `modes/_custom.md`.

## Upgrade Architecture

The upgrade uses the repository's system updater in preserve mode. Before applying it, custom untracked code is copied into a dated archive outside the repository, immutable user files receive a SHA-256 manifest in `data/cache/upgrade/`, and fork-only user directories are declared in `config/local-paths.txt`. Clone-only privacy ignores go in `.git/info/exclude` so the pre-upgrade step does not create another modified system file. Private user-layer files are never committed.

The updater is run without `--force`, so locally changed system files remain intact while all non-overlapping system files move to 1.32.0. Afterward, the Workday provider is intentionally reconstructed from the upstream 1.32 implementation and the local `myworkdaysite.com` URL support is reapplied. The upstream implementation is the base because its facet-splitting recovery and CXS URL handling are important for large employers. The Ashby fallback is retained because upstream 1.32 does not contain equivalent hosted-page recovery. The MobiCloud provider remains a separate provider and is checked against the upgraded provider loader.

## Company Expansion Architecture

Expansion has four independent evidence streams:

1. **DOL-first unresolved replay:** rebuild the resolution state against the upgraded `portals.yml`, refreshed public ATS caches, and reviewed aliases. This is the authoritative universe.
2. **Built In discovery:** use the new aggregator provider for broad Sunny title/location queries, extract employer brands, then join each brand back to the DOL universe before ATS resolution.
3. **H-1B sponsor enrichment:** enable the new sponsor plugin when it is locally available and use it as additional evidence during evaluation and alias review. It supplements rather than replaces Sunny's FY2026 Q3 DOL table.
4. **ATS resolution with an ownership gate:** run `discover-ats.mjs` and the checkpointed Sunny resolver across unresolved identities, but treat a live board as a candidate rather than proof. Greenhouse, Ashby, and Lever candidates must publish an owner that canonically equals the DOL/DBA/reviewed alias identity. Other providers require an exact accepted URL in `profiles/sunny-h1b-ats-identity-reviews.yml` or evidence that the employer's official site links to that ATS URL. Workday still requires an official URL or coordinates; it is never brute-forced. Collision-prone prefix matches such as Mercury/Mercury Systems and Scale/Scale AI fail closed.

Every input identity ends in one durable v2 state: `already_covered`, `owner_verified`, `reviewed_official_link`, `live_empty`, `owner_mismatch`, `owner_unreachable`, `unsupported_official`, `ambiguous`, `excluded`, `invalid_identity`, `dead`, `partial`, `error`, or `unresolved`. Only `owner_verified` and `reviewed_official_link` may enter `portals.yml`. Repeating the same pass must add zero duplicates. A versioned checkpoint replays all old unresolved/error records once after the upgrade and supports explicit `--retry-statuses` thereafter.

## Data Flow

```text
DOL FY2026 Q3 CHANGE_EMPLOYER + NYC Metro geography
                         |
                         v
              normalized employer universe
                         |
          +--------------+----------------+
          |              |                |
          v              v                v
 existing portals   Built In brands   sponsor/alias evidence
          |              |                |
          +--------------+----------------+
                         v
                identity-safe ATS resolver
                         |
        +----------------+----------------+
        |                                 |
        v                                 v
  portals.yml additions            durable non-covered state
        |
        v
  scan -> title/location/date filter -> dedup -> Sunny scoring -> Sheet
```

## Failure Handling

- Upgrade failure: stop, preserve the updater log, and recover through the generated backup branch/WIP ref; do not rerun with `--force`.
- Provider merge failure: restore the 1.32 upstream provider and reapply only the smallest proven local behavior behind focused tests.
- ATS timeout or transient 429/5xx: retain an error/checkpoint state and retry with the existing bounded retry policy; never classify it as an empty board.
- Partial Workday board: record partial/facet recovery in the portal-health log; the v1 scan receipt does not carry this state. Do not treat a partial zero as a trustworthy zero.
- Aggregator-only employer: retain as a discovery lead until DOL identity and official ATS evidence are established.
- Alias collision: withhold the company rather than attach another employer's board.

## Verification and Acceptance

The upgrade is accepted only when:

1. `VERSION` reports 1.32.0.
2. Sunny user-layer files are byte-identical to the pre-upgrade inventory except for intentional company additions and regenerated audit artifacts.
3. Upstream Workday facet/CXS tests and the local `myworkdaysite.com` test pass together.
4. Ashby fallback, MobiCloud, Sunny title filter, geography, identity resolution, and dedup tests pass.
5. `node test-all.mjs`, portal validation, and `git diff --check` pass.
6. A dry scan produces the documented `careerops.scan.receipt@1` counters and URLs. A separate portal-health artifact from strict verification records live, empty, missing/dead, partial, and transient-error states.

The expansion is accepted only when:

1. All deterministic upgraded discovery streams have completed or have durable checkpoint states.
2. Every newly added portal has DOL/alias evidence and a live first-party or supported provider.
3. `portals.yml` validates with zero errors.
4. Rebuilding the identity resolution yields updated exact linked/unresolved counts.
5. A second identical append pass adds zero entries.
6. The dated coverage audit records the baseline, additions by source, final linked identities, final unresolved identities, live/empty/error/partial counts, and known coverage limits.

## Non-goals

- Claiming near-100% ATS coverage when an employer has no public ATS or exposes no safe legal-name/brand mapping.
- Adding all DOL employers regardless of role, geography, liveness, or identity confidence.
- Replacing the existing FY2026 Q3 DOL evidence with an aggregator badge or historical sponsor label.
- Generating a tailored resume for every discovered job before Sunny shortlists it.
