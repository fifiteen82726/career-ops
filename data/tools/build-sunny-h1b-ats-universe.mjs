#!/usr/bin/env node

/**
 * Build Sunny's H-1B-transfer public ATS universe without using historical
 * LCA job titles as a company-level gate.
 *
 * The matcher is deliberately conservative: only a collision-free exact
 * normalized legal-name/DBA match is eligible for automatic live probing.
 * Ambiguous identities remain in the audit output and are never appended.
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as yaml from 'js-yaml';
import { parseQuotedTsv } from './sunny-tsv.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const PROVIDERS = ['greenhouse', 'ashby', 'lever', 'workday', 'icims'];
const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'llc', 'llp',
  'lp', 'ltd', 'limited', 'plc', 'pllc', 'pc', 'na', 'nv', 'sa', 'ag', 'gmbh',
]);

export function normalizeCompanyIdentity(value) {
  let normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  normalized = normalized.replace(/^the\s+/, '');
  const tokens = normalized.split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens.at(-1))) tokens.pop();
  return tokens.join('');
}

function atsIdentity(provider, identifier) {
  const raw = provider === 'workday' ? String(identifier).split('|')[0] : identifier;
  return normalizeCompanyIdentity(raw);
}

export function providerCoordinates(provider, identifier) {
  if (provider === 'greenhouse') {
    return {
      careersUrl: `https://job-boards.greenhouse.io/${identifier}`,
      api: `https://boards-api.greenhouse.io/v1/boards/${identifier}/jobs`,
    };
  }
  if (provider === 'ashby') {
    return {
      careersUrl: `https://jobs.ashbyhq.com/${identifier}`,
      api: `https://api.ashbyhq.com/posting-api/job-board/${identifier}?includeCompensation=true`,
    };
  }
  if (provider === 'lever') {
    return {
      careersUrl: `https://jobs.lever.co/${identifier}`,
      api: `https://api.lever.co/v0/postings/${identifier}?mode=json`,
    };
  }
  if (provider === 'workday') {
    const [tenant, instance, site] = String(identifier).split('|');
    if (!tenant || !instance || !site) throw new Error(`Invalid Workday identifier: ${identifier}`);
    return { careersUrl: `https://${tenant}.${instance}.myworkdayjobs.com/${site}` };
  }
  if (provider === 'icims') return { careersUrl: '' };
  throw new Error(`Unsupported provider: ${provider}`);
}

export function buildExactCandidates(employers, atsCaches) {
  const identityToEmployers = new Map();
  for (const employer of employers) {
    for (const source of [employer.employerName, employer.dba]) {
      const identity = normalizeCompanyIdentity(source);
      if (!identity) continue;
      if (!identityToEmployers.has(identity)) identityToEmployers.set(identity, new Map());
      identityToEmployers.get(identity).set(JSON.stringify([employer.employerName, employer.dba || '']), employer);
    }
  }

  const rows = [];
  for (const provider of PROVIDERS) {
    for (const identifier of atsCaches[provider] || []) {
      const identity = atsIdentity(provider, identifier);
      const matches = [...(identityToEmployers.get(identity)?.values() || [])];
      if (!matches.length) continue;
      if (matches.length > 1) {
        rows.push({
          provider,
          identifier,
          identity,
          employerName: '',
          dba: '',
          transferPositions: matches.reduce((sum, row) => sum + Number(row.transferPositions || 0), 0),
          nyTransferPositions: matches.reduce((sum, row) => sum + Number(row.nyTransferPositions || 0), 0),
          matchedEmployers: matches.map(row => row.employerName),
          status: 'ambiguous',
        });
        continue;
      }

      const employer = matches[0];
      rows.push({
        provider,
        identifier,
        identity,
        employerName: employer.employerName,
        dba: employer.dba || '',
        transferPositions: Number(employer.transferPositions || 0),
        nyTransferPositions: Number(employer.nyTransferPositions || 0),
        matchedEmployers: [employer.employerName],
        status: 'candidate',
        ...providerCoordinates(provider, identifier),
      });
    }
  }
  return rows;
}

function parseTsv(path) { return parseQuotedTsv(readFileSync(path, 'utf8')); }

function loadEmployers(path) {
  return parseTsv(path).map(row => ({
    employerName: row.EMPLOYER_NAME || row.employerName,
    dba: row.DBA || row.dba || '',
    transferPositions: Number(row.transfer_positions || row.transferPositions || 0),
    nyTransferPositions: Number(row.ny_transfer_positions || row.nyTransferPositions || 0),
  }));
}

function loadAtsCaches(cacheDir) {
  return Object.fromEntries(PROVIDERS.map(provider => [
    provider,
    JSON.parse(readFileSync(join(cacheDir, `${provider}.json`), 'utf8')),
  ]));
}

function directTrackedKeys(portalsPath) {
  const doc = yaml.load(readFileSync(portalsPath, 'utf8')) || {};
  const keys = new Set();
  for (const entry of doc.tracked_companies || []) {
    for (const value of [entry.careers_url, entry.api]) {
      if (!value) continue;
      for (const provider of PROVIDERS) {
        const parsed = identifierFromUrl(provider, value);
        if (parsed) keys.add(`${provider}\t${parsed}`);
      }
    }
  }
  return keys;
}

function directTrackedNameIdentities(portalsPath) {
  const doc = yaml.load(readFileSync(portalsPath, 'utf8')) || {};
  return new Set((doc.tracked_companies || [])
    .map(entry => normalizeCompanyIdentity(entry.name))
    .filter(Boolean));
}

function identifierFromUrl(provider, value) {
  const url = String(value);
  if (provider === 'greenhouse') return url.match(/(?:boards-api|boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:v1\/boards\/)?([^/?#]+)/)?.[1] || '';
  if (provider === 'ashby') return url.match(/(?:jobs\.ashbyhq\.com|api\.ashbyhq\.com\/posting-api\/job-board)\/([^/?#]+)/)?.[1] || '';
  if (provider === 'lever') return url.match(/(?:jobs|api)\.lever\.co\/(?:v0\/postings\/)?([^/?#]+)/)?.[1] || '';
  if (provider === 'workday') {
    const match = url.match(/^https:\/\/([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)/);
    return match ? `${match[1]}|${match[2]}|${match[3]}` : '';
  }
  if (provider === 'icims') return url.match(/^https:\/\/([^./]+)\.icims\.com/)?.[1] || '';
  return '';
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
    ...options,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`non-JSON response (${text.slice(0, 40).replace(/\s+/g, ' ')})`); }
}

async function probeIcims(identifier) {
  const hosts = [
    `${identifier}.icims.com`,
    `careers-${identifier}.icims.com`,
    `jobs-${identifier}.icims.com`,
    `external-${identifier}.icims.com`,
    `uscareers-${identifier}.icims.com`,
  ];
  for (const host of hosts) {
    const url = `https://${host}/jobs/search?ss=1`;
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(12_000) });
      const body = await response.text();
      if (response.ok && /iCIMS|job-search|jobs\/\d+/i.test(body)) return { careersUrl: `https://${host}/jobs/search?ss=1`, count: null };
    } catch { /* try the next known public hostname form */ }
  }
  throw new Error('no verifiable public iCIMS host');
}

export async function verifyCandidate(candidate) {
  const { provider, identifier } = candidate;
  if (candidate.status !== 'candidate') return { ...candidate, verification: 'skipped' };
  try {
    if (provider === 'greenhouse') {
      const data = await fetchJson(`${candidate.api}?content=false`);
      if (!Array.isArray(data?.jobs)) throw new Error('jobs array missing');
      return { ...candidate, verification: 'live', jobCount: data.jobs.length };
    }
    if (provider === 'ashby') {
      const data = await fetchJson(candidate.api);
      if (!Array.isArray(data?.jobs)) throw new Error('jobs array missing');
      return { ...candidate, verification: 'live', jobCount: data.jobs.length };
    }
    if (provider === 'lever') {
      const data = await fetchJson(candidate.api);
      if (!Array.isArray(data)) throw new Error('postings array missing');
      return { ...candidate, verification: 'live', jobCount: data.length };
    }
    if (provider === 'workday') {
      const [tenant, instance, site] = identifier.split('|');
      const origin = `https://${tenant}.${instance}.myworkdayjobs.com`;
      const data = await fetchJson(`${origin}/wday/cxs/${tenant}/${site}/jobs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36',
          origin,
          referer: `${candidate.careersUrl}/`,
        },
        body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: '' }),
      });
      if (!Array.isArray(data?.jobPostings)) throw new Error('jobPostings array missing');
      return { ...candidate, verification: 'live', jobCount: Number(data.total ?? data.jobPostings.length) };
    }
    if (provider === 'icims') {
      const verified = await probeIcims(identifier);
      return { ...candidate, ...verified, verification: 'live', jobCount: verified.count };
    }
    throw new Error(`unsupported provider ${provider}`);
  } catch (error) {
    return { ...candidate, verification: 'error', error: String(error?.message || error) };
  }
}

async function mapConcurrent(items, limit, mapper, progress) {
  const output = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await mapper(items[index], index);
      done += 1;
      if (progress && (done % 50 === 0 || done === items.length)) progress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return output;
}

function tsvEscape(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

function writeAudit(path, rows) {
  const headers = [
    'employer_name', 'dba', 'provider', 'identifier', 'normalized_identity',
    'transfer_positions', 'ny_transfer_positions', 'match_status',
    'verification', 'job_count', 'already_tracked', 'careers_url', 'error',
  ];
  const lines = [headers.join('\t')];
  for (const row of rows) {
    lines.push([
      row.employerName, row.dba, row.provider, row.identifier, row.identity,
      row.transferPositions, row.nyTransferPositions, row.status,
      row.verification || '', row.jobCount ?? '', row.alreadyTracked ? 'yes' : 'no',
      row.careersUrl || '', row.error || '',
    ].map(tsvEscape).join('\t'));
  }
  writeFileSync(path, `${lines.join('\n')}\n`);
}

function appendPortals(portalsPath, rows) {
  if (!rows.length) return;
  const blocks = rows.map(row => {
    const safeName = JSON.stringify(row.employerName || row.dba || row.identifier);
    const lines = [
      `  - name: ${safeName}`,
      `    careers_url: ${row.careersUrl}`,
    ];
    if (row.api && row.provider !== 'workday') lines.push(`    api: ${row.api}`);
    lines.push(`    provider: ${row.provider}`, '    enabled: true');
    return lines.join('\n');
  });
  const current = readFileSync(portalsPath, 'utf8').replace(/\s*$/, '\n');
  const temp = `${portalsPath}.sunny-universe.tmp`;
  writeFileSync(temp, `${current}\n${blocks.join('\n\n')}\n`);
  renameSync(temp, portalsPath);
}

export function selectPreferredAdditions(rows, existingNameIdentities = new Set()) {
  const providerPreference = new Map([
    ['greenhouse', 5],
    ['ashby', 4],
    ['workday', 3],
    ['lever', 2],
    ['icims', 1],
  ]);
  const eligible = rows.filter(row =>
    row.status === 'candidate'
      && row.verification === 'live'
      && !row.alreadyTracked
      && row.careersUrl,
  );
  const best = new Map();
  for (const row of eligible) {
    const identity = normalizeCompanyIdentity(row.employerName || row.dba);
    if (!identity || existingNameIdentities.has(identity)) continue;
    const current = best.get(identity);
    const rowCount = Number(row.jobCount ?? -1);
    const currentCount = Number(current?.jobCount ?? -1);
    const rowPreference = providerPreference.get(row.provider) || 0;
    const currentPreference = providerPreference.get(current?.provider) || 0;
    if (!current || rowCount > currentCount || (rowCount === currentCount && rowPreference > currentPreference)) {
      best.set(identity, row);
    }
  }
  return [...best.values()].sort((a, b) =>
    Number(b.nyTransferPositions || 0) - Number(a.nyTransferPositions || 0)
      || Number(b.transferPositions || 0) - Number(a.transferPositions || 0)
      || a.employerName.localeCompare(b.employerName),
  );
}

function parseArgs(argv) {
  const args = {
    employers: join(ROOT, 'data/cache/dol/sunny-all-title-h1b-employers-fy2026q3.tsv'),
    cacheDir: join(ROOT, 'data/cache/ats-companies'),
    portals: join(ROOT, 'portals.yml'),
    output: join(ROOT, 'data/cache/dol/sunny-all-title-ats-candidates-2026-09-01.tsv'),
    verify: false,
    append: false,
    concurrency: 20,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--verify') args.verify = true;
    else if (token === '--append') args.append = true;
    else if (token === '--employers') args.employers = resolve(argv[++i]);
    else if (token === '--cache-dir') args.cacheDir = resolve(argv[++i]);
    else if (token === '--portals') args.portals = resolve(argv[++i]);
    else if (token === '--output') args.output = resolve(argv[++i]);
    else if (token === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (token === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.append) throw new Error('--append disabled: published owner verification and portal CAS are required; use probe-sunny-ats-candidates.mjs or sunny-company-expansion.mjs');
  if (args.help) {
    console.log('Usage: node data/tools/build-sunny-h1b-ats-universe.mjs [--verify] [--concurrency N] (discovery only; no portal writes)');
    return;
  }
  const employers = loadEmployers(args.employers);
  const candidates = buildExactCandidates(employers, loadAtsCaches(args.cacheDir));
  const tracked = directTrackedKeys(args.portals);
  const trackedNames = directTrackedNameIdentities(args.portals);
  for (const row of candidates) row.alreadyTracked = tracked.has(`${row.provider}\t${row.identifier}`);
  const probed = args.verify
    ? await mapConcurrent(
        candidates,
        args.concurrency,
        row => verifyCandidate(row),
        (done, total) => console.error(`verified ${done}/${total}`),
      )
    : candidates;
  writeAudit(args.output, probed);

  const additions = selectPreferredAdditions(probed, trackedNames);
  if (args.append) appendPortals(args.portals, additions);

  const counts = {
    employers: employers.length,
    matchedBoards: candidates.length,
    ambiguous: candidates.filter(row => row.status === 'ambiguous').length,
    alreadyTracked: candidates.filter(row => row.alreadyTracked).length,
    verifiedLive: probed.filter(row => row.verification === 'live').length,
    verificationErrors: probed.filter(row => row.verification === 'error').length,
    additions: args.append ? additions.length : 0,
    output: args.output,
  };
  console.log(JSON.stringify(counts, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
