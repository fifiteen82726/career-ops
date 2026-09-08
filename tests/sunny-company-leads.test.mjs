import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  canonicalLeadUrl,
  ingestLeadRows,
  leadKey,
  normalizeLead,
} from '../data/tools/sunny-company-leads.mjs';

test('canonicalLeadUrl removes tracking while preserving provider job identity', () => {
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
  assert.match(leadKey(normalized), /^builtin\|example\|senior data engineer\|new york ny\|2026-09-08$/);
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
