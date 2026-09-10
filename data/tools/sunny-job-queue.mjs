#!/usr/bin/env node
/** Scan-history means seen, not evaluated. This queue preserves that distinction. */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { acquirePipelineLock } from '../../pipeline-lock.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { canonicalLeadUrl } from './sunny-company-leads.mjs';

function queuePath(dataRoot) { return join(dataRoot, 'data/sunny-job-queue.json'); }
function readQueue(dataRoot) {
  const file = queuePath(dataRoot);
  if (!existsSync(file)) return { schema_version: 1, jobs: [] };
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  if (doc.schema_version !== 1 || !Array.isArray(doc.jobs)) throw new Error('Invalid Sunny job queue; refusing to overwrite');
  return doc;
}

async function updateQueue(fn, { dataRoot = getCareerOpsRoot(), lockOptions } = {}) {
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const lock = await acquirePipelineLock(join(dataRoot, 'data/.sunny-job-queue'), lockOptions);
  const temp = `${queuePath(dataRoot)}.tmp-${randomUUID()}`;
  try {
    const doc = readQueue(dataRoot);
    const result = fn(doc);
    writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    renameSync(temp, queuePath(dataRoot));
    return result;
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
    lock.release();
  }
}

function historyIndex(dataRoot) {
  const file = join(dataRoot, 'data/sunny-scan-history.tsv');
  if (!existsSync(file)) return new Map();
  const [header, ...lines] = readFileSync(file, 'utf8').trimEnd().split(/\r?\n/);
  const columns = header.split('\t');
  return new Map(lines.filter(Boolean).map(line => {
    const cells = line.split('\t');
    const row = Object.fromEntries(columns.map((column, i) => [column, cells[i] || '']));
    return [canonicalLeadUrl(row.url), row];
  }));
}

export function readPendingJobs({ dataRoot = getCareerOpsRoot(), limit = Infinity } = {}) {
  return readQueue(dataRoot).jobs.filter(job => job.status === 'pending').slice(0, limit);
}

export async function enqueueScanReceipt(receipt, { dataRoot = getCareerOpsRoot(), ...options } = {}) {
  if (receipt.dry_run || receipt.scan_receipt?.dry_run) return { added: 0, dry_run: true };
  if (!['daily', 'backfill'].includes(receipt.kind) || !receipt.run_id
    || receipt.scan_receipt?.version !== 'careerops.scan.receipt@1'
    || !Array.isArray(receipt.scan_receipt.added_urls)) throw new Error('Invalid scan receipt for job queue');
  const history = historyIndex(dataRoot);
  const source = {
    run_id: receipt.run_id, kind: receipt.kind, observed_at: receipt.started_at,
    ...(receipt.kind === 'backfill'
      ? { posted_after: receipt.posted_after, posted_before: receipt.posted_before,
        provider: receipt.provider, board_identifier: receipt.board_identifier }
      : { since_days: receipt.since_days }),
  };
  // Partial/error scans may still have real added URLs. Preserve them for evaluation.
  const urls = [...new Set(receipt.scan_receipt.added_urls.map(raw => {
    const parsed = new URL(raw);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Invalid job URL protocol');
    return canonicalLeadUrl(raw);
  }))];
  return updateQueue(doc => {
    const byUrl = new Map(doc.jobs.map(job => [job.url, job]));
    let added = 0;
    for (const url of urls) {
      let job = byUrl.get(url);
      if (!job) {
        const row = history.get(url) || {};
        job = { url, title: row.title || '', company: row.company || receipt.company || '',
          location: row.location || '', posted_at: row.posted_at || '',
          first_seen: row.first_seen || '', status: 'pending', sources: [] };
        doc.jobs.push(job);
        byUrl.set(url, job);
        added += 1;
      }
      if (!job.sources.some(item => item.run_id === source.run_id)) job.sources.push(source);
    }
    return { added, pending: doc.jobs.filter(job => job.status === 'pending').length };
  }, { dataRoot, ...options });
}

export async function markJobDisposition({ url, status, reason, sheet_ref }, options = {}) {
  if (!['published', 'rejected', 'duplicate', 'closed'].includes(status)) throw new Error('Invalid job disposition');
  if (status === 'published' && !/^https:\/\/docs\.google\.com\/spreadsheets\/d\/[^/]+\/.*(?:range=|!)/.test(sheet_ref || '')) {
    throw new Error('Published disposition requires a verified Sheet URL with row/range reference');
  }
  if (status !== 'published' && !String(reason || '').trim()) throw new Error('Disposition requires a reason');
  return updateQueue(doc => {
    const job = doc.jobs.find(item => item.url === canonicalLeadUrl(url));
    if (!job) throw new Error('Job not found in pending queue');
    if (job.status !== 'pending' && job.status !== status) throw new Error('Cannot overwrite a terminal disposition');
    Object.assign(job, { status, reason: reason || '', sheet_ref: sheet_ref || '', disposition_at: new Date().toISOString() });
    return { url: job.url, status };
  }, options);
}

export async function reconcileScanReceipts({ dataRoot = getCareerOpsRoot() } = {}) {
  const dir = join(dataRoot, 'data/company-discovery/receipts');
  const result = { receipts: 0, added: 0, errors: [] };
  for (const name of existsSync(dir) ? readdirSync(dir).filter(name => /^(daily|backfill)-.*\.json$/.test(name)).sort() : []) {
    try {
      const receipt = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const ingested = await enqueueScanReceipt(receipt, { dataRoot });
      result.receipts += 1;
      result.added += ingested.added;
    } catch (error) { result.errors.push({ file: name, error: error.message }); }
  }
  return { ...result, pending: readPendingJobs({ dataRoot }).length };
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = flag => args[args.indexOf(flag) + 1];
  const command = args[0];
  Promise.resolve().then(() => {
    if (command === 'pending') return readPendingJobs({ limit: args.includes('--limit') ? Number(value('--limit')) : Infinity });
    if (command === 'reconcile') return reconcileScanReceipts();
    if (command === 'mark') return markJobDisposition({ url: value('--url'), status: value('--status'),
      reason: args.includes('--reason') ? value('--reason') : '', sheet_ref: args.includes('--sheet-ref') ? value('--sheet-ref') : '' });
    throw new Error('Usage: sunny-job-queue.mjs reconcile | pending [--limit N] | mark --url URL --status published|rejected|duplicate|closed [--reason TEXT] [--sheet-ref VERIFIED_RANGE_URL]');
  }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
