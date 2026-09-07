import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCheckpoint,
  selectPendingCompanies,
  recordsFromDiscovery,
  runCheckpointedDiscovery,
  resolveCompanyWithIdentityGate,
} from '../data/tools/run-sunny-ny-metro-discovery.mjs';


test('checkpoint keeps the latest record and ignores a truncated final line', () => {
  const checkpoint = parseCheckpoint([
    JSON.stringify({ name: 'Alpha', status: 'unresolved', attempt: 1 }),
    JSON.stringify({ name: 'Alpha', status: 'resolved', attempt: 2 }),
    '{"name":"truncated"',
  ].join('\n'));

  assert.equal(checkpoint.size, 1);
  assert.equal(checkpoint.get('alpha').status, 'resolved');
});

test('an owner mismatch on one provider does not hide an exact board on a later provider', async () => {
  const calls = [];
  const resolveFn = async (_company, { vendors }) => {
    calls.push(vendors[0]);
    if (vendors[0] === 'gh') return { resolved: {
      name: 'Mercury', vendor: 'greenhouse', slug: 'mercury',
      careers_url: 'https://job-boards.greenhouse.io/mercury', jobCount: 2,
    } };
    return { resolved: {
      name: 'Mercury', vendor: 'ashby', slug: 'mercury',
      careers_url: 'https://jobs.ashbyhq.com/mercury', jobCount: 3,
    } };
  };
  const ownerFn = async resolved => ({
    owner: resolved.vendor === 'greenhouse' ? 'Mercury Systems' : 'Mercury',
  });
  const result = await resolveCompanyWithIdentityGate({ name: 'Mercury' }, {
    vendors: ['gh', 'ashby'], resolveFn, ownerFn,
  });
  assert.deepEqual(calls, ['gh', 'ashby']);
  assert.equal(result.provider, 'ashby');
  assert.equal(result.identity_status, 'owner_verified');
});

test('resume replays legacy and retryable records, but not accepted live records', () => {
  const companies = [{ name: 'Alpha' }, { name: 'Beta' }, { name: 'Gamma' }];
  const checkpoint = new Map([
    ['alpha', { name: 'Alpha', status: 'resolved' }], // legacy: no owner proof
    ['beta', {
      schemaVersion: 2,
      name: 'Beta',
      status: 'resolved',
      identity_status: 'owner_verified',
      health_status: 'live',
    }],
    ['gamma', {
      schemaVersion: 2,
      name: 'Gamma',
      status: 'unresolved',
      identity_status: 'owner_unreachable',
      health_status: 'transient_error',
    }],
  ]);

  assert.deepEqual(selectPendingCompanies(companies, checkpoint), [{ name: 'Alpha' }, { name: 'Gamma' }]);
});

test('accepted partial records retry while review-required records stay quarantined', () => {
  const companies = [{ name: 'Partial' }, { name: 'Mismatch' }];
  const checkpoint = new Map([
    ['partial', { schemaVersion: 2, identity_status: 'owner_verified', health_status: 'partial' }],
    ['mismatch', { schemaVersion: 2, identity_status: 'review_required', health_status: 'live' }],
  ]);
  assert.deepEqual(selectPendingCompanies(companies, checkpoint), [{ name: 'Partial' }]);
});

test('discovery results become one durable record per input company', () => {
  const batch = [{ name: 'Alpha' }, { name: 'Beta' }];
  const discovery = {
    resolved: [{ name: 'Alpha', vendor: 'greenhouse', careers_url: 'https://job-boards.greenhouse.io/alpha', jobCount: 2 }],
    unresolved: [{ name: 'Beta', reason: 'no supported ATS board found' }],
  };

  const records = recordsFromDiscovery(batch, discovery, '2026-09-02T00:00:00.000Z');

  assert.deepEqual(records.map(record => [record.name, record.status]), [
    ['Alpha', 'resolved'],
    ['Beta', 'unresolved'],
  ]);
});

test('streams each completed company to the checkpoint with bounded concurrency', async () => {
  const companies = [{ name: 'Alpha' }, { name: 'Beta' }, { name: 'Gamma' }];
  const appended = [];
  let active = 0;
  let maxActive = 0;
  const resolveOne = async company => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, company.name === 'Alpha' ? 5 : 1));
    active -= 1;
    if (company.name === 'Beta') throw new Error('network failed');
    return { resolved: { name: company.name, vendor: 'greenhouse', careers_url: `https://example/${company.name}` } };
  };

  const records = await runCheckpointedDiscovery(companies, {
    concurrency: 2,
    resolveOne,
    onRecord: record => appended.push(record),
  });

  assert.equal(records.length, 3);
  assert.equal(appended.length, 3);
  assert.equal(maxActive, 2);
  assert.equal(records.find(record => record.name === 'Beta').status, 'unresolved');
  assert.equal(records.find(record => record.name === 'Beta').health_status, 'transient_error');
});
