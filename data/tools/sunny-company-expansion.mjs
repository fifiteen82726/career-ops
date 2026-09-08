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
import { normalizeCompanyIdentity, providerCoordinates } from './build-sunny-h1b-ats-universe.mjs';
import { ingestLeadRows, readLeadRows } from './sunny-company-leads.mjs';
import {
  classifyPublishedOwner,
  fetchPublishedBoardOwner,
} from './sunny-ats-identity-gate.mjs';
import {
  nextRetryAt,
  finishBackfill,
  readResolutionRows,
  retryIsDue,
  startBackfill,
  statePaths,
  updateResolutionRows,
} from './sunny-company-state.mjs';

const execFileAsync = promisify(execFile);
const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OWNER_PROVIDERS = new Set(['greenhouse', 'ashby', 'lever']);

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
    if (!['indeed', 'linkedin', 'builtin'].includes(source)) {
      throw new Error('--source must be indeed, linkedin, or builtin');
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
    };
    current.source_count += 1;
    if (discovered && (!current.first_seen || discovered < current.first_seen)) current.first_seen = discovered;
    if (discovered && (!current.last_seen || discovered > current.last_seen)) {
      current.last_seen = discovered;
      current.preferred_name = clean(lead.source_company) || current.preferred_name;
    }
    if (lead.job_url) current.evidenceUrls.add(lead.job_url);
    groups.set(identity, current);
  }
  return [...groups.values()].map(group => ({
    ...group,
    evidence: JSON.stringify([...group.evidenceUrls].sort()),
    evidenceUrls: undefined,
  }));
}

function portalNameIdentities(portals) {
  return new Set((portals?.tracked_companies || [])
    .map(entry => normalizeCompanyIdentity(entry.name))
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
  currentState = [],
  now = new Date(),
  backfillDays = 20,
  unresolvedDays = 7,
  transientMinutes = 180,
  evaluateCandidate = evaluateAtsCandidate,
} = {}) {
  if (!['nyc', 'remote'].includes(scope)) throw new Error('scope must be nyc or remote');
  const trackedNames = portalNameIdentities(portals);
  const trackedBoards = new Set((portals?.tracked_companies || [])
    .map(portalEntryBoardKey).filter(Boolean));
  const previousByIdentity = new Map((currentState || [])
    .map(row => [row.normalized_lead, row]));
  const results = [];

  for (const group of aggregateLeadCompanies(leads, scope)) {
    const previous = previousByIdentity.get(group.normalized_lead);
    const hasNewEvidence = !previous?.last_seen || group.last_seen > previous.last_seen;
    if (previous && !hasNewEvidence && !retryIsDue(previous, now)) {
      results.push(previous);
      continue;
    }
    const base = {
      ...group,
      last_attempt_at: new Date(now).toISOString(),
      backfill_status: 'not_applicable',
    };
    if (previous?.status === 'accepted' && trackedBoards.has(portalBoardKey(previous))) {
      results.push({
        ...previous,
        preferred_name: group.preferred_name,
        first_seen: previous.first_seen || group.first_seen,
        last_seen: group.last_seen,
        source_count: group.source_count,
        evidence: group.evidence || previous.evidence,
      });
      continue;
    }
    if (trackedNames.has(group.normalized_lead)) {
      results.push({ ...base, status: 'already_tracked', reason: 'company name is already tracked' });
      continue;
    }

    const dol = joinLeadToDol({ source_company: group.preferred_name }, employers);
    if (dol.status !== 'dol_accepted') {
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

    const matchedCandidates = findAtsCandidatesForDol(dol, candidates)
      .sort((left, right) => Number(right.job_count || 0) - Number(left.job_count || 0));
    const trackedCandidate = matchedCandidates.find(candidate => trackedBoards.has(portalBoardKey({
      provider: candidate.provider,
      board_identifier: candidate.identifier,
    })));
    if (trackedCandidate) {
      results.push({
        ...base,
        ...dol,
        normalized_lead: group.normalized_lead,
        preferred_name: group.preferred_name,
        status: 'already_tracked',
        provider: trackedCandidate.provider,
        board_identifier: trackedCandidate.identifier,
        careers_url: trackedCandidate.careers_url,
        reason: 'verified ATS board is already tracked',
      });
      continue;
    }
    if (!matchedCandidates.length) {
      results.push({
        ...base,
        ...dol,
        normalized_lead: group.normalized_lead,
        preferred_name: group.preferred_name,
        status: 'ats_unresolved',
        next_retry_at: nextRetryAt(now, { days: unresolvedDays }),
        reason: 'no live exact public ATS candidate; bounded Google resolution is required',
      });
      continue;
    }

    const evaluated = [];
    for (const candidate of matchedCandidates) {
      evaluated.push(await evaluateCandidate(dol, candidate, { reviews }));
    }
    const accepted = evaluated.find(isScannableAdmission);
    if (accepted) {
      results.push(preserveBackfill({
        ...base,
        ...accepted,
        normalized_lead: group.normalized_lead,
        preferred_name: group.preferred_name,
        first_seen: group.first_seen,
        last_seen: group.last_seen,
        source_count: group.source_count,
        evidence: accepted.evidence || group.evidence,
        next_retry_at: '',
      }, previous, now, backfillDays));
      continue;
    }

    const chosen = evaluated.find(row => row.status === 'identity_review')
      || evaluated.find(row => row.status === 'verification_error')
      || evaluated[0];
    results.push({
      ...base,
      ...chosen,
      normalized_lead: group.normalized_lead,
      preferred_name: group.preferred_name,
      first_seen: group.first_seen,
      last_seen: group.last_seen,
      source_count: group.source_count,
      next_retry_at: nextRetryAt(now, chosen.status === 'verification_error'
        ? { minutes: transientMinutes }
        : { days: unresolvedDays }),
    });
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

function writeJsonReceipt(paths, prefix, body, now = new Date()) {
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
  const employers = loadTsv(dataPath(dataRoot, config.dol_employers));
  const candidates = loadTsv(dataPath(dataRoot, config.ats_candidates));
  const reviewsDoc = existsSync(paths.reviewsV2) ? readYaml(paths.reviewsV2) : { reviews: [] };
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
    portals,
    reviews: reviewsDoc.reviews,
    currentState,
    now,
    backfillDays: Number(config.scan?.backfill_days || 20),
    unresolvedDays: Number(config.retry?.unresolved_days || 7),
    transientMinutes: Number(config.retry?.transient_minutes || 180),
  });

  await updateResolutionRows(rows, { dataRoot });
  let portalResult = { added: 0, entries: [] };
  if (write) {
    try {
      portalResult = await commitPortalAdmissions(rows.filter(isScannableAdmission), { dataRoot });
    } catch (error) {
      const failedKeys = new Set(rows.filter(isScannableAdmission).map(row => row.normalized_lead));
      await updateResolutionRows(current => current.map(row => (
        failedKeys.has(row.normalized_lead) ? {
          ...row,
          status: 'verification_error',
          backfill_status: 'retry_error',
          backfill_error: `portal commit failed: ${clean(error?.message || error)}`,
          next_retry_at: nextRetryAt(now, { minutes: Number(config.retry?.transient_minutes || 180) }),
        } : row
      )), { dataRoot });
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
    companies_resolved: rows.length,
    outcomes: statusCounts(rows),
    portal_additions: portalResult.added,
    review_queue: reviewQueue,
    completed_at: new Date(now).toISOString(),
  };
  const receiptPath = writeJsonReceipt(paths, `company-${scope}-${mode}`, body, now);
  return { ...body, receipt_path: receiptPath };
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

  for (;;) {
    let claimed = null;
    await updateResolutionRows(current => current.map(row => {
      const eligible = row.status === 'accepted'
        && ['pending', 'retry_error', 'retry_partial'].includes(row.backfill_status)
        && !attempted.has(row.normalized_lead);
      if (!eligible || claimed) return row;
      claimed = startBackfill(row, now, Number(config.scan?.backfill_days || 20));
      return claimed;
    }), { dataRoot });
    if (!claimed) break;
    attempted.add(claimed.normalized_lead);
    totals.started += 1;

    let scanResult;
    try {
      scanResult = await runSerializedScan({
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
      row.normalized_lead === claimed.normalized_lead
        && portalBoardKey(row) === portalBoardKey(claimed)
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
