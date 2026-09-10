#!/usr/bin/env node

/**
 * High-throughput Workable tenant existence pass for Sunny's DOL seed list.
 *
 * The normal Workable provider serializes every request process-wide and also
 * probes a legacy fallback. That is correct for ordinary scans, but makes a
 * one-time 2,000+ tenant discovery pass take hours. This audit-only runner
 * probes the public widget endpoint directly with bounded concurrency. A 404
 * is terminal absence; rate limits and server/network failures stay `error`
 * so they can be retried instead of being mislabeled as no board.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as yaml from 'js-yaml';
import { deriveSlug } from '../../discover-ats.mjs';
import { parseCheckpoint, selectPendingCompanies } from './run-sunny-ny-metro-discovery.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

export function classifyWorkableResponse(name, slug, status, payload) {
  const base = {
    name,
    vendor: 'workable',
    slug,
    careers_url: `https://apply.workable.com/${slug}`,
    checkedAt: new Date().toISOString(),
  };
  if (status === 404 || status === 410) {
    return { ...base, status: 'unresolved', jobCount: 0, reason: `definitive-http-${status}` };
  }
  if (status !== 200) {
    return { ...base, status: 'error', jobCount: 0, reason: `http-${status}` };
  }
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  if (!jobs.length) return { ...base, status: 'unresolved', jobCount: 0, reason: 'live-empty-board' };
  return { ...base, status: 'resolved', jobCount: jobs.length };
}

function loadCompanies(path) {
  const doc = yaml.load(readFileSync(path, 'utf8')) || {};
  const companies = Array.isArray(doc) ? doc : doc.companies;
  if (!Array.isArray(companies)) throw new Error(`Expected companies list in ${path}`);
  return companies.filter(row => row && typeof row.name === 'string' && row.name.trim());
}

async function probe(company, timeoutMs) {
  const slug = deriveSlug(company.name);
  const endpoint = `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`;
  try {
    const response = await fetch(endpoint, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        accept: 'application/json,text/plain,*/*',
      },
    });
    let payload = null;
    if (response.status === 200) {
      try { payload = await response.json(); }
      catch { return { name: company.name, vendor: 'workable', slug, status: 'error', reason: 'invalid-json', checkedAt: new Date().toISOString() }; }
    }
    return classifyWorkableResponse(company.name, slug, response.status, payload);
  } catch (error) {
    return {
      name: company.name,
      vendor: 'workable',
      slug,
      careers_url: `https://apply.workable.com/${slug}`,
      status: 'error',
      jobCount: 0,
      reason: error?.name === 'TimeoutError' ? 'timeout' : String(error?.message || error),
      checkedAt: new Date().toISOString(),
    };
  }
}

async function run(companies, { concurrency, timeoutMs, onRecord }) {
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= companies.length) return;
      await onRecord(await probe(companies[index], timeoutMs));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, companies.length || 1) }, worker));
}

function parseArgs(argv) {
  const args = {
    input: join(ROOT, 'profiles/sunny-ny-metro-h1b-seeds.yml'),
    checkpoint: join(ROOT, 'data/cache/dol/sunny-ny-metro-discovery-workable.jsonl'),
    concurrency: 12,
    timeoutMs: 8000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--in') args.input = resolve(argv[++i]);
    else if (argv[i] === '--checkpoint') args.checkpoint = resolve(argv[++i]);
    else if (argv[i] === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (argv[i] === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const companies = loadCompanies(args.input);
  const checkpoint = parseCheckpoint(existsSync(args.checkpoint) ? readFileSync(args.checkpoint, 'utf8') : '');
  const pending = selectPendingCompanies(companies, checkpoint);
  let completed = 0;
  await run(pending, {
    concurrency: args.concurrency,
    timeoutMs: args.timeoutMs,
    onRecord: async record => {
      appendFileSync(args.checkpoint, `${JSON.stringify(record)}\n`);
      completed += 1;
      if (completed % 250 === 0 || completed === pending.length) {
        console.error(`completed ${checkpoint.size + completed}/${companies.length}`);
      }
    },
  });
  const final = parseCheckpoint(readFileSync(args.checkpoint, 'utf8'));
  const records = [...final.values()];
  const statuses = records.reduce((out, row) => ({ ...out, [row.status]: (out[row.status] || 0) + 1 }), {});
  console.log(JSON.stringify({ inputCompanies: companies.length, checkpointed: records.length, statuses }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
}
