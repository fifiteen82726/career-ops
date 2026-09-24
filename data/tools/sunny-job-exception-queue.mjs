/** Candidate-failure adapter between Sunny's normal queue and retry store. */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { acquirePipelineLock } from '../../pipeline-lock.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { canonicalLeadUrl } from './sunny-company-leads.mjs';
import { deferJobForException, releaseJobFromException, markJobDisposition, terminalizeExceptionJob } from './sunny-job-queue.mjs';
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

async function markResolved(key, evidence, { dataRoot, lockOptions } = {}) {
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
    item.resolution_evidence = evidence ?? item.resolution_evidence ?? null;
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
  attempt_id,
  attempt_at,
  terminalize_closed = false,
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
    ...(attempt_id ? { attempt_id } : {}),
    ...(attempt_at ? { attempt_at } : {}),
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

  if (exception.status === 'closed' && terminalize_closed) {
    const existing = persistedJob(dataRoot, canonicalUrl);
    const job = existing?.status === 'closed'
      ? { ...existing, replayed: true }
      : existing?.status === 'exception' && existing.exception_key === key
        ? await terminalizeExceptionJob({ url: canonicalUrl, exception_key: key, status: 'closed', reason: String(message || 'official posting expiry') }, { dataRoot, lockOptions })
        : await markJobDisposition({ url: canonicalUrl, status: 'closed', reason: String(message || 'official posting expiry') }, { dataRoot, lockOptions });
    return { key, exception, job };
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
async function resolveCandidateExceptionUnlocked({ url, stage, terminal_status, evidence } = {}, {
  dataRoot = getCareerOpsRoot(),
  lockOptions,
} = {}) {
  const canonicalUrl = canonicalLeadUrl(url);
  const key = candidateKey({ url: canonicalUrl, stage });
  const item = readExceptionQueue({ dataRoot, queue: 'candidate' }).find(candidate => candidate.key === key);
  if (!item) throw new Error('Candidate exception not found');

  const released = !terminal_status && needsNewNormalEvaluation(item)
    && alreadyDeferred(dataRoot, canonicalUrl, key);
  if (terminal_status) await terminalizeExceptionJob({ url: canonicalUrl, exception_key: key, status: terminal_status,
    reason: terminal_status === 'closed' ? String(evidence?.official_expiry || evidence?.reason || 'official posting expiry') : '',
    sheet_ref: evidence?.sheet_ref || evidence?.master_reference || '', publication_ref: evidence?.publication_ref || evidence?.archive_reference || '' }, { dataRoot, lockOptions });
  else if (released) await releaseJobFromException({ url: canonicalUrl, exception_key: key }, { dataRoot, lockOptions });
  await markResolved(key, evidence, { dataRoot, lockOptions });
  return { key, status: 'resolved', released };
}

export async function resolveCandidateException(exception = {}, options = {}) {
  const dataRoot = options.dataRoot || getCareerOpsRoot();
  return withCandidateTransition(
    () => resolveCandidateExceptionUnlocked(exception, { ...options, dataRoot }),
    { dataRoot, lockOptions: options.lockOptions },
  );
}

/** Typed CLI outcome: replay-safe failures keep their supplied attempt timestamp;
 * recovery releases only JD/normal work, while verified terminal repairs resolve. */
export async function applyCandidateOutcome(input = {}, options = {}) {
  const dataRoot = options.dataRoot || input.dataRoot || getCareerOpsRoot();
  if (!input.url || !input.stage) throw new Error('Candidate outcome requires url and stage');
  if (input.outcome === 'failure') return deferCandidateFailure({
    url: input.url, stage: input.stage, message: input.message, evidence: input.evidence,
    attempt_id: input.attempt_id,
    attempt_at: input.attempt_at || input.failed_at,
    terminalize_closed: true,
  }, { ...options, dataRoot });
  if (input.outcome === 'resolve') {
    const publicationStages = ['publish', 'publish-closeout', 'archive', 'index'];
    const sheetEvidence = input.evidence?.date_tab_reference && input.evidence?.master_reference;
    const localEvidence = input.evidence?.archive_reference && input.evidence?.index_reference;
    if (publicationStages.includes(input.stage) && !sheetEvidence && !localEvidence) {
      throw new Error('Publication repair requires verified Sheet references or local archive and index references');
    }
    const terminal_status = publicationStages.includes(input.stage) ? 'published' : undefined;
    return resolveCandidateException({ url: input.url, stage: input.stage, terminal_status, evidence: input.evidence }, { ...options, dataRoot });
  }
  throw new Error('Candidate outcome must be failure or resolve');
}

if (isMainModule(import.meta.url)) {
  const [command] = process.argv.slice(2);
  const inputPath = process.argv[process.argv.indexOf('--input') + 1];
  Promise.resolve().then(async () => {
    if (!['failure', 'resolve'].includes(command) || !inputPath) throw new Error('Use failure|resolve --input FILE');
    const input = JSON.parse(readFileSync(inputPath, 'utf8'));
    return applyCandidateOutcome({ ...input, outcome: command });
  }).then(value => process.stdout.write(`${JSON.stringify(value)}\n`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
