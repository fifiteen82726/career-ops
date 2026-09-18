import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, fsyncSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { canonicalLinkedinUrl, normalizeCompanyAlias } from './company-identities.mjs';

export const ALIAS_HEADER = ['alias_normalized', 'canonical_company_key', 'linkedin_company_url', 'resolution_source', 'confidence', 'evidence_fingerprint', 'catalog_revision', 'resolved_on', 'status'];
const sources = new Set(['ai_title', 'manual_review']);
const statuses = new Set(['accepted', 'quarantined']);
const sha = value => createHash('sha256').update(value).digest('hex');
const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;

export function parseAliasTsv(text) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  if (lines[0] !== ALIAS_HEADER.join('\t') || lines.slice(1).some(line => line && line.split('\t').length !== ALIAS_HEADER.length)) throw new Error('Invalid company alias TSV');
  const seen = new Set();
  return lines.slice(1).filter(Boolean).map(line => {
    const row = Object.fromEntries(ALIAS_HEADER.map((key, i) => [key, line.split('\t')[i]]));
    const raw = String(row.alias_normalized ?? '');
    row.alias_normalized = normalizeCompanyAlias(raw);
    if (!row.alias_normalized || raw !== row.alias_normalized || raw.length > 160 || /(?:https?:\/\/|@[^\s]+\.|\+?\d[\d .()-]{7,})/i.test(raw) || !/^[a-z0-9][a-z0-9.-]{0,127}$/.test(row.canonical_company_key) || !canonicalLinkedinUrl(row.linkedin_company_url)?.includes('/company/') || !sources.has(row.resolution_source) || !Number.isFinite(Number(row.confidence)) || Number(row.confidence) < 0 || Number(row.confidence) > 1 || !/^[a-f0-9]{64}$/.test(row.evidence_fingerprint) || !/^[a-f0-9]{64}$/.test(row.catalog_revision) || !date(row.resolved_on) || !statuses.has(row.status) || seen.has(`${row.alias_normalized}\n${row.status}`)) throw new Error('Invalid company alias row');
    seen.add(`${row.alias_normalized}\n${row.status}`); return { ...row, confidence: Number(row.confidence), linkedin_company_url: canonicalLinkedinUrl(row.linkedin_company_url) };
  });
}
export function serializeAliasTsv(rows) { parseAliasTsv(`${ALIAS_HEADER.join('\t')}\n${rows.map(row => ALIAS_HEADER.map(key => String(row[key])).join('\t')).join('\n')}\n`); return `${ALIAS_HEADER.join('\t')}\n${rows.map(row => ALIAS_HEADER.map(key => String(row[key])).join('\t')).join('\n')}\n`; }
export const aliasRevision = rows => sha(rows.slice().sort((a, b) => `${a.alias_normalized}|${a.status}`.localeCompare(`${b.alias_normalized}|${b.status}`)).map(row => ALIAS_HEADER.map(key => row[key]).join('\t')).join('\n'));

export function persistAlias({ path, proposal, catalog, today = new Date().toISOString().slice(0, 10) }) {
  const absolute = resolve(path); const lock = `${absolute}.lock`; let fd; let ownsLock = false; let temp = null;
  try {
    fd = openSync(lock, 'wx', 0o600);
    ownsLock = true;
    const prior = parseAliasTsv(readFileSync(absolute, 'utf8'));
    const rawAlias = String(proposal.alias_normalized ?? '');
    // Never turn a person identifier into something that merely looks like a
    // company token after punctuation normalization.
    if (rawAlias.length > 160 || /(?:https?:\/\/|@[^\s]+\.|\+?\d[\d .()-]{7,})/i.test(rawAlias)) return { status: 'rejected', revision: aliasRevision(prior) };
    const alias = normalizeCompanyAlias(rawAlias);
    const existingAccepted = prior.find(row => row.alias_normalized === alias && row.status === 'accepted');
    const quarantined = prior.find(row => row.alias_normalized === alias && row.status === 'quarantined');
    const target = catalog?.identities?.get?.(proposal.canonical_company_key);
    const namespace = catalog?.tokens?.get?.(alias);
    const namespaceConflict = namespace && (namespace.size !== 1 || !namespace.has(proposal.canonical_company_key));
    const isValid = alias && target && target.linkedinCompanyUrl === canonicalLinkedinUrl(proposal.linkedin_company_url) && !catalog?.quarantined?.has?.(alias) && !namespaceConflict;
    if (quarantined) return { status: 'quarantined', row: quarantined, revision: aliasRevision(prior) };
    // Replay is authority-sensitive: a formerly accepted row cannot bypass a
    // removed target, current quarantine, or a newly conflicting namespace.
    if (existingAccepted && existingAccepted.canonical_company_key === proposal.canonical_company_key && isValid) return { status: 'reused', row: existingAccepted, revision: aliasRevision(prior) };
    const status = (!isValid || existingAccepted) ? 'quarantined' : 'accepted';
    const row = { alias_normalized: alias || 'invalid', canonical_company_key: target?.canonicalCompanyKey || proposal.canonical_company_key, linkedin_company_url: target?.linkedinCompanyUrl || proposal.linkedin_company_url, resolution_source: proposal.resolution_source || 'ai_title', confidence: Number(proposal.confidence ?? 0), evidence_fingerprint: proposal.evidence_fingerprint, catalog_revision: proposal.catalog_revision, resolved_on: today, status };
    if (!isValid && (!target || !canonicalLinkedinUrl(row.linkedin_company_url))) return { status: 'rejected', revision: aliasRevision(prior) };
    const next = [...prior, row]; const text = serializeAliasTsv(next); temp = resolve(dirname(absolute), `.${basename(absolute)}.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(temp, text, { mode: 0o600, flag: 'wx' }); chmodSync(temp, 0o600); const tempFd = openSync(temp, 'r'); fsyncSync(tempFd); closeSync(tempFd); renameSync(temp, absolute); chmodSync(absolute, 0o600);
    return { status: status === 'accepted' ? 'persisted' : 'quarantined', row, revision: aliasRevision(next) };
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (temp && existsSync(temp)) unlinkSync(temp);
    // A failed O_EXCL acquisition means somebody else owns the lock.  Never
    // unlink it; only remove the descriptor created by this invocation.
    if (ownsLock && existsSync(lock)) unlinkSync(lock);
  }
}
