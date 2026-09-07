#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import builtin from '../../providers/builtin.mjs';
import { makeHttpCtx } from '../../providers/_http.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

export const SUNNY_BUILTIN_QUERIES = [
  'data engineer',
  'analytics engineer',
  'business intelligence engineer',
  'data analyst',
  'financial data analyst',
  'data platform',
  'data warehouse',
  'ETL',
  'ELT',
];

export const SUNNY_BUILTIN_HOSTS = [
  { host: 'www.builtinnyc.com', scope: '' },
  { host: 'builtin.com', scope: 'remote' },
];

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

function renderTsv(rows) {
  const columns = ['company', 'title', 'location', 'posted_at', 'url', 'source_host', 'first_seen'];
  return `${[
    columns.join('\t'),
    ...rows.map(row => columns.map(column => clean(row[column])).join('\t')),
  ].join('\n')}\n`;
}

function parseArgs(argv) {
  const args = {
    output: resolve(ROOT, 'data/cache/dol/sunny-builtin-company-leads-2026-09-07.tsv'),
    maxPages: 3,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--output') args.output = resolve(argv[++index]);
    else if (token === '--max-pages') args.maxPages = Number(argv[++index]);
    else if (token === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!Number.isInteger(args.maxPages) || args.maxPages < 1 || args.maxPages > 25) {
    throw new Error('--max-pages must be an integer from 1 to 25');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node data/tools/collect-sunny-builtin-leads.mjs [--output TSV] [--max-pages N]');
    return;
  }
  const rows = await collectBuiltinLeads({ maxPages: args.maxPages });
  writeFileSync(args.output, renderTsv(rows));
  console.log(JSON.stringify({ leads: rows.length, output: args.output }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
