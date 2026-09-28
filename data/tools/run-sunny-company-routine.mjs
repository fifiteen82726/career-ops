#!/usr/bin/env node
/** Bounded, single-scope orchestration for Sunny company discovery. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { makeHttpCtx } from '../../providers/_http.mjs';
import { collectBuiltinLeads, hostsForScope } from './collect-sunny-builtin-leads.mjs';
import { collectFreehireLeads, collectHimalayasLeads, collectJobicyLeads, collectNewgradJobsLeads, collectTheMuseLeads } from './collect-sunny-dashboard-leads.mjs';
import { ingestLeadRows } from './sunny-company-leads.mjs';
import { runPendingBackfills, runResolution, writeJsonReceipt } from './sunny-company-expansion.mjs';
import { statePaths } from './sunny-company-state.mjs';
import { runCoverageAudit, selectCoverageGaps } from './audit-sunny-coverage.mjs';
import { createSunnyCheckpoint, withSunnyRoutineLease } from './sunny-routine-runtime.mjs';

const cleanError = error => String(error?.message || error || 'unknown error');
const deadlineReached = (deadlineAt, clock) => deadlineAt != null && clock() >= new Date(deadlineAt);
const validScope = scope => scope === 'nyc' || scope === 'remote';

function sourceDefinitions(scope) {
  const shared = [
    ['builtin', ({ httpCtx }) => collectBuiltinLeads({ hosts: hostsForScope(scope), maxPages: 1, httpCtx })],
    ['freehire', ({ requestJson, continuation }) => collectFreehireLeads({ scope, maxPages: 1, requestJson, continuation })],
    ['themuse', ({ requestJson, continuation }) => collectTheMuseLeads({ scope, maxPages: 1, requestJson, continuation })],
    ['newgradjobs', ({ requestJson, requestText, continuation }) => collectNewgradJobsLeads({ scope, maxPagesPerCategory: 1, requestJson, requestText, continuation })],
  ];
  return scope === 'remote' ? [...shared,
    ['himalayas', ({ requestJson, continuation }) => collectHimalayasLeads({ scope, maxPagesPerQuery: 1, requestJson, continuation })],
    ['jobicy', ({ requestJson }) => collectJobicyLeads({ scope, requestJson })],
  ] : shared;
}

function savedContinuation(paths, { source, scope, mode }) {
  if (!existsSync(paths.inbox)) return null;
  const prefix = `${source}-${scope}-${mode}-`;
  const candidates = readdirSync(paths.inbox).filter(name => name.startsWith(prefix) && name.endsWith('.json'))
    .map(name => {
      try { return JSON.parse(readFileSync(join(paths.inbox, name), 'utf8')); } catch { return null; }
    })
    .filter(value => value?.source === source && value?.scope === scope && value?.mode === mode
      && value?.status === 'partial' && value?.continuation);
  candidates.sort((left, right) => String(right.collected_at || '').localeCompare(String(left.collected_at || '')));
  return candidates[0]?.continuation || null;
}

/** Collect one scope only and preserve partial source evidence in inbox+receipt files. */
export async function collectSunnyScope({ dataRoot, scope, mode = 'incremental', now = new Date(), deadlineAt, clock = () => new Date(), collectors } = {}) {
  if (!validScope(scope)) throw new Error('scope must be nyc or remote');
  const paths = statePaths(dataRoot); const results = [];
  for (const [source, collect] of (collectors || sourceDefinitions(scope))) {
    const requests = []; let failure = ''; let rows = []; let status = 'success';
    const recordRequest = url => requests.push({ url, started_at: new Date(clock()).toISOString() });
    const requestOptions = options => {
      if (deadlineReached(deadlineAt, clock)) throw new Error('deadline reached before source request');
      const remaining = deadlineAt == null ? 30_000 : new Date(deadlineAt).getTime() - new Date(clock()).getTime();
      if (remaining <= 0) throw new Error('deadline reached before source request');
      return { ...options, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, remaining))) };
    };
    const requestJson = async (url, options) => {
      try {
        const request = requestOptions(options); recordRequest(url);
        const response = await fetch(url, request);
        requests.at(-1).http_status = response.status;
        if (!response.ok) throw new Error(`${new URL(url).hostname}: HTTP ${response.status}`);
        return response.json();
      } catch (error) { requests.at(-1).error = cleanError(error); throw error; }
    };
    const requestText = async (url, options = {}) => {
      try {
        const request = requestOptions(options); recordRequest(url);
        const response = await fetch(url, request);
        requests.at(-1).http_status = response.status;
        if (!response.ok) throw new Error(`${new URL(url).hostname}: HTTP ${response.status}`);
        return response.text();
      } catch (error) { requests.at(-1).error = cleanError(error); throw error; }
    };
    const httpCtx = makeHttpCtx({ requestOptions: (_url, options = {}) => requestOptions(options), onRequest: recordRequest, onResponse: (statusCode, url, headers) => {
      const item = requests.findLast(row => row.url === url) || requests.at(-1);
      if (item) { item.http_status = statusCode; item.retry_after = headers?.get?.('retry-after') || ''; }
    } });
    httpCtx.onError = (error, url) => {
      const item = requests.findLast(row => row.url === url) || requests.at(-1);
      if (item) item.error = cleanError(error);
    };
    try {
      if (deadlineReached(deadlineAt, clock)) throw new Error('deadline reached before source request');
      rows = await collect({ requestJson, requestText, httpCtx, continuation: savedContinuation(paths, { source, scope, mode }) });
      const progress = rows?.collection;
      if (progress?.status === 'partial') {
        status = 'partial';
        failure = progress.error || 'collector returned partial progress';
      }
    } catch (error) { failure = cleanError(error); status = rows.length ? 'partial' : 'failure'; }
    if (requests.some(request => request.error) && status === 'success') { status = 'partial'; failure = 'one or more source requests failed'; }
    if (deadlineReached(deadlineAt, clock) && status === 'success') status = 'partial';
    const runId = `${source}-${scope}-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
    const payload = { schema_version: 1, run_id: runId, source, scope, mode, collected_at: new Date(now).toISOString(), status,
      request_count: requests.length, requests, jobs: rows, ...(failure ? { error: failure } : {}),
      page_count: rows?.collection?.page_count ?? null,
      query_count: rows?.collection?.query_count ?? null,
      continuation: status === 'success' ? null : (rows?.collection?.continuation || { scope, source, reason: failure || 'deadline reached' }) };
    const payloadPath = join(paths.inbox, `${runId}.json`); mkdirSync(dirname(payloadPath), { recursive: true });
    writeFileSync(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    let ingestion = { received: 0, appended: 0, duplicates: 0, rejected: [] };
    try { ingestion = await ingestLeadRows(rows, { dataRoot, source, scope, runId, now }); }
    catch (error) { status = 'failure'; failure = cleanError(error); payload.status = status; payload.error = failure; writeFileSync(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8'); }
    const receipt = { schema_version: 1, command: 'collect', source, scope, status, run_id: runId, payload_path: payloadPath,
      request_count: requests.length, requests, retained_rows: rows.length, ingestion, ...(failure ? { error: failure } : {}),
      page_count: payload.page_count, query_count: payload.query_count,
      continuation: payload.continuation, completed_at: new Date(clock()).toISOString() };
    results.push({ ...receipt, receipt_path: writeJsonReceipt(paths, `collect-${source}-${scope}`, receipt, now) });
  }
  return results;
}

export async function runSunnyCoverageStage({ dataRoot, scope, maxBoards, now = new Date(),
  audit = runCoverageAudit, select = selectCoverageGaps,
} = {}) {
  const report = await audit({ dataRoot, write: true });
  const selected = select(report, { scope, limit: Math.min(Number(maxBoards) || 12, 100) });
  const workItems = selected.map(row => ({ key: row.key, kind: row.kind, scope: row.scope, company: row.company,
    reason: row.reason, status: 'needs_review', next_action: `run bounded official identity/ATS verification for ${row.key}` }));
  // Selection is not evidence of verification. Persist a resumable work-item
  // receipt without changing coverage progress, attempts, or cooldowns.
  const paths = statePaths(dataRoot);
  const workItemsReceipt = writeJsonReceipt(paths, `coverage-review-${scope}`, {
    schema_version: 1, command: 'coverage-review-work-items', scope,
    status: workItems.length ? 'deferred' : 'complete', created_at: new Date(now).toISOString(), work_items: workItems,
  }, now);
  return { selected: workItems, deferred: workItems.length > 0, work_items_receipt: workItemsReceipt };
}

export async function runSunnyCompanyRoutine({
  dataRoot = getCareerOpsRoot(), scope, deadlineAt, maxBoards = Infinity, clock = () => new Date(),
  collect = (targetScope, options) => collectSunnyScope({ dataRoot, scope: targetScope, ...options }),
  resolve = (targetScope, options) => runResolution({ dataRoot, scope: targetScope, mode: 'incremental', write: true, ...options }),
  // Each backfill rechecks the pre-noon guard through the shared expansion
  // path; company discovery must never bypass the daily scan's priority.
  backfill = options => runPendingBackfills({ dataRoot, ...options }),
  coverage = options => runSunnyCoverageStage({ dataRoot, ...options }), checkpoint = createSunnyCheckpoint,
  backupDir = process.env.SUNNY_STATE_BACKUP_DIR || join(dataRoot, '.sunny-state-backups'), lockOptions,
} = {}) {
  if (!validScope(scope)) throw new Error('scope must be nyc or remote');
  if (deadlineAt != null && Number.isNaN(new Date(deadlineAt).getTime())) throw new Error('deadlineAt must be a valid timestamp');
  if (!(maxBoards === Infinity || (Number.isInteger(maxBoards) && maxBoards > 0))) throw new Error('maxBoards must be a positive integer or Infinity');
  return withSunnyRoutineLease('company', async () => {
    const stages = []; let status = 'success'; const paths = statePaths(dataRoot);
    const runStage = async (stage, fn) => {
      if (deadlineReached(deadlineAt, clock)) { status = 'partial'; stages.push({ scope, stage, status: 'partial', reason: 'deadline reached' }); return null; }
      try {
        const result = await fn();
        const collectorPartial = Array.isArray(result) && result.some(item => item?.status !== 'success');
        const stagePartial = result?.deferred_deadline || result?.deferred === true || collectorPartial
          || Number(result?.error || 0) > 0 || Number(result?.partial || 0) > 0
          || result?.deferred_pre_noon === true;
        stages.push({ scope, stage, status: stagePartial ? 'partial' : 'complete', result });
        if (stagePartial) status = 'partial';
        return result;
      }
      catch (error) { status = 'partial'; stages.push({ scope, stage, status: 'error', error: cleanError(error) }); return null; }
    };
    await runStage('collect', () => collect(scope, { deadlineAt, maxBoards, clock }));
    await runStage('resolve', () => resolve(scope, { deadlineAt, maxBoards, clock }));
    await runStage('backfill', () => backfill({ scope, deadlineAt, maxBoards, clock }));
    await runStage('coverage', () => coverage({ scope, maxBoards, now: clock() }));
    let checkpointResult; try { checkpointResult = checkpoint({ dataRoot, backupDir, now: clock() }); }
    catch (error) { status = 'partial'; checkpointResult = { verified: false, error: cleanError(error) }; }
    const receipt = { schema_version: 1, command: 'company-routine', scope, status, stages, deadline_at: deadlineAt ? new Date(deadlineAt).toISOString() : null,
      max_boards: maxBoards, checkpoint: checkpointResult, completed_at: new Date(clock()).toISOString() };
    return { ...receipt, receipt_path: writeJsonReceipt(paths, `company-routine-${scope}`, receipt, clock()) };
  }, { dataRoot, lockOptions });
}

function value(args, flag) { const index = args.indexOf(flag); return index === -1 ? undefined : args[index + 1]; }

export function parseSunnyCompanyRoutineArgs(args) {
  const deadlineAt = value(args, '--deadline-at');
  const scope = value(args, '--scope');
  const rawMaxBoards = value(args, '--max-boards');
  if (!deadlineAt || !validScope(scope)) throw new Error('Usage: --scope <nyc|remote> --deadline-at <ISO timestamp>');
  if (args.includes('--smoke') && rawMaxBoards !== undefined) throw new Error('--smoke and --max-boards cannot be combined');
  if (args.includes('--smoke')) return { scope, deadlineAt, maxBoards: 1 };
  if (rawMaxBoards === undefined) return { scope, deadlineAt, maxBoards: Infinity };
  const maxBoards = Number(rawMaxBoards);
  if (!Number.isInteger(maxBoards) || maxBoards < 1) throw new Error('--max-boards must be a positive integer');
  return { scope, deadlineAt, maxBoards };
}

if (isMainModule(import.meta.url)) {
  let parsed;
  try { parsed = parseSunnyCompanyRoutineArgs(process.argv.slice(2)); }
  catch (error) { console.error(`${error.message}\nUsage: node data/tools/run-sunny-company-routine.mjs --scope <nyc|remote> --deadline-at <ISO timestamp> [--max-boards N|--smoke]`); process.exitCode = 1; }
  if (parsed) runSunnyCompanyRoutine(parsed).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`); if (result.status !== 'success') process.exitCode = 2;
  }).catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
}
