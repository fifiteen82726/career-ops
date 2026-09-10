#!/usr/bin/env node

/**
 * Discover H-1B-positive companies by reading the owner published by every
 * public Greenhouse, Ashby, and Lever board. This closes the common gap where
 * an ATS slug bears no resemblance to either the employer's legal name or DBA.
 *
 * Owner evidence is cached. Only collision-free exact DOL owner matches are
 * probed for a currently published job, and that first-party job URL is then
 * ingested as a company lead for the normal identity-safe admission pipeline.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

import { isMainModule } from '../../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import {
  extractIcimsHiringOrganization,
  extractIcimsOwner,
  fetchPublishedBoardOwner,
} from './sunny-ats-identity-gate.mjs';
import { parseIcimsSearchPage } from '../../providers/icims.mjs';
import { parsePaylocityPage } from '../../providers/paylocity.mjs';
import { parseWorkableWidget } from '../../providers/workable.mjs';
import { parseSmartRecruitersResponse } from '../../providers/smartrecruiters.mjs';
import { parseRecruiteeResponse } from '../../providers/recruitee.mjs';
import { parseBreezyResponse } from '../../providers/breezy.mjs';
import { parseTeamtailorFeed } from '../../providers/teamtailor.mjs';
import { parseJibeapplyResponse } from '../../providers/jibeapply.mjs';
import { parsePinpointResponse } from '../../providers/pinpoint.mjs';
import { parsePersonioXml } from '../../providers/personio.mjs';
import dayforceProvider, { parseDayforceResponse } from '../../providers/dayforce.mjs';
import { parsePaycomSearch } from '../../providers/paycom.mjs';
import { parseUkgSearch, resolveUkgBoard } from '../../providers/ukg.mjs';
import {
  fetchJson as providerFetchJson,
  fetchResponse as providerFetchResponse,
  fetchTextHead as providerFetchTextHead,
} from '../../providers/_http.mjs';
import {
  directAtsCandidateFromLeadUrl,
  joinLeadToDol,
  loadDolEvidence,
  portalBoardKey,
  portalEntryBoardKey,
} from './sunny-company-expansion.mjs';
import { ingestLeadRows } from './sunny-company-leads.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROVIDERS = new Set([
  'greenhouse', 'ashby', 'lever', 'workday', 'icims', 'bamboohr', 'paylocity',
  'workable', 'smartrecruiters', 'recruitee', 'breezy', 'teamtailor',
  'jibeapply', 'pinpoint', 'personio',
  'dayforce', 'paycom',
  'ukg',
]);
const DIRECTORY_BASE = 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data';
const OPEN_JOBS_FLEET_URL = 'https://raw.githubusercontent.com/elliottdehn/open-jobs/main/slugs.json';
const OWNER_AND_JOBS_PROVIDERS = new Set([
  'workable', 'smartrecruiters', 'recruitee', 'breezy', 'teamtailor', 'jibeapply', 'personio', 'paycom',
  'ukg',
]);

export function directoryFileName(provider) {
  return provider === 'paylocity' ? 'paylocity_companies_clean.json' : `${provider}_companies.json`;
}

function clean(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function boardCoordinates(provider, identifier) {
  const vendor = clean(provider).toLowerCase();
  const slug = clean(identifier);
  if (!PROVIDERS.has(vendor)) throw new Error(`unsupported owner directory provider: ${vendor}`);
  if (vendor === 'icims') {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) throw new Error('invalid iCIMS portal host');
    const origin = `https://${slug.toLowerCase()}.icims.com`;
    return {
      careersUrl: `${origin}/jobs`,
      jobsUrl: `${origin}/jobs/search?ss=1&in_iframe=1`,
    };
  }
  if (vendor === 'bamboohr') {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) throw new Error('invalid BambooHR tenant');
    const origin = `https://${slug.toLowerCase()}.bamboohr.com`;
    return { careersUrl: `${origin}/careers`, jobsUrl: `${origin}/careers/list` };
  }
  if (vendor === 'paylocity') {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slug)) {
      throw new Error('invalid Paylocity board identifier');
    }
    const careersUrl = `https://recruiting.paylocity.com/recruiting/jobs/All/${slug.toLowerCase()}/`;
    return { careersUrl, jobsUrl: careersUrl };
  }
  if (vendor === 'workable') {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug) || slug.toLowerCase() === 'j') throw new Error('invalid Workable account');
    return {
      careersUrl: `https://apply.workable.com/${slug}`,
      jobsUrl: `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`,
    };
  }
  if (vendor === 'smartrecruiters') {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) throw new Error('invalid SmartRecruiters company identifier');
    return {
      careersUrl: `https://careers.smartrecruiters.com/${slug}`,
      jobsUrl: `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=1&offset=0&status=PUBLIC`,
    };
  }
  if (vendor === 'recruitee') {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) throw new Error('invalid Recruitee tenant');
    const origin = `https://${slug.toLowerCase()}.recruitee.com`;
    return { careersUrl: origin, jobsUrl: `${origin}/api/offers/` };
  }
  if (vendor === 'breezy') {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) throw new Error('invalid Breezy tenant');
    const origin = `https://${slug.toLowerCase()}.breezy.hr`;
    return { careersUrl: origin, jobsUrl: `${origin}/json` };
  }
  if (vendor === 'teamtailor') {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) throw new Error('invalid Teamtailor tenant');
    const origin = `https://${slug.toLowerCase()}.teamtailor.com`;
    return { careersUrl: `${origin}/jobs`, jobsUrl: `${origin}/jobs.rss` };
  }
  if (vendor === 'jibeapply') {
    const host = slug.toLowerCase();
    if (isIP(host) || host.length > 253 || !host.includes('.') || host.split('.').some(label =>
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new Error('invalid Jibe careers hostname');
    }
    const origin = `https://${host}`;
    return { careersUrl: origin, jobsUrl: `${origin}/api/jobs?page=1&limit=1` };
  }
  if (vendor === 'pinpoint') {
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(slug)) throw new Error('invalid Pinpoint tenant');
    const origin = `https://${slug.toLowerCase()}.pinpointhq.com`;
    return { careersUrl: origin, jobsUrl: `${origin}/postings.json` };
  }
  if (vendor === 'personio') {
    if (!/^[a-z0-9][a-z0-9-]*\.jobs\.personio\.(?:de|com)$/i.test(slug)) throw new Error('invalid Personio tenant host');
    const origin = `https://${slug.toLowerCase()}`;
    return { careersUrl: origin, jobsUrl: `${origin}/xml` };
  }
  if (vendor === 'dayforce') {
    const [namespace, site, ...extra] = slug.split('/');
    if (extra.length || ![namespace, site].every(value => /^[a-z0-9][a-z0-9_-]*$/i.test(value || ''))) {
      throw new Error('invalid Dayforce board coordinates');
    }
    const careersUrl = `https://jobs.dayforcehcm.com/en-US/${namespace}/${site}`;
    return { careersUrl, jobsUrl: careersUrl };
  }
  if (vendor === 'paycom') {
    if (!/^[0-9a-f]{32}$/i.test(slug)) throw new Error('invalid Paycom client key');
    const key = slug.toUpperCase();
    const careersUrl = `https://www.paycomonline.net/v4/ats/web.php/portal/${key}/career-page`;
    return { careersUrl, jobsUrl: careersUrl };
  }
  if (vendor === 'ukg') {
    const board = resolveUkgBoard({ ukg_slug: slug });
    if (!board) throw new Error('invalid UKG board coordinates');
    const careersUrl = `https://${board.host}/${board.tenant}/JobBoard/${board.board}/`;
    return { careersUrl, jobsUrl: careersUrl };
  }
  if (vendor === 'workday') {
    const [tenant, instance, site, ...extra] = slug.split('|');
    if (extra.length || ![tenant, instance, site].every(value => /^[a-z0-9][a-z0-9._-]*$/i.test(value || ''))
      || !/^wd[a-z0-9-]*$/i.test(instance)) {
      throw new Error('invalid workday board identifier');
    }
    const origin = `https://${tenant}.${instance}.myworkdayjobs.com`;
    return {
      careersUrl: `${origin}/${site}`,
      jobsUrl: `${origin}/wday/cxs/${tenant}/${site}/jobs`,
    };
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) throw new Error(`invalid ${vendor} board identifier`);
  if (vendor === 'greenhouse') return {
    careersUrl: `https://job-boards.greenhouse.io/${slug}`,
    jobsUrl: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=false`,
  };
  if (vendor === 'ashby') return {
    careersUrl: `https://jobs.ashbyhq.com/${slug}`,
    jobsUrl: `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=false`,
  };
  return {
    careersUrl: `https://jobs.lever.co/${slug}`,
    jobsUrl: `https://api.lever.co/v0/postings/${slug}?mode=json`,
  };
}

export function ownerRecordNeedsRefresh(record, now = new Date()) {
  if (!record?.checked_at) return true;
  const checked = Date.parse(record.checked_at);
  if (!Number.isFinite(checked)) return true;
  const ttlMs = record.status === 'ok' ? 30 * 86_400_000 : 7 * 86_400_000;
  return new Date(now).getTime() - checked >= ttlMs;
}

export function directoryNeedsRefresh(mtimeMs, now = new Date()) {
  return !Number.isFinite(Number(mtimeMs))
    || new Date(now).getTime() - Number(mtimeMs) >= 24 * 3_600_000;
}

export function validatedDirectoryPayload(provider, payload, previousLength = 0) {
  if (!Array.isArray(payload)) throw new Error(`${provider} directory is not an array`);
  const valid = [];
  const seen = new Set();
  for (const raw of payload) {
    const identifier = provider === 'paylocity' ? clean(raw?.guid).toLowerCase() : clean(raw);
    const key = identifier.toLowerCase();
    if (!identifier || seen.has(key)) continue;
    try { boardCoordinates(provider, identifier); }
    catch { continue; }
    seen.add(key);
    valid.push(identifier);
  }
  if (previousLength >= 10 && valid.length < previousLength * 0.8) {
    throw new Error(`${provider} directory is suspiciously truncated (${valid.length} < 80% of ${previousLength})`);
  }
  return valid;
}

export function validatedPaylocityNamedDirectoryPayload(payload, previousLength = 0) {
  if (!Array.isArray(payload)) throw new Error('paylocity directory is not an array');
  const valid = [];
  const seen = new Set();
  for (const raw of payload) {
    const guid = clean(raw?.guid).toLowerCase();
    const name = clean(raw?.name);
    const jobs = Number(raw?.jobs);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(guid)
      || !name || seen.has(guid) || !Number.isFinite(jobs) || jobs < 0) continue;
    seen.add(guid);
    valid.push({ guid, name, jobs });
  }
  if (previousLength >= 10 && valid.length < previousLength * 0.8) {
    throw new Error(`paylocity directory is suspiciously truncated (${valid.length} < 80% of ${previousLength})`);
  }
  return valid;
}

export function paylocityDirectoryCandidates(rows, employers, trackedKeys = new Set()) {
  return (rows || []).filter(row => {
    if (!(Number(row.jobs) > 0) || trackedKeys.has(`paylocity\t${clean(row.guid).toLowerCase()}`)) return false;
    return joinLeadToDol({ source_company: row.name }, employers).status === 'dol_accepted';
  }).map(row => clean(row.guid).toLowerCase());
}

export function validatedOpenJobsFleetPayload(provider, payload) {
  const values = payload?.ats?.[provider === 'jibeapply' ? 'jibe' : provider];
  if (!Array.isArray(values)) throw new Error(`OpenJobs fleet has no active ${provider} array`);
  const normalized = values.map(raw => {
    const value = clean(raw);
    if (provider === 'personio') {
      if (/^[a-z0-9][a-z0-9-]*$/i.test(value)) return `${value.toLowerCase()}.jobs.personio.de`;
      return value.toLowerCase();
    }
    if (provider === 'dayforce') {
      if (/^[a-z0-9][a-z0-9_-]*$/i.test(value)) return `${value}/CANDIDATEPORTAL`;
      return value;
    }
    if (provider !== 'teamtailor') return value;
    const match = value.toLowerCase().match(/^([a-z0-9][a-z0-9-]*)\.teamtailor\.com$/);
    return match?.[1] || '';
  });
  return validatedDirectoryPayload(provider, normalized);
}

export function selectDolBackedOwnerBoards(records, employers, trackedKeys = new Set()) {
  const selected = [];
  for (const record of records || []) {
    const provider = clean(record.provider).toLowerCase();
    const identifier = clean(record.board_identifier || record.identifier);
    const key = portalBoardKey({ provider, board_identifier: identifier });
    if (record.status !== 'ok' || !clean(record.owner) || !key || trackedKeys.has(key)) continue;
    const dol = joinLeadToDol({ source_company: record.owner }, employers);
    if (dol.status !== 'dol_accepted') continue;
    selected.push({ ...record, provider, identifier, dol });
  }
  return selected.sort((left, right) =>
    left.provider.localeCompare(right.provider) || left.identifier.localeCompare(right.identifier));
}

export function ownerRecordsNeedingProofRefresh(records) {
  return (records || []).filter(row => row?.status === 'ok'
    && OWNER_AND_JOBS_PROVIDERS.has(clean(row?.provider).toLowerCase())
    && !clean(row?.published_job?.url));
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

async function refreshDirectoryCache(provider, path, now = new Date()) {
  const previous = readJson(path, []);
  const mtimeMs = existsSync(path) ? statSync(path).mtimeMs : NaN;
  if (!directoryNeedsRefresh(mtimeMs, now)) {
    return { list: validatedDirectoryPayload(provider, previous), status: 'cached' };
  }
  try {
    const response = await fetch(`${DIRECTORY_BASE}/${directoryFileName(provider)}`, {
      redirect: 'error',
      headers: { accept: 'application/json', 'user-agent': 'career-ops-sunny-owner-discovery/1.0' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const list = validatedDirectoryPayload(provider, await response.json(), previous.length);
    atomicJson(path, list);
    return { list, status: 'refreshed' };
  } catch (error) {
    if (!previous.length) throw error;
    return {
      list: validatedDirectoryPayload(provider, previous),
      status: 'stale',
      error: clean(error?.message || error),
    };
  }
}

async function refreshPaylocityNamedDirectoryCache(path, now = new Date()) {
  const previous = readJson(path, []);
  const mtimeMs = existsSync(path) ? statSync(path).mtimeMs : NaN;
  if (!directoryNeedsRefresh(mtimeMs, now)) {
    return { list: validatedPaylocityNamedDirectoryPayload(previous), status: 'cached' };
  }
  try {
    const response = await fetch(`${DIRECTORY_BASE}/${directoryFileName('paylocity')}`, {
      redirect: 'error',
      headers: { accept: 'application/json', 'user-agent': 'career-ops-sunny-owner-discovery/1.0' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const list = validatedPaylocityNamedDirectoryPayload(await response.json(), previous.length);
    atomicJson(path, list);
    return { list, status: 'refreshed' };
  } catch (error) {
    if (!previous.length) throw error;
    return {
      list: validatedPaylocityNamedDirectoryPayload(previous),
      status: 'stale',
      error: clean(error?.message || error),
    };
  }
}

async function refreshOpenJobsFleetCache(path, providers, now = new Date()) {
  const previous = readJson(path, null);
  const mtimeMs = existsSync(path) ? statSync(path).mtimeMs : NaN;
  if (previous && !directoryNeedsRefresh(mtimeMs, now)) {
    for (const provider of providers) validatedOpenJobsFleetPayload(provider, previous);
    return { payload: previous, status: 'cached' };
  }
  try {
    const response = await fetch(OPEN_JOBS_FLEET_URL, {
      redirect: 'error',
      headers: { accept: 'application/json', 'user-agent': 'career-ops-sunny-owner-discovery/1.0' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    for (const provider of providers) validatedOpenJobsFleetPayload(provider, payload);
    atomicJson(path, payload);
    return { payload, status: 'refreshed' };
  } catch (error) {
    if (!previous) throw error;
    for (const provider of providers) validatedOpenJobsFleetPayload(provider, previous);
    return { payload: previous, status: 'stale', error: clean(error?.message || error) };
  }
}

function parseArgs(argv) {
  const args = {
    dataRoot: getCareerOpsRoot(),
    providers: ['greenhouse', 'ashby', 'lever', 'workday', 'icims', 'bamboohr', 'paylocity'],
    concurrency: 20,
    limit: Infinity,
    write: false,
    refresh: false,
    directorySource: 'legacy',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--providers') args.providers = argv[++index].split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
    else if (token === '--concurrency') args.concurrency = Number(argv[++index]);
    else if (token === '--limit') args.limit = Number(argv[++index]);
    else if (token === '--directory-source') args.directorySource = clean(argv[++index]).toLowerCase();
    else if (token === '--data-root') args.dataRoot = resolve(argv[++index]);
    else if (token === '--write') args.write = true;
    else if (token === '--refresh') args.refresh = true;
    else if (token === '--help') args.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  if (!args.providers.length || args.providers.some(provider => !PROVIDERS.has(provider))) {
    throw new Error(`--providers must contain only: ${[...PROVIDERS].join(', ')}`);
  }
  if (!['legacy', 'openjobsfleet'].includes(args.directorySource)) {
    throw new Error('--directory-source must be legacy or openjobsfleet');
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 100) {
    throw new Error('--concurrency must be an integer from 1 to 100');
  }
  if (!(args.limit > 0)) throw new Error('--limit must be positive');
  return args;
}

async function mapConcurrent(items, limit, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await mapper(items[index], index);
    }
  }));
  return output;
}

function trackedBoardKeys(dataRoot) {
  const doc = yaml.load(readFileSync(join(dataRoot, 'portals.yml'), 'utf8')) || {};
  return new Set((doc.tracked_companies || []).map(portalEntryBoardKey).filter(Boolean));
}

function ownerCacheKey(record) {
  return `${clean(record?.provider).toLowerCase()}\t${clean(record?.directory_identifier || record?.identifier)}`;
}

function icimsHostCandidates(identifier) {
  const slug = clean(identifier).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return [];
  // The upstream directory's own scanner contract is careers-{slug}. Other
  // host guesses multiply timeouts and can collide with unrelated tenants;
  // exact final in-domain redirects are still retained below.
  return [`careers-${slug}`];
}

async function fetchPage(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en-US,en;q=0.9', ...(options.headers || {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { url: response.url, text: await response.text() };
}

function directoryFetchContext() {
  return {
    fetchJson: async (url, options = {}) => {
      const { maxBytes: _maxBytes, ...requestOptions } = options;
      return providerFetchJson(url, { ...requestOptions, timeoutMs: 3_000 });
    },
    fetchText: async (url, options = {}) => {
      const { maxBytes = 2_000_000, ...requestOptions } = options;
      return providerFetchTextHead(url, { ...requestOptions, maxBytes, timeoutMs: 3_000 });
    },
    fetchResponse: async (url, options = {}) => {
      const { maxBytes: _maxBytes, ...requestOptions } = options;
      return providerFetchResponse(url, { ...requestOptions, timeoutMs: 3_000 });
    },
  };
}

async function fetchIcimsOwnerRecord(identifier, ctx, now) {
  const errors = [];
  for (const host of icimsHostCandidates(identifier)) {
    try {
      const page = await ctx.fetchPage(`https://${host}.icims.com/jobs/search?ss=1`);
      const final = new URL(page.url);
      if (final.protocol !== 'https:' || !final.hostname.endsWith('.icims.com')) {
        throw new Error('redirected outside iCIMS');
      }
      const boardIdentifier = final.hostname.slice(0, -'.icims.com'.length);
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(boardIdentifier)) throw new Error('invalid final iCIMS host');
      const origin = final.origin;
      let owner = extractIcimsOwner(page.text);
      if (!owner) {
        const first = parseIcimsSearchPage(page.text, origin, '')[0];
        if (first?.url) {
          const detail = await ctx.fetchPage(`${first.url}?in_iframe=1`);
          owner = extractIcimsHiringOrganization(detail.text);
        }
      }
      owner = clean(owner);
      if (!owner) throw new Error('published owner missing');
      return {
        provider: 'icims',
        identifier: boardIdentifier,
        directory_identifier: identifier,
        board_identifier: boardIdentifier,
        careers_url: `https://${boardIdentifier}.icims.com/jobs`,
        owner,
        status: 'ok',
        checked_at: new Date(now).toISOString(),
        error: '',
      };
    } catch (error) {
      errors.push(`${host}: ${clean(error?.message || error)}`);
    }
  }
  return {
    provider: 'icims',
    identifier,
    directory_identifier: identifier,
    board_identifier: '',
    owner: '',
    status: 'error',
    checked_at: new Date(now).toISOString(),
    error: errors.join('; ') || 'no valid iCIMS host',
  };
}

export async function fetchOwnerRecord(provider, identifier, ctx, now) {
  if (provider === 'icims') return fetchIcimsOwnerRecord(identifier, ctx, now);
  try {
    const coordinates = boardCoordinates(provider, identifier);
    if (provider === 'bamboohr') {
      const jobs = await ctx.fetchJson(coordinates.jobsUrl, {
        redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
      });
      if (!Array.isArray(jobs?.result) || jobs.result.length === 0) {
        return {
          provider, identifier, directory_identifier: identifier, board_identifier: '', owner: '',
          status: 'error', checked_at: new Date(now).toISOString(), error: 'board has no published jobs',
        };
      }
    }
    const published = await fetchPublishedBoardOwner({
      vendor: provider,
      slug: identifier,
      careers_url: coordinates.careersUrl,
    }, ctx, { includePayload: true });
    const owner = clean(published.owner);
    const publishedJob = published.payload === undefined
      ? null
      : firstPublishedJob(provider, identifier, published.payload);
    return {
      provider,
      identifier,
      directory_identifier: identifier,
      board_identifier: identifier,
      careers_url: coordinates.careersUrl,
      owner,
      ...(publishedJob?.url ? { published_job: publishedJob } : {}),
      status: owner ? 'ok' : 'error',
      checked_at: new Date(now).toISOString(),
      error: owner ? '' : clean(published.error || published.reason || 'published owner missing'),
    };
  } catch (error) {
    return {
      provider,
      identifier,
      directory_identifier: identifier,
      board_identifier: '',
      owner: '',
      status: 'error',
      checked_at: new Date(now).toISOString(),
      error: clean(error?.message || error),
    };
  }
}

export function firstPublishedJob(provider, identifier, body) {
  if (provider === 'greenhouse') {
    const job = body?.jobs?.[0];
    if (!job) return null;
    return {
      title: clean(job.title) || 'Public ATS job',
      location: clean(job.location?.name),
      // Greenhouse may publish a branded redirect in absolute_url. The same
      // official API gives us the immutable job id, so keep the URL anchored to
      // the exact board whose owner was just verified.
      url: job.id ? `https://job-boards.greenhouse.io/${identifier}/jobs/${job.id}` : '',
    };
  }
  if (provider === 'ashby') {
    const job = body?.jobs?.[0];
    if (!job) return null;
    return {
      title: clean(job.title) || 'Public ATS job',
      location: clean(job.location),
      url: clean(job.jobUrl) || clean(job.applyUrl),
    };
  }
  if (provider === 'workday') {
    const job = body?.jobPostings?.[0];
    if (!job || !String(job.externalPath || '').startsWith('/job/')) return null;
    const { careersUrl } = boardCoordinates(provider, identifier);
    return {
      title: clean(job.title) || 'Public ATS job',
      location: clean(job.locationsText),
      url: `${careersUrl}${job.externalPath}`,
    };
  }
  if (provider === 'bamboohr') {
    const job = body?.result?.[0];
    if (!job?.id || !clean(job.jobOpeningName)) return null;
    return {
      title: clean(job.jobOpeningName),
      location: [job.location?.city, job.location?.state, job.isRemote ? 'Remote' : ''].map(clean).filter(Boolean).join(', '),
      url: `https://${identifier.toLowerCase()}.bamboohr.com/careers/${encodeURIComponent(String(job.id))}`,
    };
  }
  if (provider === 'paylocity') {
    const job = parsePaylocityPage(String(body || ''), '')[0];
    return job ? { title: job.title, location: job.location, url: job.url } : null;
  }
  if (provider === 'workable') {
    let job = parseWorkableWidget(body, '')[0];
    if (!job && body?.jobs?.[0]) {
      job = parseWorkableWidget({
        jobs: [{ ...body.jobs[0], shortlink: `https://apply.workable.com/${identifier}`, url: '' }],
      }, '')[0];
    }
    return job ? { title: job.title, location: job.location, url: job.url } : null;
  }
  if (provider === 'smartrecruiters') {
    const job = parseSmartRecruitersResponse(body, identifier)[0];
    return job ? { title: job.title, location: job.location, url: job.url } : null;
  }
  if (provider === 'recruitee') {
    const job = parseRecruiteeResponse(body, '')[0];
    return job ? { title: job.title, location: job.location, url: job.url } : null;
  }
  if (provider === 'breezy') {
    const job = parseBreezyResponse(body, '')[0];
    return job ? { title: job.title, location: job.location, url: job.url } : null;
  }
  if (provider === 'teamtailor') {
    const job = parseTeamtailorFeed(String(body || ''), '')[0];
    return job ? { title: job.title, location: job.location, url: job.url } : null;
  }
  if (provider === 'jibeapply') {
    const coordinates = boardCoordinates(provider, identifier);
    const job = parseJibeapplyResponse(body, {
      name: '', careers_url: coordinates.careersUrl, api: coordinates.jobsUrl,
    })[0];
    return job ? { title: job.title, location: job.location, url: job.url } : null;
  }
  if (provider === 'pinpoint') {
    const job = parsePinpointResponse(body, '')[0];
    return job ? { title: job.title, location: job.location, url: job.url } : null;
  }
  if (provider === 'personio') {
    const job = parsePersonioXml(String(body || ''), '', identifier)[0];
    return job ? { title: job.title, location: job.location, url: job.url } : null;
  }
  if (provider === 'dayforce') {
    const [namespace, site] = identifier.split('/');
    const job = parseDayforceResponse(body, { namespace, site, locale: 'en-US' }, '')[0];
    return job ? { title: job.title, location: job.location, url: job.url } : null;
  }
  if (provider === 'paycom') {
    const job = parsePaycomSearch(body, identifier, '').jobs[0];
    return job ? { title: job.title, location: job.location, url: job.url } : null;
  }
  if (provider === 'ukg') {
    const board = resolveUkgBoard({ ukg_slug: identifier });
    const job = parseUkgSearch(body, board, '').jobs[0];
    return job ? { title: job.title, location: job.location, url: job.url } : null;
  }
  const job = Array.isArray(body) ? body[0] : null;
  if (!job) return null;
  return {
    title: clean(job.text) || 'Public ATS job',
    location: clean(job.categories?.location),
    url: clean(job.hostedUrl) || clean(job.applyUrl),
  };
}

async function liveLead(row, ctx) {
  const coordinates = boardCoordinates(row.provider, row.identifier);
  try {
    let job = row.published_job?.url ? row.published_job : null;
    if (!job && row.provider === 'icims') {
      const html = await ctx.fetchText(coordinates.jobsUrl, {
        redirect: 'error', headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en-US,en;q=0.9' },
      });
      job = parseIcimsSearchPage(html, new URL(coordinates.careersUrl).origin, row.owner)[0] || null;
    } else if (!job && row.provider === 'teamtailor') {
      const xml = await ctx.fetchText(coordinates.jobsUrl, {
        redirect: 'error', headers: { accept: 'application/rss+xml, application/xml', 'user-agent': 'Mozilla/5.0' },
        maxBytes: 2_000_000,
      });
      job = firstPublishedJob(row.provider, row.identifier, xml);
    } else if (!job && row.provider === 'paylocity') {
      const html = await ctx.fetchText(coordinates.jobsUrl, {
        redirect: 'error', headers: { 'user-agent': 'Mozilla/5.0' }, maxBytes: 2_000_000,
      });
      job = firstPublishedJob(row.provider, row.identifier, html);
    } else if (!job && row.provider === 'dayforce') {
      job = (await dayforceProvider.fetch({
        name: row.owner,
        careers_url: coordinates.careersUrl,
      }, { ...ctx, maxPages: 1 }))[0] || null;
    } else if (!job) {
      const requestOptions = row.provider === 'workday' ? {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'Mozilla/5.0',
          origin: new URL(coordinates.careersUrl).origin,
          referer: `${coordinates.careersUrl}/`,
        },
        body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: '' }),
      } : {
        redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
      };
      const body = await ctx.fetchJson(coordinates.jobsUrl, requestOptions);
      job = firstPublishedJob(row.provider, row.identifier, body);
    }
    if (!job?.url) return { error: 'board has no published job URL', row };
    const leadUrl = row.provider === 'jibeapply'
      ? coordinates.jobsUrl
      : ['paylocity', 'workable'].includes(row.provider) ? coordinates.careersUrl : job.url;
    const direct = directAtsCandidateFromLeadUrl(leadUrl);
    const expected = portalBoardKey({ provider: row.provider, board_identifier: row.identifier });
    const actual = direct && portalBoardKey({ provider: direct.provider, board_identifier: direct.identifier });
    if (!actual || actual !== expected) return { error: 'published job URL does not match board coordinates', row };
    return {
      lead: {
        company: row.owner,
        title: job.title,
        location: job.location,
        url: leadUrl,
      },
      row,
    };
  } catch (error) {
    return { error: clean(error?.message || error), row };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node data/tools/collect-sunny-ats-owner-leads.mjs [--providers ${[...PROVIDERS].join(',')}] [--directory-source legacy|openjobsfleet] [--concurrency 20] [--limit N] [--refresh] [--write]`);
    return;
  }
  const startedAt = new Date();
  const config = yaml.load(readFileSync(join(args.dataRoot, 'profiles/sunny-company-discovery.yml'), 'utf8')) || {};
  const employers = loadDolEvidence(config, args.dataRoot);
  const tracked = trackedBoardKeys(args.dataRoot);
  const ctx = { ...directoryFetchContext(), fetchPage };
  const cachePath = join(args.dataRoot, 'data/cache/ats-board-owners.json');
  const cached = readJson(cachePath, { schema_version: 1, records: [] });
  const byKey = new Map((cached.records || []).map(row => [ownerCacheKey(row), row]));
  const stats = {};
  const openJobsFleet = args.directorySource === 'openjobsfleet'
    ? await refreshOpenJobsFleetCache(
      join(args.dataRoot, 'data/cache/openjobs-fleet-slugs.json'), args.providers, startedAt,
    )
    : null;

  for (const provider of args.providers) {
    const namedPaylocity = !openJobsFleet && provider === 'paylocity'
      ? await refreshPaylocityNamedDirectoryCache(
        join(args.dataRoot, 'data/cache/ats-companies/paylocity-named.json'), startedAt,
      )
      : null;
    const directory = namedPaylocity || (openJobsFleet ? {
      list: validatedOpenJobsFleetPayload(provider, openJobsFleet.payload),
      status: openJobsFleet.status,
      ...(openJobsFleet.error ? { error: openJobsFleet.error } : {}),
    } : await refreshDirectoryCache(
      provider,
      join(args.dataRoot, `data/cache/ats-companies/${provider}.json`),
      startedAt,
    ));
    const identifiers = (namedPaylocity
      ? paylocityDirectoryCandidates(directory.list, employers, tracked)
      : directory.list).slice(0, args.limit);
    const due = identifiers.filter(identifier => {
      const key = `${provider}\t${identifier}`;
      return !tracked.has(key) && (args.refresh || ownerRecordNeedsRefresh(byKey.get(key), startedAt));
    });
    let done = 0;
    for (let offset = 0; offset < due.length; offset += 100) {
      const batch = due.slice(offset, offset + 100);
      const records = await mapConcurrent(batch, args.concurrency,
        identifier => fetchOwnerRecord(provider, identifier, ctx, startedAt));
      for (const record of records) byKey.set(ownerCacheKey(record), record);
      done += records.length;
      atomicJson(cachePath, {
        schema_version: 1,
        updated_at: new Date().toISOString(),
        records: [...byKey.values()],
      });
      console.error(`${provider} owners ${done}/${due.length}`);
    }
    stats[provider] = {
      directory: directory.list.length,
      ...(namedPaylocity ? { dol_prefiltered: identifiers.length } : {}),
      directory_status: directory.status,
      ...(directory.error ? { directory_error: directory.error } : {}),
      owner_requests: due.length,
    };
  }

  let ownerMatches = selectDolBackedOwnerBoards([...byKey.values()]
    .filter(row => args.providers.includes(row.provider)), employers, tracked);
  const proofDue = ownerRecordsNeedingProofRefresh(ownerMatches);
  if (proofDue.length) {
    const refreshed = await mapConcurrent(proofDue, Math.min(2, args.concurrency), row =>
      fetchOwnerRecord(row.provider, row.identifier, ctx, startedAt));
    for (const record of refreshed) {
      if (record.status === 'ok' && record.published_job?.url) byKey.set(ownerCacheKey(record), record);
    }
    atomicJson(cachePath, {
      schema_version: 1,
      updated_at: new Date().toISOString(),
      records: [...byKey.values()],
    });
    ownerMatches = selectDolBackedOwnerBoards([...byKey.values()]
      .filter(row => args.providers.includes(row.provider)), employers, tracked);
  }
  const probed = await mapConcurrent(ownerMatches, args.concurrency, row => liveLead(row, ctx));
  const leads = probed.filter(item => item.lead).map(item => item.lead);
  const errors = probed.filter(item => item.error).map(item => ({
    provider: item.row.provider,
    identifier: item.row.identifier,
    owner: item.row.owner,
    error: item.error,
  }));
  const timestamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const inboxDir = join(args.dataRoot, 'data/company-discovery/inbox');
  const receiptDir = join(args.dataRoot, 'data/company-discovery/receipts');
  mkdirSync(inboxDir, { recursive: true });
  mkdirSync(receiptDir, { recursive: true });
  const source = args.directorySource === 'openjobsfleet' ? 'openjobsfleet' : 'atsdirectory';
  const inbox = join(inboxDir, `${source}-remote-backfill-${timestamp}.json`);
  atomicJson(inbox, leads);
  const runId = `${source}-remote-backfill-${startedAt.toISOString()}`;
  const ingestion = args.write ? await ingestLeadRows(leads, {
    dataRoot: args.dataRoot,
    source,
    scope: 'remote',
    runId,
    now: startedAt,
  }) : null;
  const receipt = join(receiptDir, `ats-owner-discovery-${timestamp}-${randomUUID().slice(0, 8)}.json`);
  const report = {
    run_id: runId,
    directory_source: args.directorySource,
    started_at: startedAt.toISOString(),
    completed_at: new Date().toISOString(),
    stats,
    cached_owner_records: byKey.size,
    selective_proof_refreshes: proofDue.length,
    dol_backed_untracked_owner_boards: ownerMatches.length,
    live_first_party_board_leads: leads.length,
    live_probe_errors: errors.length,
    errors,
    inbox,
    ingestion,
  };
  atomicJson(receipt, report);
  console.log(JSON.stringify({ ...report, errors: errors.slice(0, 20), receipt }, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
