import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkableWidget } from '../providers/workable.mjs';

test('dedup merges locations instead of losing the second NYC posting', () => {
  const base = { title: 'Data Engineer', shortlink: 'https://apply.workable.com/j/ABC123', country: 'United States' };
  const jobs = parseWorkableWidget({ jobs: [
    { ...base, city: 'San Francisco', published_on: '2026-09-08' },
    { ...base, city: 'New York', published_on: '2026-09-01' },
  ] }, 'Example');
  assert.equal(jobs.length, 1);
  assert.match(jobs[0].location, /San Francisco/);
  assert.match(jobs[0].location, /New York/);
  assert.equal(jobs[0].postedAt, Date.parse('2026-09-01'));
});

test('keeps explicit remote and multi-location eligibility from widget payload', () => {
  const jobs = parseWorkableWidget({ jobs: [{ title: 'Data Analyst', shortlink: 'https://apply.workable.com/j/ABC123',
    country: 'United States', telecommuting: true, locations: [{ city: 'Stamford', country: 'United States' },
      { city: 'Hidden City', country: 'United States', hidden: true }] }] }, 'Example');
  assert.match(jobs[0].location, /Remote/);
  assert.match(jobs[0].location, /United States/);
  assert.match(jobs[0].location, /Stamford/);
  assert.doesNotMatch(jobs[0].location, /Hidden City/);
});
