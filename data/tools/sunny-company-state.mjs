#!/usr/bin/env node

/** Durable, concurrency-safe state for Sunny's company discovery pipeline. */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { acquirePipelineLock } from '../../pipeline-lock.mjs';

export const RESOLUTION_COLUMNS = [
  'normalized_lead', 'preferred_name', 'first_seen', 'last_seen', 'source_count',
  'status', 'dol_legal_name', 'dol_dba', 'transfer_positions', 'match_type',
  'provider', 'board_identifier', 'careers_url', 'board_owner', 'health_status',
  'last_attempt_at', 'next_retry_at', 'backfill_status', 'backfill_window_start',
  'backfill_window_end', 'backfill_attempted_at', 'backfill_completed_at',
  'backfill_error', 'evidence', 'reason',
];

export const RESOLUTION_STATUSES = new Set([
  'already_tracked', 'dol_rejected', 'dol_ambiguous', 'ats_unresolved',
  'official_careers_only', 'identity_review', 'verification_error', 'accepted',
]);

export const BACKFILL_STATUSES = new Set([
  'not_applicable', 'pending', 'running', 'retry_error', 'retry_partial', 'complete',
]);

export function statePaths(dataRoot = getCareerOpsRoot()) {
  return {
    root: dataRoot,
    config: join(dataRoot, 'profiles/sunny-company-discovery.yml'),
    reviewsV2: join(dataRoot, 'profiles/sunny-company-identity-reviews-v2.yml'),
    portals: join(dataRoot, 'portals.yml'),
    leads: join(dataRoot, 'data/sunny-company-leads.tsv'),
    resolution: join(dataRoot, 'data/sunny-company-resolution.tsv'),
    companyStateLock: join(dataRoot, 'data/.sunny-company-state'),
    scanRunLock: join(dataRoot, 'data/.sunny-scan-run'),
    inbox: join(dataRoot, 'data/company-discovery/inbox'),
    receipts: join(dataRoot, 'data/company-discovery/receipts'),
  };
}

function cleanCell(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

function parseTsv(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8').trimEnd();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const header = lines.shift().split('\t');
  return lines.filter(Boolean).map(line => {
    const values = line.split('\t');
    return Object.fromEntries(header.map((column, index) => [column, values[index] ?? '']));
  });
}

function renderResolution(rows) {
  const body = rows.map(row => RESOLUTION_COLUMNS
    .map(column => cleanCell(row[column]))
    .join('\t'));
  return `${RESOLUTION_COLUMNS.join('\t')}\n${body.length ? `${body.join('\n')}\n` : ''}`;
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, content, 'utf8');
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* nothing to clean */ }
    throw error;
  }
}

function validateResolutionRow(row) {
  if (!row?.normalized_lead) throw new Error('resolution row requires normalized_lead');
  if (row.status && !RESOLUTION_STATUSES.has(row.status)) {
    throw new Error(`invalid resolution status: ${row.status}`);
  }
  if (row.backfill_status && !BACKFILL_STATUSES.has(row.backfill_status)) {
    throw new Error(`invalid backfill status: ${row.backfill_status}`);
  }
}

export function mergeResolutionRows(current, incoming) {
  const byKey = new Map();
  for (const row of current || []) {
    validateResolutionRow(row);
    byKey.set(row.normalized_lead, { ...row });
  }
  for (const row of incoming || []) {
    validateResolutionRow(row);
    byKey.set(row.normalized_lead, { ...(byKey.get(row.normalized_lead) || {}), ...row });
  }
  return [...byKey.values()].sort((left, right) => (
    left.normalized_lead.localeCompare(right.normalized_lead)
  ));
}

export function readResolutionRows({ dataRoot = getCareerOpsRoot() } = {}) {
  return parseTsv(statePaths(dataRoot).resolution);
}

export async function withCompanyStateLock(fn, {
  dataRoot = getCareerOpsRoot(),
  lockOptions,
} = {}) {
  const paths = statePaths(dataRoot);
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const lock = await acquirePipelineLock(paths.companyStateLock, lockOptions);
  try {
    return await fn(paths);
  } finally {
    lock.release();
  }
}

export async function updateResolutionRows(incomingOrUpdater, options = {}) {
  return withCompanyStateLock((paths) => {
    const current = parseTsv(paths.resolution);
    const incoming = typeof incomingOrUpdater === 'function'
      ? incomingOrUpdater(current.map(row => ({ ...row })))
      : incomingOrUpdater;
    if (!Array.isArray(incoming)) throw new Error('resolution updater must return an array');
    const next = typeof incomingOrUpdater === 'function'
      ? incoming
      : mergeResolutionRows(current, incoming);
    for (const row of next) validateResolutionRow(row);
    const ordered = [...next].sort((left, right) => (
      left.normalized_lead.localeCompare(right.normalized_lead)
    ));
    atomicWrite(paths.resolution, renderResolution(ordered));
    return ordered;
  }, options);
}

function isoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid timestamp: ${value}`);
  return date.toISOString();
}

function utcDate(value) {
  return isoTimestamp(value).slice(0, 10);
}

function subtractUtcDays(dateString, count) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - count);
  return date.toISOString().slice(0, 10);
}

export function startBackfill(row, acceptedAt = new Date(), days = 20) {
  const numericDays = Number(days);
  if (!Number.isInteger(numericDays) || numericDays < 1) {
    throw new Error('backfill days must be a positive integer');
  }
  const end = utcDate(acceptedAt);
  const keepExistingAnchor = row.backfill_window_start && row.backfill_window_end;
  return {
    ...row,
    backfill_status: 'running',
    backfill_window_start: keepExistingAnchor
      ? row.backfill_window_start
      : subtractUtcDays(end, numericDays - 1),
    backfill_window_end: keepExistingAnchor ? row.backfill_window_end : end,
    backfill_attempted_at: isoTimestamp(acceptedAt),
    backfill_completed_at: '',
    backfill_error: '',
  };
}

export function finishBackfill(row, result, finishedAt = new Date()) {
  if (!row?.backfill_window_start || !row?.backfill_window_end) {
    throw new Error('cannot finish an unanchored backfill');
  }
  const at = isoTimestamp(finishedAt);
  const status = result?.status;
  if (!['complete', 'partial', 'error'].includes(status)) {
    throw new Error(`invalid backfill result: ${status}`);
  }
  return {
    ...row,
    backfill_status: status === 'complete'
      ? 'complete'
      : status === 'partial' ? 'retry_partial' : 'retry_error',
    backfill_attempted_at: at,
    backfill_completed_at: status === 'complete' ? at : '',
    backfill_error: status === 'complete' ? '' : cleanCell(result?.error || status),
  };
}

export function nextRetryAt(now = new Date(), { minutes, days } = {}) {
  const date = new Date(isoTimestamp(now));
  if (minutes != null) date.setUTCMinutes(date.getUTCMinutes() + Number(minutes));
  if (days != null) date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString();
}

export function retryIsDue(row, now = new Date()) {
  if (!row?.next_retry_at) return true;
  const retryAt = Date.parse(row.next_retry_at);
  return Number.isNaN(retryAt) || retryAt <= new Date(now).getTime();
}
