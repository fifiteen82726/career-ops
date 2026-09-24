#!/usr/bin/env node
/** Build the static, durable daily Sunny scan-health snapshot. */
import { existsSync, mkdirSync, readFileSync, renameSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getCareerOpsRoot } from '../../path-resolver.mjs';

const TIME_ZONE = 'America/New_York';
const active = item => item && !['resolved', 'closed'].includes(item.status) && ['retryable', 'needs_diagnosis'].includes(item.status);
const validInstant = value => typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
const dayFor = (value, zone = TIME_ZONE) => validInstant(value) ? new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)) : null;
const readJson = path => { try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; } catch { return null; } };
function usable(receipt) { return receipt?.kind === 'daily' && receipt?.dry_run !== true && receipt?.scan_receipt?.version === 'careerops.scan.receipt@1' && Array.isArray(receipt.scan_receipt.added_urls) && validInstant(receipt.started_at); }
const numeric = value => value != null && Number.isFinite(Number(value)) ? Number(value) : null;
const validPrior = row => row && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && ['green', 'yellow', 'red'].includes(row.status)
  && typeof row.label === 'string' && typeof row.summary === 'string' && Array.isArray(row.issues);

export function classifyScanDay(evidence = {}) {
  if (evidence.claimedMissing || evidence.identityMismatch || (evidence.failed && !evidence.usableReceipt) || (evidence.stopped && evidence.pendingKnown && evidence.pending > 0)) return 'red';
  if (!evidence.usableReceipt) return 'yellow';
  if (evidence.completion !== 'complete' || !evidence.completedClaim || !evidence.pendingKnown || evidence.pending !== 0 || !Number.isFinite(evidence.warnings) || !Number.isFinite(evidence.sourceErrors) || !Number.isFinite(evidence.candidateExceptions) || !Number.isFinite(evidence.sourceExceptions) || evidence.warnings > 0 || evidence.sourceErrors > 0 || evidence.candidateExceptions > 0 || evidence.sourceExceptions > 0 || evidence.partial) return 'yellow';
  return 'green';
}

export function buildScanStatusSnapshot({ receipts = [], state = null, jobs, candidateExceptions, sourceExceptions, prior = null, now = new Date(), timeZone = TIME_ZONE } = {}) {
  const priorRows = prior?.schemaVersion === 1 && Array.isArray(prior.days) ? prior.days.filter(validPrior) : [];
  const priorDays = new Map(priorRows.map(row => [row.date, row]));
  const daily = new Map();
  for (const receipt of receipts.filter(usable)) { const day = dayFor(receipt.started_at, timeZone); if (day && (!daily.has(day) || new Date(receipt.started_at) > new Date(daily.get(day).started_at))) daily.set(day, receipt); }
  const days = new Set([...priorDays.keys(), ...daily.keys()]);
  if (/^\d{4}-\d{2}-\d{2}$/.test(state?.ny_day || '')) days.add(state.ny_day);
  const rows = [...days].sort().map(date => {
    const receipt = daily.get(date); const current = state?.ny_day === date ? state : null;
    if (!current && !receipt && priorDays.has(date)) return priorDays.get(date);
    if (!receipt && !current) return priorDays.get(date);
    const receiptMatchesClaim = !current?.scan_claim || !receipt || current.scan_claim.scan_id === receipt.run_id;
    const claimedMissing = Boolean(current?.scan_claim && !receipt);
    const identityMismatch = Boolean(current?.scan_claim && receipt && !receiptMatchesClaim);
    const receiptRun = receipt?.run_id;
    const receiptJobs = receiptRun && Array.isArray(jobs) ? jobs.filter(job => (job.sources || []).some(source => source.run_id === receiptRun)) : null;
    const pendingKnown = Boolean(current && Array.isArray(jobs));
    const pending = pendingKnown ? jobs.filter(job => job.status === 'pending').length : null;
    const candidate = current && Array.isArray(candidateExceptions) ? candidateExceptions.filter(active).length : null;
    const source = current && Array.isArray(sourceExceptions) ? sourceExceptions.filter(active).length : null;
    const scan = receipt?.scan_receipt || {};
    const warnings = receipt ? (Array.isArray(receipt.warnings) ? receipt.warnings.length : numeric(receipt.warnings)) : null;
    const sourceErrors = receipt ? (Array.isArray(scan.errors) ? scan.errors.length : numeric(scan.errors)) : null;
    const completedClaim = Boolean(current?.scan_claim?.status === 'received' && receipt && receiptMatchesClaim && current.status === 'complete');
    const status = classifyScanDay({ usableReceipt: Boolean(receipt), completion: receipt?.completion_status, completedClaim, pending, pendingKnown, candidateExceptions: candidate, sourceExceptions: source, warnings, sourceErrors, partial: current?.status === 'partial' || receipt?.completion_status === 'partial', failed: current?.status === 'failed', stopped: ['partial', 'failed', 'complete'].includes(current?.status), claimedMissing, identityMismatch });
    const issues = [];
    if (claimedMissing) issues.push('已宣告掃描但找不到可用收據');
    if (identityMismatch) issues.push('掃描收據與宣告執行識別不一致');
    if (sourceErrors) issues.push(`${sourceErrors} 個來源錯誤`);
    if (warnings) issues.push(`${warnings} 個來源警告`);
    if (candidate) issues.push(`${candidate} 個 JD 無法讀取`);
    if (source) issues.push(`${source} 個來源例外`);
    if (pendingKnown && pending) issues.push(`${pending} 個一般工作待處理`);
    if (current && (!pendingKnown || candidate === null || source === null)) issues.push('掃描佇列或例外證據無法取得');
    if (receipt && (warnings === null || sourceErrors === null)) issues.push('掃描收據計數無法取得');
    if (receipt && !completedClaim) issues.push('完成狀態未驗證');
    const label = { green: '完成', yellow: '有問題', red: '重大錯誤' }[status];
    return { date, status, label, startedAt: receipt?.started_at || current?.started_at || null, finishedAt: receipt?.finished_at || null,
      scannedPortals: numeric(scan.scanned), found: numeric(scan.found),
      added: numeric(scan.added), published: receiptJobs ? receiptJobs.filter(job => job.status === 'published').length : null,
      rejected: receiptJobs ? receiptJobs.filter(job => job.status === 'rejected').length : null, normalPending: pendingKnown ? pending : null,
      candidateExceptions: candidate, sourceExceptions: source, sourceErrors, warnings,
      summary: status === 'green' ? '掃描完成，沒有待處理工作或例外。' : issues.join('，') || '掃描完成但缺少乾淨完成的佐證。', issues,
      receiptPath: receipt?.receipt_path || current?.scan_claim?.receipt_path || null };
  }).filter(Boolean);
  return { schemaVersion: 1, updatedAt: new Date(now).toISOString(), timeZone, days: rows };
}

function defaultOutputPath(dataRoot) {
  const production = getCareerOpsRoot();
  return resolve(dataRoot) === resolve(production) ? resolve(import.meta.dirname, '../../local/sunny-job-search/data/scan-status.json') : join(dataRoot, 'local/sunny-job-search/data/scan-status.json');
}
export function refreshScanStatusSnapshot({ dataRoot = getCareerOpsRoot(), outputPath = defaultOutputPath(dataRoot), now = new Date() } = {}) {
  const receiptDir = join(dataRoot, 'data/company-discovery/receipts');
  const receipts = existsSync(receiptDir) ? readdirSync(receiptDir).filter(name => name.endsWith('.json')).map(name => ({ ...readJson(join(receiptDir, name)), receipt_path: join('data/company-discovery/receipts', name) })).filter(Boolean) : [];
  const state = readJson(join(dataRoot, 'data/sunny-daily-run-state.json'));
  const jobsDoc = readJson(join(dataRoot, 'data/sunny-job-queue.json'));
  const candidateDoc = readJson(join(dataRoot, 'data/sunny-job-exception-queue.json'));
  const sourceDoc = readJson(join(dataRoot, 'data/sunny-scan-exception-queue.json'));
  const jobs = Array.isArray(jobsDoc?.jobs) ? jobsDoc.jobs : undefined;
  const candidateExceptions = Array.isArray(candidateDoc?.items) ? candidateDoc.items : undefined;
  const sourceExceptions = Array.isArray(sourceDoc?.items) ? sourceDoc.items : undefined;
  const prior = readJson(outputPath); const snapshot = buildScanStatusSnapshot({ receipts, state, jobs, candidateExceptions, sourceExceptions, prior, now });
  mkdirSync(dirname(outputPath), { recursive: true }); const temp = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  try { writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`); const check = readJson(temp); if (check?.schemaVersion !== 1 || !Array.isArray(check.days)) throw new Error('Generated scan status failed validation'); renameSync(temp, outputPath); } finally { if (existsSync(temp)) unlinkSync(temp); }
  return snapshot;
}
if (process.argv[1] === new URL(import.meta.url).pathname) console.log(JSON.stringify(refreshScanStatusSnapshot(), null, 2));
