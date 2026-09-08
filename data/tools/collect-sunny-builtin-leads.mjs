#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import builtin from '../../providers/builtin.mjs';
import { makeHttpCtx } from '../../providers/_http.mjs';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';

export const SUNNY_BUILTIN_QUERIES = [
  'data engineer',
  'analytics engineer',
  'business intelligence engineer',
  'data analyst',
  'financial data analyst',
  'data platform',
  'data infrastructure',
  'data warehouse',
  'data pipeline',
  'data automation',
  'data management',
  'data operations',
  'data quality',
  'data governance',
  'ETL',
  'ELT',
  'SQL developer',
  'reporting developer',
];

export const SUNNY_BUILTIN_HOSTS = [
  { host: 'www.builtinnyc.com', scope: '' },
  { host: 'builtin.com', scope: 'remote' },
];

export function hostsForScope(scope) {
  if (scope === 'nyc') return [{ host: 'www.builtinnyc.com', scope: '' }];
  if (scope === 'remote') return [{ host: 'builtin.com', scope: 'remote' }];
  throw new Error('scope must be nyc or remote');
}

function clean(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

function iso(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Date(number).toISOString() : '';
}

export function dedupeBuiltinLeads(jobs) {
  const seen = new Set();
  const out = [];
  for (const job of jobs || []) {
    const company = clean(job?.company);
    const url = clean(job?.url);
    if (!company || !url || seen.has(url)) continue;
    seen.add(url);
    out.push({ ...job, company, url });
  }
  return out;
}

export async function collectBuiltinLeads({
  hosts = SUNNY_BUILTIN_HOSTS,
  queries = SUNNY_BUILTIN_QUERIES,
  maxPages = 3,
  fetchProvider = builtin.fetch.bind(builtin),
  httpCtx = makeHttpCtx(),
  now = Date.now(),
} = {}) {
  const firstSeen = new Date(now).toISOString();
  const collected = [];
  for (const target of hosts) {
    const host = clean(target?.host);
    const scope = clean(target?.scope);
    const jobs = await fetchProvider({
      name: `Built In ${host}`,
      provider: 'builtin',
      builtin: { host, scope, queries, max_pages: maxPages },
    }, httpCtx);
    for (const job of jobs || []) {
      collected.push({
        company: clean(job?.company),
        title: clean(job?.title),
        location: clean(job?.location),
        posted_at: iso(job?.postedAt),
        url: clean(job?.url),
        source_host: host,
        first_seen: firstSeen,
      });
    }
  }
  return dedupeBuiltinLeads(collected);
}

export function filterBuiltinBackfillWindow(rows, { now = Date.now(), days = 20 } = {}) {
  const cutoff = Number(now) - Number(days) * 86_400_000;
  return (rows || []).filter(row => {
    if (!row.posted_at) return true;
    const posted = Date.parse(row.posted_at);
    return Number.isNaN(posted) || posted >= cutoff;
  });
}

function parseArgs(argv) {
  const args = {
    output: '',
    maxPages: 3,
    mode: 'incremental',
    scope: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--output') args.output = resolve(argv[++index]);
    else if (token === '--max-pages') args.maxPages = Number(argv[++index]);
    else if (token === '--scope') args.scope = argv[++index];
    else if (token === '--mode') args.mode = argv[++index];
    else if (token === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!Number.isInteger(args.maxPages) || args.maxPages < 1 || args.maxPages > 25) {
    throw new Error('--max-pages must be an integer from 1 to 25');
  }
  if (args.help) return args;
  if (!['nyc', 'remote'].includes(args.scope)) throw new Error('--scope must be nyc or remote');
  if (!['backfill', 'incremental'].includes(args.mode)) throw new Error('--mode must be backfill or incremental');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node data/tools/collect-sunny-builtin-leads.mjs --scope <nyc|remote> --mode <backfill|incremental> [--output JSON] [--max-pages N]');
    return;
  }
  const now = Date.now();
  const collected = await collectBuiltinLeads({
    hosts: hostsForScope(args.scope),
    maxPages: args.maxPages,
    now,
  });
  const rows = args.mode === 'backfill'
    ? filterBuiltinBackfillWindow(collected, { now, days: 20 })
    : collected;
  const dataRoot = getCareerOpsRoot();
  const timestamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const output = args.output || resolve(
    dataRoot,
    `data/company-discovery/inbox/builtin-${args.scope}-${args.mode}-${timestamp}.json`,
  );
  mkdirSync(dirname(output), { recursive: true });
  const payload = {
    schema_version: 1,
    run_id: `builtin-${args.scope}-${args.mode}-${timestamp}`,
    source: 'builtin',
    scope: args.scope,
    mode: args.mode,
    collected_at: new Date(now).toISOString(),
    date_capability: args.mode === 'backfill'
      ? 'dated rows locally limited to 20 days; undated rows retained as company leads'
      : 'bounded current search; ledger dedup retains unseen leads',
    jobs: rows,
  };
  writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ leads: rows.length, collected: collected.length, output }, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
