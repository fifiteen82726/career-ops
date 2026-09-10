#!/usr/bin/env node

/**
 * Normalize company-discovery job results into an append-only lead ledger.
 *
 * This module deliberately knows nothing about Sunny's job scan history or
 * pipeline. A source job is evidence that a company is hiring; it is not a
 * job-pipeline observation until the verified ATS scanner sees it.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { acquirePipelineLock } from '../../pipeline-lock.mjs';
import { normalizeCompanyIdentity } from './build-sunny-h1b-ats-universe.mjs';

export const LEAD_COLUMNS = [
  'source_run_id',
  'discovered_at',
  'source',
  'scope',
  'source_company',
  'normalized_source_company',
  'job_title',
  'job_location',
  'job_url',
  'posted_at',
  'posted_at_raw',
  'posted_at_kind',
];

const TRACKING_PARAMS = new Set([
  'alternateChannel', 'eBP', 'fmid', 'from', 'gh_src', 'refId',
  'source', 'ssid', 'trk', 'trackingId', 'utm_campaign', 'utm_content',
  'utm_medium', 'utm_source', 'utm_term',
].map(value => value.toLowerCase()));

function clean(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function normalizeLeadText(value) {
  return clean(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function canonicalLeadUrl(value) {
  const raw = clean(value);
  if (!raw) return '';

  let url;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }

  url.hash = '';
  const host = url.hostname.toLowerCase();
  if (host === 'indeed.com' || host.endsWith('.indeed.com')) {
    const jobKey = url.searchParams.get('jk');
    url.search = jobKey ? `?jk=${encodeURIComponent(jobKey)}` : '';
    return url.toString();
  }

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
  }

  return url.toString();
}

function normalizePostedAt(value) {
  const raw = clean(value);
  if (!raw) return { posted_at: '', posted_at_raw: '', posted_at_kind: 'missing' };
  const exact = raw.match(/^\d{4}-\d{2}-\d{2}(?=$|T| )/)?.[0];
  if (exact) {
    const date = new Date(`${exact}T00:00:00Z`);
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === exact) {
      return { posted_at: exact, posted_at_raw: raw, posted_at_kind: 'source_calendar_date' };
    }
  }
  // The source's relative label is retained, never converted to a made-up ATS date.
  return { posted_at: '', posted_at_raw: raw, posted_at_kind: 'unresolved' };
}

export function normalizeLead(row, {
  source,
  scope,
  runId,
  now = new Date(),
} = {}) {
  if (!clean(source) || !clean(scope) || !clean(runId)) {
    throw new Error('lead ingestion requires source, scope, and runId');
  }

  const company = clean(row?.company ?? row?.source_company);
  const title = clean(row?.title ?? row?.job_title);
  if (!company || !title) throw new Error('lead requires company and title');

  const discoveredAt = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(discoveredAt.getTime())) throw new Error('invalid discovery timestamp');

  return {
    source_run_id: clean(runId),
    discovered_at: discoveredAt.toISOString(),
    source: clean(source).toLowerCase(),
    scope: clean(scope).toLowerCase(),
    source_company: company,
    normalized_source_company: normalizeCompanyIdentity(company),
    job_title: title,
    job_location: clean(row?.location ?? row?.job_location),
    job_url: canonicalLeadUrl(row?.url ?? row?.job_url),
    ...normalizePostedAt(row?.posted_at_raw ?? row?.posted_at ?? row?.postedAt ?? row?.date_posted),
  };
}

export function leadKey(row) {
  if (row.job_url) return [row.source, row.scope, row.job_url].join('|');
  return [
    row.source,
    row.scope,
    row.normalized_source_company,
    normalizeLeadText(row.job_title),
    normalizeLeadText(row.job_location),
    row.posted_at,
  ].join('|');
}

function ledgerPath(dataRoot) {
  return join(dataRoot, 'data/sunny-company-leads.tsv');
}

function parseLedger(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').trimEnd().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines.shift().split('\t');
  return lines.filter(Boolean).map(line => {
    const values = line.split('\t');
    return Object.fromEntries(header.map((column, index) => [column, values[index] ?? '']));
  });
}

function renderRow(row) {
  return `${LEAD_COLUMNS.map(column => clean(row[column])).join('\t')}\n`;
}

export function readLeadRows({ dataRoot = getCareerOpsRoot() } = {}) {
  return parseLedger(ledgerPath(dataRoot));
}

export async function ingestLeadRows(rows, {
  dataRoot = getCareerOpsRoot(),
  source,
  scope,
  runId,
  now = new Date(),
  lockOptions,
} = {}) {
  if (!Array.isArray(rows)) throw new Error('lead input must be an array');
  const path = ledgerPath(dataRoot);
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const lock = await acquirePipelineLock(join(dataRoot, 'data/.sunny-company-state'), lockOptions);

  try {
    const previous = parseLedger(path);
    const known = new Set(previous.map(leadKey));
    const accepted = [];
    const rejected = [];
    let duplicates = 0;

    for (const [index, row] of rows.entries()) {
      let normalized;
      try {
        normalized = normalizeLead(row, { source, scope, runId, now });
      } catch (error) {
        rejected.push({ index, error: String(error?.message || error) });
        continue;
      }

      const key = leadKey(normalized);
      if (known.has(key)) {
        duplicates += 1;
        continue;
      }
      known.add(key);
      accepted.push(normalized);
    }

    const oldHeader = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/, 1)[0] : '';
    if (oldHeader && oldHeader !== LEAD_COLUMNS.join('\t')) {
      const columns = oldHeader.split('\t');
      if (columns.some(column => !LEAD_COLUMNS.includes(column))) throw new Error('Unknown lead ledger columns; refusing destructive schema migration');
      const migrated = previous.map(row => ({ ...row,
        ...normalizePostedAt(row.posted_at_raw || row.posted_at) }));
      const temporary = `${path}.tmp-${randomUUID()}`;
      writeFileSync(temporary, `${LEAD_COLUMNS.join('\t')}\n${[...migrated, ...accepted].map(renderRow).join('')}`, 'utf8');
      renameSync(temporary, path);
    } else if (accepted.length) {
      if (!oldHeader) appendFileSync(path, `${LEAD_COLUMNS.join('\t')}\n`, 'utf8');
      appendFileSync(path, accepted.map(renderRow).join(''), 'utf8');
    }

    return {
      received: rows.length,
      appended: accepted.length,
      duplicates,
      rejected,
    };
  } finally {
    lock.release();
  }
}
