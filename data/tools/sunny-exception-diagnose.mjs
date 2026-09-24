#!/usr/bin/env node
/** Read-only dossiers for Sunny exceptions that have exhausted retries. */
import { getCareerOpsRoot } from '../../path-resolver.mjs';
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

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index !== -1) return args[index + 1];
  return args.find(arg => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

if (isMainModule(import.meta.url)) {
  try {
    const result = diagnoseException({
      queue: flagValue(process.argv.slice(2), '--queue'),
      key: flagValue(process.argv.slice(2), '--key'),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}
