/** Candidate-failure adapter between Sunny's normal queue and retry store. */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { acquirePipelineLock } from '../../pipeline-lock.mjs';
import { canonicalLeadUrl } from './sunny-company-leads.mjs';
import { deferJobForException, releaseJobFromException } from './sunny-job-queue.mjs';
import { readExceptionQueue, recordFailure } from './sunny-exception-store.mjs';

function candidateStorePath(dataRoot) {
  return join(dataRoot, 'data/sunny-job-exception-queue.json');
}

function candidateKey({ url, stage }) {
  const canonicalUrl = canonicalLeadUrl(url);
  if (!canonicalUrl) throw new Error('Candidate exception requires a URL');
  const normalizedStage = String(stage || '').trim();
  if (!normalizedStage) throw new Error('Candidate exception requires a stage');
  return `candidate|${normalizedStage}|${canonicalUrl}`;
}

function persistedJob(dataRoot, url) {
  const file = join(dataRoot, 'data/sunny-job-queue.json');
  if (!existsSync(file)) return null;
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  return doc.jobs?.find(item => item.url === url) || null;
}

function alreadyDeferred(dataRoot, url, key) {
  const job = persistedJob(dataRoot, url);
  return job?.status === 'exception' && job.exception_key === key;
}

async function withCandidateTransition(fn, { dataRoot, lockOptions } = {}) {
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const lock = await acquirePipelineLock(join(dataRoot, 'data/.sunny-job-exception-transition'), lockOptions);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

async function markResolved(key, { dataRoot, lockOptions } = {}) {
  const file = candidateStorePath(dataRoot);
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const lock = await acquirePipelineLock(join(dataRoot, 'data/.sunny-exception-store'), lockOptions);
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    const doc = existsSync(file)
      ? JSON.parse(readFileSync(file, 'utf8'))
      : { schema_version: 1, items: [] };
    if (doc.schema_version !== 1 || !Array.isArray(doc.items)) {
      throw new Error('Invalid Sunny exception store; refusing to overwrite');
    }
    const item = doc.items.find(candidate => candidate.key === key);
    if (!item) throw new Error('Candidate exception not found');
    if (item.status !== 'resolved') item.resolved_from_status = item.status;
    item.status = 'resolved';
    item.next_retry_at = null;
    item.resolved_at = new Date().toISOString();
    writeFileSync(temporary, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    renameSync(temporary, file);
    return { ...item };
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    lock.release();
  }
}

function needsNewNormalEvaluation(item) {
  return item.status !== 'closed' && item.resolved_from_status !== 'closed'
    && !['publish', 'archive', 'index'].includes(item.stage);
}

/**
 * Preserve candidate evidence before hiding exactly that candidate from normal
 * work. A re-run with the same failure timestamp is idempotent in the store,
 * and an already-matching normal-queue exception is a successful replay.
 */
async function deferCandidateFailureUnlocked({
  url,
  stage,
  message = '',
  evidence = null,
  failed_at,
} = {}, { dataRoot = getCareerOpsRoot(), now, lockOptions } = {}) {
  const canonicalUrl = canonicalLeadUrl(url);
  const key = candidateKey({ url: canonicalUrl, stage });
  const previous = readExceptionQueue({ dataRoot, queue: 'candidate' })
    .find(candidate => candidate.key === key);
  const exception = await recordFailure({
    key,
    stage: String(stage).trim(),
    message: String(message || ''),
    evidence,
    ...(failed_at ? { failed_at } : now ? { failed_at: now }
      : previous?.last_failed_at ? { failed_at: previous.last_failed_at } : {}),
  }, { dataRoot, queue: 'candidate', lockOptions });

  if (exception.status === 'resolved') {
    return { key, exception, job: {
      url: canonicalUrl,
      status: persistedJob(dataRoot, canonicalUrl)?.status || 'missing',
      replayed: true,
    } };
  }

  let job;
  try {
    job = await deferJobForException({ url: canonicalUrl, exception_key: key }, { dataRoot, lockOptions });
  } catch (error) {
    if (!alreadyDeferred(dataRoot, canonicalUrl, key)) throw error;
    job = { url: canonicalUrl, status: 'exception', exception_key: key, replayed: true };
  }
  return { key, exception, job };
}

export async function deferCandidateFailure(failure = {}, options = {}) {
  const dataRoot = options.dataRoot || getCareerOpsRoot();
  return withCandidateTransition(
    () => deferCandidateFailureUnlocked(failure, { ...options, dataRoot }),
    { dataRoot, lockOptions: options.lockOptions },
  );
}

/** Resolve an exception and only re-open stages that require a fresh review. */
async function resolveCandidateExceptionUnlocked({ url, stage } = {}, {
  dataRoot = getCareerOpsRoot(),
  lockOptions,
} = {}) {
  const canonicalUrl = canonicalLeadUrl(url);
  const key = candidateKey({ url: canonicalUrl, stage });
  const item = readExceptionQueue({ dataRoot, queue: 'candidate' }).find(candidate => candidate.key === key);
  if (!item) throw new Error('Candidate exception not found');

  const released = needsNewNormalEvaluation(item)
    && alreadyDeferred(dataRoot, canonicalUrl, key);
  if (released) await releaseJobFromException({ url: canonicalUrl, exception_key: key }, { dataRoot, lockOptions });
  await markResolved(key, { dataRoot, lockOptions });
  return { key, status: 'resolved', released };
}

export async function resolveCandidateException(exception = {}, options = {}) {
  const dataRoot = options.dataRoot || getCareerOpsRoot();
  return withCandidateTransition(
    () => resolveCandidateExceptionUnlocked(exception, { ...options, dataRoot }),
    { dataRoot, lockOptions: options.lockOptions },
  );
}
