#!/usr/bin/env node
/** Invoke Sunny's daily planner with an auditable local invocation receipt. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { buildDailyWorkPlan } from './run-sunny-daily-work-plan.mjs';

function nyDay(now) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(now)); }
function gitHead(cwd) { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } }
function writeReceipt(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }

export async function runScheduledDaily({
  dataRoot = getCareerOpsRoot(), cwd = process.cwd(), now = new Date(), planner = buildDailyWorkPlan,
} = {}) {
  const invokedAt = new Date(now).toISOString();
  const invocationId = `sunny-scheduled-${nyDay(now)}-${randomUUID()}`;
  const directory = join(dataRoot, 'data/company-discovery/scheduled-invocations');
  const receiptPath = join(directory, `${invocationId}.json`);
  mkdirSync(directory, { recursive: true });
  const receipt = {
    version: 'careerops.sunny.scheduled-invocation@1', invocation_id: invocationId, status: 'started',
    started_at: invokedAt, ny_day: nyDay(now), cwd, data_root: dataRoot, git_head: gitHead(cwd),
    planner: { since: 3, normal_limit: 20, exception_limit: 20 },
  };
  writeReceipt(receiptPath, receipt);
  try {
    const result = await planner({ dataRoot, now, since: 3, normalLimit: 20, exceptionLimit: 20 });
    Object.assign(receipt, {
      status: 'planned', finished_at: new Date().toISOString(), run_id: result.run_id || null,
      scan_run_id: result.scan?.run_id || result.scan?.scan_id || null, phase: result.phase || null,
      batch_id: result.batch?.id || null, counts: result.status_counts || result.remaining || null,
      continue_required: Boolean(result.continue_required),
    });
    writeReceipt(receiptPath, receipt);
    return { ...result, receipt_path: receiptPath, invocation_id: invocationId };
  } catch (error) {
    Object.assign(receipt, { status: 'failed', finished_at: new Date().toISOString(), error: { name: error?.name || 'Error', message: String(error?.message || error) } });
    writeReceipt(receiptPath, receipt);
    throw error;
  }
}

if (isMainModule(import.meta.url)) {
  runScheduledDaily().then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
    console.error(`Error: ${error.message}`); process.exitCode = 1;
  });
}
