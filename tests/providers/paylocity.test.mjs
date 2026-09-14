import test from 'node:test';
import assert from 'node:assert/strict';

import paylocity, { parsePaylocityPage } from '../../providers/paylocity.mjs';

const guid = 'd9282170-896e-4b00-bec5-34963f54aad8';

test('Paylocity detects only exact public tenant board URLs', () => {
  assert.deepEqual(
    paylocity.detect({ careers_url: `https://recruiting.paylocity.com/recruiting/jobs/All/${guid}/` }),
    { url: `https://recruiting.paylocity.com/recruiting/jobs/All/${guid}/` },
  );
  assert.equal(paylocity.detect({ careers_url: 'https://evil.example/recruiting/jobs/All/' + guid }), null);
});

test('Paylocity parses window.pageData into dated scanner jobs', () => {
  const html = `<html><script>window.pageData = ${JSON.stringify({ Jobs: [{
    JobId: 4490089,
    JobTitle: 'Data Engineer &amp; Analyst',
    PublishedDate: '2026-09-09T12:42:19-05:00',
    IsRemote: true,
    Description: '<p>Build ETL pipelines</p>',
    JobLocation: { City: 'New York', State: 'NY' },
  }] })};</script></html>`;
  const jobs = parsePaylocityPage(html, '365 Retail Markets');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Data Engineer & Analyst');
  assert.equal(jobs[0].location, 'New York, NY, Remote');
  assert.equal(jobs[0].postedAt, Date.parse('2026-09-09T12:42:19-05:00'));
  assert.equal(jobs[0].url, 'https://recruiting.paylocity.com/recruiting/Jobs/Details/4490089');
});

test('Paylocity retries a rate-limited board fetch', async () => {
  const waits = [];
  let calls = 0;
  const pageData = `<script>window.pageData = ${JSON.stringify({ Jobs: [{
    JobId: 4490089,
    JobTitle: 'Data Engineer',
  }] })};</script>`;
  const ctx = {
    sleep(ms) {
      waits.push(ms);
    },
    async fetchText() {
      calls++;
      if (calls === 1) {
        const err = new Error('rate limited');
        err.status = 429;
        err.retryAfter = '0';
        throw err;
      }
      return pageData;
    },
  };

  const jobs = await paylocity.fetch({
    name: 'Example Co',
    careers_url: `https://recruiting.paylocity.com/recruiting/jobs/All/${guid}/`,
  }, ctx);

  assert.equal(calls, 2);
  assert.deepEqual(waits, [0]);
  assert.equal(jobs[0].title, 'Data Engineer');
});
