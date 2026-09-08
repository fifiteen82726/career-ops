#!/usr/bin/env node

/**
 * Identity-safe company admission for Sunny's H-1B job-search universe.
 * Source postings are leads only; this module admits scanner coordinates only
 * after a current DOL transfer match and a supported, identity-safe ATS match.
 */

import {
  existsSync,
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
import { normalizeCompanyIdentity, providerCoordinates } from './build-sunny-h1b-ats-universe.mjs';
import {
  classifyPublishedOwner,
  fetchPublishedBoardOwner,
} from './sunny-ats-identity-gate.mjs';
import { statePaths } from './sunny-company-state.mjs';

const execFileAsync = promisify(execFile);
const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OWNER_PROVIDERS = new Set(['greenhouse', 'ashby', 'lever']);

function clean(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function employerRecord(row) {
  return {
    legal: clean(row.EMPLOYER_NAME ?? row.employer_name ?? row.employerName),
    dba: clean(row.DBA ?? row.dba),
    transfer: Number(row.transfer_positions ?? row.transferPositions ?? 0),
    nyTransfer: Number(row.ny_transfer_positions ?? row.nyTransferPositions ?? 0),
  };
}

export function joinLeadToDol(lead, employers) {
  const source = clean(lead?.source_company ?? lead?.company ?? lead?.preferred_name);
  const identity = normalizeCompanyIdentity(source);
  if (!identity) return { status: 'dol_rejected', reason: 'missing source company identity' };
  if (/^meta(?:platforms)?$/.test(identity)) {
    return { status: 'dol_rejected', reason: 'Meta is explicitly excluded by Sunny policy' };
  }

  const grouped = new Map();
  for (const raw of employers || []) {
    const row = employerRecord(raw);
    if (!row.legal || row.transfer <= 0) continue;
    const legalIdentity = normalizeCompanyIdentity(row.legal);
    const dbaIdentity = normalizeCompanyIdentity(row.dba);
    if (identity !== legalIdentity && identity !== dbaIdentity) continue;
    const key = `${legalIdentity}|${dbaIdentity}`;
    const previous = grouped.get(key);
    grouped.set(key, previous ? {
      ...previous,
      transfer: previous.transfer + row.transfer,
      nyTransfer: previous.nyTransfer + row.nyTransfer,
    } : { ...row, legalIdentity, dbaIdentity });
  }

  const matches = [...grouped.values()];
  if (!matches.length) {
    return {
      status: 'dol_rejected',
      normalized_lead: identity,
      preferred_name: source,
      reason: 'no collision-free exact FY2026 Q3 CHANGE_EMPLOYER match',
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

export function identifierFromAtsUrl(provider, value) {
  const url = clean(value);
  if (provider === 'greenhouse') {
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
  return '';
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
  const expectedIdentifier = clean(review?.board_identifier).toLowerCase();
  const urlIdentifier = identifierFromAtsUrl(provider, review?.careers_url).toLowerCase();
  if (OWNER_PROVIDERS.has(provider) || ['workday', 'icims'].includes(provider)) {
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
  return reviewSource === sourceIdentity
    && reviewLegal === legalIdentity
    && clean(review.ats_provider).toLowerCase() === clean(candidate.provider).toLowerCase()
    && clean(review.board_identifier).toLowerCase() === clean(candidate.identifier).toLowerCase();
}

function defaultFetchContext() {
  const request = async (url, options = {}) => {
    const response = await fetch(url, {
      redirect: options.redirect || 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  };
  return {
    fetchJson: async (url, options) => (await request(url, options)).json(),
    fetchText: async (url, options) => (await request(url, options)).text(),
  };
}

export async function evaluateAtsCandidate(dolMatch, candidate, {
  reviews = [],
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
  };
  if (!provider || !identifier || !careersUrl || healthStatus === 'error') {
    return {
      ...base,
      status: 'verification_error',
      identity_status: 'unverified',
      reason: clean(candidate?.error || 'ATS candidate is incomplete or not live'),
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

  const review = reviews.find(row => reviewMatchesCandidate(row, dolMatch, candidate));
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
    if (/greenhouse\.io/i.test(source)) provider = 'greenhouse';
    else if (/ashbyhq\.com/i.test(source)) provider = 'ashby';
    else if (/lever\.co/i.test(source)) provider = 'lever';
    else if (/myworkdayjobs\.com/i.test(source)) provider = 'workday';
    else if (/icims\.com/i.test(source)) provider = 'icims';
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

export async function commitPortalAdmissions(admissions, {
  dataRoot,
  validate = defaultValidatePortals,
  lockOptions,
  maxCasRetries = 5,
} = {}) {
  if (!Array.isArray(admissions)) throw new Error('admissions must be an array');
  const paths = statePaths(dataRoot);

  for (let attempt = 0; attempt < maxCasRetries; attempt += 1) {
    const base = readPortals(paths.portals);
    const merged = mergeAdmissions(base.doc, admissions);
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
  const lines = readFileSync(path, 'utf8').trimEnd().split(/\r?\n/);
  const header = lines.shift()?.split('\t') || [];
  return lines.filter(Boolean).map(line => {
    const values = line.split('\t');
    return Object.fromEntries(header.map((column, index) => [column, values[index] ?? '']));
  });
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
