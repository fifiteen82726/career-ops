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
  return readQueue(dataRoot).jobs
    .filter(job => job.status === 'pending')
    .sort((left, right) => {
      const byFirstSeen = String(right.first_seen || '').localeCompare(String(left.first_seen || ''));
      return byFirstSeen || String(left.url || '').localeCompare(String(right.url || ''));
    })
    .slice(0, limit);
}

function terminalStatus(job) {
  return ['published', 'rejected', 'duplicate', 'closed'].includes(job.status) ? job.status : '';
}

function mergeJobs(left, right) {
  const leftTerminal = terminalStatus(left);
  const rightTerminal = terminalStatus(right);
  if (leftTerminal && rightTerminal && leftTerminal !== rightTerminal) {
    throw new Error(`Conflicting terminal dispositions for ${left.url}`);
  }
  const winner = { ...left };
  for (const field of ['title', 'company', 'location', 'posted_at', 'first_seen', 'reason', 'sheet_ref', 'disposition_at', 'exception_key', 'exception_at']) {
    if (!winner[field] && right[field]) winner[field] = right[field];
  }
  if (rightTerminal) winner.status = rightTerminal;
  // An active exception is a durable claim that this candidate must stay out
  // of normal evaluation.  It wins over a copied pending row in either order.
  if (!leftTerminal && !rightTerminal && (left.status === 'exception' || right.status === 'exception')) {
    winner.status = 'exception';
    if (right.status === 'exception' && right.exception_key) winner.exception_key = right.exception_key;
  }
  const sources = [...(Array.isArray(left.sources) ? left.sources : []), ...(Array.isArray(right.sources) ? right.sources : [])];
  winner.sources = [...new Map(sources.map(source => [JSON.stringify(source), source])).values()];
  return winner;
}

export function normalizeJobQueueDocument(doc) {
  const byUrl = new Map();
  let merged = 0;
  for (const legacy of doc.jobs) {
    const url = canonicalLeadUrl(legacy.url);
    const incoming = { ...legacy, url };
    if (!byUrl.has(url)) byUrl.set(url, incoming);
    else { byUrl.set(url, mergeJobs(byUrl.get(url), incoming)); merged += 1; }
  }
  doc.jobs = [...byUrl.values()];
  return merged;
}

/** Rebuild canonical URL identities before replaying receipts. */
export async function reconcileJobQueue({ dataRoot = getCareerOpsRoot(), ...options } = {}) {
  return updateQueue(doc => {
    const merged = normalizeJobQueueDocument(doc);
    return { merged, jobs: doc.jobs.length };
  }, { dataRoot, ...options });
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
    // Receipt replay is a write boundary too: legacy identities must be
    // reconciled before lookup, otherwise a published lowercase-escape row can
    // be reintroduced as a second pending candidate.
    normalizeJobQueueDocument(doc);
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

export async function deferJobForException({ url, exception_key }, options = {}) {
  if (exception_key === undefined || exception_key === null) throw new Error('Exception deferral requires a key');
  const key = String(exception_key);
  if (!key.trim()) throw new Error('Exception deferral requires a key');
  return updateQueue(doc => {
    const job = doc.jobs.find(item => item.url === canonicalLeadUrl(url));
    if (!job) throw new Error('Job not found in pending queue');
    if (['published', 'rejected', 'duplicate', 'closed'].includes(job.status)) {
      throw new Error('Cannot defer a terminal disposition');
    }
    if (job.status !== 'pending') throw new Error('Job not found in pending queue');
    Object.assign(job, {
      status: 'exception',
      exception_key: key,
      exception_at: new Date().toISOString(),
    });
    return { url: job.url, status: job.status, exception_key: job.exception_key };
  }, options);
}

export async function releaseJobFromException({ url, exception_key }, options = {}) {
  if (exception_key === undefined || exception_key === null) throw new Error('Exception release requires the matching exception key');
  const key = String(exception_key);
  if (!key.trim()) throw new Error('Exception release requires the matching exception key');
  return updateQueue(doc => {
    const job = doc.jobs.find(item => item.url === canonicalLeadUrl(url));
    if (!job || job.status !== 'exception') throw new Error('Job not found in exception queue');
    if (job.exception_key !== key) throw new Error('Exception release requires the matching exception key');
    Object.assign(job, {
      status: 'pending',
      exception_key: '',
      exception_released_at: new Date().toISOString(),
    });
    return { url: job.url, status: job.status, exception_key: job.exception_key };
  }, options);
}

/** Canonical candidate adapter transition: only the exception currently linked
 * to the job may convert it to a terminal outcome. */
export async function terminalizeExceptionJob({ url, exception_key, status, reason = '', sheet_ref = '' }, options = {}) {
  if (!['published', 'closed'].includes(status)) throw new Error('Exception terminal outcome must be published or closed');
  if (status === 'published' && !/^https:\/\/docs\.google\.com\/spreadsheets\/d\/[^/]+\/.*(?:range=|!)/.test(sheet_ref)) throw new Error('Published terminal outcome requires verified Sheet reference');
  if (status === 'closed' && !String(reason).trim()) throw new Error('Closed terminal outcome requires official evidence');
  return updateQueue(doc => {
    const job = doc.jobs.find(item => item.url === canonicalLeadUrl(url));
    if (!job) throw new Error('Job not found in exception queue');
    if (job.status === status) return { url: job.url, status, replayed: true };
    if (job.status !== 'exception' || job.exception_key !== exception_key) throw new Error('Terminal outcome requires matching linked exception');
    Object.assign(job, { status, reason, sheet_ref, exception_key: '', disposition_at: new Date().toISOString() });
    return { url: job.url, status };
  }, options);
}

export async function reconcileScanReceipts({ dataRoot = getCareerOpsRoot() } = {}) {
  const identity = await reconcileJobQueue({ dataRoot });
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
  return { ...result, identity, pending: readPendingJobs({ dataRoot }).length };
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
