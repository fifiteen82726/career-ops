/** Translate evidence-bearing scan receipts into source retry records. */
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { readFileSync } from 'node:fs';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { normalizeCompanyIdentity } from './build-sunny-h1b-ats-universe.mjs';
import { recordFailure } from './sunny-exception-store.mjs';

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
  if (/\b(?:429|5\d\d)\b|timeout|abort|fetch failed/i.test(message)) return 'transient';
  return 'error';
}

/** Record source errors and coverage warnings without touching normal job intake. */
export async function ingestScanReceiptExceptions(receipt = {}, {
  dataRoot = getCareerOpsRoot(),
  now,
  lockOptions,
} = {}) {
  const scanReceipt = receipt.scan_receipt || {};
  const errors = Array.isArray(scanReceipt.errors) ? scanReceipt.errors : [];
  const warnings = [
    ...(Array.isArray(receipt.warnings) ? receipt.warnings : []),
    ...(Array.isArray(scanReceipt.warnings) ? scanReceipt.warnings : []),
  ];
  const failedAt = receipt.finished_at || receipt.started_at || now;
  const failures = new Map();

  for (const error of errors) {
    const message = textOf(error);
    if (!message) continue;
    const errorClass = scanErrorClass(message);
    const key = `source|${companyOf(error, receipt)}|${errorClass}`;
    const board = companyOf(error, receipt);
    failures.set(key, {
      key,
      stage: 'scan',
      message,
      evidence: { receipt_run_id: receipt.run_id || '', type: 'error', detail: error, board, provider: error.provider || receipt.provider || '', window: receipt.window || receipt.posted_after || receipt.since_days || '' },
    });
  }
  for (const warning of warnings) {
    const message = textOf(warning);
    if (!message || !COVERAGE_WARNING.test(message)) continue;
    const board = companyOf(warning, receipt);
    const key = `source|${board}|coverage`;
    failures.set(key, {
      key,
      stage: 'scan',
      message,
      evidence: { receipt_run_id: receipt.run_id || '', type: 'coverage_warning', detail: warning, board, provider: warning?.provider || receipt.provider || (/\bjibe(?:apply)?\b/i.test(message) ? 'jibe' : ''), window: receipt.window || receipt.posted_after || receipt.since_days || '' },
    });
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
  if (!key.startsWith('source|')) throw new Error('Source outcome requires an exact source key');
  const items = (await import('./sunny-exception-store.mjs')).readExceptionQueue({ dataRoot, queue: 'source' });
  const item = items.find(value => value.key === key);
  if (!item) throw new Error('Source exception not found');
  if (input.outcome === 'failure') return (await import('./sunny-exception-store.mjs')).recordFailure({ ...input, stage: input.stage || 'scan' }, { dataRoot, queue: 'source' });
  if (input.outcome !== 'resolve') throw new Error('Source outcome must be failure or resolve');
  const coverage = input.evidence?.coverage;
  const origin = item.origin_evidence || item.evidence || {};
  if (key.endsWith('|coverage') && (!coverage || coverage.board !== key.split('|')[1] || !coverage.window || coverage.complete !== true || coverage.probe_only === true || coverage.type === 'probe' || !origin.provider || !origin.window || coverage.provider !== origin.provider || coverage.window !== origin.window)) throw new Error('Coverage resolution requires complete exact board, provider, and originating window evidence');
  // Use an explicit resolved record operation in the shared store without making
  // connectivity a proxy for coverage. The low-level mutation remains lock-safe.
  const { resolveException } = await import('./sunny-exception-store.mjs');
  return resolveException({ dataRoot, queue: 'source', key, evidence: input.evidence });
}

if (isMainModule(import.meta.url)) {
  const [command] = process.argv.slice(2); const path = process.argv[process.argv.indexOf('--input') + 1];
  Promise.resolve().then(() => { if (command !== 'outcome' || !path) throw new Error('Use outcome --input FILE'); return applySourceOutcome(JSON.parse(readFileSync(path, 'utf8'))); }).then(value => process.stdout.write(`${JSON.stringify(value)}\n`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
