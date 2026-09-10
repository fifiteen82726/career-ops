#!/usr/bin/env node
/** Bounded zero-LLM discovery from offline ATS hints; hints never authorize admission. */
import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { acquirePipelineLock } from '../../pipeline-lock.mjs';
import { loadProviders, resolveProvider } from '../../providers/_registry.mjs';
import { normalizeCompanyIdentity, providerCoordinates, verifyCandidate } from './build-sunny-h1b-ats-universe.mjs';
import { loadTsv, loadDolEvidence, joinLeadToDol, evaluateAtsCandidate, portalBoardKey, portalEntryBoardKey,
  isScannableAdmission, commitPortalAdmissions, commitPortalRepairs, recordPortalCommitFailure, writeJsonReceipt } from './sunny-company-expansion.mjs';
import { readResolutionRows, updateResolutionRows, statePaths, startBackfill, nextRetryAt } from './sunny-company-state.mjs';

const OWNERS = new Set(['greenhouse', 'ashby', 'lever', 'workday']);
const key = row => portalBoardKey({ provider: row.provider, board_identifier: row.identifier || row.board_identifier });
const validOwnerIdentifier = row => row?.provider === 'workday'
  ? /^[a-z0-9._-]+\|wd[a-z0-9._-]*\|[a-z0-9._-]+$/i.test(row?.identifier || '')
  : /^[a-z0-9._-]+$/i.test(row?.identifier || '');

export function selectProbeCandidates(candidates, { portals = {}, state = [], limit = 12, scope = 'remote', now = new Date() } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('probe limit must be 1–100');
  if (!['nyc', 'remote'].includes(scope)) throw new Error('scope must be nyc or remote');
  const tracked = new Set((portals.tracked_companies || []).map(portalEntryBoardKey));
  const seen = new Set();
  const attempted = new Map();
  for (const row of state) attempted.set(key(row), Math.max(attempted.get(key(row)) || 0, Date.parse(row.last_attempt_at) || 0));
  return [...candidates].sort((a, b) => (attempted.get(key(a)) || 0) - (attempted.get(key(b)) || 0)
    || Number(b.ny_transfer_positions || 0) - Number(a.ny_transfer_positions || 0)
    || Number(b.transfer_positions || 0) - Number(a.transfer_positions || 0) || key(a).localeCompare(key(b)))
    .filter(row => {
      const identity = normalizeCompanyIdentity(row.employer_name);
      if (row.match_status !== 'candidate' || !OWNERS.has(row.provider) || !validOwnerIdentifier(row)
        || /^meta(?:platforms)?$/.test(identity) || (scope === 'nyc' && !(Number(row.ny_transfer_positions) > 0))) return false;
      const board = key(row);
      if (tracked.has(board) || seen.has(board)) return false;
      seen.add(board);
      return !state.some(previous => key(previous) === board && Date.parse(previous.next_retry_at) > Date.parse(now));
    }).slice(0, limit);
}

export async function probeCandidates(candidates, { employers, now = new Date(), verify = verifyCandidate,
  evaluate = evaluateAtsCandidate, concurrency = 6, identityHolds = [] } = {}) {
  if (!Array.isArray(identityHolds) || identityHolds.some(hold => !hold || !OWNERS.has(hold.provider)
    || !validOwnerIdentifier(hold) || !String(hold.dol_legal_name || '').trim()
    || !String(hold.reason || '').trim() || !Array.isArray(hold.evidence_urls) || !hold.evidence_urls.length
    || hold.evidence_urls.some(url => { try { return new URL(url).protocol !== 'https:'; } catch { return true; } }))) {
    throw new Error('Invalid ATS identity hold: exact provider, identifier, DOL legal name, reason and HTTPS evidence URLs are required');
  }
  const results = new Array(candidates.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const index = cursor++; const candidate = candidates[index];
      // Use the dataset's exact legal name; independently reject normalized entity collisions.
      let dol = joinLeadToDol({ source_company: candidate.employer_name }, employers);
      if (dol.status === 'dol_accepted' && String(candidate.employer_name || '').trim() !== dol.dol_legal_name) {
        dol = { ...dol, status: 'dol_ambiguous', reason: 'Offline candidate exact legal identity differs from the current DOL match',
          evidence: JSON.stringify({ candidate_legal_name: candidate.employer_name, matched_legal_name: dol.dol_legal_name }) };
      }
      const preferredName = dol.dol_dba || dol.dol_legal_name || candidate.employer_name;
      let row = { ...dol, provider: candidate.provider, board_identifier: candidate.identifier,
        preferred_name: preferredName,
        normalized_lead: normalizeCompanyIdentity(preferredName),
        first_seen: new Date(now).toISOString(), last_seen: new Date(now).toISOString(), source_count: 1,
        last_attempt_at: new Date(now).toISOString(), backfill_status: 'not_applicable' };
      try {
        if (dol.status === 'dol_accepted') {
          const live = await verify({ ...candidate, status: 'candidate', ...providerCoordinates(candidate.provider, candidate.identifier) });
          const evaluated = live.verification === 'live' && Number(live.jobCount) === 0
            ? { status: 'identity_review', health_status: 'empty', reason: 'Empty current board may be retired; do not admit from an old dataset hint' }
            : await evaluate(dol, { ...live, careers_url: live.careersUrl, job_count: live.jobCount });
          row = { ...row, ...evaluated, preferred_name: row.preferred_name, normalized_lead: row.normalized_lead };
        }
      } catch (error) {
        row = { ...row, status: 'verification_error', health_status: 'error', reason: String(error.message || error) };
      }
      const hold = identityHolds.find(item => key(item) === key(row)
        && String(item.dol_legal_name).trim() === row.dol_legal_name);
      if (hold) row = { ...row, status: 'identity_review', identity_status: 'known_identity_conflict',
        backfill_status: 'not_applicable', reason: hold.reason,
        evidence: JSON.stringify({ kind: 'configured-identity-hold', evidence_urls: hold.evidence_urls,
          current_verification: row.evidence || '' }) };
      if (isScannableAdmission(row)) row = { ...startBackfill(row, now, 20), backfill_status: 'pending', backfill_attempted_at: '' };
      else row.next_retry_at = nextRetryAt(now, row.status === 'verification_error' ? { minutes: 180 } : { days: 7 });
      results[index] = row;
    }
  }));
  return results;
}

export function planProbeAdmissions(rows, portals, routable) {
  const additions = [], repairs = [], reviews = [];
  const usedTargets = new Set();
  for (const row of rows.filter(isScannableAdmission)) {
    const exactNames = new Set([row.dol_legal_name, row.dol_dba, row.board_owner].filter(Boolean)
      .map(name => String(name).trim()));
    const identities = new Set([...exactNames].map(normalizeCompanyIdentity));
    const matches = (portals.tracked_companies || []).filter(entry => identities.has(normalizeCompanyIdentity(entry.name)) && !routable(entry));
    if (matches.length > 1) { reviews.push({ ...row, status: 'identity_review', backfill_status: 'not_applicable',
      reason: 'Multiple existing no-provider targets; exact repair requires review' }); continue; }
    if (matches.length === 1 && (!exactNames.has(String(matches[0].name).trim()) || matches[0].enabled === false)) {
      reviews.push({ ...row, status: 'identity_review', backfill_status: 'not_applicable',
        reason: matches[0].enabled === false ? 'Existing portal is explicitly disabled; repair requires review'
          : 'Existing portal matches only after identity normalization; exact repair requires review' });
      continue;
    }
    if (matches.length === 1 && !usedTargets.has(matches[0].name)) {
      usedTargets.add(matches[0].name);
      repairs.push({ target_name: matches[0].name, expected_careers_url: matches[0].careers_url,
        official_evidence_url: row.careers_url, admission: row });
    } else additions.push(row);
  }
  return { additions, repairs, reviews };
}

export async function runProbe({ dataRoot = getCareerOpsRoot(), scope = 'remote', limit = 12, write = false } = {}) {
  const paths = statePaths(dataRoot);
  const config = yaml.load(readFileSync(paths.config, 'utf8'));
  if (!config.dol_manifest) throw new Error('Validated DOL manifest required for offline ATS probing');
  const employers = loadDolEvidence(config, dataRoot);
  const lock = await acquirePipelineLock(join(dataRoot, 'data/.sunny-ats-probe'));
  try {
    const now = new Date();
    const portals = yaml.load(readFileSync(paths.portals, 'utf8'));
    const selected = selectProbeCandidates(loadTsv(resolve(dataRoot, config.ats_offline_candidates)),
      { portals, state: readResolutionRows({ dataRoot }), limit, scope, now });
    const rows = await probeCandidates(selected, { employers, now,
      identityHolds: config.ats_identity_holds });
    const providers = await loadProviders(resolve(dirname(fileURLToPath(import.meta.url)), '../../providers'));
    const plan = planProbeAdmissions(rows, portals, entry => !!resolveProvider(entry, providers)?.provider);
    const reviews = new Map(plan.reviews.map(row => [key(row), row]));
    const outcomes = rows.map(row => reviews.has(key(row)) ? { ...reviews.get(key(row)), next_retry_at: nextRetryAt(now, { days: 7 }) } : row);
    const receipt = { schema_version: 1, command: 'offline-ats-probe', started_at: now.toISOString(), scope,
      scope_caveat: 'NY-state transfer count is a ranking hint, not NYC/remote job eligibility',
      dol_manifest: config.dol_manifest, candidate_file: config.ats_offline_candidates, dry_run: !write,
      selected: selected.length, rows: outcomes, added: 0, repaired: 0 };
    // Keep the evidence even if staged portal validation or a later write fails.
    writeJsonReceipt(paths, 'ats-probe-evidence', receipt);
    if (write) {
      await updateResolutionRows(outcomes, { dataRoot });
      try {
        receipt.repaired = (await commitPortalRepairs(plan.repairs, { dataRoot })).updated;
        receipt.added = (await commitPortalAdmissions(plan.additions, { dataRoot })).added;
      } catch (error) {
        await recordPortalCommitFailure(outcomes, error, { dataRoot });
        receipt.error = String(error.message || error);
      }
    }
    receipt.finished_at = new Date().toISOString();
    receipt.outcomes = Object.fromEntries([...new Set(outcomes.map(row => row.status))]
      .map(status => [status, outcomes.filter(row => row.status === status).length]));
    const receipt_path = writeJsonReceipt(paths, 'ats-probe-result', receipt);
    return { ...receipt, rows: undefined, receipt_path };
  } finally { lock.release(); }
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = flag => args[args.indexOf(flag) + 1];
  runProbe({ scope: args.includes('--scope') ? value('--scope') : 'remote',
    limit: args.includes('--limit') ? Number(value('--limit')) : 12, write: args.includes('--write') })
    .then(result => { console.log(JSON.stringify(result, null, 2)); if (result.error) process.exitCode = 1; })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
