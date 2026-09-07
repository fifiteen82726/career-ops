#!/usr/bin/env node

/** Full-board Workday health audit for Sunny's tracked portals. */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as yaml from 'js-yaml';
import { makeHttpCtx } from '../../providers/_http.mjs';
import { loadProviders, resolveProvider } from '../../providers/_registry.mjs';
import { normalizeEvidenceUrl } from './sunny-ats-identity-gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const PROVIDERS = resolve(ROOT, 'providers');

export function classifyWorkdayHealth(jobs, error) {
  if (Array.isArray(jobs)) {
    const workdayTruncated = jobs.workdayTruncated === true;
    return {
      health_status: workdayTruncated ? 'partial' : (jobs.length ? 'live' : 'live_empty'),
      jobCount: jobs.length,
      workdayTruncated,
    };
  }
  const status = Number(error?.status || String(error?.message || error || '').match(/HTTP\s+(\d{3})/i)?.[1]);
  const dead = status === 404 || status === 410;
  return {
    health_status: dead ? 'dead' : 'transient_error',
    jobCount: 0,
    workdayTruncated: false,
    error: String(error?.message || error || 'unknown Workday error'),
    ...(Number.isInteger(status) ? { httpStatus: status } : {}),
  };
}

async function parallelMap(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, worker));
  return results;
}

export async function auditWorkdayEntries(entries, { provider, ctx, concurrency = 4, now = () => new Date() }) {
  return parallelMap(entries, concurrency, async entry => {
    let jobs = null;
    let error = null;
    try { jobs = await provider.fetch(entry, ctx); }
    catch (caught) { error = caught; }
    return {
      name: entry.name,
      careers_url: normalizeEvidenceUrl(entry.careers_url || entry.api),
      checkedAt: now().toISOString(),
      ...classifyWorkdayHealth(jobs, error),
    };
  });
}

function parseArgs(argv) {
  const args = {
    portals: resolve(ROOT, 'portals.yml'),
    output: resolve(ROOT, 'data/cache/dol/sunny-workday-health-2026-09-07.jsonl'),
    concurrency: 4,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--portals') args.portals = resolve(argv[++index]);
    else if (token === '--output') args.output = resolve(argv[++index]);
    else if (token === '--concurrency') args.concurrency = Number(argv[++index]);
    else if (token === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) throw new Error('--concurrency must be a positive integer');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node data/tools/audit-sunny-workday-health.mjs [--portals YAML] [--output JSONL] [--concurrency N]');
    return;
  }
  const doc = yaml.load(readFileSync(args.portals, 'utf8')) || {};
  const providers = await loadProviders(PROVIDERS);
  const workday = providers.get('workday');
  if (!workday) throw new Error('Workday provider not found');
  const entries = [...(doc.tracked_companies || []), ...(doc.job_boards || [])]
    .filter(entry => entry?.enabled !== false)
    .filter(entry => resolveProvider(entry, providers, { skipIds: ['local-parser'] })?.provider?.id === 'workday');
  const records = await auditWorkdayEntries(entries, { provider: workday, ctx: makeHttpCtx(), concurrency: args.concurrency });
  const temporary = `${args.output}.tmp`;
  writeFileSync(temporary, records.map(record => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''));
  renameSync(temporary, args.output);
  const statuses = records.reduce((counts, row) => {
    counts[row.health_status] = (counts[row.health_status] || 0) + 1;
    return counts;
  }, {});
  console.log(JSON.stringify({ workdayEntries: entries.length, statuses, output: args.output }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
