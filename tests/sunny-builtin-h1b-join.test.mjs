import test from 'node:test';
import assert from 'node:assert/strict';

import { joinBuiltinCompanies } from '../data/tools/join-sunny-builtin-h1b.mjs';

const employers = [
  { EMPLOYER_NAME: 'Mercury Systems, Inc.', DBA: '', transfer_positions: '8' },
  { EMPLOYER_NAME: 'Scale AI, Inc.', DBA: '', transfer_positions: '25' },
  { EMPLOYER_NAME: 'Acme LLC', DBA: '', transfer_positions: '7' },
  { EMPLOYER_NAME: 'Streamvector Inc.', DBA: 'Sigmoid Analytics', transfer_positions: '12' },
  { EMPLOYER_NAME: 'Pioneer LLC', DBA: '', transfer_positions: '2' },
  { EMPLOYER_NAME: 'Pioneer Inc.', DBA: '', transfer_positions: '3' },
];

const leads = [
  { company: 'Mercury', url: 'https://builtin.com/job/1' },
  { company: 'Scale', url: 'https://builtin.com/job/2' },
  { company: 'Acme', url: 'https://builtin.com/job/3' },
  { company: 'Sigmoid', url: 'https://builtin.com/job/4' },
  { company: 'Pioneer', url: 'https://builtin.com/job/5' },
  { company: 'Aggregator Only', url: 'https://builtin.com/job/6' },
];

test('joins only exact DOL identities or an explicit reviewed alias', () => {
  const reviews = [{
    source_company: 'Sigmoid',
    identity: 'Sigmoid Analytics',
    careers_url: 'https://job-boards.greenhouse.io/sigmoid',
    verdict: 'accept',
  }];
  const result = joinBuiltinCompanies({ leads, employers, reviews });

  assert.deepEqual(result.accepted.map(row => row.company).sort(), ['Acme', 'Sigmoid']);
  assert.equal(result.accepted.find(row => row.company === 'Acme').match_type, 'exact');
  assert.equal(result.accepted.find(row => row.company === 'Sigmoid').match_type, 'reviewed_alias');
});

test('fails closed on prefixes, normalized collisions, and aggregator-only brands', () => {
  const result = joinBuiltinCompanies({ leads, employers, reviews: [] });
  const byCompany = new Map(result.needsReview.map(row => [row.company, row.reason]));

  assert.match(byCompany.get('Mercury'), /no exact/i);
  assert.match(byCompany.get('Scale'), /no exact/i);
  assert.match(byCompany.get('Pioneer'), /ambiguous/i);
  assert.match(byCompany.get('Aggregator Only'), /no exact/i);
  assert.equal(result.accepted.some(row => row.company === 'Mercury'), false);
  assert.equal(result.accepted.some(row => row.company === 'Scale'), false);
});
