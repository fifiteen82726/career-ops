import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectBuiltinLeads,
  dedupeBuiltinLeads,
} from '../data/tools/collect-sunny-builtin-leads.mjs';

test('dedupes cross-query Built In rows by URL and rejects incomplete identities', () => {
  const rows = dedupeBuiltinLeads([
    { company: 'Acme', title: 'Data Engineer', url: 'https://builtin.com/job/1' },
    { company: 'Acme', title: 'Analytics Engineer', url: 'https://builtin.com/job/1' },
    { company: '', title: 'Data Analyst', url: 'https://builtin.com/job/2' },
    { company: 'No URL', title: 'Data Analyst', url: '' },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].company, 'Acme');
  assert.equal(rows[0].title, 'Data Engineer');
});

test('collects NYC and US-remote leads with deterministic UTC timestamps', async () => {
  const calls = [];
  const fetchProvider = async entry => {
    calls.push(entry.builtin);
    if (entry.builtin.host === 'www.builtinnyc.com') {
      return [{
        company: 'Acme',
        title: 'Data Engineer',
        location: 'Hybrid · New York, NY',
        url: 'https://builtinnyc.com/job/1',
        postedAt: Date.parse('2026-09-06T08:00:00Z'),
      }];
    }
    return [
      {
        company: 'Remote Co',
        title: 'Analytics Engineer',
        location: 'Remote',
        url: 'https://builtin.com/job/2',
        postedAt: Date.parse('2026-09-07T09:30:00Z'),
      },
      {
        company: 'Acme',
        title: 'Data Engineer',
        location: 'New York, NY',
        url: 'https://builtinnyc.com/job/1',
      },
    ];
  };

  const rows = await collectBuiltinLeads({
    hosts: [
      { host: 'www.builtinnyc.com', scope: '' },
      { host: 'builtin.com', scope: 'remote' },
    ],
    queries: ['data engineer', 'analytics engineer'],
    maxPages: 2,
    fetchProvider,
    now: Date.parse('2026-09-07T12:34:56Z'),
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].scope, 'remote');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source_host, 'www.builtinnyc.com');
  assert.equal(rows[0].posted_at, '2026-09-06T08:00:00.000Z');
  assert.equal(rows[0].first_seen, '2026-09-07T12:34:56.000Z');
  assert.equal(rows[1].company, 'Remote Co');
});
