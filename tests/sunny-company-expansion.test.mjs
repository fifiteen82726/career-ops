import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as yaml from 'js-yaml';
import * as expansion from '../data/tools/sunny-company-expansion.mjs';

import {
  commitPortalAdmissions,
  directAtsCandidateFromLeadUrl,
  defaultFetchContext,
  evaluateAtsCandidate,
  identifierFromAtsUrl,
  isScannableAdmission,
  joinLeadToDol,
  parseArgs,
  portalBoardKey,
  portalEntryBoardKey,
  resolveCompanyLeads,
  validateV2Review,
} from '../data/tools/sunny-company-expansion.mjs';

test('default fetch context forwards POST options needed by Workday CXS', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let observed;
  globalThis.fetch = async (url, options) => {
    observed = { url, options };
    return { ok: true, json: async () => ({ ok: true }), text: async () => 'ok' };
  };
  const context = defaultFetchContext();
  await context.fetchJson('https://example.com/jobs', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', redirect: 'error',
  });
  assert.equal(observed.options.method, 'POST');
  assert.equal(observed.options.body, '{}');
  assert.equal(observed.options.redirect, 'error');
});

test('direct job URLs become exact ATS candidates while aggregators stay leads only', () => {
  assert.deepEqual(
    directAtsCandidateFromLeadUrl('https://job-boards.greenhouse.io/vercel/jobs/5895013004?utm_source=freehire.me'),
    {
      provider: 'greenhouse',
      identifier: 'vercel',
      careers_url: 'https://job-boards.greenhouse.io/vercel',
      job_count: '1',
      match_status: 'candidate',
      verification: 'live',
      source: 'direct-job-url',
    },
  );
  assert.equal(
    identifierFromAtsUrl('greenhouse', 'https://boards.greenhouse.io/embed/job_board?for=ManticoreGames'),
    'ManticoreGames',
  );
  assert.equal(directAtsCandidateFromLeadUrl('https://www.linkedin.com/jobs/view/123'), null);
  assert.equal(directAtsCandidateFromLeadUrl('https://www.indeed.com/viewjob?jk=123'), null);
  assert.equal(
    directAtsCandidateFromLeadUrl('https://recruiting.paylocity.com/recruiting/jobs/All/d9282170-896e-4b00-bec5-34963f54aad8/').identifier,
    'd9282170-896e-4b00-bec5-34963f54aad8',
  );
  assert.equal(directAtsCandidateFromLeadUrl('https://beehiiv.bamboohr.com/careers').identifier, 'beehiiv');
});

test('direct URLs for additional public ATS providers retain stable tenant coordinates', () => {
  const cases = [
    ['https://playtestcloud.recruitee.com/o/data-engineer', 'recruitee', 'playtestcloud', 'https://playtestcloud.recruitee.com'],
    ['https://at-t.breezy.hr/p/abc-data-engineer', 'breezy', 'at-t', 'https://at-t.breezy.hr'],
    ['https://goodgamestudios.teamtailor.com/jobs/123-data-engineer', 'teamtailor', 'goodgamestudios', 'https://goodgamestudios.teamtailor.com/jobs'],
    ['https://bigpoint.jobs.personio.de/job/123', 'personio', 'bigpoint.jobs.personio.de', 'https://bigpoint.jobs.personio.de'],
    ['https://ats.rippling.com/brainrider/jobs/123', 'rippling', 'brainrider', 'https://ats.rippling.com/brainrider/jobs'],
    ['https://jobs.jobvite.com/kwalee/job/abc', 'jobvite', 'kwalee', 'https://jobs.jobvite.com/kwalee'],
    ['https://accenture.pinpointhq.com/postings/123', 'pinpoint', 'accenture', 'https://accenture.pinpointhq.com'],
    ['https://jobs.dayforcehcm.com/en-US/4refuel/CANDIDATEPORTAL/jobs/123', 'dayforce', '4refuel/CANDIDATEPORTAL', 'https://jobs.dayforcehcm.com/en-US/4refuel/CANDIDATEPORTAL'],
    ['https://www.paycomonline.net/v4/ats/web.php/portal/000007D8719436D93F65A09284CEEA81/jobs/42', 'paycom', '000007D8719436D93F65A09284CEEA81', 'https://www.paycomonline.net/v4/ats/web.php/portal/000007D8719436D93F65A09284CEEA81/career-page'],
    ['https://recruiting.ultipro.com/ACM1000/JobBoard/12345678-1234-1234-1234-123456789abc/OpportunityDetail?opportunityId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'ukg', 'recruiting.ultipro.com:ACM1000:12345678-1234-1234-1234-123456789abc', 'https://recruiting.ultipro.com/ACM1000/JobBoard/12345678-1234-1234-1234-123456789abc/'],
  ];
  for (const [url, provider, identifier, careersUrl] of cases) {
    const candidate = directAtsCandidateFromLeadUrl(url);
    assert.equal(candidate?.provider, provider, url);
    assert.equal(candidate?.identifier, identifier, url);
    assert.equal(candidate?.careers_url, careersUrl, url);
  }
  const jibe = directAtsCandidateFromLeadUrl('https://careers.amd.com/api/jobs?page=1&limit=1');
  assert.equal(jibe?.provider, 'jibeapply');
  assert.equal(jibe?.identifier, 'careers.amd.com');
  assert.equal(jibe?.careers_url, 'https://careers.amd.com');
  assert.equal(jibe?.api, 'https://careers.amd.com/api/jobs');
});

test('repair replaces an exact existing portal only after validation and preserves unrelated fields', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-portal-repair-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const file = join(dataRoot, 'portals.yml');
  const existing = { name: 'Example Holdings, Inc.', careers_url: 'https://example.com/jobs',
    scan_method: 'websearch', scan_query: 'example', tier: 1, enabled: true };
  writeFileSync(file, yaml.dump({ tracked_companies: [existing] }));
  const repair = { target_name: existing.name, expected_careers_url: existing.careers_url,
    official_evidence_url: existing.careers_url,
    admission: { status: 'accepted', health_status: 'live', identity_status: 'reviewed_official_link',
      provider: 'greenhouse', board_identifier: 'example', careers_url: 'https://job-boards.greenhouse.io/example',
      dol_legal_name: existing.name, transfer_positions: 12, board_owner: 'Example' } };
  await assert.rejects(expansion.commitPortalRepairs([repair], { dataRoot, validate: async () => ({ ok: false, error: 'invalid fixture' }) }), /invalid fixture/);
  assert.equal(yaml.load(readFileSync(file, 'utf8')).tracked_companies[0].careers_url, existing.careers_url);
  const result = await expansion.commitPortalRepairs([repair], { dataRoot, validate: async () => true });
  const rows = yaml.load(readFileSync(file, 'utf8')).tracked_companies;
  assert.equal(result.updated, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'greenhouse');
  assert.equal(rows[0].tier, 1);
  assert.equal(rows[0].scan_method, undefined);
  assert.equal((await expansion.commitPortalRepairs([repair], { dataRoot, validate: async () => true })).updated, 0);
  await assert.rejects(expansion.commitPortalRepairs([{ ...repair, target_name: 'Example' }], { dataRoot }), /exact target/);
  await assert.rejects(expansion.commitPortalRepairs([{ ...repair, admission: { ...repair.admission, transfer_positions: 0 } }], { dataRoot }), /DOL/);
});

test('CLI requires exactly one supported scope and run mode', () => {
  assert.deepEqual(
    parseArgs(['run', '--scope', 'nyc', '--mode', 'incremental']),
    { command: 'run', scope: 'nyc', mode: 'incremental', dryRun: true, write: false },
  );
  assert.throws(() => parseArgs(['run', '--scope', 'all', '--mode', 'incremental']), /nyc or remote/);
  assert.throws(() => parseArgs(['run', '--scope', 'nyc', '--mode', 'weekly']), /backfill or incremental/);
  assert.throws(() => parseArgs(['resolve', '--scope', 'nyc', '--scope', 'remote']), /exactly one --scope/);
});

test('company lead ingestion accepts replacement dashboards and rejects LinkedIn', () => {
  for (const source of ['indeed', 'builtin', 'freehire', 'himalayas', 'jobicy', 'openjobs', 'paylocity', 'bamboohr']) {
    assert.equal(
      parseArgs(['ingest', '--source', source, '--scope', 'remote', '--input', 'leads.json']).source,
      source,
    );
  }
  assert.throws(
    () => parseArgs(['ingest', '--source', 'linkedin', '--scope', 'remote', '--input', 'leads.json']),
    /supported source/,
  );
});

const employers = [{
  EMPLOYER_NAME: 'Example Holdings, Inc.',
  DBA: 'Example',
  transfer_positions: '12',
  ny_transfer_positions: '3',
}];

test('rolling evidence is bound to the declared index, row count and pinned checksum', t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-dol-manifest-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const quarters = ['FY2024Q4', 'FY2025Q1', 'FY2025Q2', 'FY2025Q3', 'FY2025Q4', 'FY2026Q1', 'FY2026Q2', 'FY2026Q3'];
  const manifest = { schema_version: 2, window: { fiscal_quarters: quarters },
    coverage: { complete: true, observed_fiscal_quarters: quarters, declared_fiscal_quarters: quarters },
    outputs: { employers: 'employers.tsv' }, counts: { employers: 1 } };
  writeFileSync(join(dataRoot, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(dataRoot, 'employers.tsv'), 'EMPLOYER_NAME\ttransfer_positions\nExample Inc.\t1\n');
  const config = { dol_employers: 'employers.tsv', dol_manifest: 'manifest.json' };
  assert.equal(expansion.loadDolEvidence(config, dataRoot).length, 1);
  assert.throws(() => expansion.loadDolEvidence({ ...config, dol_employers: 'other.tsv' }, dataRoot), /declared index/);
  assert.throws(() => expansion.loadDolEvidence({ ...config, dol_employers_sha256: 'wrong' }, dataRoot), /checksum/);
  writeFileSync(join(dataRoot, 'manifest.json'), JSON.stringify({ ...manifest, coverage: { ...manifest.coverage, observed_fiscal_quarters: [] } }));
  assert.throws(() => expansion.loadDolEvidence(config, dataRoot), /eight-quarter/);
});

test('exact DBA match is accepted but normalized collisions require review', () => {
  const joined = joinLeadToDol({ source_company: 'Example' }, employers);
  assert.equal(joined.status, 'dol_accepted');
  assert.equal(joined.match_type, 'dba_exact');
  assert.equal(joined.dol_legal_name, 'Example Holdings, Inc.');

  const collidingEmployers = [
    { EMPLOYER_NAME: 'Acme Holdings, Inc.', DBA: 'Acme', transfer_positions: '4' },
    { EMPLOYER_NAME: 'Acme Services LLC', DBA: 'Acme', transfer_positions: '6' },
  ];
  assert.equal(
    joinLeadToDol({ source_company: 'Acme' }, collidingEmployers).status,
    'dol_ambiguous',
  );
});

test('DOL gate rejects missing transfer evidence and Meta explicitly', () => {
  assert.equal(joinLeadToDol({ source_company: 'Unknown' }, employers).status, 'dol_rejected');
  assert.match(
    joinLeadToDol({ source_company: 'Meta' }, [{
      EMPLOYER_NAME: 'Meta Platforms, Inc.', transfer_positions: '9169',
    }]).reason,
    /excluded/i,
  );
  assert.equal(joinLeadToDol({ source_company: 'Zero' }, [{
    EMPLOYER_NAME: 'Zero Inc.', transfer_positions: '0',
  }]).status, 'dol_rejected');
});

test('historical positive DOL evidence retains vintage without asserting current sponsorship', () => {
  const row = joinLeadToDol({ source_company: 'Historical Example' }, [{
    EMPLOYER_NAME: 'Historical Example Inc.', DBA: '', transfer_positions: '3',
    evidence_tier: 'B', source_periods: 'FY2024Q4 | FY2025Q4',
    current_or_historical_window: 'historical-only:2024-07-01..2026-06-30', latest_decision_date: '2025-08-03',
  }]);
  assert.equal(row.status, 'dol_accepted');
  assert.equal(row.dol_evidence_tier, 'B');
  assert.equal(row.dol_evidence_periods, 'FY2024Q4 | FY2025Q4');
  assert.equal(row.dol_latest_decision_date, '2025-08-03');
});

test('a known legal/board identity hold overrides an equal published owner name', async () => {
  const dol = joinLeadToDol({ source_company: 'Example' }, employers);
  const row = await evaluateAtsCandidate(dol, { provider: 'greenhouse', identifier: 'example', verification: 'live' }, {
    identityHolds: [{ provider: 'greenhouse', identifier: 'example', dol_legal_name: 'Example Holdings, Inc.',
      reason: 'Same brand, different legal operator', evidence_urls: ['https://example.com/legal'] }],
    fetchContext: { fetchJson: async () => { throw new Error('held identity must not fetch'); } },
  });
  assert.equal(row.status, 'identity_review');
  assert.equal(row.identity_status, 'known_identity_hold');
});

test('different exact legal entities that normalize alike require review', () => {
  const row = joinLeadToDol({ source_company: 'Example' }, [
    { EMPLOYER_NAME: 'Example Inc.', transfer_positions: '3' },
    { EMPLOYER_NAME: 'Example LLC', transfer_positions: '4' },
  ]);
  assert.equal(row.status, 'dol_ambiguous');
});

test('internal whitespace and NBSP identity collisions cannot merge counts or mix vintages', () => {
  for (const pair of [['3S  BUSINESS CORPORATION', '3S BUSINESS CORPORATION'], ['ABIOMED, Inc.', 'ABIOMED,\u00a0Inc.']]) {
    const row = joinLeadToDol({ source_company: pair[0] }, [
      { EMPLOYER_NAME: pair[0], transfer_positions: '1', evidence_tier: 'B' },
      { EMPLOYER_NAME: pair[1], transfer_positions: '8', evidence_tier: 'A' },
    ]);
    assert.equal(row.status, 'dol_ambiguous');
  }
});

const validReview = {
  source_brand: 'Example',
  dol_legal_name: 'Example Holdings, Inc.',
  dol_dba: 'Example',
  dol_evidence_urls: ['https://example.com/legal'],
  ats_provider: 'greenhouse',
  board_identifier: 'example',
  board_owner: 'Example',
  careers_url: 'https://job-boards.greenhouse.io/example',
  official_evidence_urls: ['https://example.com/careers'],
  verdict: 'accept',
  reviewed_at: '2026-09-08',
  reason: 'Official legal disclosure and careers link.',
};

test('v2 review must prove source, DOL, and ATS identities', () => {
  assert.equal(validateV2Review(validReview).accepted, true);
  assert.equal(validateV2Review({ ...validReview, board_owner: 'Other Co' }).accepted, false);
  assert.equal(validateV2Review({ ...validReview, dol_evidence_urls: [] }).accepted, false);
  assert.equal(validateV2Review({
    ...validReview,
    careers_url: 'https://job-boards.greenhouse.io/another',
  }).accepted, false);
});

test('Workable reviews require an exact tenant and deduplicate by tenant', () => {
  const review = {
    ...validReview,
    ats_provider: 'workable',
    board_identifier: 'claritas-rx',
    careers_url: 'https://apply.workable.com/claritas-rx/',
  };

  assert.equal(validateV2Review(review).accepted, true);
  assert.equal(validateV2Review({
    ...review,
    careers_url: 'https://apply.workable.com/another-company/',
  }).accepted, false);
  assert.equal(identifierFromAtsUrl('workable', review.careers_url), 'claritas-rx');
  assert.equal(
    portalEntryBoardKey({ provider: 'workable', careers_url: review.careers_url }),
    portalBoardKey({ provider: 'workable', board_identifier: 'claritas-rx' }),
  );
});

test('reviewed SmartRecruiters and Gem boards use stable board identities', () => {
  const cases = [
    {
      provider: 'smartrecruiters',
      identifier: 'integrichain1',
      url: 'https://careers.smartrecruiters.com/integrichain1',
    },
    {
      provider: 'gem',
      identifier: 'vantaca',
      url: 'https://jobs.gem.com/vantaca',
    },
  ];

  for (const item of cases) {
    const review = {
      ...validReview,
      ats_provider: item.provider,
      board_identifier: item.identifier,
      careers_url: item.url,
    };
    assert.equal(validateV2Review(review).accepted, true, item.provider);
    assert.equal(identifierFromAtsUrl(item.provider, item.url), item.identifier);
    assert.equal(
      portalEntryBoardKey({ provider: item.provider, careers_url: item.url }),
      portalBoardKey({ provider: item.provider, board_identifier: item.identifier }),
      item.provider,
    );
  }
});

test('official careers only and non-ATS records are not writable portals', () => {
  assert.equal(isScannableAdmission({ status: 'official_careers_only' }), false);
  assert.equal(isScannableAdmission({
    status: 'accepted', health_status: 'live', provider: 'websearch', careers_url: 'https://example.com/jobs',
  }), false);
  assert.equal(isScannableAdmission({
    status: 'accepted', health_status: 'live', provider: 'greenhouse', board_identifier: 'example',
    careers_url: 'https://job-boards.greenhouse.io/example', identity_status: 'owner_verified',
  }), true);
  assert.equal(isScannableAdmission({
    status: 'accepted', health_status: 'live', provider: 'greenhouse', board_identifier: 'example',
    careers_url: 'https://job-boards.greenhouse.io/example',
  }), false, 'an ATS URL is not enough without owner or reviewed identity proof');
});

test('published ATS owner must match an accepted brand or DOL identity', async () => {
  const dolMatch = joinLeadToDol({ source_company: 'Example' }, employers);
  const candidate = {
    employer_name: 'Example Holdings, Inc.',
    provider: 'greenhouse',
    identifier: 'example',
    careers_url: 'https://job-boards.greenhouse.io/example',
    verification: 'live',
    job_count: '7',
  };
  const accepted = await evaluateAtsCandidate(dolMatch, candidate, {
    fetchContext: {
      fetchJson: async () => ({ name: 'Example' }),
      fetchText: async () => '',
    },
  });
  const mismatch = await evaluateAtsCandidate(dolMatch, candidate, {
    fetchContext: {
      fetchJson: async () => ({ name: 'Another Employer' }),
      fetchText: async () => '',
    },
  });

  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.identity_status, 'owner_verified');
  assert.equal(mismatch.status, 'identity_review');
  assert.equal(isScannableAdmission(mismatch), false);
});

test('resolution groups leads, skips tracked companies, and anchors accepted backfills', async () => {
  const leads = [
    {
      source_company: 'Example', normalized_source_company: 'example', source: 'linkedin', scope: 'nyc',
      discovered_at: '2026-09-08T10:00:00Z', job_url: 'https://linkedin.com/jobs/view/1',
    },
    {
      source_company: 'Example', normalized_source_company: 'example', source: 'builtin', scope: 'nyc',
      discovered_at: '2026-09-08T11:00:00Z', job_url: 'https://builtinnyc.com/job/2',
    },
    {
      source_company: 'Existing', normalized_source_company: 'existing', source: 'indeed', scope: 'nyc',
      discovered_at: '2026-09-08T11:30:00Z', job_url: 'https://indeed.com/viewjob?jk=3',
    },
    {
      source_company: 'Unknown', normalized_source_company: 'unknown', source: 'indeed', scope: 'nyc',
      discovered_at: '2026-09-08T11:45:00Z', job_url: 'https://indeed.com/viewjob?jk=4',
    },
  ];
  const candidates = [{
    employer_name: 'Example Holdings, Inc.',
    dba: 'Example',
    provider: 'greenhouse',
    identifier: 'example',
    verification: 'live',
    careers_url: 'https://job-boards.greenhouse.io/example',
    job_count: '7',
    match_status: 'candidate',
  }];
  const rows = await resolveCompanyLeads({
    leads,
    scope: 'nyc',
    employers,
    candidates,
    portals: {
      tracked_companies: [{
        name: 'Existing', provider: 'greenhouse', careers_url: 'https://job-boards.greenhouse.io/existing',
      }],
    },
    reviews: [],
    now: new Date('2026-09-08T14:00:00Z'),
    evaluateCandidate: async (dolMatch, candidate) => ({
      ...dolMatch,
      status: 'accepted',
      provider: candidate.provider,
      board_identifier: candidate.identifier,
      careers_url: candidate.careers_url,
      health_status: 'live',
      identity_status: 'owner_verified',
      board_owner: 'Example',
    }),
  });

  assert.deepEqual(rows.map(row => row.status).sort(), ['accepted', 'already_tracked', 'dol_rejected']);
  const accepted = rows.find(row => row.status === 'accepted');
  assert.equal(accepted.source_count, 2);
  assert.equal(accepted.backfill_status, 'pending');
  assert.equal(accepted.backfill_window_start, '2026-08-20');
  assert.equal(accepted.backfill_window_end, '2026-09-08');
});

test('resolution evaluates a direct ATS job URL even when the offline candidate table misses it', async () => {
  const seen = [];
  const rows = await resolveCompanyLeads({
    leads: [{
      source_company: 'Example', normalized_source_company: 'example', source: 'freehire', scope: 'remote',
      discovered_at: '2026-09-08T10:00:00Z',
      job_url: 'https://jobs.ashbyhq.com/example/9a859605-3b08-4019-b3aa-36ea2f73da70',
    }],
    scope: 'remote',
    employers,
    candidates: [],
    portals: { tracked_companies: [] },
    forceRetry: true,
    now: new Date('2026-09-08T14:00:00Z'),
    evaluateCandidate: async (dolMatch, candidate) => {
      seen.push(candidate);
      return {
        ...dolMatch,
        status: 'accepted',
        provider: candidate.provider,
        board_identifier: candidate.identifier,
        careers_url: candidate.careers_url,
        health_status: 'live',
        identity_status: 'owner_verified',
        board_owner: 'Example',
      };
    },
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].provider, 'ashby');
  assert.equal(seen[0].identifier, 'example');
  assert.equal(seen[0].careers_url, 'https://jobs.ashbyhq.com/example');
  assert.equal(rows[0].status, 'accepted');
});

test('resolution bounds concurrent company owner checks', async () => {
  let active = 0;
  let peak = 0;
  const names = ['Alpha', 'Beta', 'Gamma'];
  const rows = await resolveCompanyLeads({
    leads: names.map(name => ({
      source_company: name, normalized_source_company: name.toLowerCase(), source: 'paylocity', scope: 'remote',
      discovered_at: '2026-09-08T10:00:00Z',
      job_url: `https://job-boards.greenhouse.io/${name.toLowerCase()}/jobs/1`,
    })),
    scope: 'remote',
    employers: names.map(name => ({ EMPLOYER_NAME: `${name} Inc.`, DBA: name, transfer_positions: '1' })),
    candidates: [],
    portals: { tracked_companies: [] },
    forceRetry: true,
    concurrency: 2,
    evaluateCandidate: async (dol, candidate) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active -= 1;
      return { ...dol, status: 'accepted', provider: candidate.provider,
        board_identifier: candidate.identifier, careers_url: candidate.careers_url,
        health_status: 'live', identity_status: 'owner_verified' };
    },
  });
  assert.equal(rows.length, 3);
  assert.equal(peak, 2);
});

test('manual backfill can force a fresh DOL decision while incremental honors cooldown', async () => {
  const leads = [{
    source_company: 'Zero', normalized_source_company: 'zero', source: 'builtin', scope: 'nyc',
    discovered_at: '2026-09-08T10:00:00Z', job_url: 'https://builtinnyc.com/job/zero',
  }];
  const currentState = [{
    normalized_lead: 'zero', preferred_name: 'Zero', status: 'ats_unresolved',
    last_seen: '2026-09-08T10:00:00Z', next_retry_at: '2026-09-15T10:00:00Z',
  }];
  const input = {
    leads,
    scope: 'nyc',
    employers: [{ EMPLOYER_NAME: 'Zero Inc.', DBA: 'Zero', transfer_positions: '0' }],
    candidates: [],
    portals: { tracked_companies: [] },
    currentState,
    now: new Date('2026-09-08T14:00:00Z'),
  };

  const incremental = await resolveCompanyLeads(input);
  const backfill = await resolveCompanyLeads({ ...input, forceRetry: true });

  assert.equal(incremental[0].status, 'ats_unresolved');
  assert.equal(backfill[0].status, 'dol_rejected');
});

test('accepted legacy alias skips re-verification only when its board is already tracked', async () => {
  const rows = await resolveCompanyLeads({
    leads: [{
      source_company: 'Hinge', normalized_source_company: 'hinge', source: 'builtin', scope: 'nyc',
      discovered_at: '2026-09-08T10:00:00Z', job_url: 'https://builtinnyc.com/job/hinge',
    }],
    scope: 'nyc',
    employers: [],
    candidates: [],
    portals: { tracked_companies: [{
      name: 'Match Group', provider: 'lever', careers_url: 'https://jobs.lever.co/matchgroup',
    }] },
    legacyReviews: [{
      identity: 'Hinge, Inc.', careers_url: 'https://jobs.lever.co/matchgroup', verdict: 'accept',
    }],
    forceRetry: true,
  });
  const wrongBoard = await resolveCompanyLeads({
    leads: [{
      source_company: 'Hinge', normalized_source_company: 'hinge', source: 'builtin', scope: 'nyc',
      discovered_at: '2026-09-08T10:00:00Z', job_url: 'https://builtinnyc.com/job/hinge',
    }],
    scope: 'nyc',
    employers: [],
    candidates: [],
    portals: { tracked_companies: [] },
    legacyReviews: [{
      identity: 'Hinge, Inc.', careers_url: 'https://jobs.lever.co/matchgroup', verdict: 'accept',
    }],
    forceRetry: true,
  });

  assert.equal(rows[0].status, 'already_tracked');
  assert.equal(wrongBoard[0].status, 'dol_rejected');
});

test('accepted legacy legal identity covers a tracked board after the DOL join', async () => {
  const rows = await resolveCompanyLeads({
    leads: [{
      source_company: 'Fanatics', normalized_source_company: 'fanatics', source: 'builtin', scope: 'nyc',
      discovered_at: '2026-09-08T10:00:00Z', job_url: 'https://builtinnyc.com/job/fanatics',
    }],
    scope: 'nyc',
    employers: [{
      EMPLOYER_NAME: 'Fanatics Retail Group Fulfillment LLC', DBA: 'Fanatics', transfer_positions: '3',
    }],
    candidates: [],
    portals: { tracked_companies: [{
      name: 'Fanatics Loyalty, LLC', provider: 'greenhouse',
      careers_url: 'https://job-boards.greenhouse.io/fanaticsinc',
    }] },
    legacyReviews: [{
      identity: 'Fanatics Retail Group Fulfillment LLC',
      careers_url: 'https://job-boards.greenhouse.io/fanaticsinc', verdict: 'accept',
    }],
    forceRetry: true,
  });

  assert.equal(rows[0].status, 'already_tracked');
});

test('an accepted v2 official-link review can supply a new ATS candidate', async () => {
  const review = {
    source_brand: 'Example',
    dol_legal_name: 'Example Holdings, Inc.',
    dol_dba: 'Example',
    dol_evidence_urls: ['https://example.com/legal'],
    ats_provider: 'workday',
    board_identifier: 'example|wd5|External',
    board_owner: 'Example',
    careers_url: 'https://example.wd5.myworkdayjobs.com/External',
    official_evidence_urls: ['https://example.com/careers'],
    verdict: 'accept',
    reviewed_at: '2026-09-08',
    reason: 'Official careers page links to the Workday board.',
  };
  const rows = await resolveCompanyLeads({
    leads: [{
      source_company: 'Example', normalized_source_company: 'example', source: 'linkedin', scope: 'remote',
      discovered_at: '2026-09-08T10:00:00Z', job_url: 'https://linkedin.com/jobs/view/example',
    }],
    scope: 'remote',
    employers,
    candidates: [],
    portals: { tracked_companies: [] },
    reviews: [review],
    forceRetry: true,
  });

  assert.equal(rows[0].status, 'accepted');
  assert.equal(rows[0].provider, 'workday');
  assert.equal(rows[0].board_identifier, 'example|wd5|External');
  assert.equal(rows[0].backfill_status, 'pending');
});

test('portal board identity is exact, so clear never collides with clearstreet', () => {
  assert.notEqual(
    portalBoardKey({ provider: 'greenhouse', board_identifier: 'clear' }),
    portalBoardKey({ provider: 'greenhouse', board_identifier: 'clearstreet' }),
  );
});

test('staged portal commit validates, appends idempotently, and preserves live file on failure', async (t) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-company-portals-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const portalsPath = join(dataRoot, 'portals.yml');
  writeFileSync(portalsPath, yaml.dump({
    title_filter: { positive: ['word:data'] },
    tracked_companies: [{
      name: 'Existing',
      provider: 'greenhouse',
      careers_url: 'https://job-boards.greenhouse.io/existing',
      enabled: true,
    }],
  }), 'utf8');

  const admission = {
    status: 'accepted',
    preferred_name: 'Example',
    provider: 'greenhouse',
    board_identifier: 'example',
    careers_url: 'https://job-boards.greenhouse.io/example',
    health_status: 'live',
    identity_status: 'owner_verified',
  };
  const first = await commitPortalAdmissions([admission], {
    dataRoot,
    validate: async stagedPath => {
      assert.match(readFileSync(stagedPath, 'utf8'), /Example/);
      return { ok: true };
    },
  });
  const second = await commitPortalAdmissions([admission], {
    dataRoot,
    validate: async () => ({ ok: true }),
  });

  assert.equal(first.added, 1);
  assert.equal(second.added, 0);
  assert.equal(yaml.load(readFileSync(portalsPath, 'utf8')).tracked_companies.length, 2);

  const beforeFailure = readFileSync(portalsPath, 'utf8');
  await assert.rejects(
    commitPortalAdmissions([{
      ...admission,
      preferred_name: 'Broken',
      board_identifier: 'broken',
      careers_url: 'https://job-boards.greenhouse.io/broken',
    }], {
      dataRoot,
      validate: async () => ({ ok: false, error: 'schema rejected' }),
    }),
    /schema rejected/,
  );
  assert.equal(readFileSync(portalsPath, 'utf8'), beforeFailure);
});
