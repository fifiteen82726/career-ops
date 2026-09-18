#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { loadAndMigrateReferralState, migrateReferralState, validateReferralState } from '../../local/sunny-job-search/referrals.mjs';

const DAY_MS = 86_400_000;
const REQUIRED_FIELDS = ['scanDate', 'priority', 'priorityLabel', 'score', 'recommendation', 'company', 'title', 'category', 'location', 'workMode', 'primaryGap', 'resume', 'applyUrl', 'referralMessage'];
const PRIORITIES = new Set(['priority', 'suggested', 'low']);

export function canonicalUrl(rawUrl) {
  const url = new URL(rawUrl);
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|gclid$|fbclid$)/i.test(key)) url.searchParams.delete(key);
  }
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

function assertArchive(archive) {
  if (!archive || archive.schemaVersion !== 1 || !Array.isArray(archive.jobs) || archive.jobs.length === 0) {
    throw new Error('Sunny archive must have schemaVersion 1 and at least one job. Existing snapshot was preserved.');
  }
  for (const [index, job] of archive.jobs.entries()) {
    for (const field of REQUIRED_FIELDS) {
      if (job[field] === undefined || job[field] === null || job[field] === '') throw new Error(`Sunny archive row ${index + 1} is missing ${field}. Existing snapshot was preserved.`);
    }
    if (!validDate(job.scanDate)) throw new Error(`Sunny archive row ${index + 1} has invalid scanDate. Existing snapshot was preserved.`);
    if (!PRIORITIES.has(job.priority)) throw new Error(`Sunny archive row ${index + 1} has invalid priority. Existing snapshot was preserved.`);
    if (!Number.isFinite(Number(job.score))) throw new Error(`Sunny archive row ${index + 1} has invalid score. Existing snapshot was preserved.`);
    canonicalUrl(job.applyUrl);
  }
}

function todayInZone(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const values = Object.fromEntries(parts.filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isRecentReferralDate(value, now, windowDays = 14) {
  if (!validDate(value)) return false;
  const today = todayInZone(now, 'America/New_York');
  const difference = (new Date(`${today}T12:00:00Z`) - new Date(`${value}T12:00:00Z`)) / DAY_MS;
  return difference >= 0 && difference < windowDays;
}

const CONTACT_FIELDS = ['fullName', 'profileUrl', 'currentTitle', 'currentEmployer', 'connectedLabelRaw', 'connectedAtEarliest', 'connectedAtLatest', 'lastObservedAt', 'matchQuality'];
function safeReferralContact(value, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const text = key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 500;
  // A title is optional for a title-only employer observation.  Do not turn a
  // valid referral into a missing referral simply because LinkedIn omitted it.
  const title = typeof value.currentTitle === 'string' && value.currentTitle.length <= 500;
  if (!CONTACT_FIELDS.filter(key => key !== 'currentTitle').every(text) || !title || !/^https:\/\/www\.linkedin\.com\/in\/[^/?#]+\/$/.test(value.profileUrl)
    || !['company_url_exact', 'reviewed_alias'].includes(value.matchQuality)
    || !isRecentReferralDate(value.connectedAtEarliest, now) || !isRecentReferralDate(value.connectedAtLatest, now)) return null;
  const observed = Date.parse(value.lastObservedAt);
  if (Number.isNaN(observed) || observed > now.getTime() || (now.getTime() - observed) / DAY_MS > 90) return null;
  // Deliberately project a closed public shape rather than spreading a cache
  // object, which prevents private cache/context fields from reaching the site.
  return Object.fromEntries(CONTACT_FIELDS.map(key => [key, value[key]]));
}

function referralContactsFor(job, referralState, now) {
  if (!referralState || !Array.isArray(referralState.matches) || !isRecentReferralDate(job.scanDate, now)) return [];
  const identity = `${job.scanDate}|${canonicalUrl(job.applyUrl)}`;
  const seen = new Set();
  return referralState.matches.filter(match => match && `${match.jobScanDate}|${match.canonicalApplyUrl}` === identity
    && isRecentReferralDate(match.jobScanDate, now) && isRecentReferralDate(match.connectedAtEarliest, now)
    && isRecentReferralDate(match.connectedAtLatest, now) && typeof match.profileUrl === 'string'
    && !seen.has(match.profileUrl) && seen.add(match.profileUrl)).map(match => safeReferralContact({
    fullName: match.fullName, profileUrl: match.profileUrl, currentTitle: match.currentTitle,
    currentEmployer: match.currentEmployer, connectedLabelRaw: match.connectedLabelRaw,
    connectedAtEarliest: match.connectedAtEarliest, connectedAtLatest: match.connectedAtLatest,
    lastObservedAt: match.lastObservedAt, matchQuality: match.matchQuality,
  }, now)).filter(Boolean);
}

function validReferralState(state) { try { return validateReferralState(state); } catch { return false; } }

function cachedContacts(previous, now) {
  if (!previous || !Array.isArray(previous.jobs)) return new Map(); const result = new Map();
  for (const job of previous.jobs) {
    try {
      if (!job || typeof job !== 'object' || !validDate(job.scanDate) || !job.applyUrl || !isRecentReferralDate(job.scanDate, now)) continue;
      const key = `${job.scanDate}|${canonicalUrl(job.applyUrl)}`;
      const contacts = Array.isArray(job.referralContacts) ? job.referralContacts.map(contact => safeReferralContact(contact, now)).filter(Boolean) : [];
      if (contacts.length) result.set(key, contacts);
    } catch { /* A malformed stale cache entry must not block fresh jobs. */ }
  }
  return result;
}

export function buildSnapshot(archive, now = new Date(), referralState = null) {
  assertArchive(archive);
  if (referralState) {
    try { referralState = migrateReferralState(referralState, { now }); validateReferralState(referralState); }
    catch { referralState = { sourceStatus: 'error', matches: [], updatedAt: null }; }
  }
  const timeZone = archive.timeZone || 'America/New_York';
  const today = todayInZone(now, timeZone);
  const cutoff = new Date(`${today}T12:00:00Z`).getTime() - (29 * DAY_MS);
  const deduped = new Map();
  for (const source of archive.jobs) {
    const scanAt = new Date(`${source.scanDate}T12:00:00Z`).getTime();
    if (scanAt < cutoff) continue;
    const applyUrl = canonicalUrl(source.applyUrl);
    const key = `${source.scanDate}|${applyUrl}`;
    const job = { ...source, id: applyUrl, applyUrl, score: Number(source.score), referralContacts: [] };
    const current = deduped.get(key);
    if (!current || job.score > current.score) deduped.set(key, job);
  }
  if (!deduped.size) throw new Error('Sunny archive has no rows in the most recent 30 calendar days. Existing snapshot was preserved.');
  for (const job of deduped.values()) job.referralContacts = referralContactsFor(job, referralState, now);
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    timeZone,
    windowDays: 30,
    referralDataStatus: referralState?.sourceStatus || 'not_configured',
    referralDataUpdatedAt: referralState?.updatedAt || null,
    jobs: [...deduped.values()].sort((a, b) => b.scanDate.localeCompare(a.scanDate) || b.score - a.score || a.company.localeCompare(b.company) || a.title.localeCompare(b.title)),
  };
}

export function refreshSnapshot({ archivePath, referralPath, outputPath, now = new Date() }) {
  const archive = JSON.parse(readFileSync(archivePath, 'utf8'));
  let referralState = null;
  let invalidReferral = false;
  if (referralPath && existsSync(referralPath)) {
    try { referralState = loadAndMigrateReferralState(referralPath, { now, write: false }); invalidReferral = !validReferralState(referralState); }
    catch { invalidReferral = true; }
  }
  const snapshot = buildSnapshot(archive, now, invalidReferral ? { sourceStatus: 'error', matches: [], updatedAt: null } : referralState);
  if (invalidReferral) {
    let previous = null; try { previous = JSON.parse(readFileSync(outputPath, 'utf8')); } catch {}
    const cache = cachedContacts(previous, now);
    for (const job of snapshot.jobs) job.referralContacts = cache.get(`${job.scanDate}|${canonicalUrl(job.applyUrl)}`) || [];
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  const tempPath = resolve(dirname(outputPath), `.jobs-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(tempPath, 0o600);
    const validated = JSON.parse(readFileSync(tempPath, 'utf8'));
    if (validated.schemaVersion !== 1 || !Array.isArray(validated.jobs) || validated.jobs.length === 0) throw new Error('Generated Sunny snapshot failed validation. Existing snapshot was preserved.');
    renameSync(tempPath, outputPath);
    chmodSync(outputPath, 0o600);
  } finally { if (existsSync(tempPath)) unlinkSync(tempPath); }
  return snapshot;
}

function main() {
  const checkoutRoot = resolve(import.meta.dirname, '../..');
  const dataRoot = getCareerOpsRoot();
  const archivePath = resolve(process.argv[2] || `${dataRoot}/data/sunny-job-search-archive.json`);
  const outputPath = resolve(process.argv[3] || `${checkoutRoot}/local/sunny-job-search/data/jobs.json`);
  const referralPath = resolve(process.argv[4] || `${dataRoot}/data/sunny-linkedin-referrals.json`);
  if (!existsSync(archivePath)) throw new Error(`Sunny archive not found at ${archivePath}. Existing snapshot was preserved.`);
  const snapshot = refreshSnapshot({ archivePath, referralPath, outputPath });
  console.log(`Sunny snapshot refreshed: ${snapshot.jobs.length} jobs (${snapshot.jobs.at(-1).scanDate} to ${snapshot.jobs[0].scanDate}).`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) main();
