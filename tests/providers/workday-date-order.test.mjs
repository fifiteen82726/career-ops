import assert from 'node:assert/strict';
import test from 'node:test';
import workday from '../../providers/workday.mjs';
import { captureConsoleErrors } from '../helpers.mjs';

const ENTRY = Object.freeze({
  name: 'Date Order Fixture',
  careers_url: 'https://dateorder.wd5.myworkdayjobs.com/External',
});
const DAY_MS = 86_400_000;

function page(offset, postedOn = 'Posted Today') {
  return Array.from({ length: 20 }, (_, index) => ({
    title: `Role ${offset + index}`,
    externalPath: `/job/New-York/Role_${offset + index}`,
    locationsText: 'New York, NY',
    postedOn,
  }));
}

// A pinned older posting ahead of fresh results violates the ordering assumed
// by the default date shortcut. Keep a recent posting on the same first page.
const mixedFirstPage = page(0);
mixedFirstPage[0].postedOn = 'Posted 23 Days Ago';
mixedFirstPage[1].postedOn = 'Posted 30+ Days Ago';
const outOfOrderPages = {
  0: { total: 40, facets: [], jobPostings: mixedFirstPage },
  20: { total: 40, facets: [], jobPostings: page(20) },
};
const undatedFirstPages = {
  0: { total: 40, facets: [], jobPostings: page(0, 'Posted 30+ Days Ago') },
  20: outOfOrderPages[20],
};

function fixtureContext(pages, extra = {}) {
  const offsets = [];
  const delays = [];
  const ctx = Object.freeze({
    sinceMs: Date.now() - 20 * DAY_MS,
    sleep: async (ms) => { delays.push(ms); },
    fetchJson: async (_url, options) => {
      const { offset } = JSON.parse(options.body);
      offsets.push(offset);
      const response = pages[offset];
      assert.ok(response, `unexpected page offset ${offset}`);
      if (response instanceof Error) throw response;
      return response;
    },
    ...extra,
  });
  return { ctx, offsets, delays };
}

test('date_early_stop: false fetches fresh jobs after an older first-page posting', async () => {
  const { ctx, offsets, delays } = fixtureContext(outOfOrderPages);
  const { result: jobs, errors } = await captureConsoleErrors(() =>
    workday.fetch({ ...ENTRY, date_early_stop: false }, ctx));

  assert.deepEqual(offsets, [0, 20]);
  assert.equal(jobs.length, 40);
  assert.equal(jobs[20].title, 'Role 20');
  assert.ok(jobs[20].postedAt >= ctx.sinceMs);
  assert.ok(jobs[0].postedAt < ctx.sinceMs);
  assert.equal(jobs[1].postedAt, undefined);
  assert.equal(jobs.workdayTruncated, undefined);
  assert.equal(jobs.workdayNoDateSkip, undefined);
  assert.deepEqual(delays, [250]);
  assert.deepEqual(errors, []);
});

for (const value of [undefined, true, null, 0, 'false']) {
  test(`date_early_stop=${JSON.stringify(value) ?? 'omitted'} preserves the default date shortcut`, async () => {
    const entry = value === undefined ? ENTRY : { ...ENTRY, date_early_stop: value };
    const { ctx, offsets } = fixtureContext(outOfOrderPages);
    const { result: jobs, errors } = await captureConsoleErrors(() => workday.fetch(entry, ctx));

    assert.deepEqual(offsets, [0]);
    assert.equal(jobs.length, 20);
    assert.equal(jobs.workdayTruncated, undefined);
    assert.deepEqual(errors, []);
  });
}

test('date_early_stop: false also disables the date shortcut on later pages', async () => {
  const pages = {
    0: { total: 60, facets: [], jobPostings: page(0) },
    20: { total: 60, facets: [], jobPostings: page(20, 'Posted 23 Days Ago') },
    40: { total: 60, facets: [], jobPostings: page(40) },
  };
  const { ctx, offsets } = fixtureContext(pages);
  const jobs = await workday.fetch({ ...ENTRY, date_early_stop: false }, ctx);

  assert.deepEqual(offsets, [0, 20, 40]);
  assert.equal(jobs.length, 60);
  assert.equal(jobs[40].title, 'Role 40');
});

test('date_early_stop: false reaches dated jobs after an undated first page', async () => {
  const { ctx, offsets } = fixtureContext(undatedFirstPages, { includeUndated: false });
  const jobs = await workday.fetch({ ...ENTRY, date_early_stop: false }, ctx);

  assert.deepEqual(offsets, [0, 20]);
  assert.equal(jobs.length, 40);
  assert.equal(jobs[0].postedAt, undefined);
  assert.ok(jobs[20].postedAt >= ctx.sinceMs);
  assert.equal(jobs.workdayNoDateSkip, undefined);
});

test('omitting date_early_stop preserves the undated-first-page shortcut', async () => {
  const { ctx, offsets } = fixtureContext(undatedFirstPages, { includeUndated: false });
  const jobs = await workday.fetch(ENTRY, ctx);

  assert.deepEqual(offsets, [0]);
  assert.equal(jobs.length, 20);
  assert.equal(jobs.workdayNoDateSkip, true);
});

test('date_early_stop: false preserves the max_pages cap and truncation warning', async () => {
  const { ctx, offsets } = fixtureContext(outOfOrderPages);
  const { result: jobs, errors } = await captureConsoleErrors(() =>
    workday.fetch({ ...ENTRY, date_early_stop: false, max_pages: 1 }, ctx));

  assert.deepEqual(offsets, [0]);
  assert.equal(jobs.length, 20);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /truncated at max_pages=1 \(20 of 40 jobs\).*raise max_pages/);
});

for (const [status, attempts] of [[503, 4], [400, 1]]) {
  test(`date_early_stop: false preserves HTTP ${status} retry and partial-result handling`, async () => {
    const error = Object.assign(new Error(`HTTP ${status}`), { status });
    const { ctx, offsets } = fixtureContext({ ...outOfOrderPages, 20: error });
    const { result: jobs, errors } = await captureConsoleErrors(() =>
      workday.fetch({ ...ENTRY, date_early_stop: false }, ctx));

    assert.deepEqual(offsets, [0, ...Array(attempts).fill(20)]);
    assert.equal(jobs.length, 20);
    assert.equal(jobs.workdayTruncated, true);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes(`truncated at 2 of 2 pages after ${attempts} attempts (20 of 40 jobs): HTTP ${status}`));
    assert.doesNotMatch(errors[0], /raise max_pages/);
  });
}

test('date_early_stop: false preserves the quiet ctx.maxPages probe cap', async () => {
  const { ctx, offsets, delays } = fixtureContext(outOfOrderPages, { maxPages: 1 });
  const { result: jobs, errors } = await captureConsoleErrors(() =>
    workday.fetch({ ...ENTRY, date_early_stop: false }, ctx));

  assert.deepEqual(offsets, [0]);
  assert.equal(jobs.length, 20);
  assert.equal(jobs.workdayTruncated, undefined);
  assert.deepEqual(delays, []);
  assert.deepEqual(errors, []);
});

test('the date opt-out leaves shared context unchanged for later consumers and boards', async () => {
  const { ctx, offsets } = fixtureContext(outOfOrderPages);
  const before = { ...ctx };
  await workday.fetch({ ...ENTRY, date_early_stop: false }, ctx);

  assert.deepEqual(ctx, before);
  const defaultJobs = await workday.fetch(ENTRY, ctx);
  assert.deepEqual(offsets, [0, 20, 0]);
  assert.equal(defaultJobs.length, 20);
  assert.deepEqual(ctx, before);
});
