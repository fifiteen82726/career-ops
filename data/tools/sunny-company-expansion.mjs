#!/usr/bin/env node

/**
 * Identity-safe company admission for Sunny's H-1B job-search universe.
 * Source postings are leads only; this module admits scanner coordinates only
 * after a current DOL transfer match and a supported, identity-safe ATS match.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as yaml from 'js-yaml';

import { acquirePipelineLock } from '../../pipeline-lock.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { resolveTenant } from '../../providers/eightfold.mjs';
import { resolveSite } from '../../providers/oraclecloud.mjs';
import {
  fetchJson as providerFetchJson,
  fetchResponse as providerFetchResponse,
  fetchTextHead as providerFetchTextHead,
} from '../../providers/_http.mjs';
import { normalizeCompanyIdentity, providerCoordinates } from './build-sunny-h1b-ats-universe.mjs';
import { ingestLeadRows, readLeadRows } from './sunny-company-leads.mjs';
import { parseQuotedTsv } from './sunny-tsv.mjs';
import {
  classifyPublishedOwner,
  fetchPublishedBoardOwner,
} from './sunny-ats-identity-gate.mjs';
import {
  nextRetryAt,
  finishBackfill,
  readResolutionRows,
  resolutionRowKey,
  retryIsDue,
  startBackfill,
  statePaths,
  updateResolutionRows,
} from './sunny-company-state.mjs';

const execFileAsync = promisify(execFile);
const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OWNER_PROVIDERS = new Set([
  'greenhouse', 'ashby', 'lever', 'workday', 'paylocity', 'bamboohr',
  'smartrecruiters', 'gem', 'workable', 'icims', 'recruitee', 'breezy',
  'teamtailor', 'personio', 'rippling', 'jobvite', 'jibeapply', 'pinpoint',
  'dayforce', 'paycom',
  'ukg',
]);
const SCOPED_PROVIDERS = new Set(['eightfold', 'oraclecloud']);

function flagOccurrences(args, flag) {
  return args.filter(token => token === flag || token.startsWith(`${flag}=`));
}

function flagValue(args, flag) {
  const occurrences = flagOccurrences(args, flag);
  if (occurrences.length > 1) throw new Error(`pass exactly one ${flag}`);
  if (!occurrences.length) return undefined;
  const token = occurrences[0];
  if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  const index = args.indexOf(token);
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

export function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  if (!['ingest', 'run', 'resolve', 'backfill'].includes(command)) {
    throw new Error('command must be ingest, run, resolve, or backfill');
  }
  const scopeOccurrences = flagOccurrences(args, '--scope');
  if (command !== 'backfill' && scopeOccurrences.length !== 1) {
    throw new Error('pass exactly one --scope (nyc or remote)');
  }
  const scope = flagValue(args, '--scope');
  if (command !== 'backfill' && !['nyc', 'remote'].includes(scope)) {
    throw new Error('--scope must be nyc or remote');
  }

  if (command === 'run') {
    const mode = flagValue(args, '--mode');
    if (!['backfill', 'incremental'].includes(mode)) {
      throw new Error('--mode must be backfill or incremental');
    }
    const write = args.includes('--write');
    const explicitDryRun = args.includes('--dry-run');
    if (write && explicitDryRun) throw new Error('--write and --dry-run are mutually exclusive');
    return { command, scope, mode, dryRun: !write, write };
  }

  if (command === 'resolve') {
    const write = args.includes('--write');
    return { command, scope, dryRun: !write, write };
  }

  if (command === 'ingest') {
    const source = flagValue(args, '--source');
    const input = flagValue(args, '--input');
    if (!['indeed', 'builtin', 'freehire', 'himalayas', 'jobicy', 'openjobs', 'openjobsfleet', 'paylocity', 'bamboohr', 'atsdirectory', 'themuse', 'newgradjobs'].includes(source)) {
      throw new Error('--source must be a supported source: indeed, builtin, freehire, himalayas, jobicy, openjobs, openjobsfleet, paylocity, bamboohr, atsdirectory, themuse, or newgradjobs');
    }
    if (!input) throw new Error('--input is required');
    return { command, scope, source, input };
  }

  if (!args.includes('--pending')) throw new Error('backfill requires --pending');
  return { command, pending: true };
}

function clean(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function employerRecord(row) {
  return {
    legal: String(row.EMPLOYER_NAME ?? row.employer_name ?? row.employerName ?? '').trim(),
    dba: String(row.DBA ?? row.dba ?? '').trim(),
    transfer: Number(row.transfer_positions ?? row.transferPositions ?? 0),
    nyTransfer: Number(row.ny_transfer_positions ?? row.nyTransferPositions ?? 0),
    evidenceTier: clean(row.evidence_tier),
    evidencePeriods: clean(row.source_periods),
    evidenceWindow: clean(row.current_or_historical_window),
    latestDecision: clean(row.latest_decision_date),
  };
}

const dolIndexCache = new WeakMap();

function indexedEmployers(employers) {
  if (Array.isArray(employers) && dolIndexCache.has(employers)) return dolIndexCache.get(employers);
  const index = new Map();
  for (const raw of employers || []) {
    const row = employerRecord(raw);
    if (!row.legal || row.transfer <= 0) continue;
    const enriched = {
      ...row,
      legalIdentity: normalizeCompanyIdentity(row.legal),
      dbaIdentity: normalizeCompanyIdentity(row.dba),
    };
    for (const identity of new Set([enriched.legalIdentity, enriched.dbaIdentity].filter(Boolean))) {
      if (!index.has(identity)) index.set(identity, new Map());
      const key = JSON.stringify([row.legal, row.dba]);
      const previous = index.get(identity).get(key);
      index.get(identity).set(key, previous ? {
        ...previous,
        transfer: previous.transfer + row.transfer,
        nyTransfer: previous.nyTransfer + row.nyTransfer,
      } : enriched);
    }
  }
  if (Array.isArray(employers)) dolIndexCache.set(employers, index);
  return index;
}

export function joinLeadToDol(lead, employers) {
  const source = clean(lead?.source_company ?? lead?.company ?? lead?.preferred_name);
  const identity = normalizeCompanyIdentity(source);
  if (!identity) return { status: 'dol_rejected', reason: 'missing source company identity' };
  if (/^meta(?:platforms)?$/.test(identity)) {
    return { status: 'dol_rejected', reason: 'Meta is explicitly excluded by Sunny policy' };
  }

  // Build once per loaded employer array; company resolution otherwise becomes
  // O(leads × DOL rows), which dominates large dashboard backfills.
  const matches = [...(indexedEmployers(employers).get(identity)?.values() || [])];
  if (!matches.length) {
    return {
      status: 'dol_rejected',
      normalized_lead: identity,
      preferred_name: source,
      reason: 'no collision-free exact CHANGE_EMPLOYER match in the configured DOL evidence index',
    };
  }
  if (matches.length > 1) {
    return {
      status: 'dol_ambiguous',
      normalized_lead: identity,
      preferred_name: source,
      evidence: matches.map(row => row.legal),
      reason: `exact normalized identity collides across ${matches.length} DOL employers`,
    };
  }

  const match = matches[0];
  return {
    status: 'dol_accepted',
    normalized_lead: identity,
    preferred_name: source,
    dol_legal_name: match.legal,
    dol_dba: match.dba,
    transfer_positions: match.transfer,
    ny_transfer_positions: match.nyTransfer,
    dol_evidence_tier: match.evidenceTier,
    dol_evidence_periods: match.evidencePeriods,
    dol_evidence_window: match.evidenceWindow,
    dol_latest_decision_date: match.latestDecision,
    match_type: identity === match.dbaIdentity && identity !== match.legalIdentity
      ? 'dba_exact'
      : 'legal_exact',
  };
}

function httpsEvidence(values) {
  return Array.isArray(values) && values.length > 0 && values.every(value => {
    try { return new URL(value).protocol === 'https:'; }
    catch { return false; }
  });
}

function dnsName(value) {
  return typeof value === 'string' && value.length <= 253
    && value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function safeIdentityUrl(raw) {
  if (typeof raw !== 'string' || /[\s\\]/.test(raw)) return null;
  const shape = raw.match(/^https:\/\/([^/?#]+)([^?#]*)(?:[?#]|$)/i);
  try {
    const url = new URL(raw);
    if (!shape || shape[1].toLowerCase() !== url.hostname || !dnsName(url.hostname)
      || (shape[2] || '/') !== url.pathname
      || /[\x00-\x20\x7f]/.test(decodeURIComponent(url.pathname + url.search))) return null;
    return url;
  } catch { return null; }
}

/** Exact request identity, using the provider's api/override precedence. */
function scopedEntryIdentifier(provider, entry) {
  const resolveCoordinates = provider === 'eightfold' ? resolveTenant : resolveSite;
  for (const raw of [entry?.api, entry?.careers_url]) {
    const coordinates = resolveCoordinates({ ...entry, api: undefined, careers_url: raw });
    if (!coordinates) continue;
    // A selected but unsafe endpoint must not fall through to a different board.
    const url = safeIdentityUrl(raw);
    if (!url) return '';

    if (provider === 'eightfold') {
      if (!/^\/(?:careers|api\/apply\/v2\/jobs)\/?$/.test(url.pathname)
        || url.searchParams.getAll('domain').length > 1) return '';
      if (coordinates.domain && !dnsName(coordinates.domain)) return '';
      return `${coordinates.host}|${coordinates.domain || ''}`;
    }
    if (!/^\/hcmUI\/CandidateExperience\/[a-zA-Z-]+\/sites\/[A-Za-z0-9_-]+(?:\/(?:jobs|job\/[A-Za-z0-9_-]+))?\/?$/.test(url.pathname)
      && !/^\/hcmRestApi\/resources\/(?:latest|[0-9.]+)\/recruitingCEJobRequisitions\/?$/.test(url.pathname)) return '';
    if (!/^[A-Za-z0-9_-]+$/.test(coordinates.siteNumber)
      || (coordinates.locationId !== null && !/^\d+$/.test(coordinates.locationId))) return '';
    return `${coordinates.host}|${coordinates.siteNumber}|${coordinates.locationId ?? ''}`;
  }
  return '';
}

/** Persisted identifiers carry every scope even when state omits entry fields. */
function scopedEntryFromIdentifier(provider, identifier) {
  if (typeof identifier !== 'string') return null;
  const parts = identifier.split('|');
  if (parts.length !== (provider === 'eightfold' ? 2 : 3)) return null;
  const [host, scope, locationId] = parts;
  const entry = provider === 'eightfold'
    ? { api: `https://${host}/api/apply/v2/jobs`, ...(scope ? { domain: scope } : {}) }
    : { api: `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`,
      siteNumber: scope, ...(locationId ? { locationId } : {}) };
  return scopedEntryIdentifier(provider, entry) === identifier ? entry : null;
}

export function identifierFromAtsUrl(provider, value) {
  if (SCOPED_PROVIDERS.has(provider)) return scopedEntryIdentifier(provider, { careers_url: value });
  const url = clean(value);
  if (provider === 'greenhouse') {
    try {
      const parsed = new URL(url);
      if (/^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/i.test(parsed.hostname)
        && parsed.pathname === '/embed/job_board'
        && parsed.searchParams.getAll('for').length === 1) {
        return clean(parsed.searchParams.get('for'));
      }
    } catch { /* fall through to the exact path matcher */ }
    return url.match(/(?:boards-api|boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:v1\/boards\/)?([^/?#]+)/i)?.[1] || '';
  }
  if (provider === 'ashby') {
    return url.match(/(?:jobs\.ashbyhq\.com|api\.ashbyhq\.com\/posting-api\/job-board)\/([^/?#]+)/i)?.[1] || '';
  }
  if (provider === 'lever') {
    return url.match(/(?:jobs|api)\.lever\.co\/(?:v0\/postings\/)?([^/?#]+)/i)?.[1] || '';
  }
  if (provider === 'workday') {
    const match = url.match(/^https:\/\/([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)/);
    return match ? `${match[1]}|${match[2]}|${match[3]}` : '';
  }
  if (provider === 'icims') return url.match(/^https:\/\/([^./]+)\.icims\.com/i)?.[1] || '';
  if (provider === 'workable') {
    const slug = url.match(/^https:\/\/apply\.workable\.com\/([^/?#]+)/i)?.[1] || '';
    return slug.toLowerCase() === 'j' ? '' : slug;
  }
  if (provider === 'smartrecruiters') {
    return url.match(/^https:\/\/(?:careers|jobs)\.smartrecruiters\.com\/([^/?#]+)/i)?.[1] || '';
  }
  if (provider === 'gem') return url.match(/^https:\/\/jobs\.gem\.com\/([^/?#]+)/i)?.[1] || '';
  if (provider === 'paylocity') {
    return url.match(/^https:\/\/recruiting\.paylocity\.com\/recruiting\/jobs\/All\/([0-9a-f-]{36})(?:\/|$)/i)?.[1] || '';
  }
  if (provider === 'bamboohr') return url.match(/^https:\/\/([a-z0-9][a-z0-9-]*)\.bamboohr\.com(?:\/|$)/i)?.[1] || '';
  if (provider === 'recruitee') return url.match(/^https:\/\/([a-z0-9][a-z0-9-]*)\.recruitee\.com(?:\/|$)/i)?.[1] || '';
  if (provider === 'breezy') return url.match(/^https:\/\/([a-z0-9][a-z0-9-]*)\.breezy\.hr(?:\/|$)/i)?.[1] || '';
  if (provider === 'teamtailor') return url.match(/^https:\/\/([a-z0-9][a-z0-9-]*)\.teamtailor\.com(?:\/|$)/i)?.[1] || '';
  if (provider === 'personio') return url.match(/^https:\/\/([a-z0-9][a-z0-9-]*\.jobs\.personio\.(?:de|com))(?:\/|$)/i)?.[1] || '';
  if (provider === 'rippling') {
    const segments = safeIdentityUrl(url)?.pathname.split('/').filter(Boolean) || [];
    if (/^[a-z]{2}(?:-[a-z]{2})?$/i.test(segments[0] || '')) segments.shift();
    return /^[a-z0-9][a-z0-9-]*$/i.test(segments[0] || '') ? segments[0] : '';
  }
  if (provider === 'jobvite') {
    const segments = safeIdentityUrl(url)?.pathname.split('/').filter(Boolean) || [];
    const slug = segments[0]?.toLowerCase() === 'careers' ? segments[1] : segments[0];
    return /^[a-z0-9][a-z0-9-]*$/i.test(slug || '') ? slug : '';
  }
  if (provider === 'jibeapply') {
    const parsed = safeIdentityUrl(url);
    return parsed && /^\/api\/jobs\/?$/i.test(parsed.pathname) ? parsed.hostname.toLowerCase() : '';
  }
  if (provider === 'pinpoint') return url.match(/^https:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.pinpointhq\.com(?:\/|$)/i)?.[1] || '';
  if (provider === 'dayforce') {
    const parsed = safeIdentityUrl(url);
    if (!parsed || parsed.hostname.toLowerCase() !== 'jobs.dayforcehcm.com') return '';
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2 || !/^[a-z]{2}-[a-z]{2}$/i.test(parts[0])) return '';
    const namespace = parts[1];
    const site = parts[2] || 'CANDIDATEPORTAL';
    return [namespace, site].every(part => /^[a-z0-9][a-z0-9_-]*$/i.test(part))
      ? `${namespace}/${site}` : '';
  }
  if (provider === 'paycom') {
    return url.match(/^https:\/\/www\.paycomonline\.net\/v4\/ats\/web\.php\/portal\/([0-9a-f]{32})(?:\/|$)/i)?.[1]?.toUpperCase() || '';
  }
  if (provider === 'ukg') {
    const parsed = safeIdentityUrl(url);
    if (!parsed || !/^recruiting2?\.ultipro\.com$/i.test(parsed.hostname)) return '';
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts[1]?.toLowerCase() !== 'jobboard'
      || !/^[a-z0-9][a-z0-9_-]*$/i.test(parts[0] || '')
      || !/^[0-9a-f-]{36}$/i.test(parts[2] || '')) return '';
    return `${parsed.hostname.toLowerCase()}:${parts[0]}:${parts[2].toLowerCase()}`;
  }
  return '';
}

/** Convert a first-party ATS job/board URL into exact scanner coordinates. */
export function directAtsCandidateFromLeadUrl(value) {
  const parsed = safeIdentityUrl(value);
  if (!parsed || parsed.username || parsed.password || parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  let provider = '';
  if (/^(?:boards-api|boards|job-boards)(?:\.eu)?\.greenhouse\.io$/.test(host)) provider = 'greenhouse';
  else if (host === 'jobs.ashbyhq.com' || host === 'api.ashbyhq.com') provider = 'ashby';
  else if (host === 'jobs.lever.co' || host === 'api.lever.co') provider = 'lever';
  else if (/^[a-z0-9-]+\.wd[a-z0-9-]*\.myworkdayjobs\.com$/.test(host)) provider = 'workday';
  else if (/^[a-z0-9-]+\.icims\.com$/.test(host)) provider = 'icims';
  else if (host === 'apply.workable.com') provider = 'workable';
  else if (host === 'careers.smartrecruiters.com' || host === 'jobs.smartrecruiters.com') provider = 'smartrecruiters';
  else if (host === 'jobs.gem.com') provider = 'gem';
  else if (host === 'recruiting.paylocity.com') provider = 'paylocity';
  else if (/^[a-z0-9][a-z0-9-]*\.bamboohr\.com$/.test(host)) provider = 'bamboohr';
  else if (/^[a-z0-9][a-z0-9-]*\.recruitee\.com$/.test(host)) provider = 'recruitee';
  else if (/^[a-z0-9][a-z0-9-]*\.breezy\.hr$/.test(host)) provider = 'breezy';
  else if (/^[a-z0-9][a-z0-9-]*\.teamtailor\.com$/.test(host)) provider = 'teamtailor';
  else if (/^[a-z0-9][a-z0-9-]*\.jobs\.personio\.(?:de|com)$/.test(host)) provider = 'personio';
  else if (host === 'ats.rippling.com') provider = 'rippling';
  else if (host === 'jobs.jobvite.com') provider = 'jobvite';
  else if (/^\/api\/jobs\/?$/i.test(parsed.pathname)) provider = 'jibeapply';
  else if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.pinpointhq\.com$/.test(host)) provider = 'pinpoint';
  else if (host === 'jobs.dayforcehcm.com') provider = 'dayforce';
  else if (host === 'www.paycomonline.net') provider = 'paycom';
  else if (/^recruiting2?\.ultipro\.com$/.test(host)) provider = 'ukg';
  else return null;

  const identifier = identifierFromAtsUrl(provider, parsed.toString());
  if (!identifier) return null;
  let careersUrl = '';
  if (provider === 'greenhouse') careersUrl = `https://job-boards.greenhouse.io/${identifier}`;
  else if (provider === 'ashby') careersUrl = `https://jobs.ashbyhq.com/${identifier}`;
  else if (provider === 'lever') careersUrl = `https://jobs.lever.co/${identifier}`;
  else if (provider === 'workday') {
    const [tenant, instance, board] = identifier.split('|');
    careersUrl = `https://${tenant}.${instance}.myworkdayjobs.com/${board}`;
  } else if (provider === 'icims') careersUrl = `https://${identifier}.icims.com/jobs`;
  else if (provider === 'workable') careersUrl = `https://apply.workable.com/${identifier}`;
  else if (provider === 'smartrecruiters') careersUrl = `https://careers.smartrecruiters.com/${identifier}`;
  else if (provider === 'gem') careersUrl = `https://jobs.gem.com/${identifier}`;
  else if (provider === 'paylocity') careersUrl = `https://recruiting.paylocity.com/recruiting/jobs/All/${identifier.toLowerCase()}/`;
  else if (provider === 'bamboohr') careersUrl = `https://${identifier.toLowerCase()}.bamboohr.com/careers`;
  else if (provider === 'recruitee') careersUrl = `https://${identifier.toLowerCase()}.recruitee.com`;
  else if (provider === 'breezy') careersUrl = `https://${identifier.toLowerCase()}.breezy.hr`;
  else if (provider === 'teamtailor') careersUrl = `https://${identifier.toLowerCase()}.teamtailor.com/jobs`;
  else if (provider === 'personio') careersUrl = `https://${identifier.toLowerCase()}`;
  else if (provider === 'rippling') careersUrl = `https://ats.rippling.com/${identifier}/jobs`;
  else if (provider === 'jobvite') careersUrl = `https://jobs.jobvite.com/${identifier}`;
  else if (provider === 'jibeapply') careersUrl = `https://${identifier}`;
  else if (provider === 'pinpoint') careersUrl = `https://${identifier.toLowerCase()}.pinpointhq.com`;
  else if (provider === 'dayforce') careersUrl = `https://jobs.dayforcehcm.com/en-US/${identifier}`;
  else if (provider === 'paycom') careersUrl = `https://www.paycomonline.net/v4/ats/web.php/portal/${identifier}/career-page`;
  else if (provider === 'ukg') {
    const [hostName, tenant, board] = identifier.split(':');
    careersUrl = `https://${hostName}/${tenant}/JobBoard/${board}/`;
  }

  return {
    provider,
    identifier,
    careers_url: careersUrl,
    job_count: '1',
    match_status: 'candidate',
    verification: 'live',
    source: 'direct-job-url',
    ...(provider === 'jibeapply' ? { api: `https://${identifier}/api/jobs` } : {}),
  };
}

export function validateV2Review(review) {
  const errors = [];
  if (review?.verdict !== 'accept') errors.push('verdict must be accept');
  for (const field of [
    'source_brand', 'dol_legal_name', 'ats_provider', 'board_identifier',
    'board_owner', 'careers_url', 'reviewed_at', 'reason',
  ]) {
    if (!clean(review?.[field])) errors.push(`${field} is required`);
  }
  if (!httpsEvidence(review?.dol_evidence_urls)) errors.push('DOL identity evidence is required');
  if (!httpsEvidence(review?.official_evidence_urls)) errors.push('official ATS evidence is required');

  const provider = clean(review?.ats_provider).toLowerCase();
  if (!provider || provider === 'websearch') errors.push('a supported ATS provider is required');
  const scoped = SCOPED_PROVIDERS.has(provider);
  if (scoped && !safeIdentityUrl(review?.careers_url)) errors.push('careers URL must be a safe HTTPS URL');
  const expectedIdentifier = scoped ? review?.board_identifier : clean(review?.board_identifier).toLowerCase();
  const urlIdentifier = scoped ? scopedEntryIdentifier(provider, review)
    : identifierFromAtsUrl(provider, review?.careers_url).toLowerCase();
  if (OWNER_PROVIDERS.has(provider)
    || scoped
    || ['workday', 'icims', 'workable', 'smartrecruiters', 'gem'].includes(provider)) {
    if (!urlIdentifier || urlIdentifier !== expectedIdentifier) {
      errors.push('careers URL does not match provider and board identifier');
    }
  }

  const ownerIdentity = normalizeCompanyIdentity(review?.board_owner);
  const acceptedOwnerIdentities = new Set([
    review?.source_brand,
    review?.dol_legal_name,
    review?.dol_dba,
  ].map(normalizeCompanyIdentity).filter(Boolean));
  if (!ownerIdentity || !acceptedOwnerIdentities.has(ownerIdentity)) {
    errors.push('ATS board owner does not match the accepted brand or DOL identity');
  }

  return { accepted: errors.length === 0, errors };
}

export function isScannableAdmission(row) {
  return row?.status === 'accepted'
    && ['live', 'partial'].includes(row?.health_status)
    && ['owner_verified', 'reviewed_official_link'].includes(row?.identity_status)
    && Boolean(clean(row?.provider))
    && clean(row?.provider).toLowerCase() !== 'websearch'
    && Boolean(clean(row?.board_identifier))
    && Boolean(clean(row?.careers_url));
}

function reviewMatchesCandidate(review, dolMatch, candidate) {
  if (!validateV2Review(review).accepted) return false;
  const sourceIdentity = normalizeCompanyIdentity(dolMatch.preferred_name);
  const legalIdentity = normalizeCompanyIdentity(dolMatch.dol_legal_name);
  const reviewSource = normalizeCompanyIdentity(review.source_brand);
  const reviewLegal = normalizeCompanyIdentity(review.dol_legal_name);
  // Compare each schema's authoritative fields; unrelated aliases cannot
  // replace the coordinates already checked by validation and evaluation.
  const reviewKey = portalBoardKey({ provider: review.ats_provider, board_identifier: review.board_identifier });
  const candidateKey = portalBoardKey({ provider: candidate.provider, board_identifier: candidate.identifier });
  return reviewSource === sourceIdentity
    && reviewLegal === legalIdentity
    && Boolean(reviewKey) && reviewKey === candidateKey;
}

export function defaultFetchContext() {
  return {
    fetchJson: async (url, options = {}) => {
      const { maxBytes: _maxBytes, ...requestOptions } = options;
      return providerFetchJson(url, { ...requestOptions, timeoutMs: 15_000 });
    },
    fetchText: async (url, options = {}) => {
      const { maxBytes = 2_000_000, ...requestOptions } = options;
      return providerFetchTextHead(url, { ...requestOptions, maxBytes, timeoutMs: 15_000 });
    },
    fetchResponse: async (url, options = {}) => {
      const { maxBytes: _maxBytes, ...requestOptions } = options;
      return providerFetchResponse(url, { ...requestOptions, timeoutMs: 15_000 });
    },
  };
}

export async function evaluateAtsCandidate(dolMatch, candidate, {
  reviews = [],
  identityHolds = [],
  fetchContext = defaultFetchContext(),
} = {}) {
  if (dolMatch?.status !== 'dol_accepted') {
    throw new Error('ATS evaluation requires a DOL-accepted company');
  }
  const provider = clean(candidate?.provider).toLowerCase();
  const identifier = clean(candidate?.identifier);
  const careersUrl = clean(candidate?.careers_url)
    || (() => {
      try { return providerCoordinates(provider, identifier).careersUrl || ''; }
      catch { return ''; }
    })();
  const healthStatus = candidate?.verification === 'partial' || candidate?.partial === true
    ? 'partial'
    : candidate?.verification === 'live' ? 'live' : 'error';
  const base = {
    ...dolMatch,
    provider,
    board_identifier: identifier,
    careers_url: careersUrl,
    health_status: healthStatus,
    job_count: Number(candidate?.job_count ?? candidate?.jobCount ?? 0),
    ...(clean(candidate?.api) ? { api: clean(candidate.api) } : {}),
  };
  const hold = identityHolds.find(row => String(row.provider || '').toLowerCase() === provider
    && String(row.identifier || '').toLowerCase() === identifier.toLowerCase()
    && String(row.dol_legal_name || '').trim() === dolMatch.dol_legal_name);
  if (hold) return { ...base, status: 'identity_review', identity_status: 'known_identity_hold',
    reason: String(hold.reason || 'Known legal/board identity conflict'), evidence: JSON.stringify(hold) };
  if (!provider || !identifier || !careersUrl || healthStatus === 'error') {
    return {
      ...base,
      status: 'verification_error',
      identity_status: 'unverified',
      reason: clean(candidate?.error || 'ATS candidate is incomplete or not live'),
    };
  }
  if (SCOPED_PROVIDERS.has(provider)
    && (scopedEntryIdentifier(provider, candidate) !== candidate.identifier
      || !safeIdentityUrl(candidate.careers_url))) {
    return { ...base, status: 'verification_error', identity_status: 'unverified',
      reason: 'candidate URL does not match exact provider board coordinates' };
  }

  const reviewedIdentity = reviews.find(row => reviewMatchesCandidate(row, dolMatch, candidate));
  if (reviewedIdentity && provider === 'workday') {
    return {
      ...base,
      status: 'accepted',
      identity_status: 'reviewed_official_link',
      board_owner: clean(reviewedIdentity.board_owner),
      evidence: JSON.stringify({
        kind: 'reviewed-official-link',
        dol: reviewedIdentity.dol_evidence_urls,
        official: reviewedIdentity.official_evidence_urls,
      }),
      reason: reviewedIdentity.reason,
    };
  }

  if (OWNER_PROVIDERS.has(provider)) {
    const published = await fetchPublishedBoardOwner({
      vendor: provider,
      slug: identifier,
      careers_url: careersUrl,
    }, fetchContext);
    if (published.error || !published.owner) {
      return {
        ...base,
        status: 'verification_error',
        identity_status: 'owner_unreachable',
        board_owner: '',
        reason: clean(published.error || 'published ATS owner missing'),
      };
    }
    const names = [dolMatch.preferred_name, dolMatch.dol_dba, dolMatch.dol_legal_name].filter(Boolean);
    const ownerAccepted = names.some(name => (
      classifyPublishedOwner(name, published.owner).identity_status === 'owner_verified'
    ));
    return {
      ...base,
      status: ownerAccepted ? 'accepted' : 'identity_review',
      identity_status: ownerAccepted ? 'owner_verified' : 'review_required',
      board_owner: clean(published.owner),
      evidence: JSON.stringify({ kind: 'published-board-owner', owner: published.owner }),
      reason: ownerAccepted
        ? 'published ATS owner matches an accepted brand or DOL identity'
        : `published ATS owner mismatch: ${published.owner}`,
    };
  }

  const review = reviewedIdentity;
  return {
    ...base,
    status: review ? 'accepted' : 'identity_review',
    identity_status: review ? 'reviewed_official_link' : 'review_required',
    board_owner: clean(review?.board_owner),
    evidence: review ? JSON.stringify({
      kind: 'reviewed-official-link',
      dol: review.dol_evidence_urls,
      official: review.official_evidence_urls,
    }) : '',
    reason: review?.reason || 'provider requires an accepted v2 official-link review',
  };
}

export function portalBoardKey(row) {
  const provider = clean(row?.provider ?? row?.ats_provider).toLowerCase();
  if (SCOPED_PROVIDERS.has(provider)) {
    const identifier = row?.board_identifier ?? row?.identifier ?? scopedEntryIdentifier(provider, row);
    return scopedEntryFromIdentifier(provider, identifier) ? `${provider}\t${identifier}` : '';
  }
  const identifier = clean(
    row?.board_identifier
      ?? row?.identifier
      ?? row?.slug
      ?? identifierFromAtsUrl(provider, row?.careers_url ?? row?.api),
  ).toLowerCase();
  return provider && identifier ? `${provider}\t${identifier}` : '';
}

export function portalEntryBoardKey(entry) {
  let provider = clean(entry?.provider).toLowerCase();
  const source = clean(entry?.careers_url ?? entry?.api);
  if (!provider) {
    if (resolveTenant(entry)) provider = 'eightfold';
    else if (resolveSite(entry ?? {})) provider = 'oraclecloud';
    else if (/greenhouse\.io/i.test(source)) provider = 'greenhouse';
    else if (/ashbyhq\.com/i.test(source)) provider = 'ashby';
    else if (/lever\.co/i.test(source)) provider = 'lever';
    else if (/myworkdayjobs\.com/i.test(source)) provider = 'workday';
    else if (/icims\.com/i.test(source)) provider = 'icims';
    else if (/apply\.workable\.com/i.test(source)) provider = 'workable';
    else if (/(?:careers|jobs)\.smartrecruiters\.com/i.test(source)) provider = 'smartrecruiters';
    else if (/jobs\.gem\.com/i.test(source)) provider = 'gem';
    else if (/recruiting\.paylocity\.com/i.test(source)) provider = 'paylocity';
    else if (/\.bamboohr\.com/i.test(source)) provider = 'bamboohr';
    else if (/www\.paycomonline\.net\/v4\/ats\/web\.php\/portal\//i.test(source)) provider = 'paycom';
    else if (/recruiting2?\.ultipro\.com/i.test(source)) provider = 'ukg';
  }
  if (SCOPED_PROVIDERS.has(provider)) {
    return portalBoardKey({ provider, board_identifier: scopedEntryIdentifier(provider, entry) });
  }
  const identifier = identifierFromAtsUrl(provider, entry?.careers_url)
    || identifierFromAtsUrl(provider, entry?.api);
  return portalBoardKey({ provider, board_identifier: identifier });
}

export function portalEntryFromAdmission(row) {
  if (!isScannableAdmission(row)) throw new Error('record is not a scannable admission');
  const entry = {
    name: clean(row.preferred_name ?? row.source_company ?? row.dol_dba ?? row.dol_legal_name),
    careers_url: clean(row.careers_url),
    provider: clean(row.provider).toLowerCase(),
    enabled: true,
  };
  if (clean(row.api)) entry.api = clean(row.api);
  if (SCOPED_PROVIDERS.has(entry.provider)) {
    const coordinates = scopedEntryFromIdentifier(entry.provider, row.board_identifier);
    if (!coordinates) throw new Error('invalid scoped board identifier');
    return { ...entry, ...coordinates };
  }
  try {
    const coordinate = providerCoordinates(entry.provider, row.board_identifier);
    if (coordinate.api) entry.api = coordinate.api;
  } catch {
    // Reviewed providers outside the built-in coordinate helper can still be
    // represented by their validated careers URL and explicit provider.
  }
  return entry;
}

function checksum(content) {
  return createHash('sha256').update(content).digest('hex');
}

function readPortals(path) {
  if (!existsSync(path)) throw new Error(`portals file not found: ${path}`);
  const text = readFileSync(path, 'utf8');
  const doc = yaml.load(text) || {};
  if (!Array.isArray(doc.tracked_companies)) doc.tracked_companies = [];
  return { text, doc };
}

function mergeAdmissions(doc, admissions) {
  const known = new Set(doc.tracked_companies.map(portalEntryBoardKey).filter(Boolean));
  const additions = [];
  for (const row of admissions) {
    if (!isScannableAdmission(row)) continue;
    const key = portalBoardKey(row);
    if (!key || known.has(key)) continue;
    known.add(key);
    additions.push(portalEntryFromAdmission(row));
  }
  return {
    doc: { ...doc, tracked_companies: [...doc.tracked_companies, ...additions] },
    additions,
  };
}

async function defaultValidatePortals(stagedPath) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      join(CODE_ROOT, 'validate-portals.mjs'), '--file', stagedPath,
    ], { cwd: CODE_ROOT, maxBuffer: 10 * 1024 * 1024 });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    return {
      ok: false,
      error: clean(error?.stderr || error?.stdout || error?.message || error),
    };
  }
}

export async function commitPortalAdmissions(admissions, options = {}) {
  if (!Array.isArray(admissions)) throw new Error('admissions must be an array');
  return commitPortalMutation(doc => mergeAdmissions(doc, admissions), options);
}

/** Repair an exact, already-tracked entry without inflating the company count. */
export async function commitPortalRepairs(repairs, options = {}) {
  if (!Array.isArray(repairs)) throw new Error('repairs must be an array');
  for (const repair of repairs) {
    const row = repair.admission;
    if (!isScannableAdmission(row) || !row.dol_legal_name || !(Number(row.transfer_positions) > 0)) {
      throw new Error('Repair requires a DOL-positive, identity-verified live ATS admission');
    }
    if (!/^https:\/\//.test(repair.official_evidence_url || '')) throw new Error('Repair requires official evidence URL');
  }
  const result = await commitPortalMutation(doc => {
    const entries = doc.tracked_companies.map(entry => ({ ...entry }));
    const changed = [];
    for (const repair of repairs) {
      const matches = entries.filter(entry => entry.name === repair.target_name);
      if (matches.length !== 1) throw new Error(`Repair requires one exact target: ${repair.target_name}`);
      const entry = matches[0];
      const replacement = portalEntryFromAdmission(repair.admission);
      const desiredKey = portalEntryBoardKey(replacement);
      if (portalEntryBoardKey(entry) === desiredKey && entry.provider === replacement.provider) continue;
      if (entry.careers_url !== repair.expected_careers_url) throw new Error(`Repair target changed: ${repair.target_name}`);
      if (entries.some(other => other !== entry && portalEntryBoardKey(other) === desiredKey)) {
        throw new Error(`Repair board already tracked under another entry: ${desiredKey}`);
      }
      delete entry.api; delete entry.scan_method; delete entry.scan_query;
      if (SCOPED_PROVIDERS.has(replacement.provider)) {
        delete entry.domain; delete entry.siteNumber; delete entry.locationId;
      }
      Object.assign(entry, replacement, { name: repair.target_name });
      changed.push(entry);
    }
    return { doc: { ...doc, tracked_companies: entries }, additions: changed };
  }, options);
  return { updated: result.added, entries: result.entries, retries: result.retries };
}

async function commitPortalMutation(transform, {
  dataRoot,
  validate = defaultValidatePortals,
  lockOptions,
  maxCasRetries = 5,
} = {}) {
  const paths = statePaths(dataRoot);

  for (let attempt = 0; attempt < maxCasRetries; attempt += 1) {
    const base = readPortals(paths.portals);
    const merged = transform(base.doc);
    if (!merged.additions.length) return { added: 0, entries: [], retries: attempt };

    const stagedPath = join(dirname(paths.portals), `.portals-stage-${process.pid}-${randomUUID()}.yml`);
    writeFileSync(stagedPath, yaml.dump(merged.doc, {
      noRefs: true,
      lineWidth: -1,
      sortKeys: false,
    }), 'utf8');

    try {
      const validation = await validate(stagedPath);
      if (validation !== true && validation?.ok !== true) {
        throw new Error(validation?.error || 'staged portals validation failed');
      }

      const lock = await acquirePipelineLock(paths.companyStateLock, lockOptions);
      try {
        const live = readPortals(paths.portals);
        if (checksum(live.text) !== checksum(base.text)) continue;
        renameSync(stagedPath, paths.portals);
        return { added: merged.additions.length, entries: merged.additions, retries: attempt };
      } finally {
        lock.release();
      }
    } finally {
      try { unlinkSync(stagedPath); } catch { /* renamed or already removed */ }
    }
  }

  throw new Error(`portals.yml changed during ${maxCasRetries} consecutive CAS attempts`);
}

export function loadTsv(path) {
  return parseQuotedTsv(readFileSync(path, 'utf8'));
}

export function loadDolEvidence(config, dataRoot = getCareerOpsRoot()) {
  const file = resolve(dataRoot, config.dol_employers);
  let manifest;
  if (config.dol_manifest) {
    const manifestFile = resolve(dataRoot, config.dol_manifest);
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const quarters = manifest.window?.fiscal_quarters;
    if (manifest.schema_version !== 2 || manifest.coverage?.complete !== true
      || !Array.isArray(quarters) || new Set(quarters).size !== 8
      || !quarters.every(q => manifest.coverage.observed_fiscal_quarters?.includes(q)
        && manifest.coverage.declared_fiscal_quarters?.includes(q))) {
      throw new Error('Validated complete eight-quarter DOL evidence required');
    }
    if (!manifest.outputs?.employers || resolve(dirname(manifestFile), manifest.outputs.employers) !== file) {
      throw new Error('DOL configuration does not match the manifest declared index');
    }
  }
  const content = readFileSync(file, 'utf8');
  if (config.dol_employers_sha256 && checksum(content) !== config.dol_employers_sha256) throw new Error('DOL index checksum mismatch');
  const rows = parseQuotedTsv(content);
  if (manifest && rows.length !== manifest.counts?.employers) throw new Error('DOL index row count differs from manifest');
  return rows;
}

export function findAtsCandidatesForDol(dolMatch, candidates) {
  if (dolMatch?.status !== 'dol_accepted') return [];
  const legal = normalizeCompanyIdentity(dolMatch.dol_legal_name);
  const dba = normalizeCompanyIdentity(dolMatch.dol_dba);
  return (candidates || []).filter(row => {
    const employer = normalizeCompanyIdentity(row.employer_name ?? row.employerName);
    const candidateDba = normalizeCompanyIdentity(row.dba);
    return (employer === legal || (dba && candidateDba === dba))
      && (row.match_status ?? row.status) === 'candidate'
      && ['live', 'partial'].includes(row.verification);
  });
}

function reviewedCandidatesForDol(dolMatch, reviews) {
  if (dolMatch?.status !== 'dol_accepted') return [];
  return (reviews || []).filter(review => {
    if (!validateV2Review(review).accepted) return false;
    return normalizeCompanyIdentity(review.source_brand) === normalizeCompanyIdentity(dolMatch.preferred_name)
      && normalizeCompanyIdentity(review.dol_legal_name) === normalizeCompanyIdentity(dolMatch.dol_legal_name)
      && normalizeCompanyIdentity(review.dol_dba) === normalizeCompanyIdentity(dolMatch.dol_dba);
  }).map(review => ({
    employer_name: dolMatch.dol_legal_name,
    dba: dolMatch.dol_dba,
    provider: clean(review.ats_provider).toLowerCase(),
    identifier: clean(review.board_identifier),
    careers_url: clean(review.careers_url),
    ...(SCOPED_PROVIDERS.has(clean(review.ats_provider).toLowerCase()) ? {
      api: review.api, domain: review.domain, siteNumber: review.siteNumber, locationId: review.locationId,
    } : {}),
    job_count: '0',
    match_status: 'candidate',
    verification: 'live',
    reviewed: true,
  }));
}

function aggregateLeadCompanies(leads, scope) {
  const groups = new Map();
  for (const lead of leads || []) {
    if (lead.scope !== scope) continue;
    const identity = clean(lead.normalized_source_company)
      || normalizeCompanyIdentity(lead.source_company);
    if (!identity) continue;
    const discovered = clean(lead.discovered_at);
    const current = groups.get(identity) || {
      normalized_lead: identity,
      preferred_name: clean(lead.source_company),
      first_seen: discovered,
      last_seen: discovered,
      source_count: 0,
      evidenceUrls: new Set(),
      directCandidates: new Map(),
    };
    current.source_count += 1;
    if (discovered && (!current.first_seen || discovered < current.first_seen)) current.first_seen = discovered;
    if (discovered && (!current.last_seen || discovered > current.last_seen)) {
      current.last_seen = discovered;
      current.preferred_name = clean(lead.source_company) || current.preferred_name;
    }
    if (lead.job_url) {
      current.evidenceUrls.add(lead.job_url);
      const candidate = directAtsCandidateFromLeadUrl(lead.job_url);
      const key = candidate && portalBoardKey({
        provider: candidate.provider,
        board_identifier: candidate.identifier,
      });
      if (key && !current.directCandidates.has(key)) current.directCandidates.set(key, candidate);
    }
    groups.set(identity, current);
  }
  return [...groups.values()].map(group => ({
    ...group,
    evidence: JSON.stringify([...group.evidenceUrls].sort()),
    directCandidates: [...group.directCandidates.values()],
    evidenceUrls: undefined,
  }));
}

function portalNameIdentities(portals) {
  return new Set((portals?.tracked_companies || [])
    .map(entry => normalizeCompanyIdentity(entry.name))
    .filter(Boolean));
}

function trackedEvidenceKey(value) {
  const raw = clean(value);
  if (!raw) return '';
  for (const provider of ['greenhouse', 'ashby', 'lever', 'workday', 'icims']) {
    const identifier = identifierFromAtsUrl(provider, raw);
    if (identifier) return `${provider}\t${identifier.toLowerCase()}`;
  }
  try {
    const url = new URL(raw);
    url.hash = '';
    url.search = '';
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return raw.replace(/\/+$/, '').toLowerCase();
  }
}

function acceptedTrackedLegacyAliases(portals, reviews) {
  const tracked = new Set();
  for (const entry of portals?.tracked_companies || []) {
    for (const value of [entry.careers_url, entry.api]) {
      const key = trackedEvidenceKey(value);
      if (key) tracked.add(key);
    }
  }
  return new Set((reviews || [])
    .filter(review => review?.verdict === 'accept')
    .filter(review => tracked.has(trackedEvidenceKey(review.careers_url)))
    .map(review => normalizeCompanyIdentity(review.identity))
    .filter(Boolean));
}

function preserveBackfill(accepted, previous, now, backfillDays) {
  if (previous?.status === 'accepted'
    && portalBoardKey(previous) === portalBoardKey(accepted)
    && previous.backfill_status) {
    return {
      ...accepted,
      backfill_status: previous.backfill_status,
      backfill_window_start: previous.backfill_window_start,
      backfill_window_end: previous.backfill_window_end,
      backfill_attempted_at: previous.backfill_attempted_at,
      backfill_completed_at: previous.backfill_completed_at,
      backfill_error: previous.backfill_error,
    };
  }
  const anchored = startBackfill(accepted, now, backfillDays);
  return {
    ...anchored,
    backfill_status: 'pending',
    backfill_attempted_at: '',
  };
}

export async function resolveCompanyLeads({
  leads,
  scope,
  employers,
  candidates,
  portals,
  reviews = [],
  identityHolds = [],
  legacyReviews = [],
  currentState = [],
  now = new Date(),
  backfillDays = 20,
  unresolvedDays = 7,
  transientMinutes = 180,
  forceRetry = false,
  concurrency = 6,
  evaluateCandidate = evaluateAtsCandidate,
} = {}) {
  if (!['nyc', 'remote'].includes(scope)) throw new Error('scope must be nyc or remote');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) {
    throw new Error('concurrency must be an integer from 1 to 20');
  }
  if (concurrency > 1) {
    const grouped = new Map();
    for (const lead of leads || []) {
      if (lead.scope !== scope) continue;
      const identity = clean(lead.normalized_source_company)
        || normalizeCompanyIdentity(lead.source_company);
      if (!identity) continue;
      if (!grouped.has(identity)) grouped.set(identity, []);
      grouped.get(identity).push(lead);
    }
    const batches = [...grouped.values()];
    const resolved = new Array(batches.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length || 1) }, async () => {
      while (cursor < batches.length) {
        const index = cursor++;
        resolved[index] = await resolveCompanyLeads({
          leads: batches[index], scope, employers, candidates, portals, reviews, identityHolds,
          legacyReviews, currentState, now, backfillDays, unresolvedDays, transientMinutes,
          forceRetry, concurrency: 1, evaluateCandidate,
        });
      }
    }));
    return resolved.flat().sort((left, right) => left.normalized_lead.localeCompare(right.normalized_lead));
  }
  const trackedNames = portalNameIdentities(portals);
  const trackedLegacyAliases = acceptedTrackedLegacyAliases(portals, legacyReviews);
  const trackedBoards = new Set((portals?.tracked_companies || [])
    .map(portalEntryBoardKey).filter(Boolean));
  const previousByIdentity = new Map();
  for (const row of currentState || []) {
    if (!previousByIdentity.has(row.normalized_lead)) previousByIdentity.set(row.normalized_lead, []);
    previousByIdentity.get(row.normalized_lead).push(row);
  }
  const results = [];

  for (const aggregatedGroup of aggregateLeadCompanies(leads, scope)) {
    const { directCandidates = [], ...group } = aggregatedGroup;
    const previousRows = previousByIdentity.get(group.normalized_lead) || [];
    const previous = previousRows.find(row => !portalBoardKey(row));
    const hasNewEvidence = !previous?.last_seen || group.last_seen > previous.last_seen;
    if (!forceRetry && previous && !hasNewEvidence && !retryIsDue(previous, now)) {
      results.push(previous);
      continue;
    }
    const base = {
      ...group,
      last_attempt_at: new Date(now).toISOString(),
      backfill_status: 'not_applicable',
    };
    const retained = previousRows.filter(row => row.status === 'accepted' && trackedBoards.has(portalBoardKey(row)));
    for (const row of retained) {
      results.push({
        ...row,
        preferred_name: group.preferred_name,
        first_seen: row.first_seen || group.first_seen,
        last_seen: group.last_seen,
        source_count: group.source_count,
        evidence: row.evidence || group.evidence,
      });
    }

    const dol = joinLeadToDol({ source_company: group.preferred_name }, employers);
    if (dol.status === 'dol_accepted') {
      for (const row of results.filter(item => item.normalized_lead === group.normalized_lead
        && retained.some(previous => portalBoardKey(previous) === portalBoardKey(item)))) {
        if (String(row.dol_legal_name || '').trim() !== dol.dol_legal_name
          || String(row.dol_dba || '').trim() !== dol.dol_dba) continue;
        for (const field of ['dol_evidence_tier', 'dol_evidence_periods', 'dol_evidence_window', 'dol_latest_decision_date']) {
          row[field] = dol[field];
        }
      }
    }
    if (dol.status !== 'dol_accepted') {
      if (retained.length) continue;
      if (trackedNames.has(group.normalized_lead) || trackedLegacyAliases.has(group.normalized_lead)) {
        results.push({ ...base, status: 'already_tracked', reason: 'company name is already tracked; no new board admitted' });
        continue;
      }
      results.push({
        ...base,
        ...dol,
        normalized_lead: group.normalized_lead,
        preferred_name: group.preferred_name,
        first_seen: group.first_seen,
        last_seen: group.last_seen,
        source_count: group.source_count,
        evidence: group.evidence,
        next_retry_at: dol.status === 'dol_ambiguous'
          ? nextRetryAt(now, { days: unresolvedDays })
          : '',
      });
      continue;
    }

    const dolCoveredByLegacyBoard = [dol.dol_legal_name, dol.dol_dba]
      .map(normalizeCompanyIdentity)
      .some(identity => identity && trackedLegacyAliases.has(identity));
    const matchedCandidates = [];
    const seenCandidateBoards = new Set();
    for (const candidate of [
      ...directCandidates,
      ...findAtsCandidatesForDol(dol, candidates),
      ...reviewedCandidatesForDol(dol, reviews),
    ]) {
      const key = portalBoardKey({
        provider: candidate.provider,
        board_identifier: candidate.identifier,
      });
      if (!key || seenCandidateBoards.has(key)) continue;
      seenCandidateBoards.add(key);
      matchedCandidates.push(candidate);
    }
    matchedCandidates.sort((left, right) => Number(right.job_count || 0) - Number(left.job_count || 0));
    if (!matchedCandidates.length) {
      if (retained.length) continue;
      const alreadyTracked = dolCoveredByLegacyBoard || trackedNames.has(group.normalized_lead)
        || trackedLegacyAliases.has(group.normalized_lead);
      results.push({
        ...base,
        ...dol,
        normalized_lead: group.normalized_lead,
        preferred_name: group.preferred_name,
        status: alreadyTracked ? 'already_tracked' : 'ats_unresolved',
        next_retry_at: nextRetryAt(now, { days: unresolvedDays }),
        reason: alreadyTracked ? 'company is already tracked; no new candidate board found'
          : 'no live exact public ATS candidate; bounded Google resolution is required',
      });
      continue;
    }

    for (const candidate of matchedCandidates) {
      const key = portalBoardKey({ provider: candidate.provider, board_identifier: candidate.identifier });
      if (retained.some(row => portalBoardKey(row) === key)) continue;
      const priorBoard = previousRows.find(row => portalBoardKey(row) === key);
      if (trackedBoards.has(key)) {
        results.push({ ...base, ...dol, status: 'already_tracked', provider: candidate.provider,
          board_identifier: candidate.identifier, careers_url: candidate.careers_url,
          reason: 'exact ATS board is already tracked; other boards are evaluated independently' });
        continue;
      }
      if (!forceRetry && priorBoard && group.last_seen <= priorBoard.last_seen && !retryIsDue(priorBoard, now)) {
        results.push(priorBoard);
        continue;
      }
      const evaluated = await evaluateCandidate(dol, candidate, { reviews, identityHolds });
      const resolved = {
        ...base,
        ...evaluated,
        provider: evaluated.provider || candidate.provider,
        board_identifier: evaluated.board_identifier || candidate.identifier,
        careers_url: evaluated.careers_url || candidate.careers_url,
        normalized_lead: group.normalized_lead,
        preferred_name: group.preferred_name,
        first_seen: group.first_seen,
        last_seen: group.last_seen,
        source_count: group.source_count,
        evidence: evaluated.evidence || group.evidence,
        next_retry_at: isScannableAdmission(evaluated) ? '' : nextRetryAt(now,
          evaluated.status === 'verification_error' ? { minutes: transientMinutes } : { days: unresolvedDays }),
      };
      results.push(isScannableAdmission(evaluated) ? preserveBackfill(resolved, priorBoard, now, backfillDays) : resolved);
    }
  }

  return results.sort((left, right) => left.normalized_lead.localeCompare(right.normalized_lead));
}

function readYaml(path) {
  return yaml.load(readFileSync(path, 'utf8')) || {};
}

function dataPath(dataRoot, value) {
  return resolve(dataRoot, clean(value));
}

function statusCounts(rows) {
  const counts = {};
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
  return counts;
}

export function writeJsonReceipt(paths, prefix, body, now = new Date()) {
  mkdirSync(paths.receipts, { recursive: true });
  const timestamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const path = join(paths.receipts, `${prefix}-${timestamp}-${randomUUID().slice(0, 8)}.json`);
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return path;
}

function writeReviewQueue(paths, scope, rows, now = new Date()) {
  const reviewRows = rows.filter(row => ['dol_ambiguous', 'identity_review'].includes(row.status));
  if (!reviewRows.length) return '';
  const day = new Date(now).toISOString().slice(0, 10);
  const path = join(paths.root, `profiles/sunny-company-review-queue-${scope}-${day}.yml`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yaml.dump({
    schema_version: 1,
    generated_at: new Date(now).toISOString(),
    scope,
    reviews: reviewRows.map(row => ({
      source_brand: row.preferred_name,
      status: row.status,
      dol_legal_name: row.dol_legal_name || '',
      dol_dba: row.dol_dba || '',
      ats_provider: row.provider || '',
      board_identifier: row.board_identifier || '',
      board_owner: row.board_owner || '',
      careers_url: row.careers_url || '',
      evidence: row.evidence || '',
      reason: row.reason || '',
    })),
  }, { noRefs: true, lineWidth: -1 }), 'utf8');
  return path;
}

export async function runResolution({
  dataRoot = getCareerOpsRoot(),
  scope,
  mode = 'incremental',
  write = false,
  now = new Date(),
} = {}) {
  if (!['nyc', 'remote'].includes(scope)) throw new Error('scope must be nyc or remote');
  if (!['backfill', 'incremental'].includes(mode)) throw new Error('mode must be backfill or incremental');
  const paths = statePaths(dataRoot);
  const config = readYaml(paths.config);
  const employers = loadDolEvidence(config, dataRoot);
  const candidates = loadTsv(dataPath(dataRoot, config.ats_candidates));
  const reviewsDoc = existsSync(paths.reviewsV2) ? readYaml(paths.reviewsV2) : { reviews: [] };
  const legacyReviewsDoc = existsSync(paths.legacyReviews)
    ? readYaml(paths.legacyReviews)
    : { reviews: [] };
  if (Number(reviewsDoc.schema_version) !== 2 || !Array.isArray(reviewsDoc.reviews)) {
    throw new Error('v2 identity review file must have schema_version: 2 and reviews: []');
  }
  const portals = readYaml(paths.portals);
  const leads = readLeadRows({ dataRoot });
  const currentState = readResolutionRows({ dataRoot });
  const rows = await resolveCompanyLeads({
    leads,
    scope,
    employers,
    candidates,
    identityHolds: config.ats_identity_holds || [],
    portals,
    reviews: reviewsDoc.reviews,
    legacyReviews: Array.isArray(legacyReviewsDoc.reviews) ? legacyReviewsDoc.reviews : [],
    currentState,
    now,
    backfillDays: Number(config.scan?.backfill_days || 20),
    unresolvedDays: Number(config.retry?.unresolved_days || 7),
    transientMinutes: Number(config.retry?.transient_minutes || 180),
    concurrency: Number(config.resolution_concurrency || 6),
    forceRetry: mode === 'backfill',
  });

  await updateResolutionRows(rows, { dataRoot });
  let portalResult = { added: 0, entries: [] };
  if (write) {
    try {
      portalResult = await commitPortalAdmissions(rows.filter(isScannableAdmission), { dataRoot });
    } catch (error) {
      await recordPortalCommitFailure(rows, error, { dataRoot, now,
        transientMinutes: Number(config.retry?.transient_minutes || 180) });
      throw error;
    }
  }

  const reviewQueue = writeReviewQueue(paths, scope, rows, now);
  const body = {
    schema_version: 1,
    command: 'resolve',
    scope,
    mode,
    dry_run: !write,
    lead_rows_in_scope: leads.filter(row => row.scope === scope).length,
    companies_resolved: new Set(rows.map(row => row.normalized_lead)).size,
    board_resolution_rows: rows.length,
    outcomes: statusCounts(rows),
    portal_additions: portalResult.added,
    review_queue: reviewQueue,
    completed_at: new Date(now).toISOString(),
  };
  const receiptPath = writeJsonReceipt(paths, `company-${scope}-${mode}`, body, now);
  return { ...body, receipt_path: receiptPath };
}

export async function recordPortalCommitFailure(admissions, error, {
  dataRoot = getCareerOpsRoot(), now = new Date(), transientMinutes = 180,
} = {}) {
  return updateResolutionRows(current => {
    // Re-read under the same company-state lock used by portal CAS writes.
    // Another resolver may have committed some of our snapshot's candidates.
    const live = readPortals(statePaths(dataRoot).portals).doc;
    const tracked = new Set(live.tracked_companies.map(portalEntryBoardKey).filter(Boolean));
    const failedKeys = new Set(admissions.filter(isScannableAdmission)
      .filter(row => !tracked.has(portalBoardKey(row))).map(resolutionRowKey));
    return current.map(row => failedKeys.has(resolutionRowKey(row)) ? {
      ...row, status: 'verification_error', backfill_status: 'retry_error',
      backfill_error: `portal commit failed: ${clean(error?.message || error)}`,
      next_retry_at: nextRetryAt(now, { minutes: transientMinutes }),
    } : row);
  }, { dataRoot });
}

export function isInsidePreNoonGuard(now = new Date(), guardMinutes = 30) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const minuteOfDay = Number(values.hour) * 60 + Number(values.minute);
  return minuteOfDay >= 12 * 60 - Number(guardMinutes) && minuteOfDay < 12 * 60;
}

export async function runPendingBackfills({
  dataRoot = getCareerOpsRoot(),
  now = new Date(),
  ignoreGuard = false,
  scan,
} = {}) {
  const paths = statePaths(dataRoot);
  const config = readYaml(paths.config);
  const guardMinutes = Number(config.scan?.pre_noon_guard_minutes || 30);
  if (!ignoreGuard && isInsidePreNoonGuard(now, guardMinutes)) {
    return { started: 0, complete: 0, partial: 0, error: 0, deferred_pre_noon: true };
  }
  const attempted = new Set();
  const totals = { started: 0, complete: 0, partial: 0, error: 0, deferred_pre_noon: false };
  const { runSerializedScan } = await import('./run-sunny-serialized-scan.mjs');
  const scanner = scan || runSerializedScan;

  for (;;) {
    let claimed = null;
    let claimedKeys = new Set();
    await updateResolutionRows(current => {
      // New aliases may arrive after another worker claimed/completed this board.
      // Reuse a completed superset window; never queue behind an in-flight twin.
      const settled = current.map(row => {
        if (row.status !== 'accepted' || !['pending', 'retry_error', 'retry_partial'].includes(row.backfill_status)) return row;
        const anchored = startBackfill(row, now, Number(config.scan?.backfill_days || 20));
        const complete = current.find(other => other.backfill_status === 'complete'
          && portalBoardKey(other) === portalBoardKey(row)
          && other.backfill_window_start <= anchored.backfill_window_start
          && other.backfill_window_end >= anchored.backfill_window_end);
        return complete ? { ...finishBackfill(anchored, { status: 'complete' }, complete.backfill_completed_at),
          backfill_attempted_at: complete.backfill_attempted_at } : row;
      });
      const runningBoards = new Set(settled.filter(row => row.backfill_status === 'running').map(portalBoardKey));
      const eligible = row => row.status === 'accepted' && !!portalBoardKey(row)
        && ['pending', 'retry_error', 'retry_partial'].includes(row.backfill_status)
        && !runningBoards.has(portalBoardKey(row))
        && !attempted.has(portalBoardKey(row));
      const first = settled.find(eligible);
      if (!first) return settled;
      const running = settled.filter(row => eligible(row) && portalBoardKey(row) === portalBoardKey(first))
        .map(row => startBackfill(row, now, Number(config.scan?.backfill_days || 20)));
      claimedKeys = new Set(running.map(resolutionRowKey));
      claimed = { ...running[0], backfill_window_start: running.map(row => row.backfill_window_start).sort()[0],
        backfill_window_end: running.map(row => row.backfill_window_end).sort().at(-1) };
      const byKey = new Map(running.map(row => [resolutionRowKey(row), row]));
      return settled.map(row => byKey.get(resolutionRowKey(row)) || row);
    }, { dataRoot });
    if (!claimed) break;
    attempted.add(portalBoardKey(claimed));
    totals.started += 1;

    let scanResult;
    try {
      scanResult = await scanner({
        kind: 'backfill',
        dataRoot,
        provider: claimed.provider,
        boardIdentifier: claimed.board_identifier,
        postedAfter: claimed.backfill_window_start,
        postedBefore: claimed.backfill_window_end,
      });
    } catch (error) {
      scanResult = { completion_status: 'error', error: clean(error?.message || error) };
    }
    const completion = scanResult.completion_status || 'error';
    totals[completion] += 1;
    await updateResolutionRows(current => current.map(row => (
      claimedKeys.has(resolutionRowKey(row)) && row.backfill_status === 'running'
        ? finishBackfill(row, {
          status: completion,
          error: scanResult.error || scanResult.warnings?.join('; ') || '',
        })
        : row
    )), { dataRoot });
  }
  return totals;
}

async function runIngestCommand(args, dataRoot = getCareerOpsRoot()) {
  const inputPath = resolve(args.input);
  const payload = JSON.parse(readFileSync(inputPath, 'utf8'));
  const rows = Array.isArray(payload) ? payload : payload.jobs || payload.results;
  if (!Array.isArray(rows)) throw new Error('ingest JSON must be an array or contain jobs/results array');
  const runId = clean(payload.run_id) || `${args.source}-${args.scope}-${new Date().toISOString()}`;
  const result = await ingestLeadRows(rows, {
    dataRoot,
    source: args.source,
    scope: args.scope,
    runId,
  });
  const paths = statePaths(dataRoot);
  const receipt = {
    schema_version: 1,
    command: 'ingest',
    source: args.source,
    scope: args.scope,
    input: inputPath,
    ...result,
  };
  return { ...receipt, receipt_path: writeJsonReceipt(paths, `ingest-${args.source}-${args.scope}`, receipt) };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  let result;
  if (args.command === 'ingest') result = await runIngestCommand(args);
  else if (args.command === 'backfill') result = await runPendingBackfills();
  else result = await runResolution({
    scope: args.scope,
    mode: args.mode || 'incremental',
    write: args.write,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
