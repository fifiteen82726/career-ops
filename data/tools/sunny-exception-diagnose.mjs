#!/usr/bin/env node
/** Read-only dossiers for Sunny exceptions that have exhausted retries. */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { acquirePipelineLock } from '../../pipeline-lock.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { readExceptionQueue } from './sunny-exception-store.mjs';

/**
 * Return the durable evidence for a single exception that requires human
 * inspection. This deliberately reads the store only: diagnosis does not
 * retry, resolve, fetch, or otherwise change queue state.
 */
export function diagnoseException({
  dataRoot = getCareerOpsRoot(),
  queue,
  key,
} = {}) {
  if (!['candidate', 'source'].includes(queue)) {
    throw new Error('Exception queue must be candidate or source');
  }
  const stableKey = String(key || '').trim();
  if (!stableKey) throw new Error('Exception diagnosis requires a key');
  const item = readExceptionQueue({ dataRoot, queue }).find(candidate => candidate.key === stableKey);
  if (!item) throw new Error('Exception record not found');
  if (item.status !== 'needs_diagnosis') throw new Error('Exception record does not need diagnosis');
  return { ...item, recommendation: 'inspect_individually' };
}

export async function acknowledgeException({ dataRoot = getCareerOpsRoot(), queue, key, dossier_reference, conclusion, next_action, lockOptions } = {}) {
  if (!['candidate', 'source'].includes(queue)) throw new Error('Exception queue must be candidate or source');
  if (!key || !dossier_reference || !conclusion || !next_action) throw new Error('Acknowledgement requires key, dossier_reference, conclusion, and next_action');
  const path = join(dataRoot, 'data', queue === 'candidate' ? 'sunny-job-exception-queue.json' : 'sunny-scan-exception-queue.json');
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const lock = await acquirePipelineLock(join(dataRoot, 'data/.sunny-exception-store'), lockOptions);
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    const doc = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { schema_version: 1, items: [] };
    const item = doc.items.find(value => value.key === key);
    if (!item || item.status !== 'needs_diagnosis') throw new Error('Exception record does not need diagnosis');
    if (!item.diagnosis_acknowledged) item.diagnosis_acknowledged_at = new Date().toISOString();
    item.diagnosis_acknowledged = true;
    item.diagnosis = { dossier_reference, conclusion, next_action };
    writeFileSync(temporary, `${JSON.stringify(doc, null, 2)}\n`); renameSync(temporary, path);
    return { ...item };
  } finally { if (existsSync(temporary)) unlinkSync(temporary); lock.release(); }
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index !== -1) return args[index + 1];
  return args.find(arg => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

if (isMainModule(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const result = args[0] === 'acknowledge'
      ? await acknowledgeException(JSON.parse(readFileSync(flagValue(args, '--input'), 'utf8')))
      : diagnoseException({ queue: flagValue(args, '--queue'), key: flagValue(args, '--key') });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}
