import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import jibeapply from '../providers/jibeapply.mjs';
import workday from '../providers/workday.mjs';
import { createProviderContinuation } from '../data/tools/sunny-provider-continuation.mjs';
import { classifyScanCompletion } from '../data/tools/run-sunny-serialized-scan.mjs';

function ledger(root, provider = 'jibeapply') {
  return createProviderContinuation({ dataRoot: root, key: { origin_gap: 'gap-1', provider, board_identifier: 'board-1', window: { posted_after: '2026-09-01', posted_before: '2026-09-03' } } });
}
function jibePage(n) { return { totalCount: 3, jobs: [{ data: { title: `Job ${n}`, slug: `job-${n}`, hiring_organization: 'Acme' } }] }; }

test('Jibe resumes from durable page identity across bounded invocations', async t => {
  const root = mkdtempSync(join(tmpdir(), 'sunny-jibe-continuation-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = ledger(root); const calls = [];
  const fetchJson = async url => { calls.push(url); const page = Number(new URL(url).searchParams.get('page') || 1); return jibePage(page); };
  const first = await jibeapply.fetch({ name: 'Acme', careers_url: 'https://acme.jibeapply.com', max_pages: 3 }, { fetchJson, maxPages: 1, continuation: state });
  assert.equal(first.jibeapplyTruncated, true); assert.deepEqual(first.continuationPages, ['page:1']);
  first.continuationPages.forEach(page => state.acknowledge(page));
  const second = await jibeapply.fetch({ name: 'Acme', careers_url: 'https://acme.jibeapply.com', max_pages: 3 }, { fetchJson, maxPages: 2, continuation: state });
  assert.equal(calls.filter(url => !new URL(url).searchParams.has('page')).length, 1, 'resume must not re-request acknowledged page 1');
  assert.ok(calls.some(url => new URL(url).searchParams.get('page') === '2'));
  assert.ok(calls.some(url => new URL(url).searchParams.get('page') === '3'));
  second.continuationPages.forEach(page => state.acknowledge(page)); state.complete();
  assert.equal(state.snapshot().complete, true);
});

test('Jibe treats entry max_pages as an invocation budget and advances past page two', async t => {
  const root = mkdtempSync(join(tmpdir(), 'sunny-jibe-entry-budget-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = ledger(root); const calls = [];
  const fetchJson = async url => { const page = Number(new URL(url).searchParams.get('page') || 1); calls.push(page); return { totalCount: 4, jobs: [{ data: { title: `Job ${page}`, slug: `job-${page}`, hiring_organization: 'Acme' } }] }; };
  const entry = { name: 'Acme', careers_url: 'https://acme.jibeapply.com', max_pages: 2 };
  const first = await jibeapply.fetch(entry, { continuation: state, fetchJson });
  first.continuationPages.forEach(page => state.acknowledge(page));
  const second = await jibeapply.fetch(entry, { continuation: state, fetchJson });
  assert.ok(calls.includes(3) && calls.includes(4));
  assert.equal(second.continuationComplete, true);
});

test('Jibe leaves saved page unacknowledged after later page failure for replay', async t => {
  const root = mkdtempSync(join(tmpdir(), 'sunny-jibe-failure-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = ledger(root); let failed = false;
  const first = await jibeapply.fetch({ name: 'Acme', careers_url: 'https://acme.jibeapply.com', max_pages: 3 }, { continuation: state, fetchJson: async url => {
    const page = Number(new URL(url).searchParams.get('page') || 1); if (page === 3 && !failed) { failed = true; throw new Error('page outage'); } return jibePage(page);
  } });
  assert.equal(first.jibeapplyContinuation.stop_reason, 'page_3_failure');
  assert.deepEqual(state.pending().map(page => page.identity), ['page:1', 'page:2']);
  const replay = await jibeapply.fetch({ name: 'Acme', careers_url: 'https://acme.jibeapply.com', max_pages: 3 }, { continuation: state, fetchJson: async url => jibePage(Number(new URL(url).searchParams.get('page') || 1)) });
  assert.ok(replay.some(job => job.url.endsWith('/job-1')) && replay.some(job => job.url.endsWith('/job-2')), 'saved payloads replay before cursor advances');
});

test('Workday saves partition payloads and structured incomplete evidence controls completion', async t => {
  const root = mkdtempSync(join(tmpdir(), 'sunny-workday-frontier-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = ledger(root, 'workday');
  const jobs = await workday.fetch({ name: 'Acme', careers_url: 'https://acme.wd1.myworkdayjobs.com/jobs', max_pages: 1 }, { continuation: state, fetchJson: async () => ({ total: 40, jobPostings: [{ title: 'Data Engineer', externalPath: '/job/New-York/Data-Engineer_REQ1', postedOn: 'Posted Today' }] }), sleep: async () => {} });
  assert.equal(jobs.workdayContinuation?.complete, false);
  assert.equal(state.pending().length, 1);
  assert.equal(classifyScanCompletion({ exitCode: 0, stderr: '', receipt: { version: 'careerops.scan.receipt@1', errors: [], added_urls: [], source_observations: [{ complete: false, continuation: jobs.workdayContinuation }] } }), 'partial');
});

test('Workday replays an unacknowledged saved page before advancing its facet frontier', async t => {
  const root = mkdtempSync(join(tmpdir(), 'sunny-workday-pending-replay-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = ledger(root, 'workday'); let calls = 0;
  const entry = { name: 'Acme', careers_url: 'https://acme.wd1.myworkdayjobs.com/jobs', max_pages: 1 };
  await workday.fetch(entry, { continuation: state, fetchJson: async () => { calls++; return { total: 40, jobPostings: [{ title: 'Data Engineer', externalPath: '/job/New-York/Data_REQ1', postedOn: 'Posted Today' }] }; }, sleep: async () => {} });
  const replay = await workday.fetch(entry, { continuation: state, fetchJson: async () => { calls++; throw new Error('must not advance before intake'); }, sleep: async () => {} });
  assert.equal(calls, 1);
  assert.equal(replay.workdayContinuation.reason, 'pending_intake');
  assert.equal(replay.length, 1);
});

test('Workday drains a durable facet frontier across bounded invocations without re-running completed branches', async t => {
  const root = mkdtempSync(join(tmpdir(), 'sunny-workday-facet-frontier-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = ledger(root, 'workday');
  const calls = [];
  const fetchJson = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ facets: body.appliedFacets, offset: body.offset });
    const family = body.appliedFacets.jobFamily?.[0];
    if (!family) return {
      total: 2000,
      facets: [{ facetParameter: 'jobFamily', values: [{ id: 'data', count: 1001 }, { id: 'platform', count: 1001 }] }],
      jobPostings: [{ title: 'Root', externalPath: '/job/New-York/Root_REQ0', postedOn: 'Posted Today' }],
    };
    return {
      total: 1,
      jobPostings: [{ title: family, externalPath: `/job/New-York/${family}_REQ1`, postedOn: 'Posted Today' }],
    };
  };
  const entry = { name: 'Acme', careers_url: 'https://acme.wd1.myworkdayjobs.com/jobs', max_pages: 1 };
  const first = await workday.fetch(entry, { continuation: state, fetchJson, sleep: async () => {} });
  assert.equal(first.workdayContinuation?.complete, false);
  assert.deepEqual(state.snapshot().pending_partitions.map(p => p.applied_facets.jobFamily?.[0]), ['data', 'platform']);
  first.continuationPages.forEach(page => state.acknowledge(page));

  const second = await workday.fetch(entry, { continuation: state, fetchJson, sleep: async () => {} });
  second.continuationPages.forEach(page => state.acknowledge(page));
  assert.deepEqual(state.snapshot().pending_partitions.map(p => p.applied_facets.jobFamily?.[0]), ['platform']);

  const third = await workday.fetch(entry, { continuation: state, fetchJson, sleep: async () => {} });
  third.continuationPages.forEach(page => state.acknowledge(page));
  assert.equal(third.continuationComplete, true);
  assert.deepEqual(calls.map(call => call.facets.jobFamily?.[0] || 'root'), ['root', 'data', 'platform']);
  assert.equal(state.snapshot().completed_partitions.length, 3);
});

test('probe-only Workday execution remains bounded and never establishes continuation completion', async () => {
  const jobs = await workday.fetch({ name: 'Acme', careers_url: 'https://acme.wd1.myworkdayjobs.com/jobs' }, { maxPages: 1, fetchJson: async () => ({ total: 1000, jobPostings: [] }) });
  assert.equal(jobs.length, 0);
  assert.equal(jobs.workdayTruncated, undefined);
});
