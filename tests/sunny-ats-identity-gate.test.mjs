import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyDiscoveryCandidate,
  fetchPublishedBoardOwner,
  isWritableDiscoveryRecord,
  normalizeEvidenceUrl,
} from '../data/tools/sunny-ats-identity-gate.mjs';

const company = { name: 'Mercury' };

test('owner-publishing ATS requires exact canonical board ownership', () => {
  const resolved = {
    vendor: 'greenhouse', slug: 'mercury', careers_url: 'https://job-boards.greenhouse.io/mercury', jobCount: 3,
  };
  const mismatch = classifyDiscoveryCandidate({ company, resolved, boardOwner: 'Mercury Systems' });
  assert.equal(mismatch.identity_status, 'review_required');
  assert.equal(isWritableDiscoveryRecord(mismatch), false);

  const exact = classifyDiscoveryCandidate({ company, resolved, boardOwner: 'Mercury, Inc.' });
  assert.equal(exact.identity_status, 'owner_verified');
  assert.equal(exact.health_status, 'live');
  assert.equal(isWritableDiscoveryRecord(exact), true);
});

test('Scale does not match Scale AI', () => {
  const record = classifyDiscoveryCandidate({
    company: { name: 'Scale' },
    resolved: { vendor: 'ashby', slug: 'scale', careers_url: 'https://jobs.ashbyhq.com/scale', jobCount: 2 },
    boardOwner: 'Scale AI Jobs',
  });
  assert.equal(record.identity_status, 'review_required');
  assert.equal(isWritableDiscoveryRecord(record), false);
});

test('non-owner ATS is writable only with an exact accepted URL review', () => {
  const resolved = {
    vendor: 'workday',
    careers_url: 'https://acme.wd5.myworkdayjobs.com/External',
    jobCount: 8,
  };
  const reviews = [{
    identity: 'Acme Incorporated',
    careers_url: 'https://acme.wd5.myworkdayjobs.com/External/',
    verdict: 'accept',
  }];
  const accepted = classifyDiscoveryCandidate({ company: { name: 'Acme Inc.' }, resolved, reviews });
  assert.equal(accepted.identity_status, 'reviewed_official_link');
  assert.equal(isWritableDiscoveryRecord(accepted), true);

  const guessed = classifyDiscoveryCandidate({ company: { name: 'Acme Inc.' }, resolved, reviews: [] });
  assert.equal(guessed.identity_status, 'review_required');
  assert.equal(isWritableDiscoveryRecord(guessed), false);
});

test('owner endpoint failure is retryable and never writable', () => {
  const record = classifyDiscoveryCandidate({
    company,
    resolved: { vendor: 'lever', slug: 'mercury', careers_url: 'https://jobs.lever.co/mercury', jobCount: 1 },
    ownerError: 'HTTP 503',
  });
  assert.equal(record.identity_status, 'owner_unreachable');
  assert.equal(record.health_status, 'live');
  assert.equal(isWritableDiscoveryRecord(record), false);
});

test('published owners are fetched from the provider-specific endpoint', async () => {
  const calls = [];
  const ctx = {
    fetchJson: async url => { calls.push(url); return { name: 'Acme' }; },
    fetchText: async url => { calls.push(url); return '<title>Acme Jobs</title>'; },
  };
  assert.deepEqual(await fetchPublishedBoardOwner({ vendor: 'greenhouse', slug: 'acme' }, ctx), { owner: 'Acme' });
  assert.deepEqual(await fetchPublishedBoardOwner({ vendor: 'ashby', slug: 'acme' }, ctx), { owner: 'Acme' });
  assert.equal(calls[0], 'https://boards-api.greenhouse.io/v1/boards/acme');
  assert.equal(calls[1], 'https://jobs.ashbyhq.com/acme');
});

test('evidence URL normalization is exact and stable', () => {
  assert.equal(normalizeEvidenceUrl('HTTPS://Example.com/jobs/?a=1#x'), 'https://example.com/jobs?a=1');
});
