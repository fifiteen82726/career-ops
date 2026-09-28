#!/usr/bin/env node
/** Build the static, durable daily Sunny scan-health snapshot. */
import { existsSync, mkdirSync, readFileSync, renameSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { parseSourceKey } from './sunny-source-identity.mjs';

const TIME_ZONE = 'America/New_York';
const active = item => item && !['resolved', 'closed'].includes(item.status) && ['retryable', 'needs_diagnosis'].includes(item.status);
const validInstant = value => typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
const dayFor = (value, zone = TIME_ZONE) => validInstant(value) ? new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)) : null;
const readJson = path => { try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; } catch { return null; } };
function usable(receipt) { return receipt?.kind === 'daily' && receipt?.dry_run !== true && receipt?.scan_receipt?.version === 'careerops.scan.receipt@1' && Array.isArray(receipt.scan_receipt.added_urls) && validInstant(receipt.started_at); }
function usableRecovery(receipt) { return receipt?.kind === 'backfill' && receipt?.dry_run !== true && receipt?.completion_status === 'complete' && receipt?.scan_receipt?.version === 'careerops.scan.receipt@1' && Array.isArray(receipt.scan_receipt.added_urls) && Array.isArray(receipt.scan_receipt.errors) && receipt.scan_receipt.errors.length === 0 && !receipt.scan_receipt.partial && validInstant(receipt.started_at) && receipt.recovery_of?.origin_run_id; }
const numeric = value => value != null && Number.isFinite(Number(value)) ? Number(value) : null;
const informationalWarning = value => /\b(?:fallback|recovered|recovery succeeded|informational)\b/i.test(typeof value === 'string' ? value : JSON.stringify(value || {}))
  && !/\b(?:partial|incomplete|truncat|max[-_ ]?pages?)\b/i.test(typeof value === 'string' ? value : JSON.stringify(value || {}));
const validPrior = row => row && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && ['green', 'yellow', 'red'].includes(row.status)
  && typeof row.label === 'string' && typeof row.summary === 'string' && Array.isArray(row.issues);
const isSameReceiptAsPrior = (receipt, prior) => receipt?.receipt_path === prior?.receiptPath
  && receipt?.started_at === prior?.startedAt;
const isNewerReceiptThanPrior = (receipt, prior) => validInstant(receipt?.started_at) && validInstant(prior?.startedAt)
  && new Date(receipt.started_at) > new Date(prior.startedAt);
const windowMatches = (left, right) => left?.posted_after === right?.posted_after && left?.posted_before === right?.posted_before;
const sourceCoverage = item => item?.resolution_evidence?.coverage || item?.evidence?.coverage || null;
function recoveryProvesGap(recovery, item, jobs = []) {
  const origin = recovery?.recovery_of; const coverage = sourceCoverage(item);
  if (!usableRecovery(recovery) || item?.status !== 'resolved' || !origin?.source_key || !coverage || coverage.complete !== true || coverage.receipt_run_id !== recovery.run_id) return false;
  const parsedOrigin = parseSourceKey(origin.source_key);
  const originProvider = origin.provider || parsedOrigin?.provider;
  const originBoard = origin.board_identifier || parsedOrigin?.board_identifier;
  if (item.key !== origin.source_key || !originProvider || !originBoard || coverage.provider !== originProvider) return false;
  if (coverage.board_identifier !== originBoard) return false;
  if (!windowMatches(coverage.window, origin.original_window || origin.window)) return false;
  // A backfill receipt is only evidence for the original immutable window.
  if (!windowMatches({ posted_after: recovery.posted_after, posted_before: recovery.posted_before }, origin.original_window || origin.window)) return false;
  const observation = (recovery.scan_receipt.source_observations || []).find(value => value?.complete === true && !value?.probe
    && value.provider === coverage.provider && value.board_identifier === coverage.board_identifier);
  if (!observation) return false;
  // If a recovery added candidates, each one must have crossed canonical
  // intake and reached a durable terminal disposition. An empty result is
  // legitimate coverage evidence; a missing queue row is not.
  const intake = recovery.scan_receipt.canonical_intake_urls || recovery.scan_receipt.added_urls || [];
  return intake.every(url => jobs.some(job => job.url === url
    && (job.sources || []).some(source => source.run_id === recovery.run_id)
    && ['published', 'rejected', 'duplicate', 'closed'].includes(job.status)));
}
function controllerForRun(runId, state, archivedStates) {
  // Daily receipts are keyed by the immutable scan claim, which can differ
  // from the controller's own run UUID after a resume/rollover.
  return [state, ...(archivedStates || [])].find(value => value?.scan_claim?.scan_id === runId || value?.run_id === runId) || null;
}
function controllerCompleted(controller, runId) {
  return Boolean(controller?.status === 'complete' && controller?.final_closeout?.reference
    && controller?.scan_claim?.status === 'received' && controller.scan_claim.scan_id === runId);
}
function belongsToRun(item, runId) {
  if (!item || !runId) return false;
  const parsed = parseSourceKey(item.key);
  return parsed?.origin_run_id === runId || item?.origin_evidence?.receipt_run_id === runId || item?.evidence?.receipt_run_id === runId;
}
function originalSourceGaps(receipt, sourceExceptions) {
  if (!receipt || !Array.isArray(sourceExceptions)) return [];
  const gaps = sourceExceptions.filter(item => belongsToRun(item, receipt.run_id));
  return [...new Map(gaps.map(item => [item.key, item])).values()];
}

export function classifyScanDay(evidence = {}) {
  if (evidence.claimedMissing || evidence.identityMismatch || (evidence.failed && !evidence.usableReceipt) || (evidence.stopped && evidence.pendingKnown && evidence.pending > 0)) return 'red';
  if (!evidence.usableReceipt) return 'yellow';
  if (evidence.completion !== 'complete' || !evidence.completedClaim || !evidence.pendingKnown || evidence.pending !== 0 || !Number.isFinite(evidence.warnings) || !Number.isFinite(evidence.sourceErrors) || !Number.isFinite(evidence.candidateExceptions) || !Number.isFinite(evidence.sourceExceptions) || evidence.warnings > 0 || evidence.sourceErrors > 0 || evidence.candidateExceptions > 0 || evidence.sourceExceptions > 0 || evidence.partial) return 'yellow';
  return 'green';
}

export function buildScanStatusSnapshot({ receipts = [], state = null, archivedStates = [], jobs, candidateExceptions, sourceExceptions, prior = null, now = new Date(), timeZone = TIME_ZONE } = {}) {
  const priorRows = prior?.schemaVersion === 1 && Array.isArray(prior.days) ? prior.days.filter(validPrior) : [];
  const priorDays = new Map(priorRows.map(row => [row.date, row]));
  const daily = new Map();
  for (const receipt of receipts.filter(usable)) { const day = dayFor(receipt.started_at, timeZone); if (day && (!daily.has(day) || new Date(receipt.started_at) > new Date(daily.get(day).started_at))) daily.set(day, receipt); }
  const days = new Set([...priorDays.keys(), ...daily.keys()]);
  const recoveries = receipts.filter(usableRecovery);
  if (/^\d{4}-\d{2}-\d{2}$/.test(state?.ny_day || '')) days.add(state.ny_day);
  const rows = [...days].sort().map(date => {
    const receipt = daily.get(date); const current = state?.ny_day === date ? state : null; const priorRow = priorDays.get(date);
    if (!current && !receipt && priorDays.has(date)) return priorDays.get(date);
    // A historical row contains completion evidence that the rollover controller no
    // longer carries. Keep it until a later receipt provides fresh same-day evidence.
    const linkedRecoveries = receipt ? recoveries.filter(value => value.recovery_of?.origin_run_id === receipt.run_id) : [];
    if (!current && priorRow && receipt && !linkedRecoveries.length && (isSameReceiptAsPrior(receipt, priorRow) || !isNewerReceiptThanPrior(receipt, priorRow))) return priorRow;
    if (!receipt && !current) return priorDays.get(date);
    const controller = current || controllerForRun(receipt?.run_id, state, archivedStates);
    const receiptMatchesClaim = !controller?.scan_claim || !receipt || controller.scan_claim.scan_id === receipt.run_id;
    const claimedMissing = Boolean(current?.scan_claim && !receipt);
    const identityMismatch = Boolean(current?.scan_claim && receipt && !receiptMatchesClaim);
    const receiptRun = receipt?.run_id;
    const receiptJobs = receiptRun && Array.isArray(jobs) ? jobs.filter(job => (job.sources || []).some(source => source.run_id === receiptRun)) : null;
    const pendingKnown = Boolean(controller && Array.isArray(jobs));
    const pending = pendingKnown ? jobs.filter(job => job.status === 'pending').length : null;
    const candidate = controller && Array.isArray(candidateExceptions) ? candidateExceptions.filter(item => active(item) && (!item.origin_evidence?.receipt_run_id || item.origin_evidence.receipt_run_id === receipt?.run_id)).length : null;
    const source = controller && Array.isArray(sourceExceptions) ? sourceExceptions.filter(item => active(item) && (!receipt?.run_id || belongsToRun(item, receipt.run_id))).length : null;
    const scan = receipt?.scan_receipt || {};
    const warnings = receipt ? (Array.isArray(receipt.warnings) ? receipt.warnings.filter(value => !informationalWarning(value)).length : numeric(receipt.warnings)) : null;
    const sourceErrors = receipt ? (Array.isArray(scan.errors) ? scan.errors.length : numeric(scan.errors)) : null;
    const completedClaim = Boolean(receipt && receiptMatchesClaim && (controller === current
      ? current?.scan_claim?.status === 'received' && current.status === 'complete'
      : controllerCompleted(controller, receipt.run_id)));
    const sourceGaps = originalSourceGaps(receipt, sourceExceptions);
    const rawOriginalGaps = (sourceErrors || 0) + (warnings || 0);
    // Structured-only observations have no warning/error counter. Their
    // durable source rows are still original gaps and must each be recovered.
    const originalGaps = Math.max(rawOriginalGaps, sourceGaps.length);
    const recovered = originalGaps > 0 && sourceGaps.length > 0
      && sourceGaps.every(item => linkedRecoveries.some(recovery => recoveryProvesGap(recovery, item, jobs || [])));
    const effectiveWarnings = recovered ? 0 : warnings;
    const effectiveSourceErrors = recovered ? 0 : sourceErrors;
    const coverageStatus = originalGaps === 0 ? (receipt?.completion_status === 'complete' ? 'complete' : 'degraded') : (recovered ? 'complete' : 'degraded');
    const executionStatus = completedClaim ? 'complete' : receipt ? 'incomplete' : 'unknown';
    const status = classifyScanDay({ usableReceipt: Boolean(receipt), completion: recovered ? 'complete' : receipt?.completion_status, completedClaim, pending, pendingKnown, candidateExceptions: candidate, sourceExceptions: source, warnings: effectiveWarnings, sourceErrors: effectiveSourceErrors, partial: !recovered && (controller?.status === 'partial' || receipt?.completion_status === 'partial'), failed: controller?.status === 'failed', stopped: ['partial', 'failed', 'complete'].includes(controller?.status), claimedMissing, identityMismatch });
    const issues = [];
    if (claimedMissing) issues.push('已宣告掃描但找不到可用收據');
    if (identityMismatch) issues.push('掃描收據與宣告執行識別不一致');
    if (effectiveSourceErrors) issues.push(`${effectiveSourceErrors} 個來源錯誤`);
    if (effectiveWarnings) issues.push(`${effectiveWarnings} 個來源警告`);
    if (originalGaps && recovered) issues.push('原始來源缺口已有精確補抓與收尾佐證');
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
      candidateExceptions: candidate, sourceExceptions: source, sourceErrors: effectiveSourceErrors, warnings: effectiveWarnings, executionStatus, coverageStatus,
      summary: status === 'green' ? '掃描完成，沒有待處理工作或例外。' : issues.join('，') || '掃描完成但缺少乾淨完成的佐證。', issues,
      receiptPath: receipt?.receipt_path || controller?.scan_claim?.receipt_path || null };
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
  const historyDir = join(dataRoot, 'data/company-discovery/daily-run-history');
  const archivedStates = existsSync(historyDir) ? readdirSync(historyDir).filter(name => name.endsWith('.json')).map(name => readJson(join(historyDir, name))).filter(Boolean) : [];
  const jobsDoc = readJson(join(dataRoot, 'data/sunny-job-queue.json'));
  const candidateDoc = readJson(join(dataRoot, 'data/sunny-job-exception-queue.json'));
  const sourceDoc = readJson(join(dataRoot, 'data/sunny-scan-exception-queue.json'));
  const jobs = Array.isArray(jobsDoc?.jobs) ? jobsDoc.jobs : undefined;
  const candidateExceptions = Array.isArray(candidateDoc?.items) ? candidateDoc.items : undefined;
  const sourceExceptions = Array.isArray(sourceDoc?.items) ? sourceDoc.items : undefined;
  const prior = readJson(outputPath); const snapshot = buildScanStatusSnapshot({ receipts, state, archivedStates, jobs, candidateExceptions, sourceExceptions, prior, now });
  mkdirSync(dirname(outputPath), { recursive: true }); const temp = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  try { writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`); const check = readJson(temp); if (check?.schemaVersion !== 1 || !Array.isArray(check.days)) throw new Error('Generated scan status failed validation'); renameSync(temp, outputPath); } finally { if (existsSync(temp)) unlinkSync(temp); }
  return snapshot;
}
if (process.argv[1] === new URL(import.meta.url).pathname) console.log(JSON.stringify(refreshScanStatusSnapshot(), null, 2));
