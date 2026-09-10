#!/usr/bin/env node
/** Offline coverage, not a live scan or a market-size estimate. */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { loadProviders, resolveProvider } from '../../providers/_registry.mjs';
import { acquirePipelineLock } from '../../pipeline-lock.mjs';
import { normalizeCompanyIdentity } from './build-sunny-h1b-ats-universe.mjs';
import { portalEntryBoardKey, portalBoardKey } from './sunny-company-expansion.mjs';
import { parseQuotedTsv } from './sunny-tsv.mjs';

const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cell = value => String(value ?? '').replace(/[\t\n\r]/g, ' ');
function tsv(file) {
  if (!existsSync(file)) return [];
  return parseQuotedTsv(readFileSync(file, 'utf8'));
}
function boardKey(entry) {
  return portalEntryBoardKey(entry) || `${entry.provider || 'unresolved'}\t${entry.api || entry.careers_url || entry.name}`;
}
function officialUrlKey(raw) {
  if (!raw) return '';
  try { const u = new URL(raw); return u.origin + u.pathname.replace(/\/+$/, '') + u.search + u.hash; }
  catch { return String(raw); }
}
function latestBy(rows, key, time) {
  const result = new Map();
  for (const row of rows) {
    const k = key(row); const previous = result.get(k);
    if (!previous || (Date.parse(time(row)) || 0) > (Date.parse(time(previous)) || 0)) result.set(k, row);
  }
  return result;
}

function boardHealthEvidence(entry, observation, ambiguous, scanReceipts, now) {
  const evidence = [];
  if (observation && !ambiguous) evidence.push({ status: observation.status, at: observation.timestamp });
  for (const run of scanReceipts) {
    if (run.dry_run) continue;
    const exact = run.kind === 'backfill' && portalBoardKey(run) === boardKey(entry);
    const namedPartial = run.kind === 'daily' && (run.warnings || []).some(warning =>
      /partial|truncat|page cap|max_pages/i.test(warning)
      && String(warning).toLowerCase().includes(entry.name.toLowerCase()));
    if (exact && ['error', 'partial'].includes(run.completion_status)) {
      evidence.push({ status: run.completion_status, at: run.finished_at });
    } else if (namedPartial) {
      evidence.push({ status: 'partial', at: run.finished_at });
    } else if (exact && run.completion_status === 'complete'
      && run.scan_receipt?.version === 'careerops.scan.receipt@1'
      && run.scan_receipt.scanned === 1 && run.scan_receipt.skipped === 0
      && Array.isArray(run.scan_receipt.errors) && run.scan_receipt.errors.length === 0) {
      evidence.push({ status: run.scan_receipt.found === 0 ? 'empty' : 'reachable', at: run.finished_at });
    }
    // A global daily status has no per-board identity; it cannot clear a failure.
  }
  const failed = item => !['reachable', 'empty'].includes(item.status);
  return evidence.filter(item => Number.isFinite(Date.parse(item.at)) && Date.parse(item.at) <= Date.parse(now))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || Number(failed(b)) - Number(failed(a)))[0];
}

export function buildCoverage({ portals = {}, providers, healthRows = [], metroRows = [], nationalRows = [],
  sourceRuns = [], scanReceipts = [], progress = {}, now = new Date(), freshDays = 7 } = {}) {
  const timestamp = new Date(now).toISOString();
  const fresh = value => Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.parse(timestamp)
    && Date.parse(timestamp) - Date.parse(value) <= freshDays * 86400000;
  const all = portals.tracked_companies || [];
  const enabled = all.filter(entry => entry.enabled !== false);
  const names = new Set(enabled.map(entry => normalizeCompanyIdentity(entry.name)));
  const shared = (portals.job_boards || []).filter(entry => entry.enabled !== false && resolveProvider(entry, providers)?.provider);
  const urls = new Set([...enabled, ...shared].map(entry => officialUrlKey(entry.careers_url)).filter(Boolean));
  const health = latestBy(healthRows, row => row.company, row => row.timestamp);
  const nameBoards = new Map();
  for (const entry of enabled) {
    if (!nameBoards.has(entry.name)) nameBoards.set(entry.name, new Set());
    nameBoards.get(entry.name).add(boardKey(entry));
  }
  const gapMap = new Map();
  function gap(item) {
    if (/^meta(?:platforms)?$/.test(normalizeCompanyIdentity(item.company))) return;
    const prior = progress[item.key];
    const row = { ...item, previous_outcome: prior?.outcome || '', next_retry_at: prior?.next_retry_at || '',
      due: !prior?.next_retry_at || Date.parse(prior.next_retry_at) <= Date.parse(timestamp) };
    if (!gapMap.has(row.key) || gapMap.get(row.key).priority > row.priority) gapMap.set(row.key, row);
  }
  const boards = enabled.map(entry => {
    const route = resolveProvider(entry, providers);
    const provider = route?.provider?.id || '';
    const matches = metroRows.filter(row => row.status !== 'excluded' && (
      normalizeCompanyIdentity(row.preferred_name) === normalizeCompanyIdentity(entry.name)
      || (row.careers_url && officialUrlKey(row.careers_url) === officialUrlKey(entry.careers_url))));
    const weight = matches.reduce((sum, row) => sum + Number(row.metro_transfer_positions || 0), 0);
    const observation = health.get(entry.name);
    const ambiguous = nameBoards.get(entry.name).size > 1 && !!observation;
    const evidence = boardHealthEvidence(entry, observation, ambiguous, scanReceipts, timestamp);
    const recentSuccess = !!provider && fresh(evidence?.at) && ['reachable', 'empty'].includes(evidence?.status);
    const row = { company: entry.name, board_key: boardKey(entry), careers_url: entry.careers_url || '',
      provider, route_error: route?.error || '', routable: !!provider,
      health_status: evidence?.status || (ambiguous ? 'ambiguous_name_only' : 'unobserved'),
      health_at: evidence?.at || '', recent_success: recentSuccess,
      metro_transfer_positions: weight };
    const base = { key: row.board_key, company: entry.name, careers_url: row.careers_url,
      provider, metro_transfer_positions: weight, scope: weight > 0 ? 'nyc' : 'remote' };
    if (!provider) gap({ ...base, kind: 'repair_provider', priority: 1,
      reason: row.route_error || 'Official/configured URL has no scanner provider; not actual scan coverage' });
    else if (evidence && !['reachable', 'empty'].includes(evidence.status)) {
      gap({ ...base, kind: 'repair_scan', priority: 0, reason: `Latest recorded health: ${row.health_status} at ${row.health_at}` });
    } else if (!recentSuccess) gap({ ...base, kind: 'verify_health', priority: 3,
      reason: ambiguous ? 'Company-name health cannot identify which board succeeded' : 'No recent successful health observation' });
    return row;
  });
  const metroNames = new Set(metroRows.map(row => normalizeCompanyIdentity(row.preferred_name)));
  for (const row of metroRows) {
    if (row.status === 'excluded' || names.has(normalizeCompanyIdentity(row.preferred_name))
      || (row.careers_url && urls.has(officialUrlKey(row.careers_url)))) continue;
    gap({ key: `metro\t${row.identity}`, kind: 'resolve_metro', priority: 2, scope: 'nyc',
      company: row.preferred_name, careers_url: row.careers_url || '', provider: row.provider || '',
      metro_transfer_positions: Number(row.metro_transfer_positions || 0),
      dol_legal_names: row.legal_names || '', reason: `${row.status || 'unresolved'}; needs current identity/ATS verification` });
  }
  // National employers are leads, not evidence of NYC offices or remote hiring.
  for (const row of nationalRows) {
    const legal = normalizeCompanyIdentity(row.EMPLOYER_NAME);
    const dba = normalizeCompanyIdentity(row.DBA);
    if (!(Number(row.transfer_positions) > 0) || names.has(legal) || (dba && names.has(dba)) || metroNames.has(legal)) continue;
    gap({ key: `national\t${legal}\t${dba}`, kind: 'resolve_national', priority: 4, scope: 'remote',
      company: row.DBA || row.EMPLOYER_NAME, dol_legal_names: row.EMPLOYER_NAME,
      careers_url: '', provider: '', metro_transfer_positions: 0, transfer_positions: Number(row.transfer_positions),
      reason: 'National positive CHANGE_EMPLOYER lead only; NY-eligible remote opening and official ATS still unverified' });
  }
  const gaps = [...gapMap.values()].sort((a, b) => a.priority - b.priority
    || b.metro_transfer_positions - a.metro_transfer_positions
    || Number(b.transfer_positions || 0) - Number(a.transfer_positions || 0) || a.key.localeCompare(b.key));
  const sourceLatest = latestBy(sourceRuns, row => `${row.source}|${row.scope}`, row => row.collected_at || row.completed_at);
  const sourceScopes = [
    ...['indeed', 'builtin', 'freehire', 'himalayas', 'jobicy'].flatMap(source => ['nyc', 'remote'].map(scope => ({ source, scope }))),
    ...['nyc', 'remote'].map(scope => ({ source: 'newgradjobs', scope })),
    { source: 'openjobsfleet', scope: 'remote' },
  ];
  const source_health = sourceScopes.map(({ source, scope }) => {
    const run = sourceLatest.get(`${source}|${scope}`);
    const at = run?.collected_at || run?.completed_at || '';
    return { source, scope, at, status: !run ? 'missing' : run.status || (run.error ? 'error' : 'observed_not_exhaustive'),
      stale: !fresh(at), observed_jobs: run?.jobs?.length || 0,
      observed_company_names: new Set((run?.jobs || []).map(job => normalizeCompanyIdentity(job.company))).size,
      error: run?.error || '', run_id: run?.run_id || '' };
  });
  return { schema_version: 1, generated_at: timestamp, mode: 'offline',
    caveats: ['Provider routing is capability, not a live successful scan.',
      'Configured name keys are not verified distinct legal employers.',
      'Metro input scope/vintage is retained; this is not nationwide market recall.',
      'National leads do not prove remote hiring. Source samples do not prove exhaustive searches.'],
    counts: { enabled_portal_rows: enabled.length, disabled_portal_rows: all.length - enabled.length,
      configured_name_keys: names.size, unique_board_keys: new Set(boards.map(row => row.board_key)).size,
      routable_portal_rows: boards.filter(row => row.routable).length,
      routable_unique_board_keys: new Set(boards.filter(row => row.routable).map(row => row.board_key)).size,
      no_provider_rows: boards.filter(row => !row.routable).length,
      recent_success_portal_rows: boards.filter(row => row.recent_success).length,
      ambiguous_health_portal_rows: boards.filter(row => row.health_status === 'ambiguous_name_only').length,
      enabled_shared_job_boards: (portals.job_boards || []).filter(row => row.enabled !== false).length,
      metro_rows: metroRows.length, metro_excluded_rows: metroRows.filter(row => row.status === 'excluded').length,
      gap_rows: gaps.length, due_gap_rows: gaps.filter(row => row.due).length },
    gap_counts: Object.fromEntries([...new Set(gaps.map(row => row.kind))].map(kind => [kind, gaps.filter(row => row.kind === kind).length])),
    scan_warning_receipts: scanReceipts.filter(run => !run.dry_run && run.warnings?.length).map(run => ({
      run_id: run.run_id, finished_at: run.finished_at, company: run.company || '', warnings: run.warnings,
      note: 'Historical warnings; unbound warning text is not proof that a specific board is healthy or unhealthy.' })),
    provider_counts: Object.fromEntries([...new Set(boards.map(row => row.provider || 'no-provider'))].map(id => [id,
      boards.filter(row => (row.provider || 'no-provider') === id).length])), source_health, boards, gaps };
}

export function selectCoverageGaps(report, { scope, limit = 12 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Coverage batch limit must be 1–100');
  const due = report.gaps.filter(row => row.due && (!scope || row.scope === scope));
  const buckets = ['repair_scan', 'repair_provider', 'resolve_metro', 'resolve_national', 'verify_health']
    .map(kind => due.filter(row => row.kind === kind));
  const selected = [];
  while (selected.length < limit && buckets.some(bucket => bucket.length)) {
    for (const bucket of buckets) { if (bucket.length && selected.length < limit) selected.push(bucket.shift()); }
  }
  return selected;
}

function atomicJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${randomUUID()}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); renameSync(temp, file);
}

export async function recordGapAttempt({ key, outcome, reason, evidence_url = '', now = new Date(), retryDays },
  { dataRoot = getCareerOpsRoot() } = {}) {
  if (!key || !reason || !['updated', 'needs_review', 'transient', 'not_applicable'].includes(outcome)) throw new Error('Gap attempt requires key, outcome and reason');
  const reportFile = join(dataRoot, 'data/company-discovery/coverage/latest.json');
  const known = existsSync(reportFile) && JSON.parse(readFileSync(reportFile, 'utf8')).gaps.some(row => row.key === key);
  if (!known) throw new Error('Unknown gap key; rebuild coverage before recording an attempt');
  if (outcome === 'updated' && !/^https:\/\//.test(evidence_url)) throw new Error('Updated gap requires official evidence URL');
  const file = join(dataRoot, 'data/company-discovery/coverage/progress.json');
  const lock = await acquirePipelineLock(join(dataRoot, 'data/.sunny-company-state'));
  try {
    const doc = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    const days = retryDays ?? (outcome === 'transient' ? 0.125 : 7);
    if (!Number.isFinite(days) || days < 0) throw new Error('Invalid cooldown');
    const previous = doc[key];
    const record = { outcome, reason, evidence_url, attempted_at: new Date(now).toISOString(),
      next_retry_at: new Date(Date.parse(now) + days * 86400000).toISOString() };
    const history = previous?.attempt_records || (previous ? [{ outcome: previous.outcome,
      reason: previous.reason, evidence_url: previous.evidence_url, attempted_at: previous.attempted_at,
      next_retry_at: previous.next_retry_at }] : []);
    doc[key] = { ...record, attempts: Number(previous?.attempts || 0) + 1, attempt_records: [...history, record] };
    atomicJson(file, doc); return doc[key];
  } finally { lock.release(); }
}

export async function runCoverageAudit({ dataRoot = getCareerOpsRoot(), write = false } = {}) {
  const config = yaml.load(readFileSync(join(dataRoot, 'profiles/sunny-company-discovery.yml'), 'utf8'));
  const coverage = config.coverage || {};
  const base = join(dataRoot, 'data/company-discovery/coverage');
  const inbox = join(dataRoot, 'data/company-discovery/inbox');
  const inputErrors = [];
  const requiredTsv = file => {
    try {
      if (!existsSync(file)) throw new Error('required coverage input missing');
      return tsv(file);
    } catch (error) { inputErrors.push({ file, error: error.message }); return []; }
  };
  const sources = [];
  for (const name of existsSync(inbox) ? readdirSync(inbox).filter(name => name.endsWith('.json')) : []) {
    try { sources.push(JSON.parse(readFileSync(join(inbox, name), 'utf8'))); }
    catch (error) { inputErrors.push({ file: name, error: error.message }); }
  }
  const receiptDir = join(dataRoot, 'data/company-discovery/receipts');
  const scanReceipts = [];
  for (const name of existsSync(receiptDir) ? readdirSync(receiptDir).filter(name => /^(backfill|daily)-.*\.json$/.test(name)) : []) {
    try { scanReceipts.push(JSON.parse(readFileSync(join(receiptDir, name), 'utf8'))); }
    catch (error) { inputErrors.push({ file: name, error: error.message }); }
  }
  const result = buildCoverage({ portals: yaml.load(readFileSync(join(dataRoot, 'portals.yml'), 'utf8')),
    providers: await loadProviders(join(CODE_ROOT, 'providers')),
    healthRows: requiredTsv(join(dataRoot, 'data/portal-health.tsv')),
    metroRows: requiredTsv(resolve(dataRoot, coverage.metro_resolution || 'data/cache/dol/sunny-ny-metro-resolution-2026-09-02.tsv')),
    nationalRows: requiredTsv(resolve(dataRoot, config.dol_employers)), sourceRuns: sources, scanReceipts,
    progress: existsSync(join(base, 'progress.json')) ? JSON.parse(readFileSync(join(base, 'progress.json'), 'utf8')) : {} });
  result.input_errors = inputErrors;
  result.inputs_complete = inputErrors.length === 0;
  if (write) {
    atomicJson(join(base, `baseline-${result.generated_at.replace(/[:.]/g, '-')}.json`), result);
    atomicJson(join(base, 'latest.json'), result);
    const columns = ['key', 'kind', 'scope', 'company', 'provider', 'careers_url', 'metro_transfer_positions', 'transfer_positions', 'due', 'next_retry_at', 'reason'];
    const temp = join(base, `gaps.tmp-${randomUUID()}`);
    // JSON is canonical; replace TSV tabs inside the compound board key with '|'.
    writeFileSync(temp, `${columns.join('\t')}\n${result.gaps.map(row => columns.map(key => cell(row[key])).join('\t')).join('\n')}\n`);
    renameSync(temp, join(base, 'gaps.tsv'));
  }
  return result;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  Promise.resolve().then(async () => {
    if (args.includes('--record')) return recordGapAttempt({ key: value('--key'), outcome: value('--outcome'),
      reason: value('--reason'), evidence_url: value('--evidence-url') });
    const result = await runCoverageAudit({ write: args.includes('--write') });
    if (args.includes('--next')) return selectCoverageGaps(result, { scope: value('--scope'), limit: Number(value('--limit') || 12) });
    return { generated_at: result.generated_at, counts: result.counts, gap_counts: result.gap_counts,
      source_health: result.source_health, input_errors: result.input_errors,
      ...(args.includes('--write') ? { report: join(getCareerOpsRoot(), 'data/company-discovery/coverage/latest.json') } : {}) };
  }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
