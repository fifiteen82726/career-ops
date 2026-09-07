#!/usr/bin/env node

/**
 * Join Sunny's NY State / practical NYC Metro DOL employer universe to the
 * refreshed public-ATS audit and current portals configuration.
 *
 * This script performs no network calls.  It produces a complete baseline in
 * which every normalized DOL identity has a current resolution state, plus a
 * YAML seed file containing only identities that still need live slug-vendor
 * discovery.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as yaml from 'js-yaml';
import { normalizeCompanyIdentity } from './build-sunny-h1b-ats-universe.mjs';
import { isWritableDiscoveryRecord, normalizeEvidenceUrl } from './sunny-ats-identity-gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

function parseTsv(path) {
  const text = readFileSync(path, 'utf8').trimEnd();
  if (!text) return [];
  const [headerLine, ...lines] = text.split(/\r?\n/);
  const headers = headerLine.split('\t');
  return lines.filter(Boolean).map(line => {
    const values = line.split('\t');
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
  });
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function splitLocations(value) {
  return String(value || '').split('|').map(item => item.trim()).filter(Boolean);
}

export function mergeEmployerIdentities(rows) {
  const groups = new Map();
  for (const row of rows) {
    const employerName = String(row.EMPLOYER_NAME || row.employer_name || '').trim();
    const dba = String(row.DBA || row.dba || '').trim();
    const preferredName = dba || employerName;
    const identity = normalizeCompanyIdentity(preferredName);
    if (!identity) continue;
    if (!groups.has(identity)) {
      groups.set(identity, {
        identity,
        preferredName,
        names: new Set(),
        legalNames: new Set(),
        dbas: new Set(),
        transferPositions: 0,
        nyStateTransferPositions: 0,
        metroTransferPositions: 0,
        metroLocations: new Set(),
      });
    }
    const group = groups.get(identity);
    if (employerName) {
      group.names.add(employerName);
      group.legalNames.add(employerName);
    }
    if (dba) {
      group.names.add(dba);
      group.dbas.add(dba);
    }
    group.transferPositions += number(row.transfer_positions);
    group.nyStateTransferPositions += number(row.ny_state_transfer_positions || row.ny_transfer_positions);
    group.metroTransferPositions += number(row.metro_transfer_positions);
    for (const location of splitLocations(row.metro_locations)) group.metroLocations.add(location);
  }

  return [...groups.values()].map(group => ({
    ...group,
    names: [...group.names].sort(),
    legalNames: [...group.legalNames].sort(),
    dbas: [...group.dbas].sort(),
    metroLocations: [...group.metroLocations].sort(),
  })).sort((a, b) =>
    b.metroTransferPositions - a.metroTransferPositions
      || b.nyStateTransferPositions - a.nyStateTransferPositions
      || b.transferPositions - a.transferPositions
      || a.preferredName.localeCompare(b.preferredName),
  );
}

function isMeta(identity) {
  const value = String(identity?.identity || '');
  return value === 'meta' || value === 'metaplatforms' || value.startsWith('metaplatforms');
}

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

export function classifyResolution(identity, auditRows, trackedNameIdentities, trackedUrls = new Set(), identityReviews = new Map()) {
  const base = { ...identity };
  if (isMeta(identity)) return { ...base, status: 'excluded', reason: 'user-excluded-meta' };

  const matches = auditRows.filter(row => row.normalized_identity === identity.identity);
  const reviewFor = row => identityReviews.get(`${identity.identity}\t${String(row.careers_url || '')}`)
    || identityReviews.get(`${identity.identity}\t${normalizeUrl(row.careers_url)}`);
  const rejectedMatches = matches.filter(row => reviewFor(row)?.verdict === 'reject');
  const usableMatches = matches.filter(row => reviewFor(row)?.verdict !== 'reject');
  const live = usableMatches.filter(row => row.match_status === 'candidate' && row.verification === 'live');
  if (live.length) {
    const best = [...live].sort((a, b) => number(b.job_count) - number(a.job_count))[0];
    const exactBoardTracked = live.some(row =>
      row.already_tracked === 'yes' || trackedUrls.has(normalizeUrl(row.careers_url)),
    );
    const employerNameTracked = trackedNameIdentities.has(identity.identity);
    return {
      ...base,
      status: exactBoardTracked ? 'already_tracked_live' : (employerNameTracked ? 'already_tracked_name' : 'verified_candidate'),
      provider: best.provider || '',
      identifier: best.identifier || '',
      careersUrl: best.careers_url || '',
      jobCount: number(best.job_count),
      reason: exactBoardTracked
        ? 'collision-safe-exact-dol-ats-match'
        : (employerNameTracked ? 'tracked-name-identity-with-alternate-live-ats' : 'collision-safe-exact-dol-ats-match'),
    };
  }
  if (rejectedMatches.some(row => row.verification === 'live')) {
    const review = reviewFor(rejectedMatches.find(row => row.verification === 'live'));
    return { ...base, status: 'identity_mismatch', reason: review?.reason || 'reviewed-board-owner-mismatch' };
  }
  const reviewedAlias = [...identityReviews.entries()].find(([key, review]) => {
    const separator = key.indexOf('\t');
    if (separator < 0 || key.slice(0, separator) !== identity.identity) return false;
    const reviewedUrl = normalizeUrl(key.slice(separator + 1));
    return review?.verdict === 'accept' && trackedUrls.has(reviewedUrl);
  });
  if (reviewedAlias) {
    const reviewedUrl = normalizeUrl(reviewedAlias[0].slice(reviewedAlias[0].indexOf('\t') + 1));
    return {
      ...base,
      status: 'already_tracked_alias',
      careersUrl: reviewedUrl,
      reason: reviewedAlias[1]?.reason || 'reviewed-identity-alias-to-tracked-board',
    };
  }
  if (trackedNameIdentities.has(identity.identity)) {
    return { ...base, status: 'already_tracked_name', reason: 'tracked-name-identity' };
  }
  if (usableMatches.some(row => row.match_status === 'ambiguous')) {
    return { ...base, status: 'ambiguous', reason: 'normalized-identity-collision' };
  }
  if (usableMatches.some(row => row.verification === 'error')) {
    const errors = [...new Set(usableMatches.map(row => row.error).filter(Boolean))];
    return { ...base, status: 'verification_error', reason: errors.join(' | ') || 'public-ats-verification-error' };
  }
  return { ...base, status: 'unresolved', reason: 'no-live-exact-public-ats-match' };
}

export function buildSeedCompanies(rows) {
  return rows
    .filter(row => ['unresolved', 'verification_error'].includes(row.status) && !isMeta(row))
    .map(row => ({ name: row.preferredName }));
}

export function applyDiscoveryEvidence(base, discoveryRecord, workdayHealth = null) {
  if (!discoveryRecord) return {
    ...base,
    identityStatus: base.identityStatus || '',
    healthStatus: base.healthStatus || '',
  };
  const healthStatus = workdayHealth?.health_status || discoveryRecord.health_status || '';
  const enriched = {
    ...base,
    identityStatus: discoveryRecord.identity_status || '',
    healthStatus,
    boardOwner: discoveryRecord.boardOwner || '',
  };
  if (isWritableDiscoveryRecord({ ...discoveryRecord, health_status: healthStatus })) {
    if (!['already_tracked_live', 'already_tracked_name', 'already_tracked_alias'].includes(base.status)) {
      enriched.status = 'verified_candidate';
      enriched.provider = discoveryRecord.provider || '';
      enriched.identifier = discoveryRecord.slug || '';
      enriched.careersUrl = discoveryRecord.careers_url || discoveryRecord.careersUrl || '';
      enriched.jobCount = Number(workdayHealth?.jobCount ?? discoveryRecord.jobCount ?? 0);
      enriched.reason = discoveryRecord.reason || 'ownership-gated live ATS discovery';
    }
  } else if (discoveryRecord.identity_status === 'review_required'
    && ['unresolved', 'verification_error', 'ambiguous'].includes(base.status)) {
    enriched.status = 'review_required';
    enriched.reason = discoveryRecord.reason || 'ATS owner requires review';
  }
  return enriched;
}

export function collectTrackedPortalEvidence(doc) {
  const entries = [
    ...(doc.tracked_companies || []),
    ...(doc.job_boards || []),
  ].filter(entry => entry.enabled !== false);
  const names = new Set(entries
    .map(entry => normalizeCompanyIdentity(entry.name))
    .filter(Boolean));
  const urls = new Set(entries
    .flatMap(entry => [entry.careers_url, entry.api])
    .map(normalizeUrl)
    .filter(Boolean));
  return { names, urls };
}

function trackedPortalEvidence(portalsPath) {
  const doc = yaml.load(readFileSync(portalsPath, 'utf8')) || {};
  return collectTrackedPortalEvidence(doc);
}

function loadIdentityReviews(path) {
  if (!path) return new Map();
  let doc;
  try { doc = yaml.load(readFileSync(path, 'utf8')) || {}; }
  catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw error;
  }
  const reviews = new Map();
  for (const row of doc.reviews || []) {
    const identity = normalizeCompanyIdentity(row.identity || row.company || '');
    const url = normalizeUrl(row.careers_url);
    if (!identity || !url || !['accept', 'reject'].includes(row.verdict)) continue;
    reviews.set(`${identity}\t${url}`, { verdict: row.verdict, reason: String(row.reason || '') });
  }
  return reviews;
}

function loadJsonlLatest(path, keyFn) {
  const records = new Map();
  if (!path) return records;
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return records;
    throw error;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const key = keyFn(row);
      if (key) records.set(key, row);
    } catch {
      // Ignore a truncated append tail; earlier complete records remain valid.
    }
  }
  return records;
}

function escapeTsv(value) {
  if (Array.isArray(value)) value = value.join(' | ');
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

function writeResolution(path, rows) {
  const headers = [
    'identity', 'preferred_name', 'legal_names', 'dbas',
    'transfer_positions', 'ny_state_transfer_positions', 'metro_transfer_positions',
    'metro_locations', 'status', 'provider', 'identifier', 'careers_url',
    'job_count', 'identity_status', 'health_status', 'board_owner', 'reason',
  ];
  const lines = [headers.join('\t')];
  for (const row of rows) {
    lines.push([
      row.identity, row.preferredName, row.legalNames, row.dbas,
      row.transferPositions, row.nyStateTransferPositions, row.metroTransferPositions,
      row.metroLocations, row.status, row.provider, row.identifier, row.careersUrl,
      row.jobCount ?? '', row.identityStatus, row.healthStatus, row.boardOwner, row.reason,
    ].map(escapeTsv).join('\t'));
  }
  writeFileSync(path, `${lines.join('\n')}\n`);
}

function writeSeeds(path, rows) {
  const text = yaml.dump({ companies: buildSeedCompanies(rows) }, { lineWidth: 120, noRefs: true });
  writeFileSync(path, `# Generated from DOL NY State + practical NYC Metro unresolved identities.\n${text}`);
}

function parseArgs(argv) {
  const args = {
    employers: join(ROOT, 'data/cache/dol/sunny-ny-metro-h1b-employers-fy2026q3.tsv'),
    audit: join(ROOT, 'data/cache/dol/sunny-all-title-ats-candidates-2026-09-02.tsv'),
    portals: join(ROOT, 'portals.yml'),
    reviews: join(ROOT, 'profiles/sunny-h1b-ats-identity-reviews.yml'),
    output: join(ROOT, 'data/cache/dol/sunny-ny-metro-resolution-2026-09-02.tsv'),
    seeds: join(ROOT, 'profiles/sunny-ny-metro-h1b-seeds.yml'),
    discovery: join(ROOT, 'data/cache/dol/sunny-ny-metro-discovery-v2-2026-09-07.jsonl'),
    workdayHealth: join(ROOT, 'data/cache/dol/sunny-workday-health-post-write-2026-09-07.jsonl'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--employers') args.employers = resolve(argv[++index]);
    else if (token === '--audit') args.audit = resolve(argv[++index]);
    else if (token === '--portals') args.portals = resolve(argv[++index]);
    else if (token === '--reviews') args.reviews = resolve(argv[++index]);
    else if (token === '--output') args.output = resolve(argv[++index]);
    else if (token === '--seeds') args.seeds = resolve(argv[++index]);
    else if (token === '--discovery') args.discovery = resolve(argv[++index]);
    else if (token === '--workday-health') args.workdayHealth = resolve(argv[++index]);
    else if (token === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node data/tools/build-sunny-ny-metro-resolution.mjs [--employers TSV] [--audit TSV] [--portals YAML] [--output TSV] [--seeds YAML]');
    return;
  }
  const identities = mergeEmployerIdentities(parseTsv(args.employers));
  const auditRows = parseTsv(args.audit);
  const tracked = trackedPortalEvidence(args.portals);
  const reviews = loadIdentityReviews(args.reviews);
  const discovery = loadJsonlLatest(args.discovery, row => normalizeCompanyIdentity(row.name));
  const workdayHealth = loadJsonlLatest(args.workdayHealth, row => normalizeEvidenceUrl(row.careers_url));
  const rows = identities.map(identity => {
    const base = classifyResolution(identity, auditRows, tracked.names, tracked.urls, reviews);
    const found = discovery.get(identity.identity);
    const health = found ? workdayHealth.get(normalizeEvidenceUrl(found.careers_url || found.careersUrl)) : null;
    return applyDiscoveryEvidence(base, found, health);
  });
  writeResolution(args.output, rows);
  writeSeeds(args.seeds, rows);
  const statuses = rows.reduce((counts, row) => {
    counts[row.status] = (counts[row.status] || 0) + 1;
    return counts;
  }, {});
  console.log(JSON.stringify({ identities: rows.length, statuses, output: args.output, seeds: args.seeds }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(); }
  catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
