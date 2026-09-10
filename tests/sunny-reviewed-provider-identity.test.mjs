import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import {
  commitPortalRepairs,
  evaluateAtsCandidate,
  identifierFromAtsUrl,
  portalBoardKey,
  portalEntryBoardKey,
  portalEntryFromAdmission,
  resolveCompanyLeads,
  validateV2Review,
} from '../data/tools/sunny-company-expansion.mjs';
import { mergeResolutionRows } from '../data/tools/sunny-company-state.mjs';
import { resolveTenant } from '../providers/eightfold.mjs';
import { resolveSite } from '../providers/oraclecloud.mjs';

const reviewBase = {
  source_brand: 'Example', dol_legal_name: 'Example Inc.', dol_dba: 'Example',
  board_owner: 'Example', dol_evidence_urls: ['https://example.com/legal'],
  official_evidence_urls: ['https://example.com/careers'], verdict: 'accept',
  reviewed_at: '2026-09-09', reason: 'Official employer careers link identifies this exact board.',
};
const eightfoldUrl = 'https://shared.eightfold.ai/careers?domain=example.com';
const oracleUrl = 'https://shared.fa.ocs.oraclecloud26.com/hcmUI/CandidateExperience/en/sites/CX_1002/jobs';
const key = (provider, board_identifier) => portalBoardKey({ provider, board_identifier });

test('Eightfold URL identity includes host and explicit domain, including an unscoped marker', () => {
  for (const url of [eightfoldUrl, 'https://SHARED.eightfold.ai/api/apply/v2/jobs?domain=example.com&start=10']) {
    assert.equal(identifierFromAtsUrl('eightfold', url), 'shared.eightfold.ai|example.com');
  }
  assert.equal(identifierFromAtsUrl('eightfold', 'https://shared.eightfold.ai/careers'), 'shared.eightfold.ai|');
  assert.notEqual(identifierFromAtsUrl('eightfold', eightfoldUrl),
    identifierFromAtsUrl('eightfold', eightfoldUrl.replace('example.com', 'other.com')));
});

test('Oracle identity includes host, site and an explicit empty location scope', () => {
  for (const apex of ['oraclecloud.com', 'oraclecloud1.com', 'oraclecloud26.com', 'oraclecloud99.com']) {
    const url = oracleUrl.replace('oraclecloud26.com', apex);
    assert.equal(identifierFromAtsUrl('oraclecloud', url), `shared.fa.ocs.${apex}|CX_1002|`);
  }
  assert.notEqual(identifierFromAtsUrl('oraclecloud', oracleUrl),
    identifierFromAtsUrl('oraclecloud', oracleUrl.replace('CX_1002', 'CX_1003')));
  assert.equal(identifierFromAtsUrl('oraclecloud', oracleUrl.replace('/en/', '/fr/')),
    identifierFromAtsUrl('oraclecloud', oracleUrl), 'language does not change the board');
});

test('Eightfold entry identity follows provider api precedence and explicit domain override', () => {
  const entry = { provider: 'eightfold', careers_url: eightfoldUrl,
    api: 'https://pinned.eightfold.ai/api/apply/v2/jobs?domain=url.example', domain: 'override.example' };
  const tenant = resolveTenant(entry);
  assert.equal(portalEntryBoardKey(entry), key('eightfold', `${tenant.host}|${tenant.domain}`));
  assert.equal(portalEntryBoardKey({ ...entry, provider: undefined }), portalEntryBoardKey(entry));
  assert.equal(portalEntryBoardKey({ ...entry, careers_url: 'https://example.com/careers', provider: undefined }),
    portalEntryBoardKey(entry), 'api identifies provider behind a branded careers URL');
  assert.notEqual(portalEntryBoardKey(entry), portalEntryBoardKey({ ...entry, domain: 'other.example' }));
  assert.notEqual(portalEntryBoardKey({ provider: 'eightfold', careers_url: eightfoldUrl }),
    portalEntryBoardKey({ provider: 'eightfold', careers_url: 'https://shared.eightfold.ai/careers' }));
});

test('Oracle entry identity follows provider api precedence, site override and location scope', () => {
  const entry = { provider: 'oraclecloud', careers_url: oracleUrl,
    api: 'https://pinned.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2/jobs',
    siteNumber: 'CX_3', locationId: 3001 };
  const site = resolveSite(entry);
  assert.equal(portalEntryBoardKey(entry), key('oraclecloud', `${site.host}|${site.siteNumber}|${site.locationId}`));
  assert.equal(portalEntryBoardKey({ ...entry, provider: undefined }), portalEntryBoardKey(entry));
  assert.equal(portalEntryBoardKey({ ...entry, careers_url: 'https://example.com/careers', provider: undefined }),
    portalEntryBoardKey(entry));
  assert.notEqual(portalEntryBoardKey(entry), portalEntryBoardKey({ ...entry, siteNumber: 'CX_4' }));
  assert.notEqual(portalEntryBoardKey(entry), portalEntryBoardKey({ ...entry, locationId: 3002 }));
  assert.notEqual(portalEntryBoardKey(entry), portalEntryBoardKey({ ...entry, locationId: undefined }));
});

test('scoped identifiers preserve opaque scope case rather than merge different provider requests', () => {
  assert.notEqual(key('eightfold', 'shared.eightfold.ai|Example.com'), key('eightfold', 'shared.eightfold.ai|example.com'));
  assert.notEqual(key('oraclecloud', 'shared.fa.oraclecloud.com|CX_1|'), key('oraclecloud', 'shared.fa.oraclecloud.com|cx_1|'));
});

for (const [provider, careers_url, board_identifier] of [
  ['eightfold', eightfoldUrl, 'shared.eightfold.ai|example.com'],
  ['oraclecloud', oracleUrl, 'shared.fa.ocs.oraclecloud26.com|CX_1002|'],
]) {
  test(`${provider} review validates exact provider coordinates and rejects a mismatched URL`, () => {
    const review = { ...reviewBase, ats_provider: provider, careers_url, board_identifier };
    assert.equal(validateV2Review(review).accepted, true);
    for (const identifier of [board_identifier.replace('shared.', 'other.'), 'guessed', `${board_identifier}|extra`]) {
      assert.equal(validateV2Review({ ...review, board_identifier: identifier }).accepted, false, identifier);
    }
    assert.equal(validateV2Review({ ...review, careers_url: careers_url.replace('shared.', 'other.') }).accepted, false);
    assert.equal(validateV2Review({ ...review, careers_url: 'https://example.com/careers' }).accepted, false);
  });

  test(`${provider} review and keys reject unsupported URLs even on a recognized tenant host`, () => {
    const parsed = new URL(careers_url);
    const invalid = [
      careers_url.replace('https:', 'http:'),
      careers_url.replace(parsed.hostname, `${parsed.hostname}.evil.example`),
      careers_url.replace(parsed.hostname, `evil.example/${parsed.hostname}`),
      careers_url.replace(parsed.hostname, `user:pass@${parsed.hostname}`),
      careers_url.replace(parsed.hostname, `${parsed.hostname}:8443`),
      careers_url.replace(parsed.hostname, `${parsed.hostname}:443`),
      careers_url.replace(parsed.hostname, `-${parsed.hostname}`),
      careers_url.replace(parsed.pathname, '/unrelated/path'),
      careers_url.replace(parsed.pathname, '/unrelated/../' + parsed.pathname.slice(1)),
      careers_url.replace('https://', 'https:///'),
      careers_url.replace(parsed.hostname, `${parsed.hostname}\n`),
    ];
    if (provider === 'eightfold') invalid.push(
      careers_url.replace('shared.eightfold.ai', 'eightfold.ai'),
      careers_url.replace('shared.eightfold.ai', 'shared.nested.eightfold.ai'),
      `${careers_url}&domain=other.com`,
      careers_url.replace('example.com', 'example.com%7Cother.com'),
      careers_url.replace('example.com', 'example.com%0A'),
    );
    if (provider === 'oraclecloud') invalid.push(
      careers_url.replace('oraclecloud26.com', 'oraclecloud100.com'),
      careers_url.replace('oraclecloud26.com', 'oraclecloud01.com'),
      careers_url.replace('CX_1002', 'CX_1002%2Fother'),
      careers_url.replace('CX_1002', ''),
    );
    for (const url of invalid) {
      assert.equal(identifierFromAtsUrl(provider, url), '', url);
      assert.equal(portalEntryBoardKey({ provider, careers_url: url }), '', url);
      assert.equal(validateV2Review({ ...reviewBase, ats_provider: provider, careers_url: url, board_identifier }).accepted, false, url);
    }
  });
}

test('review identity uses exactly the coordinates the provider will request', () => {
  const cases = [
    { ats_provider: 'eightfold', careers_url: eightfoldUrl,
      api: 'https://pinned.eightfold.ai/api/apply/v2/jobs?domain=url.example', domain: 'override.example',
      board_identifier: 'pinned.eightfold.ai|override.example' },
    { ats_provider: 'oraclecloud', careers_url: oracleUrl,
      api: 'https://pinned.fa.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions',
      siteNumber: 'CX_2', locationId: '3001', board_identifier: 'pinned.fa.oraclecloud.com|CX_2|3001' },
  ];
  for (const entry of cases) {
    assert.equal(validateV2Review({ ...reviewBase, ...entry }).accepted, true);
    assert.equal(validateV2Review({ ...reviewBase, ...entry, careers_url: 'https://example.com/careers' }).accepted, true);
    assert.equal(validateV2Review({ ...reviewBase, ...entry, board_identifier: entry.board_identifier.replace('pinned.', 'shared.') }).accepted, false);
    assert.equal(portalEntryBoardKey({ ...entry, provider: entry.ats_provider }), key(entry.ats_provider, entry.board_identifier));
  }
});

test('invalid explicit scopes and unsafe selected api never fall back to a different careers board', () => {
  const entries = [
    { provider: 'eightfold', careers_url: eightfoldUrl, domain: 'bad|domain' },
    { provider: 'eightfold', careers_url: eightfoldUrl, api: 'https://user@pinned.eightfold.ai/careers' },
    { provider: 'eightfold', careers_url: eightfoldUrl, api: 'https://pinned.eightfold.ai/wrong' },
    { provider: 'oraclecloud', careers_url: oracleUrl, siteNumber: 'CX_1,locationId=2' },
    { provider: 'oraclecloud', careers_url: oracleUrl, locationId: '3,limit=1' },
    { provider: 'oraclecloud', careers_url: oracleUrl, locationId: -1 },
    { provider: 'oraclecloud', careers_url: oracleUrl, api: 'https://pinned.fa.oraclecloud.com:8443/hcmUI/CandidateExperience/en/sites/CX_2/jobs' },
  ];
  for (const entry of entries) {
    assert.equal(portalEntryBoardKey(entry), '', JSON.stringify(entry));
    assert.equal(validateV2Review({ ...reviewBase, ...entry, ats_provider: entry.provider, board_identifier: 'untrusted' }).accepted, false);
  }
});

test('accepted coordinates round-trip through a portal without depending on nonpersisted entry overrides', () => {
  const rows = [
    { provider: 'eightfold', careers_url: eightfoldUrl, board_identifier: 'shared.eightfold.ai|example.com' },
    { provider: 'eightfold', careers_url: 'https://example.com/careers', board_identifier: 'pinned.eightfold.ai|other.example' },
    { provider: 'oraclecloud', careers_url: oracleUrl, board_identifier: 'shared.fa.ocs.oraclecloud26.com|CX_1002|' },
    { provider: 'oraclecloud', careers_url: 'https://example.com/careers', board_identifier: 'pinned.fa.oraclecloud.com|CX_2|3001' },
  ];
  for (const row of rows) {
    const entry = portalEntryFromAdmission({ ...row, preferred_name: 'Example', status: 'accepted',
      identity_status: 'reviewed_official_link', health_status: 'live' });
    assert.equal(portalEntryBoardKey(entry), key(row.provider, row.board_identifier));
    if (row.provider === 'eightfold') {
      const tenant = resolveTenant(entry);
      assert.equal(`${tenant.host}|${tenant.domain || ''}`, row.board_identifier);
    } else {
      const site = resolveSite(entry);
      assert.equal(`${site.host}|${site.siteNumber}|${site.locationId || ''}`, row.board_identifier);
    }
  }
});

test('an accepted review cannot authorize a different candidate URL or case-sensitive scope', async () => {
  const dol = { status: 'dol_accepted', preferred_name: 'Example', dol_legal_name: 'Example Inc.', dol_dba: 'Example' };
  for (const [provider, careers_url, identifier] of [
    ['eightfold', eightfoldUrl, 'shared.eightfold.ai|example.com'],
    ['oraclecloud', oracleUrl, 'shared.fa.ocs.oraclecloud26.com|CX_1002|'],
  ]) {
    const reviews = [{ ...reviewBase, ats_provider: provider, careers_url, board_identifier: identifier }];
    const candidate = { provider, careers_url, identifier, verification: 'live' };
    assert.equal((await evaluateAtsCandidate(dol, candidate, { reviews })).status, 'accepted');
    for (const changed of [
      { ...candidate, careers_url: careers_url.replace('shared.', 'other.') },
      { ...candidate, identifier: identifier.replace('CX_', 'cx_').replace('example.com', 'Example.com'),
        careers_url: careers_url.replace('CX_', 'cx_').replace('example.com', 'Example.com') },
    ]) {
      assert.notEqual((await evaluateAtsCandidate(dol, changed, { reviews })).status, 'accepted');
    }
  }
});

const aliasCases = [
  { provider: 'eightfold', careers_url: eightfoldUrl, identifier: 'shared.eightfold.ai|example.com',
    otherUrl: eightfoldUrl.replace('example.com', 'other.com'), otherIdentifier: 'shared.eightfold.ai|other.com' },
  { provider: 'oraclecloud', careers_url: oracleUrl, identifier: 'shared.fa.ocs.oraclecloud26.com|CX_1002|',
    otherUrl: oracleUrl.replace('CX_1002', 'CX_1003'), otherIdentifier: 'shared.fa.ocs.oraclecloud26.com|CX_1003|' },
];
for (const item of aliasCases) {
  const dol = { status: 'dol_accepted', preferred_name: 'Example', dol_legal_name: 'Example Inc.', dol_dba: 'Example' };
  test(`${item.provider} candidate board_identifier alias cannot override authoritative identifier`, async () => {
    const review = { ...reviewBase, ats_provider: item.provider, careers_url: item.careers_url, board_identifier: item.identifier };
    const candidate = { provider: item.provider, identifier: item.otherIdentifier, board_identifier: item.identifier,
      careers_url: item.otherUrl, verification: 'live', job_count: 1 };
    assert.equal(validateV2Review(review).accepted, true);
    const row = await evaluateAtsCandidate(dol, candidate, { reviews: [review] });
    assert.notEqual(row.status, 'accepted');
    assert.equal(row.board_identifier, item.otherIdentifier);
  });

  test(`${item.provider} matching uses authoritative review ats_provider despite a provider alias`, async () => {
    const review = { ...reviewBase, ats_provider: item.provider, provider: 'unrelated',
      careers_url: item.careers_url, board_identifier: item.identifier };
    const candidate = { provider: item.provider, identifier: item.identifier, careers_url: item.careers_url, verification: 'live' };
    assert.equal((await evaluateAtsCandidate(dol, candidate, { reviews: [review] })).status, 'accepted');
  });

  test(`${item.provider} cannot match another provider through conflicting aliases or two empty keys`, async () => {
    const other = aliasCases.find(entry => entry.provider !== item.provider);
    const review = { ...reviewBase, ats_provider: other.provider, provider: item.provider,
      careers_url: other.careers_url, board_identifier: other.identifier };
    const candidate = { provider: item.provider, identifier: item.identifier, board_identifier: 'invalid-alias',
      careers_url: item.careers_url, verification: 'live' };
    assert.equal(validateV2Review(review).accepted, true);
    assert.notEqual((await evaluateAtsCandidate(dol, candidate, { reviews: [review] })).status, 'accepted');
  });
}

test('a valid selected api does not make unsafe review display URLs admissible', () => {
  for (const [ats_provider, api, board_identifier] of [
    ['eightfold', eightfoldUrl, 'shared.eightfold.ai|example.com'],
    ['oraclecloud', oracleUrl, 'shared.fa.ocs.oraclecloud26.com|CX_1002|'],
  ]) {
    for (const careers_url of ['http://example.com/jobs', 'https://user:pass@example.com/jobs', 'https://example.com:8443/jobs']) {
      assert.equal(validateV2Review({ ...reviewBase, ats_provider, api, board_identifier, careers_url }).accepted, false);
    }
  }
});

test('case-sensitive scoped boards remain separate in resolution state merges', () => {
  for (const [provider, first, second] of [
    ['eightfold', 'shared.eightfold.ai|example.com', 'shared.eightfold.ai|Example.com'],
    ['oraclecloud', 'shared.fa.oraclecloud.com|CX_1|', 'shared.fa.oraclecloud.com|cx_1|'],
  ]) {
    const row = { normalized_lead: 'example', provider, status: 'accepted' };
    assert.equal(mergeResolutionRows([], [{ ...row, board_identifier: first }, { ...row, board_identifier: second }]).length, 2);
  }
});

test('review-derived candidates preserve api and scope through pure in-memory resolution', async () => {
  const reviews = [
    { ...reviewBase, ats_provider: 'eightfold', careers_url: 'https://example.com/careers',
      api: 'https://shared.eightfold.ai/careers?domain=url.example', domain: 'override.example',
      board_identifier: 'shared.eightfold.ai|override.example' },
    { ...reviewBase, ats_provider: 'oraclecloud', careers_url: 'https://example.com/careers',
      api: oracleUrl, siteNumber: 'CX_3', locationId: '3001',
      board_identifier: 'shared.fa.ocs.oraclecloud26.com|CX_3|3001' },
  ];
  const rows = await resolveCompanyLeads({
    scope: 'nyc', leads: [{ scope: 'nyc', source_company: 'Example', discovered_at: '2026-09-09T00:00:00Z' }],
    employers: [{ EMPLOYER_NAME: 'Example Inc.', DBA: 'Example', transfer_positions: '1' }],
    candidates: [], portals: { tracked_companies: [] }, reviews,
    now: '2026-09-09T01:00:00Z',
    evaluateCandidate: async (dol, candidate, options) => {
      assert.equal(portalEntryBoardKey(candidate), key(candidate.provider, candidate.identifier));
      return evaluateAtsCandidate(dol, candidate, options);
    },
  });
  assert.equal(rows.length, 2);
  assert.equal(rows.every(row => row.status === 'accepted'), true);
  assert.equal(rows.every(row => portalEntryBoardKey(portalEntryFromAdmission(row)) === portalBoardKey(row)), true);
});

test('Oracle URL-only identity does not invent scopes that resolveSite ignores', () => {
  const careers_url = `${oracleUrl}?locationId=3001`;
  const entry = { provider: 'oraclecloud', careers_url };
  const site = resolveSite(entry);
  assert.equal(identifierFromAtsUrl(entry.provider, careers_url), `${site.host}|${site.siteNumber}|`);
  const api = 'https://shared.fa.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?finder=findReqs;siteNumber=CX_9,locationId=3001';
  assert.equal(identifierFromAtsUrl(entry.provider, api), 'shared.fa.oraclecloud.com|CX_1|');
});

test('missing portal entries retain their empty-key behavior', () => {
  for (const entry of [undefined, null, {}, { careers_url: 'invalid' }]) {
    assert.equal(portalEntryBoardKey(entry), '');
  }
});

test('an exact scoped repair removes old provider scopes before applying the reviewed board', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-scoped-repair-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  for (const [provider, careers_url, board_identifier, oldFields] of [
    ['eightfold', 'https://shared.eightfold.ai/careers', 'shared.eightfold.ai|', { domain: 'old.example' }],
    ['oraclecloud', oracleUrl, 'shared.fa.ocs.oraclecloud26.com|CX_1002|', { siteNumber: 'CX_9', locationId: 3001 }],
  ]) {
    const oldEntry = { name: 'Example', provider, careers_url, ...oldFields, max_pages: 7 };
    const path = join(dataRoot, 'portals.yml');
    writeFileSync(path, yaml.dump({ tracked_companies: [oldEntry] }));
    const admission = { provider, careers_url, board_identifier, preferred_name: 'Example', status: 'accepted',
      identity_status: 'reviewed_official_link', health_status: 'live', dol_legal_name: 'Example Inc.', transfer_positions: 1 };
    const result = await commitPortalRepairs([{ target_name: 'Example', expected_careers_url: careers_url,
      official_evidence_url: 'https://example.com/careers', admission }], { dataRoot, validate: async () => ({ ok: true }) });
    assert.equal(result.updated, 1);
    const saved = yaml.load(readFileSync(path, 'utf8')).tracked_companies[0];
    assert.equal(portalEntryBoardKey(saved), key(provider, board_identifier));
    assert.equal(saved.max_pages, 7);
  }
});
