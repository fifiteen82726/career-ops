import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { emptyState, migrateReferralState, prepareTitleResolution, finalizeTitleResolution, validateReferralState, writeReferralStateAtomic, buildReferralMatches } from '../referrals.mjs';
import { buildCompanyIdentityIndex, parseCompanyMapRows, computeCatalogRevision, computeAliasMappingRevision } from '../company-identities.mjs';

const now = new Date('2026-09-16T16:00:00.000Z');
const index = buildCompanyIdentityIndex({ companyMapRows: parseCompanyMapRows('company_key\tcompany_display\tlinkedin_company_url\tlinkedin_people_url\tverification_source\tverified_on\tstatus\nacme\tAcme\thttps://www.linkedin.com/company/acme/\thttps://www.linkedin.com/company/acme/people/\treview\t2026-09-16\tverified\n') });
const capture = headline => ({ observedAt: now.toISOString(), sourceStatus:'ok', sourceWarning:'', connections:[{profileUrl:'https://www.linkedin.com/in/a/',fullName:'Person',headline,connectedLabelRaw:'Connected yesterday'}] });

test('v3 keeps a headline-only exact resolution and rejects legacy profile fields', () => {
  const prepared = prepareTitleResolution({state:emptyState(now),capture:capture('Engineer at Acme'),identityIndex:index,catalogRevision:computeCatalogRevision(index),aliasRevision:computeAliasMappingRevision([]),now});
  assert.equal(prepared.exact, 1); assert.equal(prepared.batch.requests.length, 0);
  assert.equal(prepared.state.connections[0].employers[0].resolutionSource, 'connections_headline_exact');
  assert.throws(() => validateReferralState({...prepared.state, profileInspectionComplete:true}));
});

test('v1 migration retains legacy employers but gives them no canonical identity', () => {
  const migrated = migrateReferralState({schemaVersion:1,sourceStatus:'ok',updatedAt:now.toISOString(),connections:[{profileUrl:'https://www.linkedin.com/in/a/',fullName:'P',currentEmployments:[{employer:'Old',title:'Engineer',isCurrent:true}]}],matches:[]},{now});
  validateReferralState(migrated); assert.equal(migrated.connections[0].employers[0].canonicalCompanyKey, null);
});

test('atomic v3 writer preserves private mode', () => {
  const path=join(mkdtempSync(join(tmpdir(),'sunny-v3-')),'state.json'), state=emptyState(now); writeReferralStateAtomic(path,state);
  assert.equal(statSync(path).mode & 0o777,0o600); assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),state);
});

test('accepted AI decision settles the prepared card with its employer evidence', () => {
  const unresolved = prepareTitleResolution({
    state: emptyState(now), capture: capture('Engineer at Acm'), identityIndex: index,
    catalogRevision: computeCatalogRevision(index), aliasRevision: computeAliasMappingRevision([]), now,
  });
  assert.equal(unresolved.batch.requests.length, 1);
  const request = unresolved.batch.requests[0];
  const finalized = finalizeTitleResolution({
    prepared: unresolved, identityIndex: index, catalogRevision: computeCatalogRevision(index),
    aliasRevision: computeAliasMappingRevision([]), now,
    decisions: { schemaVersion: 1, batchId: unresolved.batch.batchId, decisions: [{ schemaVersion: 1, requestId: request.requestId, decision: 'resolved', canonicalCompanyKey: 'acme', confidence: .99, reasonCode: 'recognized_brand_alias' }] },
    persist: () => ({ status: 'persisted' }),
  });
  assert.equal(finalized.state.connections[0].employers[0].canonicalCompanyKey, 'acme');
  assert.equal(finalized.state.connections[0].employers[0].employerLabel, 'Acm');
});

test('title-only resolved employers produce deterministic recent archive matches', () => {
  const prepared = prepareTitleResolution({ state: emptyState(now), capture: capture('Engineer at Acme'), identityIndex: index,
    catalogRevision: computeCatalogRevision(index), aliasRevision: computeAliasMappingRevision([]), now });
  const matches = buildReferralMatches({ state: prepared.state, now, jobs: [
    { scanDate: '2026-09-15', applyUrl: 'https://jobs.example.test/a?utm_source=x', canonicalCompanyKey: 'acme' },
    { scanDate: '2026-09-15', applyUrl: 'https://jobs.example.test/a', canonicalCompanyKey: 'acme' },
  ] });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].canonicalApplyUrl, 'https://jobs.example.test/a');
});

test('strict state rejects malformed nested cache, duplicate match keys, and expired retained PII', () => {
  const state = emptyState(now);
  state.retainedHashes.push({ sha256: 'a'.repeat(64), lastSeenAt: 'not-a-date' });
  assert.throws(() => validateReferralState(state));
  const prepared = prepareTitleResolution({ state: emptyState(now), capture: capture('Engineer at Acme'), identityIndex: index,
    catalogRevision: computeCatalogRevision(index), aliasRevision: computeAliasMappingRevision([]), now });
  prepared.state.connections[0].unresolvedCache = { catalogRevision: 'x' };
  assert.throws(() => validateReferralState(prepared.state));
});

test('time-bound validation rejects residual expired connection PII before matching', () => {
  const prepared = prepareTitleResolution({ state: emptyState(now), capture: capture('Engineer at Acme'), identityIndex: index,
    catalogRevision: computeCatalogRevision(index), aliasRevision: computeAliasMappingRevision([]), now });
  prepared.state.connections[0].lastObservedAt = '2026-06-01T16:00:00.000Z';
  assert.throws(() => validateReferralState(prepared.state, { now }), /expired connection PII/);
});

test('validator accepts title parser vocabulary and legacy multi-employer migration', () => {
  const ambiguous = prepareTitleResolution({
    state: emptyState(now), capture: capture('Engineer at Acme · Advisor at Other'), identityIndex: index,
    catalogRevision: computeCatalogRevision(index), aliasRevision: computeAliasMappingRevision([]), now,
  });
  assert.equal(ambiguous.state.connections[0].classification, 'ambiguous_employer');
  assert.equal(ambiguous.state.connections[0].connectedDatePrecision, 'relative_day');
  assert.doesNotThrow(() => validateReferralState(ambiguous.state));
  const legacy = migrateReferralState({ schemaVersion: 1, sourceStatus: 'ok', updatedAt: now.toISOString(), connections: [{
    profileUrl: 'https://www.linkedin.com/in/multi/', fullName: 'P', currentEmployments: [
      { employer: 'One', title: 'One', isCurrent: true }, { employer: 'Two', title: 'Two', isCurrent: true },
    ],
  }], matches: [] }, { now });
  assert.equal(legacy.connections[0].employers.length, 2);
  assert.doesNotThrow(() => validateReferralState(legacy));
});

test('validator closes match-key and calendar chronology across records', () => {
  const prepared = prepareTitleResolution({ state: emptyState(now), capture: capture('Engineer at Acme'), identityIndex: index,
    catalogRevision: computeCatalogRevision(index), aliasRevision: computeAliasMappingRevision([]), now });
  const [match] = buildReferralMatches({ state: prepared.state, now, jobs: [{ scanDate: '2026-09-15', applyUrl: 'https://jobs.example.test/a', canonicalCompanyKey: 'acme' }] });
  const state = structuredClone(prepared.state); state.matches = [{ ...match, matchKey: `wrong|${match.canonicalApplyUrl}|${match.profileUrl}` }];
  assert.throws(() => validateReferralState(state));
  state.matches = [match]; state.connections[0].connectedAtEarliest = '2026-09-17';
  assert.throws(() => validateReferralState(state));
});

test('alias persistence failures settle only the affected AI card as unresolved', () => {
  const prepared = prepareTitleResolution({ state: emptyState(now), capture: capture('Engineer at Acm'), identityIndex: index,
    catalogRevision: computeCatalogRevision(index), aliasRevision: computeAliasMappingRevision([]), now });
  const request = prepared.batch.requests[0];
  const result = finalizeTitleResolution({ prepared, identityIndex: index, catalogRevision: computeCatalogRevision(index), aliasRevision: computeAliasMappingRevision([]), now,
    decisions: { schemaVersion: 1, batchId: prepared.batch.batchId, decisions: [{ schemaVersion: 1, requestId: request.requestId, decision: 'resolved', canonicalCompanyKey: 'acme', confidence: .99, reasonCode: 'recognized_brand_alias' }] },
    persist: () => { throw new Error('rename injected failure'); },
  });
  assert.equal(result.state.connections[0].disposition, 'unresolved');
  assert.equal(result.state.connections[0].employers.length, 0);
});

test('current identity validation drops resolved evidence whose reviewed identity disappeared', () => {
  const prepared = prepareTitleResolution({ state: emptyState(now), capture: capture('Engineer at Acme'), identityIndex: index,
    catalogRevision: computeCatalogRevision(index), aliasRevision: computeAliasMappingRevision([]), now });
  const none = buildCompanyIdentityIndex({});
  const replay = prepareTitleResolution({ state: prepared.state, capture: capture('Engineer at Acme'), identityIndex: none,
    catalogRevision: computeCatalogRevision(none), aliasRevision: computeAliasMappingRevision([]), now });
  assert.equal(replay.state.connections[0].disposition, 'unresolved');
  assert.equal(replay.state.connections[0].employers.length, 0);
});

test('authority settlement leaves unchanged observations and completed cache timestamps untouched', async () => {
  const prepared = prepareTitleResolution({ state: emptyState(now), capture: capture('Engineer at Acme'), identityIndex: index,
    catalogRevision: computeCatalogRevision(index), aliasRevision: computeAliasMappingRevision([]), now });
  const observed = prepared.state.connections[0].lastObservedAt;
  const { settleTitleAuthority } = await import('../referrals.mjs');
  settleTitleAuthority(prepared.state, index, computeCatalogRevision(index), computeAliasMappingRevision([]), new Date('2026-09-16T16:05:00.000Z'));
  assert.equal(prepared.state.connections[0].lastObservedAt, observed);
  const unresolved = prepareTitleResolution({ state: emptyState(now), capture: capture('Engineer at Unknown Brand'), identityIndex: index,
    catalogRevision: computeCatalogRevision(index), aliasRevision: computeAliasMappingRevision([]), now });
  const cachedAt = unresolved.state.connections[0].lastObservedAt;
  settleTitleAuthority(unresolved.state, index, computeCatalogRevision(index), computeAliasMappingRevision([]), new Date('2026-09-16T16:05:00.000Z'));
  assert.equal(unresolved.state.connections[0].lastObservedAt, cachedAt);
});

test('matcher rejects an orphan resolved employer when given the current catalog', () => {
  const prepared = prepareTitleResolution({ state: emptyState(now), capture: capture('Engineer at Acme'), identityIndex: index,
    catalogRevision: computeCatalogRevision(index), aliasRevision: computeAliasMappingRevision([]), now });
  const jobs = [{ scanDate:'2026-09-15', applyUrl:'https://jobs.example.test/a', canonicalCompanyKey:'acme' }];
  assert.equal(buildReferralMatches({ state: prepared.state, jobs, identityIndex: buildCompanyIdentityIndex({}), now }).length, 0);
});
