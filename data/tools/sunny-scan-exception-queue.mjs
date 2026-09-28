/** Translate evidence-bearing scan receipts into source retry records. */
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { readFileSync } from 'node:fs';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { normalizeCompanyIdentity } from './build-sunny-h1b-ats-universe.mjs';
import { recordFailure } from './sunny-exception-store.mjs';
import { isSourceKey, sourceIdentityKey } from './sunny-source-identity.mjs';

const COVERAGE_WARNING = /\b(?:partial|truncat(?:ed|ion)?|max[-_ ]?pages?)\b/i;

function textOf(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') return String(value.error || value.message || value.warning || JSON.stringify(value));
  return String(value || '').trim();
}

function companyOf(value, receipt) {
  // Jibe formats its coverage warning as "Jibe: {company} has more postings
  // than max_pages". Keep the board evidence, but remove explanatory prose.
  const jibeBoard = typeof value === 'string'
    ? value.match(/^(?:[\p{Extended_Pictographic}\uFE0F\s]+)?(?:jibeapply|jibe):\s*(.+?)\s+has\s+more\s+postings\s+than\b/iu)?.[1]
    : '';
  const warningBoard = typeof value === 'string'
    ? value.match(/^[^:]+:\s*(.+?)\s+(?:partial|truncat(?:ed|ion)?|max[-_ ]?pages?)\b/i)?.[1]
    : '';
  // The shared normalizer intentionally strips legal suffixes for matching.
  // Queue identity must preserve the raw board name so it matches the Jibe
  // warning evidence and does not collapse a distinct board.
  if (jibeBoard) return jibeBoard.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'unknown';
  const raw = value?.company || value?.provider || warningBoard
    || receipt.company || receipt.provider || 'unknown';
  return normalizeCompanyIdentity(raw) || 'unknown';
}

export function scanErrorClass(message) {
  if (/unexpected redirect|redirect(?:ed)?\b|retired[ -]?route/i.test(message)) return 'retired_route';
  if (/\b(?:401|403)\b|\bblocked\b|access denied/i.test(message)) return 'blocked';
  if (/unsupported provider|no provider|not supported/i.test(message)) return 'unsupported';
  if (/parse|malformed|invalid json|unexpected token/i.test(message)) return 'parse_failure';
  if (/\b(?:429|5\d\d)\b|timeout|abort|fetch failed/i.test(message)) return 'transient';
  return 'error';
}

function normalizedOutcomeClass(value, fallback) {
  const outcome = String(value || '').toLowerCase();
  if (['retired_route', 'blocked', 'unsupported', 'parse_failure', 'coverage'].includes(outcome)) return outcome;
  if (['incomplete_coverage'].includes(outcome)) return 'coverage';
  if (['network', 'server', 'transient_failure', 'transient'].includes(outcome)) return 'transient';
  return fallback;
}

function sourceWindow(receipt) {
  const explicit = receipt.original_window || receipt.window;
  if (explicit && typeof explicit === 'object' && explicit.posted_after && explicit.posted_before) return explicit;
  if (receipt.posted_after && receipt.posted_before) return {
    posted_after: receipt.posted_after, posted_before: receipt.posted_before,
    timezone: receipt.window_timezone || 'America/New_York', semantics: receipt.window_semantics || 'calendar-date-inclusive',
  };
  return null;
}

/**
 * New receipts get an exact immutable key.  Older receipts are intentionally
 * left on their legacy company key when they cannot prove provider+board+window;
 * manufacturing those coordinates from today's portals would make recovery
 * look precise while selecting the wrong source.
 */
export function sourceExceptionKey({ runId, provider, board, window, type, legacyBoard }) {
  return sourceIdentityKey({ runId, provider, board, window, type, legacyBoard });
}

/** Record source errors and coverage warnings without touching normal job intake. */
export async function ingestScanReceiptExceptions(receipt = {}, {
  dataRoot = getCareerOpsRoot(),
  now,
  lockOptions,
} = {}) {
  const scanReceipt = receipt.scan_receipt || {};
  const errors = Array.isArray(scanReceipt.errors) ? scanReceipt.errors : [];
  const observations = Array.isArray(scanReceipt.source_observations) ? scanReceipt.source_observations : [];
  const warnings = [
    ...(Array.isArray(receipt.warnings) ? receipt.warnings : []),
    ...(Array.isArray(scanReceipt.warnings) ? scanReceipt.warnings : []),
  ];
  const failedAt = receipt.finished_at || receipt.started_at || now;
  const failures = new Map();
  const addFailure = ({ provider, exactBoard, board, window, type, message, evidence }) => {
    const key = sourceExceptionKey({ runId: receipt.run_id, provider, board: exactBoard, window, type, legacyBoard: board });
    const existing = failures.get(key);
    if (existing) {
      existing.evidence.observations = [...(existing.evidence.observations || []), evidence];
      if (evidence.type === 'source_observation') existing.evidence.outcome_class = type;
      return;
    }
    failures.set(key, { key, stage: 'scan', message, evidence: { ...evidence, outcome_class: type, observations: [evidence] } });
  };

  for (const error of errors) {
    const message = textOf(error);
    if (!message) continue;
    const errorClass = normalizedOutcomeClass(error?.kind || error?.outcome, scanErrorClass(message));
    const board = companyOf(error, receipt);
    const provider = error?.provider || error?.actual_provider || receipt.provider || '';
    const exactBoard = error?.board_identifier || error?.board || error?.identifier || '';
    const window = sourceWindow(receipt);
    const windowEvidence = window || receipt.window || receipt.posted_after || receipt.since_days || '';
    addFailure({ provider, exactBoard, board, window, type: errorClass, message,
      evidence: { receipt_run_id: receipt.run_id || '', type: 'error', detail: error, board, board_identifier: exactBoard || null, provider, window: windowEvidence } });
  }
  for (const observation of observations) {
    if (observation?.complete !== false) continue;
    const errorClass = normalizedOutcomeClass(observation.outcome, scanErrorClass(textOf(observation)));
    const board = companyOf(observation, receipt);
    const provider = observation.provider || '';
    const exactBoard = observation.board_identifier || '';
    const window = sourceWindow(receipt);
    addFailure({ provider, exactBoard, board, window, type: errorClass, message: textOf(observation.error_name || observation.outcome || 'source incomplete'),
      evidence: { receipt_run_id: receipt.run_id || '', type: 'source_observation', detail: observation, board, board_identifier: exactBoard || null, provider,
        window: window || receipt.window || receipt.posted_after || receipt.since_days || '' } });
  }
  for (const warning of warnings) {
    const message = textOf(warning);
    if (!message || !COVERAGE_WARNING.test(message)) continue;
    const board = companyOf(warning, receipt);
    const provider = warning?.provider || receipt.provider || (/\bjibe(?:apply)?\b/i.test(message) ? 'jibe' : '');
    const exactBoard = warning?.board_identifier || warning?.board || warning?.identifier || '';
    const window = sourceWindow(receipt);
    const windowEvidence = window || receipt.window || receipt.posted_after || receipt.since_days || '';
    addFailure({ provider, exactBoard, board, window, type: 'coverage', message,
      evidence: { receipt_run_id: receipt.run_id || '', type: 'coverage_warning', detail: warning, board, board_identifier: exactBoard || null, provider, window: windowEvidence } });
  }

  const items = [];
  for (const failure of failures.values()) {
    items.push(await recordFailure({
      ...failure,
      ...(failedAt ? { failed_at: failedAt } : {}),
    }, { dataRoot, queue: 'source', lockOptions }));
  }
  return { recorded: items.length, items };
}

export async function applySourceOutcome(input = {}, { dataRoot = input.dataRoot || getCareerOpsRoot() } = {}) {
  const key = String(input.key || '');
  if (!isSourceKey(key)) throw new Error('Source outcome requires an exact source key');
  const items = (await import('./sunny-exception-store.mjs')).readExceptionQueue({ dataRoot, queue: 'source' });
  const item = items.find(value => value.key === key);
  if (!item) throw new Error('Source exception not found');
  if (input.outcome === 'failure') return (await import('./sunny-exception-store.mjs')).recordFailure({ ...input, stage: input.stage || 'scan' }, { dataRoot, queue: 'source' });
  if (input.outcome !== 'resolve') throw new Error('Source outcome must be failure or resolve');
  const coverage = input.evidence?.coverage;
  const origin = item.origin_evidence || item.evidence || {};
  const legacyBoard = key.startsWith('source|') ? key.split('|')[1] : null;
  if (!coverage || coverage.complete !== true || coverage.probe_only === true || coverage.type === 'probe' || !origin.provider || !origin.window || coverage.provider !== origin.provider || JSON.stringify(coverage.window) !== JSON.stringify(origin.window) || (legacyBoard && coverage.board !== legacyBoard) || (origin.board_identifier && coverage.board_identifier !== origin.board_identifier)) throw new Error('Source resolution requires complete exact board, provider, and originating window evidence');
  // Use an explicit resolved record operation in the shared store without making
  // connectivity a proxy for coverage. The low-level mutation remains lock-safe.
  const { resolveException } = await import('./sunny-exception-store.mjs');
  return resolveException({ dataRoot, queue: 'source', key, evidence: input.evidence });
}

if (isMainModule(import.meta.url)) {
  const [command] = process.argv.slice(2); const path = process.argv[process.argv.indexOf('--input') + 1];
  Promise.resolve().then(() => { if (command !== 'outcome' || !path) throw new Error('Use outcome --input FILE'); return applySourceOutcome(JSON.parse(readFileSync(path, 'utf8'))); }).then(value => process.stdout.write(`${JSON.stringify(value)}\n`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
