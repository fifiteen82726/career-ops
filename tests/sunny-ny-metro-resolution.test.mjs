import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeEmployerIdentities,
  classifyResolution,
  buildSeedCompanies,
  collectTrackedPortalEvidence,
  applyDiscoveryEvidence,
} from '../data/tools/build-sunny-ny-metro-resolution.mjs';


test('merges spelling variants while retaining NY and Metro evidence', () => {
  const rows = [
    {
      EMPLOYER_NAME: 'Example, Inc.', DBA: '', transfer_positions: '3',
      ny_state_transfer_positions: '2', metro_transfer_positions: '1',
      metro_locations: 'NEW YORK, NY',
    },
    {
      EMPLOYER_NAME: 'EXAMPLE INC', DBA: '', transfer_positions: '2',
      ny_state_transfer_positions: '0', metro_transfer_positions: '2',
      metro_locations: 'JERSEY CITY, NJ',
    },
  ];

  const identities = mergeEmployerIdentities(rows);

  assert.equal(identities.length, 1);
  assert.equal(identities[0].identity, 'example');
  assert.equal(identities[0].transferPositions, 5);
  assert.equal(identities[0].nyStateTransferPositions, 2);
  assert.equal(identities[0].metroTransferPositions, 3);
  assert.deepEqual(identities[0].metroLocations, ['JERSEY CITY, NJ', 'NEW YORK, NY']);
});

test('suppresses an alternate live ATS when the employer identity is already tracked', () => {
  const identity = { identity: 'example', names: ['Example, Inc.'] };
  const auditRows = [{
    normalized_identity: 'example', match_status: 'candidate',
    verification: 'live', already_tracked: 'no', provider: 'greenhouse',
    careers_url: 'https://job-boards.greenhouse.io/example',
  }];

  assert.equal(classifyResolution(identity, auditRows, new Set(['example'])).status, 'already_tracked_name');
});

test('current tracked identity wins over a stale public-dataset verification error', () => {
  const identity = { identity: 'example', names: ['Example, Inc.'] };
  const auditRows = [{
    normalized_identity: 'example', match_status: 'candidate',
    verification: 'error', error: 'HTTP 404', provider: 'greenhouse',
    careers_url: 'https://job-boards.greenhouse.io/old-example',
  }];

  assert.equal(classifyResolution(identity, auditRows, new Set(['example'])).status, 'already_tracked_name');
});

test('keeps a live exact ATS as a candidate when the employer is not tracked', () => {
  const identity = { identity: 'example', names: ['Example, Inc.'] };
  const auditRows = [{
    normalized_identity: 'example', match_status: 'candidate',
    verification: 'live', already_tracked: 'no', provider: 'greenhouse',
    careers_url: 'https://job-boards.greenhouse.io/example',
  }];

  assert.equal(classifyResolution(identity, auditRows, new Set()).status, 'verified_candidate');
});

test('recognizes a live ATS URL already tracked under the legal parent name', () => {
  const identity = { identity: 'annalect', names: ['Annalect'] };
  const careersUrl = 'https://careers-annalect.icims.com/jobs/search?ss=1';
  const auditRows = [{
    normalized_identity: 'annalect', match_status: 'candidate', verification: 'live',
    already_tracked: 'no', provider: 'icims', careers_url: careersUrl,
  }];

  assert.equal(
    classifyResolution(identity, auditRows, new Set(), new Set([careersUrl])).status,
    'already_tracked_live',
  );
});

test('recognizes a reviewed subsidiary alias on a tracked parent ATS board', () => {
  const identity = { identity: 'hinge', names: ['Hinge, Inc.'] };
  const careersUrl = 'https://jobs.lever.co/matchgroup';
  const reviews = new Map([[`hinge\t${careersUrl}`, {
    verdict: 'accept', reason: 'Hinge roles are published on the Match Group board',
  }]]);

  const result = classifyResolution(identity, [], new Set(['matchgroup']), new Set([careersUrl]), reviews);

  assert.equal(result.status, 'already_tracked_alias');
  assert.equal(result.careersUrl, careersUrl);
});

test('a reviewed alias overrides an unrelated ambiguous public-directory collision', () => {
  const identity = { identity: 'linkedin', names: ['LinkedIn Corporation'] };
  const careersUrl = 'https://jobs.careers.microsoft.com/global/en/search';
  const auditRows = [{
    normalized_identity: 'linkedin', match_status: 'ambiguous', verification: '',
    careers_url: 'https://unrelated.example/jobs',
  }];
  const reviews = new Map([[`linkedin\t${careersUrl}`, {
    verdict: 'accept', reason: 'LinkedIn roles are published through Microsoft Careers',
  }]]);

  const result = classifyResolution(identity, auditRows, new Set(['microsoft']), new Set([careersUrl]), reviews);

  assert.equal(result.status, 'already_tracked_alias');
  assert.equal(result.careersUrl, careersUrl);
});

test('an explicitly tracked company identity overrides an ambiguous public-directory collision', () => {
  const identity = { identity: 'stripe', names: ['Stripe, LLC'] };
  const auditRows = [{
    normalized_identity: 'stripe', match_status: 'ambiguous', verification: 'skipped',
    careers_url: '',
  }];

  const result = classifyResolution(identity, auditRows, new Set(['stripe']));

  assert.equal(result.status, 'already_tracked_name');
});

test('collects tracking evidence from both company portals and shared job boards', () => {
  const evidence = collectTrackedPortalEvidence({
    tracked_companies: [{ name: 'Example', careers_url: 'https://jobs.example.com' }],
    job_boards: [{ name: 'Amazon Data', careers_url: 'https://www.amazon.jobs/en/' }],
  });

  assert.ok(evidence.names.has('example'));
  assert.ok(evidence.names.has('amazondata'));
  assert.ok(evidence.urls.has('https://www.amazon.jobs/en'));
});

test('a reviewed board-owner mismatch overrides an exact slug match', () => {
  const careersUrl = 'https://careers-parker.icims.com/jobs/search?ss=1';
  const identity = { identity: 'parker', names: ['Parker', 'Parker Group Inc.'] };
  const auditRows = [{
    normalized_identity: 'parker', match_status: 'candidate', verification: 'live',
    already_tracked: 'no', provider: 'icims', careers_url: careersUrl,
  }];
  const reviews = new Map([[`parker\t${careersUrl}`, {
    verdict: 'reject', reason: 'board identifies as Parker Health',
  }]]);

  assert.equal(
    classifyResolution(identity, auditRows, new Set(), new Set(), reviews).status,
    'identity_mismatch',
  );
});

test('excludes Meta and emits every remaining unresolved identity as a seed', () => {
  const identities = [
    { identity: 'meta', preferredName: 'Meta Platforms, Inc.', names: ['Meta Platforms, Inc.'] },
    { identity: 'missing', preferredName: 'Missing Company LLC', names: ['Missing Company LLC'] },
  ];
  const rows = identities.map(identity => classifyResolution(identity, [], new Set()));

  const seeds = buildSeedCompanies(rows);

  assert.deepEqual(seeds, [{ name: 'Missing Company LLC' }]);
  assert.equal(rows.find(row => row.identity === 'meta').status, 'excluded');
});

test('v2 discovery preserves identity and health axes in the final resolution', () => {
  const base = { identity: 'example', status: 'unresolved', reason: 'not found' };
  const discovery = {
    schemaVersion: 2,
    name: 'Example',
    provider: 'greenhouse',
    slug: 'example',
    careers_url: 'https://job-boards.greenhouse.io/example',
    identity_status: 'owner_verified',
    health_status: 'live',
    boardOwner: 'Example',
    jobCount: 4,
  };
  const result = applyDiscoveryEvidence(base, discovery);
  assert.equal(result.status, 'verified_candidate');
  assert.equal(result.identityStatus, 'owner_verified');
  assert.equal(result.healthStatus, 'live');
  assert.equal(result.boardOwner, 'Example');
});

test('post-write Workday health overrides the checkpoint health axis', () => {
  const base = { identity: 'example', status: 'unresolved' };
  const discovery = {
    schemaVersion: 2,
    name: 'Example',
    provider: 'workday',
    careers_url: 'https://example.wd5.myworkdayjobs.com/External',
    identity_status: 'reviewed_official_link',
    health_status: 'live',
  };
  const result = applyDiscoveryEvidence(base, discovery, {
    health_status: 'partial', jobCount: 100,
  });
  assert.equal(result.status, 'verified_candidate');
  assert.equal(result.healthStatus, 'partial');
  assert.equal(result.jobCount, 100);
});
