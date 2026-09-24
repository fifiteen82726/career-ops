#!/usr/bin/env node
/** Build the static, durable daily Sunny scan-health snapshot. */
import { existsSync, mkdirSync, readFileSync, renameSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getCareerOpsRoot } from '../../path-resolver.mjs';

const TIME_ZONE = 'America/New_York';
const active = item => item && !['resolved', 'closed'].includes(item.status) && ['retryable', 'needs_diagnosis'].includes(item.status);
const dayFor = (value, zone = TIME_ZONE) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const readJson = path => { try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; } catch { return null; } };
function usable(receipt) { return receipt?.kind === 'daily' && receipt?.dry_run !== true && receipt?.scan_receipt?.version === 'careerops.scan.receipt@1' && Array.isArray(receipt.scan_receipt.added_urls) && receipt.started_at && !Number.isNaN(new Date(receipt.started_at)); }

export function classifyScanDay(evidence = {}) {
  if (evidence.claimedMissing || evidence.identityMismatch || (evidence.failed && !evidence.usableReceipt) || (evidence.stopped && evidence.pendingKnown && evidence.pending > 0)) return 'red';
  if (!evidence.usableReceipt) return 'yellow';
  if (evidence.completion !== 'complete' || !evidence.pendingKnown || evidence.pending !== 0 || evidence.warnings > 0 || evidence.sourceErrors > 0 || evidence.candidateExceptions > 0 || evidence.sourceExceptions > 0 || evidence.partial) return 'yellow';
  return 'green';
}

export function buildScanStatusSnapshot({ receipts = [], state = null, jobs = [], candidateExceptions = [], sourceExceptions = [], prior = null, now = new Date(), timeZone = TIME_ZONE } = {}) {
  const priorDays = new Map((prior?.days || []).filter(row => row?.date).map(row => [row.date, row]));
  const daily = new Map();
  for (const receipt of receipts.filter(usable)) { const day = dayFor(receipt.started_at, timeZone); if (!daily.has(day) || new Date(receipt.started_at) > new Date(daily.get(day).started_at)) daily.set(day, receipt); }
  const days = new Set([...priorDays.keys(), ...daily.keys()]);
  if (state?.scan_claim?.ny_day) days.add(state.scan_claim.ny_day);
  const rows = [...days].sort().map(date => {
    const receipt = daily.get(date); const current = state?.ny_day === date ? state : null;
    if (!receipt && !current) return priorDays.get(date);
    const receiptMatchesClaim = !current?.scan_claim || !receipt || current.scan_claim.scan_id === receipt.run_id;
    const claimedMissing = Boolean(current?.scan_claim && current.scan_claim.status !== 'received' && !receipt);
    const identityMismatch = Boolean(current?.scan_claim && receipt && !receiptMatchesClaim);
    const receiptRun = receipt?.run_id;
    const receiptJobs = receiptRun ? jobs.filter(job => (job.sources || []).some(source => source.run_id === receiptRun)) : [];
    const pendingKnown = Boolean(current && Array.isArray(jobs));
    const pending = current ? jobs.filter(job => job.status === 'pending').length : null;
    const candidate = current ? candidateExceptions.filter(active).length : null;
    const source = current ? sourceExceptions.filter(active).length : null;
    const scan = receipt?.scan_receipt || {};
    const warnings = Array.isArray(receipt?.warnings) ? receipt.warnings.length : 0;
    const sourceErrors = Array.isArray(scan.errors) ? scan.errors.length : Number.isFinite(Number(scan.errors)) ? Number(scan.errors) : 0;
    const status = classifyScanDay({ usableReceipt: Boolean(receipt), completion: receipt?.completion_status, pending, pendingKnown, candidateExceptions: candidate || 0, sourceExceptions: source || 0, warnings, sourceErrors, partial: current?.status === 'partial' || receipt?.completion_status === 'partial', failed: current?.status === 'failed', stopped: ['partial', 'failed', 'complete'].includes(current?.status), claimedMissing, identityMismatch });
    const issues = [];
    if (claimedMissing) issues.push('已宣告掃描但找不到可用收據');
    if (identityMismatch) issues.push('掃描收據與宣告執行識別不一致');
    if (sourceErrors) issues.push(`${sourceErrors} 個來源錯誤`);
    if (warnings) issues.push(`${warnings} 個來源警告`);
    if (candidate) issues.push(`${candidate} 個 JD 無法讀取`);
    if (source) issues.push(`${source} 個來源例外`);
    if (pendingKnown && pending) issues.push(`${pending} 個一般工作待處理`);
    if (receipt && (!current || current.scan_claim?.scan_id !== receipt.run_id || receipt.completion_status !== 'complete')) issues.push('完成狀態未驗證');
    const label = { green: '完成', yellow: '有問題', red: '重大錯誤' }[status];
    return { date, status, label, startedAt: receipt?.started_at || current?.started_at || null, finishedAt: receipt?.finished_at || null,
      scannedPortals: Number.isFinite(Number(scan.scanned)) ? Number(scan.scanned) : null, found: Number.isFinite(Number(scan.found)) ? Number(scan.found) : null,
      added: Number.isFinite(Number(scan.added)) ? Number(scan.added) : null, published: receiptRun ? receiptJobs.filter(job => job.status === 'published').length : null,
      rejected: receiptRun ? receiptJobs.filter(job => job.status === 'rejected').length : null, normalPending: pendingKnown ? pending : null,
      candidateExceptions: candidate, sourceExceptions: source, sourceErrors, warnings,
      summary: status === 'green' ? '掃描完成，沒有待處理工作或例外。' : issues.join('，') || '掃描完成但缺少乾淨完成的佐證。', issues,
      receiptPath: receipt?.receipt_path || current?.scan_claim?.receipt_path || null };
  }).filter(Boolean);
  return { schemaVersion: 1, updatedAt: new Date(now).toISOString(), timeZone, days: rows };
}

export function refreshScanStatusSnapshot({ dataRoot = getCareerOpsRoot(), outputPath = resolve(import.meta.dirname, '../../local/sunny-job-search/data/scan-status.json'), now = new Date() } = {}) {
  const receiptDir = join(dataRoot, 'data/company-discovery/receipts');
  const receipts = existsSync(receiptDir) ? readdirSync(receiptDir).filter(name => name.endsWith('.json')).map(name => ({ ...readJson(join(receiptDir, name)), receipt_path: join('data/company-discovery/receipts', name) })).filter(Boolean) : [];
  const state = readJson(join(dataRoot, 'data/sunny-daily-run-state.json'));
  const jobs = readJson(join(dataRoot, 'data/sunny-job-queue.json'))?.jobs || [];
  const candidateExceptions = readJson(join(dataRoot, 'data/sunny-job-exception-queue.json'))?.items || [];
  const sourceExceptions = readJson(join(dataRoot, 'data/sunny-scan-exception-queue.json'))?.items || [];
  const prior = readJson(outputPath); const snapshot = buildScanStatusSnapshot({ receipts, state, jobs, candidateExceptions, sourceExceptions, prior, now });
  mkdirSync(dirname(outputPath), { recursive: true }); const temp = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  try { writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`); const check = readJson(temp); if (check?.schemaVersion !== 1 || !Array.isArray(check.days)) throw new Error('Generated scan status failed validation'); renameSync(temp, outputPath); } finally { if (existsSync(temp)) unlinkSync(temp); }
  return snapshot;
}
if (process.argv[1] === new URL(import.meta.url).pathname) console.log(JSON.stringify(refreshScanStatusSnapshot(), null, 2));
