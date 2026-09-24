/** Translate evidence-bearing scan receipts into source retry records. */
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { normalizeCompanyIdentity } from './build-sunny-h1b-ats-universe.mjs';
import { recordFailure } from './sunny-exception-store.mjs';

const COVERAGE_WARNING = /\b(?:partial|truncat(?:ed|ion)?|max[-_ ]?pages?)\b/i;

function textOf(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') return String(value.error || value.message || value.warning || JSON.stringify(value));
  return String(value || '').trim();
}

function companyOf(value, receipt) {
  const warningBoard = typeof value === 'string'
    ? value.match(/^[^:]+:\s*(.+?)\s+(?:partial|truncat(?:ed|ion)?|max[-_ ]?pages?)\b/i)?.[1]
    : '';
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
    failures.set(key, {
      key,
      stage: 'scan',
      message,
      evidence: { receipt_run_id: receipt.run_id || '', type: 'error', detail: error },
    });
  }
  for (const warning of warnings) {
    const message = textOf(warning);
    if (!message || !COVERAGE_WARNING.test(message)) continue;
    const key = `source|${companyOf(warning, receipt)}|coverage`;
    failures.set(key, {
      key,
      stage: 'scan',
      message,
      evidence: { receipt_run_id: receipt.run_id || '', type: 'coverage_warning', detail: warning },
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
