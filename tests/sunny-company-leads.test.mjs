import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  canonicalLeadUrl,
  ingestLeadRows,
  leadKey,
  normalizeLead,
} from '../data/tools/sunny-company-leads.mjs';

test('relative or invalid dates retain raw provenance without verified publication', () => {
  for (const date of ['28 minutes ago', '2026-02-31']) {
    const row = normalizeLead({ company: 'Example', title: 'Data Analyst', posted_at: date },
      { source: 'linkedin', scope: 'nyc', runId: 'run' });
    assert.equal(row.posted_at, '');
    assert.equal(row.posted_at_raw, date);
    assert.equal(row.posted_at_kind, 'unresolved');
  }
});

test('ledger keeps scope observations and migrates old header without column drift', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-source-observations-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'data'));
  const file = join(dataRoot, 'data/sunny-company-leads.tsv');
  writeFileSync(file, 'source_run_id\tdiscovered_at\tsource\tscope\tsource_company\tnormalized_source_company\tjob_title\tjob_location\tjob_url\tposted_at\nold\t2026-09-08\tlinkedin\tnyc\tExample\texample\tData Engineer\tNew York\thttps://example.com/job/1\t1 hour ago\n');
  await ingestLeadRows([{ company: 'Example', title: 'Data Engineer', url: 'https://example.com/job/1', posted_at: '2026-09-08' }],
    { dataRoot, source: 'linkedin', scope: 'remote', runId: 'run-new' });
  const [header, oldRow, newRow] = readFileSync(file, 'utf8').trimEnd().split('\n').map(line => line.split('\t'));
  assert.equal(header.length, oldRow.length);
  assert.equal(header.length, newRow.length);
  assert.equal(header.includes('posted_at_raw'), true);
  assert.equal(oldRow[header.indexOf('posted_at_raw')], '1 hour ago');
  assert.equal(oldRow[header.indexOf('posted_at')], '');
  assert.equal(newRow[header.indexOf('scope')], 'remote');
});

test('canonicalLeadUrl removes tracking while preserving provider job identity', () => {
  assert.notEqual(
    canonicalLeadUrl('https://example.com/careers?gh_jid=123&gh_src=x'),
    canonicalLeadUrl('https://example.com/careers?gh_jid=456&gh_src=x'),
  );
  assert.equal(
    canonicalLeadUrl('https://job-boards.greenhouse.io/clear/jobs/8148139?gh_src=x'),
    'https://job-boards.greenhouse.io/clear/jobs/8148139',
  );
  assert.equal(
    canonicalLeadUrl('https://www.linkedin.com/jobs/view/4458427653/?trackingId=x&refId=y'),
    'https://www.linkedin.com/jobs/view/4458427653/',
  );
  assert.equal(
    canonicalLeadUrl('https://www.indeed.com/viewjob?jk=abc123&from=shareddesktop_copy'),
    'https://www.indeed.com/viewjob?jk=abc123',
  );
});

test('normalizeLead makes a stable fallback key when no canonical URL exists', () => {
  const normalized = normalizeLead({
    company: 'The Example, Inc.',
    title: 'Senior Data Engineer',
    location: 'New York, NY',
    posted_at: '2026-09-08',
  }, {
    source: 'builtin',
    scope: 'nyc',
    runId: 'run-1',
    now: new Date('2026-09-08T14:00:00Z'),
  });

  assert.equal(normalized.normalized_source_company, 'example');
  assert.equal(normalized.discovered_at, '2026-09-08T14:00:00.000Z');
  assert.match(leadKey(normalized), /^builtin\|nyc\|example\|senior data engineer\|new york ny\|2026-09-08$/);
});

test('no-URL leads retain both NYC and remote scope observations', async t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-no-url-scopes-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const lead = { company: 'Example', title: 'Data Analyst', location: 'New York / Remote' };
  const opts = { dataRoot, source: 'linkedin', runId: 'no-url' };
  assert.equal((await ingestLeadRows([lead], { ...opts, scope: 'nyc' })).appended, 1);
  assert.equal((await ingestLeadRows([lead], { ...opts, scope: 'remote' })).appended, 1);
  assert.equal((await ingestLeadRows([lead], { ...opts, scope: 'nyc' })).duplicates, 1);
});

test('ingestLeadRows deduplicates leads without touching job history', async (t) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-company-leads-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));

  const lead = {
    company: 'CLEAR',
    title: 'Senior Analytics Engineer',
    location: 'New York, NY',
    url: 'https://job-boards.greenhouse.io/clear/jobs/8148139?gh_src=x',
    posted_at: '2026-09-08',
  };
  const first = await ingestLeadRows([lead, lead], {
    dataRoot,
    source: 'linkedin',
    scope: 'nyc',
    runId: 'linkedin-nyc-2026-09-08',
    now: new Date('2026-09-08T14:00:00Z'),
  });
  const second = await ingestLeadRows([lead], {
    dataRoot,
    source: 'linkedin',
    scope: 'nyc',
    runId: 'linkedin-nyc-2026-09-08-rerun',
    now: new Date('2026-09-08T15:00:00Z'),
  });

  assert.deepEqual(first, { received: 2, appended: 1, duplicates: 1, rejected: [] });
  assert.deepEqual(second, { received: 1, appended: 0, duplicates: 1, rejected: [] });
  const ledger = readFileSync(join(dataRoot, 'data/sunny-company-leads.tsv'), 'utf8');
  assert.equal(ledger.trim().split('\n').length, 2, 'header plus one unique lead');
  assert.equal(existsSync(join(dataRoot, 'data/sunny-scan-history.tsv')), false);
  assert.equal(existsSync(join(dataRoot, 'data/scan-history.tsv')), false);
  assert.equal(existsSync(join(dataRoot, 'data/pipeline.md')), false);
});

test('ingestLeadRows rejects malformed source rows without rejecting the batch', async (t) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-company-leads-invalid-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));

  const result = await ingestLeadRows([
    { company: 'Missing Title', url: 'https://example.com/jobs/1' },
    { company: 'Valid Co', title: 'Data Analyst', url: 'https://example.com/jobs/2' },
  ], {
    dataRoot,
    source: 'indeed',
    scope: 'remote',
    runId: 'indeed-remote-1',
  });

  assert.equal(result.appended, 1);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].error, /company and title/i);
});
