#!/usr/bin/env node

/**
 * Checkpointed live ATS discovery for Sunny's unresolved NY/NYC Metro DOL
 * employers.  It reuses discover-ats.mjs providers and writes one JSON object
 * per completed employer, so an interrupted multi-thousand-company pass can
 * resume without repeating finished network probes.
 */

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as yaml from 'js-yaml';
import {
  dedupeAgainstPortals,
  insertIntoTrackedCompanies,
  renderPortalEntry,
  resolveCompany,
} from '../../discover-ats.mjs';
import { makeHttpCtx } from '../../providers/_http.mjs';
import {
  classifyDiscoveryCandidate,
  fetchPublishedBoardOwner,
  isWritableDiscoveryRecord,
} from './sunny-ats-identity-gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const DEFAULT_VENDORS = ['gh', 'ashby', 'lever', 'workable', 'smartrecruiters', 'recruitee', 'bamboohr', 'breezy', 'pinpoint', 'rippling', 'join'];

function companyKey(value) {
  return String(value || '').trim().toLowerCase();
}

export function parseCheckpoint(text) {
  const byCompany = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const key = companyKey(record?.name);
      if (key) byCompany.set(key, record);
    } catch {
      // An interrupted append can leave one truncated tail line.  Earlier
      // complete JSONL records remain authoritative and resumable.
    }
  }
  return byCompany;
}

export function selectPendingCompanies(companies, checkpoint, {
  retryIdentityStatuses = new Set(['unresolved', 'owner_unreachable']),
  retryHealthStatuses = new Set(['transient_error', 'partial']),
} = {}) {
  return companies.filter(company => {
    const record = checkpoint.get(companyKey(company.name));
    if (!record) return true;
    // v1 records never proved board ownership. Replay them rather than treating
    // an old guessed slug as a terminal result.
    if (record.schemaVersion !== 2) return true;
    if (retryIdentityStatuses.has(record.identity_status)) return true;
    if (retryHealthStatuses.has(record.health_status)) return true;
    return false;
  });
}

export function recordsFromDiscovery(batch, discovery, timestamp = new Date().toISOString()) {
  const resolved = new Map((discovery.resolved || []).map(row => [companyKey(row.name), row]));
  const unresolved = new Map((discovery.unresolved || []).map(row => [companyKey(row.name), row]));
  return batch.map(company => {
    const key = companyKey(company.name);
    if (resolved.has(key)) return { ...resolved.get(key), name: company.name, status: 'resolved', checkedAt: timestamp };
    if (unresolved.has(key)) return { ...unresolved.get(key), name: company.name, status: 'unresolved', checkedAt: timestamp };
    return { name: company.name, status: 'error', reason: 'resolver-returned-no-record', checkedAt: timestamp };
  });
}

export async function runCheckpointedDiscovery(companies, { concurrency = 8, resolveOne, onRecord = () => {} }) {
  const records = new Array(companies.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= companies.length) return;
      const company = companies[index];
      let record;
      try {
        const discovery = await resolveOne(company);
        record = discovery?.schemaVersion === 2
          ? discovery
          : recordsFromDiscovery([company], {
            resolved: discovery?.resolved ? [discovery.resolved] : [],
            unresolved: discovery?.unresolved ? [discovery.unresolved] : [],
          })[0];
      } catch (error) {
        record = {
          name: company.name,
          schemaVersion: 2,
          status: 'unresolved',
          identity_status: 'unresolved',
          health_status: 'transient_error',
          reason: String(error?.message || error),
          checkedAt: new Date().toISOString(),
        };
      }
      records[index] = record;
      await onRecord(record, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, companies.length || 1) }, worker));
  return records;
}

export async function resolveCompanyWithIdentityGate(company, {
  vendors = DEFAULT_VENDORS,
  ctx,
  reviews = [],
  runId = '',
  resolveFn = resolveCompany,
  ownerFn = fetchPublishedBoardOwner,
} = {}) {
  let quarantined = null;
  const unresolved = [];
  // Probe one provider at a time. A live board with the wrong owner must not
  // stop discovery of the correct board on a later provider.
  for (const vendor of vendors) {
    const result = await resolveFn(company, { vendors: [vendor], ctx, includeWorkday: false });
    if (!result?.resolved) {
      if (result?.unresolved) unresolved.push(result.unresolved);
      continue;
    }
    const ownership = await ownerFn(result.resolved, ctx);
    const record = classifyDiscoveryCandidate({
      company,
      resolved: result.resolved,
      boardOwner: ownership.owner,
      ownerError: ownership.error,
      reviews,
      runId,
    });
    if (isWritableDiscoveryRecord(record)) return record;
    quarantined ||= record;
  }

  // Workday can only be probed from explicit coordinates/official URL hints.
  if (company.workday || company.careers_url || company.website) {
    const result = await resolveFn(company, { vendors: [], ctx, includeWorkday: true });
    if (result?.resolved) {
      const record = classifyDiscoveryCandidate({ company, resolved: result.resolved, reviews, runId });
      if (isWritableDiscoveryRecord(record)) return record;
      quarantined ||= record;
    } else if (result?.unresolved) unresolved.push(result.unresolved);
  }

  if (quarantined) return quarantined;
  const transient = unresolved.find(row => /probe error|unknown|network|timeout|429|5\d\d/i.test(row?.reason || ''));
  return classifyDiscoveryCandidate({
    company,
    unresolved: transient || { name: company.name, reason: 'no supported ATS board found' },
    reviews,
    runId,
  });
}

function loadCompanies(path) {
  const doc = yaml.load(readFileSync(path, 'utf8')) || {};
  const list = Array.isArray(doc) ? doc : doc.companies;
  if (!Array.isArray(list)) throw new Error(`Expected a companies list in ${path}`);
  return list.filter(item => item && typeof item.name === 'string' && item.name.trim());
}

function appendRecords(path, records) {
  if (!records.length) return;
  appendFileSync(path, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
}

export function writeResolvedToPortals(portalsPath, records) {
  const fileText = readFileSync(portalsPath, 'utf8');
  const doc = yaml.load(fileText) || {};
  const matches = records.filter(isWritableDiscoveryRecord);
  const { fresh, duplicates } = dedupeAgainstPortals(matches, doc.tracked_companies || []);
  if (!fresh.length) return { added: 0, duplicates: duplicates.length };
  const snippets = fresh.map(renderPortalEntry);
  const updated = insertIntoTrackedCompanies(fileText, snippets);
  const temporary = `${portalsPath}.sunny-metro.tmp`;
  writeFileSync(temporary, updated);
  renameSync(temporary, portalsPath);
  return { added: fresh.length, duplicates: duplicates.length };
}

function parseArgs(argv) {
  const args = {
    input: join(ROOT, 'profiles/sunny-ny-metro-h1b-seeds.yml'),
    checkpoint: join(ROOT, 'data/cache/dol/sunny-ny-metro-discovery-v2.jsonl'),
    portals: join(ROOT, 'portals.yml'),
    batchSize: 50,
    concurrency: 8,
    max: Infinity,
    vendors: undefined,
    reviews: join(ROOT, 'profiles/sunny-h1b-ats-identity-reviews.yml'),
    retryIdentityStatuses: new Set(['unresolved', 'owner_unreachable']),
    retryHealthStatuses: new Set(['transient_error', 'partial']),
    write: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--in') args.input = resolve(argv[++index]);
    else if (token === '--checkpoint') args.checkpoint = resolve(argv[++index]);
    else if (token === '--portals') args.portals = resolve(argv[++index]);
    else if (token === '--batch-size') args.batchSize = Number(argv[++index]);
    else if (token === '--concurrency') args.concurrency = Number(argv[++index]);
    else if (token === '--max') args.max = Number(argv[++index]);
    else if (token === '--vendors') args.vendors = String(argv[++index]).split(',').map(value => value.trim()).filter(Boolean);
    else if (token === '--reviews') args.reviews = resolve(argv[++index]);
    else if (token === '--retry-identity-statuses') args.retryIdentityStatuses = new Set(String(argv[++index]).split(',').map(value => value.trim()).filter(Boolean));
    else if (token === '--retry-health-statuses') args.retryHealthStatuses = new Set(String(argv[++index]).split(',').map(value => value.trim()).filter(Boolean));
    else if (token === '--write') args.write = true;
    else if (token === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!Number.isInteger(args.batchSize) || args.batchSize < 1) throw new Error('--batch-size must be a positive integer');
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) throw new Error('--concurrency must be a positive integer');
  if (!(args.max === Infinity || (Number.isInteger(args.max) && args.max >= 0))) throw new Error('--max must be a non-negative integer');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node data/tools/run-sunny-ny-metro-discovery.mjs [--in YAML] [--checkpoint JSONL] [--vendors gh,ashby,lever] [--reviews YAML] [--retry-identity-statuses LIST] [--retry-health-statuses LIST] [--batch-size N] [--concurrency N] [--max N] [--write]');
    return;
  }
  const companies = loadCompanies(args.input);
  const checkpoint = parseCheckpoint(existsSync(args.checkpoint) ? readFileSync(args.checkpoint, 'utf8') : '');
  const pending = selectPendingCompanies(companies, checkpoint, args).slice(0, args.max);
  const httpCtx = makeHttpCtx();
  const reviewDoc = existsSync(args.reviews) ? (yaml.load(readFileSync(args.reviews, 'utf8')) || {}) : {};
  const reviews = reviewDoc.reviews || [];
  const runId = `sunny-ats-${new Date().toISOString()}`;
  let completed = 0;
  await runCheckpointedDiscovery(pending, {
    concurrency: args.concurrency,
    resolveOne: company => resolveCompanyWithIdentityGate(company, {
      vendors: args.vendors || DEFAULT_VENDORS,
      ctx: httpCtx,
      reviews,
      runId,
    }),
    onRecord: record => {
      appendRecords(args.checkpoint, [record]);
      completed += 1;
      if (completed % args.batchSize === 0 || completed === pending.length) {
        console.error(`completed ${checkpoint.size + completed}/${companies.length}`);
      }
    },
  });

  const finalCheckpoint = parseCheckpoint(existsSync(args.checkpoint) ? readFileSync(args.checkpoint, 'utf8') : '');
  const records = [...finalCheckpoint.values()];
  const statusCounts = records.reduce((counts, record) => {
    counts[record.status] = (counts[record.status] || 0) + 1;
    return counts;
  }, {});
  const portalWrite = args.write ? writeResolvedToPortals(args.portals, records) : { added: 0, duplicates: 0 };
  console.log(JSON.stringify({
    inputCompanies: companies.length,
    checkpointed: records.length,
    remaining: selectPendingCompanies(companies, finalCheckpoint, args).length,
    statuses: statusCounts,
    previewResolved: records.filter(isWritableDiscoveryRecord).length,
    written: args.write,
    ...portalWrite,
    checkpoint: args.checkpoint,
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
