#!/usr/bin/env node

/**
 * Read the daily public Open Jobs board export and turn high-confidence board
 * identities into company-discovery leads. Open Jobs is only a lead source:
 * the normal Sunny resolver must still join the company to DOL evidence,
 * re-read the owner from the first-party ATS, and verify a live board before a
 * portal can be admitted.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';

const OPEN_JOBS_DATA = 'https://backend.dehnbostele.workers.dev/data';
const DEFAULT_PROVIDERS = [
  'greenhouse', 'ashby', 'lever', 'workable', 'smartrecruiters',
  'recruitee', 'breezy', 'teamtailor', 'paylocity', 'bamboohr', 'icims',
  'jobvite',
];
const SIMPLE_SLUG = /^[a-z0-9][a-z0-9._-]*$/i;
const HOST_SLUG = /^[a-z0-9][a-z0-9-]*$/i;
const PAYLOCITY_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clean(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function latestOpenJobsExportDate(payload) {
  const dates = (Array.isArray(payload?.dirs) ? payload.dirs : [])
    .map(value => clean(value).replace(/\/$/, ''))
    .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value))
    .filter(value => {
      const date = new Date(`${value}T00:00:00Z`);
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
    })
    .sort();
  if (!dates.length) throw new Error('OpenJobs public index contains no dated export');
  return dates.at(-1);
}

export async function latestCompleteOpenJobsExport(providers, requestJson = fetchJson) {
  const root = await requestJson(`${OPEN_JOBS_DATA}/exports/`);
  const remaining = [...(Array.isArray(root?.dirs) ? root.dirs : [])]
    .map(value => clean(value).replace(/\/$/, ''))
    .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value))
    .sort().reverse();
  for (const date of remaining) {
    const index = await requestJson(`${OPEN_JOBS_DATA}/exports/${date}/boards/`);
    const available = new Set((Array.isArray(index?.files) ? index.files : []).map(row => clean(row?.file)));
    if (providers.every(provider => available.has(`${provider}.parquet`))) return date;
  }
  throw new Error('OpenJobs public index contains no complete board export for the requested providers');
}

export function openJobsCareersUrl(provider, rawSlug) {
  const vendor = clean(provider).toLowerCase();
  const slug = clean(rawSlug);
  if (['greenhouse', 'ashby', 'lever', 'workable', 'smartrecruiters'].includes(vendor)) {
    if (!SIMPLE_SLUG.test(slug) || (vendor === 'workable' && slug.toLowerCase() === 'j')) return '';
    if (vendor === 'greenhouse') return `https://job-boards.greenhouse.io/${slug}`;
    if (vendor === 'ashby') return `https://jobs.ashbyhq.com/${slug}`;
    if (vendor === 'lever') return `https://jobs.lever.co/${slug}`;
    if (vendor === 'workable') return `https://apply.workable.com/${slug}`;
    return `https://careers.smartrecruiters.com/${slug}`;
  }
  if (['recruitee', 'breezy', 'bamboohr'].includes(vendor)) {
    if (!HOST_SLUG.test(slug)) return '';
    if (vendor === 'recruitee') return `https://${slug.toLowerCase()}.recruitee.com`;
    if (vendor === 'breezy') return `https://${slug.toLowerCase()}.breezy.hr`;
    return `https://${slug.toLowerCase()}.bamboohr.com/careers`;
  }
  if (vendor === 'teamtailor') {
    const host = slug.toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.teamtailor\.com$/.test(host)) return '';
    return `https://${host}/jobs`;
  }
  if (vendor === 'paylocity') {
    if (!PAYLOCITY_GUID.test(slug)) return '';
    return `https://recruiting.paylocity.com/recruiting/jobs/All/${slug.toLowerCase()}/`;
  }
  if (vendor === 'icims') {
    if (!HOST_SLUG.test(slug)) return '';
    return `https://${slug.toLowerCase()}.icims.com/jobs`;
  }
  if (vendor === 'jobvite') {
    if (!HOST_SLUG.test(slug)) return '';
    return `https://jobs.jobvite.com/${slug.toLowerCase()}`;
  }
  return '';
}

export function normalizeOpenJobsBoardRows(provider, rows, { minConfidence = 0.8 } = {}) {
  const output = [];
  const seen = new Set();
  for (const row of rows || []) {
    const company = clean(row?.company_name);
    const url = openJobsCareersUrl(provider, row?.slug);
    if (clean(row?.last_status).toLowerCase() !== 'ok'
      || !(Number(row?.job_count) > 0)
      || !company
      || !(Number(row?.company_confidence) >= minConfidence)
      || row?.company_is_staffing_agency === true
      || !url
      || seen.has(url)) continue;
    seen.add(url);
    output.push({
      company,
      title: 'Active public ATS board',
      location: [clean(row?.company_hq_city), clean(row?.company_hq_region)].filter(Boolean).join(', '),
      url,
    });
  }
  return output;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    redirect: 'error',
    headers: { accept: 'application/json', 'user-agent': 'career-ops-sunny-openjobs-fleet/1.0' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`OpenJobs: HTTP ${response.status} for ${url}`);
  return response.json();
}

async function readBoardParquet(url) {
  const response = await fetch(url, {
    redirect: 'error',
    headers: { accept: 'application/vnd.apache.parquet', 'user-agent': 'career-ops-sunny-openjobs-fleet/1.0' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`OpenJobs: HTTP ${response.status} for ${url}`);
  const file = await response.arrayBuffer();
  return parquetReadObjects({
    file,
    compressors,
    columns: [
      'slug', 'last_status', 'job_count', 'company_name', 'company_hq_city',
      'company_hq_region', 'company_is_staffing_agency', 'company_confidence',
    ],
  });
}

export async function collectOpenJobsFleetLeads({
  providers = DEFAULT_PROVIDERS,
  requestJson = fetchJson,
  requestParquet = readBoardParquet,
} = {}) {
  const exportDate = await latestCompleteOpenJobsExport(providers, requestJson);
  const leads = [];
  const stats = {};
  for (const rawProvider of providers) {
    const provider = clean(rawProvider).toLowerCase();
    if (!DEFAULT_PROVIDERS.includes(provider)) throw new Error(`unsupported OpenJobs provider: ${provider}`);
    const url = `${OPEN_JOBS_DATA}/exports/${exportDate}/boards/${provider}.parquet`;
    const rows = await requestParquet(url);
    const normalized = normalizeOpenJobsBoardRows(provider, rows);
    leads.push(...normalized);
    stats[provider] = { exported_boards: rows.length, high_confidence_leads: normalized.length };
  }
  return { exportDate, leads, stats };
}

function parseArgs(argv) {
  const args = { providers: DEFAULT_PROVIDERS, output: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--providers') args.providers = argv[++index].split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
    else if (token === '--output') args.output = resolve(argv[++index]);
    else if (token === '--help') args.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  if (!args.providers.length || args.providers.some(provider => !DEFAULT_PROVIDERS.includes(provider))) {
    throw new Error(`--providers must contain only: ${DEFAULT_PROVIDERS.join(', ')}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node data/tools/collect-sunny-openjobs-fleet.mjs [--providers ${DEFAULT_PROVIDERS.join(',')}] [--output JSON]`);
    return;
  }
  const now = new Date();
  const result = await collectOpenJobsFleetLeads({ providers: args.providers });
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const output = args.output || resolve(
    getCareerOpsRoot(),
    `data/company-discovery/inbox/openjobsfleet-remote-backfill-${timestamp}.json`,
  );
  mkdirSync(dirname(output), { recursive: true });
  const payload = {
    schema_version: 1,
    run_id: `openjobsfleet-remote-backfill-${timestamp}`,
    source: 'openjobsfleet',
    scope: 'remote',
    mode: 'backfill',
    collected_at: now.toISOString(),
    upstream_export_date: result.exportDate,
    qualification: 'lead only; downstream DOL, first-party ATS owner, and live-board verification required',
    stats: result.stats,
    jobs: result.leads,
  };
  writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ export_date: result.exportDate, leads: result.leads.length, stats: result.stats, output }, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
