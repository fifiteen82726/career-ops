import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as yaml from 'js-yaml';

import {
  commitPortalAdmissions,
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

test('CLI requires exactly one supported scope and run mode', () => {
  assert.deepEqual(
    parseArgs(['run', '--scope', 'nyc', '--mode', 'incremental']),
    { command: 'run', scope: 'nyc', mode: 'incremental', dryRun: true, write: false },
  );
  assert.throws(() => parseArgs(['run', '--scope', 'all', '--mode', 'incremental']), /nyc or remote/);
  assert.throws(() => parseArgs(['run', '--scope', 'nyc', '--mode', 'weekly']), /backfill or incremental/);
  assert.throws(() => parseArgs(['resolve', '--scope', 'nyc', '--scope', 'remote']), /exactly one --scope/);
});

const employers = [{
  EMPLOYER_NAME: 'Example Holdings, Inc.',
  DBA: 'Example',
  transfer_positions: '12',
  ny_transfer_positions: '3',
}];

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
