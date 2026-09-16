#!/usr/bin/env node

/** Bounded, lease-owning orchestration entry point for Sunny company routines. */

import { join } from 'node:path';

import { isMainModule } from '../../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { runPendingBackfills, runResolution } from './sunny-company-expansion.mjs';
import { createSunnyCheckpoint, withSunnyRoutineLease } from './sunny-routine-runtime.mjs';

function deadlineReached(deadlineAt, clock) {
  return deadlineAt != null && clock() >= new Date(deadlineAt);
}

export async function runSunnyCompanyRoutine({
  dataRoot = getCareerOpsRoot(),
  deadlineAt,
  maxBoards = Infinity,
  clock = () => new Date(),
  collect = async () => ({}),
  resolve = scope => runResolution({ dataRoot, scope, mode: 'incremental', write: true }),
  backfill = options => runPendingBackfills({ dataRoot, ignoreGuard: true, ...options }),
  checkpoint = createSunnyCheckpoint,
  backupDir = process.env.SUNNY_STATE_BACKUP_DIR || join(dataRoot, '.sunny-state-backups'),
  lockOptions,
} = {}) {
  if (deadlineAt != null && Number.isNaN(new Date(deadlineAt).getTime())) throw new Error('deadlineAt must be a valid timestamp');
  return withSunnyRoutineLease('company', async () => {
    const stages = [];
    let status = 'success';
    try {
      for (const scope of ['nyc', 'remote']) {
        if (deadlineReached(deadlineAt, clock)) { status = 'partial'; break; }
        await collect(scope, { deadlineAt, maxBoards, smoke: maxBoards !== Infinity });
        stages.push({ scope, stage: 'collect', status: 'complete' });
        if (deadlineReached(deadlineAt, clock)) { status = 'partial'; break; }
        await resolve(scope, { deadlineAt, maxBoards, smoke: maxBoards !== Infinity });
        stages.push({ scope, stage: 'resolve', status: 'complete' });
      }
      if (status === 'success' && !deadlineReached(deadlineAt, clock)) {
        const result = await backfill({ deadlineAt, maxBoards, clock });
        stages.push({ stage: 'backfill', status: result?.deferred_deadline ? 'partial' : 'complete', result });
        if (result?.deferred_deadline) status = 'partial';
      } else if (status === 'success') status = 'partial';
    } catch (error) {
      status = 'partial';
      stages.push({ stage: 'error', status: 'error', error: String(error?.message || error) });
    }
    let checkpointResult;
    try {
      checkpointResult = checkpoint({ dataRoot, backupDir, now: clock() });
    } catch (error) {
      status = 'partial';
      checkpointResult = { verified: false, error: String(error?.message || error) };
    }
    return { status, stages, deadline_at: deadlineAt ? new Date(deadlineAt).toISOString() : null, checkpoint: checkpointResult };
  }, { dataRoot, lockOptions });
}

function value(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const deadlineAt = value(args, '--deadline-at');
  if (!deadlineAt) {
    console.error('Usage: node data/tools/run-sunny-company-routine.mjs --deadline-at <ISO timestamp> [--smoke]');
    process.exitCode = 1;
  } else {
    runSunnyCompanyRoutine({ deadlineAt, maxBoards: args.includes('--smoke') ? 1 : Infinity }).then(result => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.status !== 'success') process.exitCode = 2;
    }).catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
  }
}
