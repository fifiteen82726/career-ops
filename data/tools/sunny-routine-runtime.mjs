/** Shared lease and verified state checkpoints for Sunny's cloud routines. */

import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';

import { acquirePipelineLock } from '../../pipeline-lock.mjs';
import { getCareerOpsRoot } from '../../path-resolver.mjs';

const REQUIRED_STATE_PATHS = [
  'portals.yml', 'data/sunny-job-queue.json', 'data/sunny-pipeline.md',
  'data/sunny-scan-history.tsv', 'data/scan-runs.tsv', 'data/sunny-company-leads.tsv',
  'data/sunny-company-resolution.tsv', 'data/portal-health.tsv',
  'data/company-discovery/coverage/progress.json', 'data/cache/ats-board-owners.json',
  'data/cache/openjobs-fleet-slugs.json',
];

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isoFileTime(now) {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

function checkpointFiles(dataRoot) {
  const files = REQUIRED_STATE_PATHS.filter(path => existsSync(join(dataRoot, path)));
  for (const root of ['data/company-discovery/receipts', 'data/cache/ats-companies']) {
    const absolute = join(dataRoot, root);
    if (!existsSync(absolute)) continue;
    for (const name of readdirSync(absolute)) {
      const path = join(root, name);
      if (statSync(join(dataRoot, path)).isFile() && (root.endsWith('receipts')
        ? /^(daily|backfill)-.*\.json$/.test(name) : name.endsWith('.json'))) files.push(path);
    }
  }
  return [...new Set(files)].sort();
}

export function sunnyRoutineLeasePath(dataRoot = getCareerOpsRoot()) {
  return join(dataRoot, 'data/.sunny-routine');
}

export async function withSunnyRoutineLease(kind, fn, {
  dataRoot = getCareerOpsRoot(), lockOptions,
} = {}) {
  if (!['company', 'daily'].includes(kind)) throw new Error('routine kind must be company or daily');
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  const lock = await acquirePipelineLock(sunnyRoutineLeasePath(dataRoot), lockOptions);
  try {
    return await fn({ kind, dataRoot, lockDir: lock.lockDir });
  } finally {
    lock.release();
  }
}

export function createSunnyCheckpoint({
  dataRoot = getCareerOpsRoot(), backupDir = join(dataRoot, '.sunny-state-backups'), now = new Date(),
} = {}) {
  const files = checkpointFiles(dataRoot);
  const missing = REQUIRED_STATE_PATHS.filter(path => !existsSync(join(dataRoot, path)));
  if (missing.length) throw new Error(`checkpoint missing required mutable state: ${missing.join(', ')}`);
  mkdirSync(backupDir, { recursive: true });
  const suffix = `${isoFileTime(now)}-${randomUUID().slice(0, 8)}`;
  const staging = join(backupDir, `.checkpoint-${suffix}`);
  const archivePath = join(backupDir, `post-run-${suffix}.tgz`);
  const temporaryArchive = `${archivePath}.tmp`;
  try {
    mkdirSync(staging, { recursive: true });
    const manifest = { schema_version: 1, created_at: new Date(now).toISOString(), files: [] };
    for (const path of files) {
      const source = join(dataRoot, path);
      const target = join(staging, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { force: false });
      manifest.files.push({ path, bytes: statSync(source).size, sha256: sha256(source) });
    }
    writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    execFileSync('tar', ['-czf', temporaryArchive, '-C', staging, '.']);
    execFileSync('tar', ['-tzf', temporaryArchive], { stdio: 'pipe' });
    for (const entry of manifest.files) {
      const copied = join(staging, entry.path);
      if (statSync(copied).size !== entry.bytes || sha256(copied) !== entry.sha256) {
        throw new Error(`checkpoint verification failed: ${entry.path}`);
      }
    }
    renameSync(temporaryArchive, archivePath);
    const archives = readdirSync(backupDir).filter(name => /^post-run-.*\.tgz$/.test(name)).sort();
    for (const old of archives.slice(0, Math.max(0, archives.length - 7))) rmSync(join(backupDir, old), { force: true });
    writeFileSync(join(backupDir, 'latest.json'), `${JSON.stringify({
      archive: archivePath, sha256: sha256(archivePath), verified: true, created_at: manifest.created_at,
    }, null, 2)}\n`);
    return { archive_path: archivePath, sha256: sha256(archivePath), files: manifest.files, verified: true };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(temporaryArchive, { force: true });
  }
}
