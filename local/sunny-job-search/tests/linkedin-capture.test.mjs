import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyHeadline, normalizeConnectionCard, parseConnectionDate } from '../linkedin-capture.mjs';

test('classifies only unambiguous explicit employers', () => {
  for (const [headline, status, employer] of [
    ['DS @ Capital One', 'explicit_employer', 'Capital One'], ['Data Engineer at Datadog', 'explicit_employer', 'Datadog'],
    ['Staff Software Engineer', 'missing_employer', null], ['ex-Google · Data Engineer', 'former_only', null],
    ['Google @ WPP Media', 'ambiguous_employer', null], ['Consultant at Client A for Agency B', 'ambiguous_employer', null], ['Data | Datadog', 'missing_employer', null],
  ]) assert.deepEqual(classifyHeadline(headline), { classification: status, employerLabel: employer });
});

test('normalizes a card with a cross-day-stable relative date fingerprint', () => {
  const first = normalizeConnectionCard({ profileUrl: 'https://www.linkedin.com/in/a?trk=x', fullName: ' A ', headline: 'DS @ Capital One', connectedLabelRaw: 'Connected yesterday' }, { now: new Date('2026-09-16T16:00:00Z') });
  const later = normalizeConnectionCard({ profileUrl: 'https://www.linkedin.com/in/a/', fullName: 'A', headline: 'DS @ Capital One', connectedLabelRaw: 'Connected 2 days ago' }, { now: new Date('2026-09-17T16:00:00Z') });
  assert.equal(first.cardFingerprint, later.cardFingerprint);
  assert.equal(first.connectedAtEarliest, '2026-09-15');
});

test('rejects noncanonical raw profile URL authorities before canonicalization', () => {
  for (const profileUrl of [
    'https://linkedin.com/in/a/',
    'https://user@www.linkedin.com/in/a/',
    'https://www.linkedin.com:444/in/a/',
    'https://www.linkedin.com/in/%2fa/',
  ]) assert.throws(() => normalizeConnectionCard({ profileUrl, fullName: 'A', headline: 'Engineer at Acme', connectedLabelRaw: 'Connected yesterday' }));
});

test('parses conservative dates and rejects impossible or future labels', () => {
  const now = new Date('2026-03-09T04:30:00Z');
  assert.equal(parseConnectionDate('Connected 1 week ago', { now }).precision, 'relative_week');
  assert.equal(parseConnectionDate('Connected Sep 15, 2026', { now }).precision, 'unknown');
  assert.equal(parseConnectionDate('Connected 31 February 2026', { now }).precision, 'unknown');
});

test('keeps week labels as ranges and recognizes a current employer after former history', () => {
  const parsed = parseConnectionDate('Connected 1 week ago', { now: new Date('2026-09-16T16:00:00Z') });
  assert.deepEqual(parsed, { earliest: '2026-09-02', latest: '2026-09-09', precision: 'relative_week', stableDateIdentity: null, timeZone: 'America/New_York' });
  assert.deepEqual(classifyHeadline('ex-Google · Engineer @ Datadog'), { classification: 'explicit_employer', employerLabel: 'Datadog' });
  assert.deepEqual(classifyHeadline('Engineer @ Datadog'), { classification: 'explicit_employer', employerLabel: 'Datadog' });
});

test('routes former-only headlines to Experience but retains a later current employer', () => {
  assert.deepEqual(classifyHeadline('Formerly Google · Staff Engineer'), { classification: 'former_only', employerLabel: null });
  assert.deepEqual(classifyHeadline('Formerly Google · Staff Engineer at Datadog'), { classification: 'explicit_employer', employerLabel: 'Datadog' });
});

test('never treats a former-only at-clause as a current explicit employer', () => {
  assert.deepEqual(classifyHeadline('Former Engineer at Datadog'), { classification: 'former_only', employerLabel: null });
  assert.deepEqual(classifyHeadline('Previously at Datadog'), { classification: 'former_only', employerLabel: null });
});

test('recognizes an explicit current employer after an ex-role prefix', () => {
  assert.deepEqual(classifyHeadline('Ex-Engineer at Old Co · Staff Engineer at Current Co'), { classification: 'explicit_employer', employerLabel: 'Current Co' });
});

test('retains LinkedIn absolute Connected on labels', () => {
  const value = parseConnectionDate('Connected on September 15, 2026', { now: new Date('2026-09-16T16:00:00Z') });
  assert.equal(value.precision, 'day');
  assert.equal(value.latest, '2026-09-15');
});
