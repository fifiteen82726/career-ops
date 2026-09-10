import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildExactCandidates,
  normalizeCompanyIdentity,
  providerCoordinates,
  selectPreferredAdditions,
} from '../data/tools/build-sunny-h1b-ats-universe.mjs';

const oldTargetTable = readFileSync(
  new URL('../data/cache/dol/sunny-eligible-employers-fy2026q3.tsv', import.meta.url),
  'utf8',
);

test('all-title DOL universe restores Datadog even though the old title-gated table excluded it', () => {
  assert.doesNotMatch(oldTargetTable, /^Datadog(?:\t|$)/mi);

  const employers = [{
    employerName: 'Datadog, Inc.',
    dba: '',
    transferPositions: 15,
    nyTransferPositions: 13,
  }];
  const candidates = buildExactCandidates(employers, {
    greenhouse: ['datadog'],
    ashby: [],
    lever: [],
    workday: [],
    icims: [],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].employerName, 'Datadog, Inc.');
  assert.equal(candidates[0].provider, 'greenhouse');
  assert.equal(candidates[0].identifier, 'datadog');
  assert.equal(candidates[0].status, 'candidate');
});

test('normalized employer collisions are never auto-approved', () => {
  const employers = [
    { employerName: 'Acme, Inc.', dba: '', transferPositions: 3, nyTransferPositions: 0 },
    { employerName: 'Acme LLC', dba: '', transferPositions: 2, nyTransferPositions: 1 },
  ];
  const candidates = buildExactCandidates(employers, {
    greenhouse: ['acme'],
    ashby: [],
    lever: [],
    workday: [],
    icims: [],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].status, 'ambiguous');
  assert.deepEqual(candidates[0].matchedEmployers.sort(), ['Acme LLC', 'Acme, Inc.']);
});

test('company identity strips legal suffixes but preserves meaningful names', () => {
  assert.equal(normalizeCompanyIdentity('Datadog, Inc.'), 'datadog');
  assert.equal(normalizeCompanyIdentity('The Travelers Companies, Inc.'), 'travelerscompanies');
  assert.equal(normalizeCompanyIdentity('Weights & Biases'), 'weightsandbiases');
});

test('provider coordinates construct supported public ATS URLs', () => {
  assert.deepEqual(providerCoordinates('greenhouse', 'datadog'), {
    careersUrl: 'https://job-boards.greenhouse.io/datadog',
    api: 'https://boards-api.greenhouse.io/v1/boards/datadog/jobs',
  });
  assert.deepEqual(providerCoordinates('workday', 'blackrock|wd1|blackrock_professional'), {
    careersUrl: 'https://blackrock.wd1.myworkdayjobs.com/blackrock_professional',
  });
});

test('automatic additions keep one strongest live board per legal employer', () => {
  const rows = [
    { employerName: 'Acme, Inc.', provider: 'workday', identifier: 'acme|wd1|small', verification: 'live', jobCount: 3, status: 'candidate', alreadyTracked: false, careersUrl: 'https://acme.wd1.myworkdayjobs.com/small' },
    { employerName: 'Acme, Inc.', provider: 'greenhouse', identifier: 'acme', verification: 'live', jobCount: 40, status: 'candidate', alreadyTracked: false, careersUrl: 'https://job-boards.greenhouse.io/acme' },
    { employerName: 'Beta LLC', provider: 'ashby', identifier: 'beta', verification: 'live', jobCount: 5, status: 'candidate', alreadyTracked: false, careersUrl: 'https://jobs.ashbyhq.com/beta' },
  ];

  const additions = selectPreferredAdditions(rows, new Set());
  assert.equal(additions.length, 2);
  assert.equal(additions.find(row => row.employerName === 'Acme, Inc.').provider, 'greenhouse');
});
