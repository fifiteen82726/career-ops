import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import { canonicalLinkedinUrl as canonical } from './linkedin-capture.mjs';

export const canonicalLinkedinUrl = canonical;
export function normalizeCompanyAlias(value) { return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[.,]/g, '').replace(/\b(?:incorporated|inc|llc|ltd|limited|corp|corporation|co)\b/g, '').replace(/[^\p{L}\p{N}& -]/gu, '').replace(/\s+/g, ' ').trim(); }
const mapHeader = ['company_key', 'company_display', 'linkedin_company_url', 'linkedin_people_url', 'verification_source', 'verified_on', 'status'];
const aliasHeader = ['alias_normalized', 'canonical_company_key', 'linkedin_company_url', 'resolution_source', 'confidence', 'evidence_fingerprint', 'catalog_revision', 'resolved_on', 'status'];
const hash = v => createHash('sha256').update(v).digest('hex');
const calendarDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v;
function tsv(text, header) { const lines = String(text || '').replace(/\r/g, '').trimEnd().split('\n'); if (lines[0] !== header.join('\t')) throw new Error('Invalid TSV headers'); return lines.slice(1).filter(Boolean).map(line => { const cells = line.split('\t'); if (cells.length !== header.length) throw new Error('Invalid TSV columns'); return Object.fromEntries(header.map((key, i) => [key, cells[i]])); }); }
export function parseCompanyMapRows(text) { return tsv(text, mapHeader).map(row => { const url = canonical(row.linkedin_company_url); const people=String(row.linkedin_people_url||''); const validPeople=url && people === `${url}people/`; if (!/^[a-z0-9][a-z0-9.-]{0,127}$/.test(row.company_key) || !row.company_display.trim() || !url?.includes('/company/') || !validPeople || row.status !== 'verified' || !calendarDate(row.verified_on) || !row.verification_source.trim()) throw new Error('Invalid reviewed company-map row'); return { ...row, linkedin_company_url: url, linkedin_people_url: people, canonicalCompanyKey: url.split('/')[4] }; }); }
export function parseCompanyAliases(text) { const seen = new Set(); return tsv(text, aliasHeader).map(row => { const raw=String(row.alias_normalized||''), url = canonical(row.linkedin_company_url), alias=normalizeCompanyAlias(raw), confidence=Number(row.confidence), identity=`${alias}\n${row.status}`; if (!alias || raw !== alias || raw.length > 160 || /(?:https?:\/\/|@[^\s]+\.|\+?\d[\d .()-]{7,})/i.test(raw) || !/^[a-z0-9][a-z0-9.-]{0,127}$/.test(row.canonical_company_key) || !url?.includes('/company/') || !['accepted', 'quarantined'].includes(row.status) || !['ai_title','manual_review'].includes(row.resolution_source) || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 || !/^[a-f0-9]{64}$/.test(row.catalog_revision) || !/^[a-f0-9]{64}$/.test(row.evidence_fingerprint) || !calendarDate(row.resolved_on) || seen.has(identity)) throw new Error('Invalid company alias row'); seen.add(identity); return { ...row, alias_normalized: alias, linkedin_company_url: url, confidence }; }); }
export function loadVerifiedTrackedCompanyRows({ portalsText = '', archive = null } = {}) {
  // Parse portals strictly even though it currently supplies no reviewed
  // LinkedIn identity evidence.  This keeps a malformed authoritative input
  // from silently changing the interpretation of an archive run.
  if (portalsText) {
    let portals;
    try { portals = yaml.load(portalsText, { schema: yaml.JSON_SCHEMA, json: false }); }
    catch { throw new Error('Invalid portals YAML'); }
    if (!portals || typeof portals !== 'object' || Array.isArray(portals)) throw new Error('Invalid portals YAML');
  }
  // Archive company/People pairs can corroborate a reviewed URL but their
  // labels are unreviewed data.  buildCompanyIdentityIndex only incorporates
  // the label when it already exactly belongs to that reviewed identity.
  const jobs = archive && typeof archive === 'object' && Array.isArray(archive.jobs) ? archive.jobs : [];
  return jobs.flatMap(job => {
    const people = typeof job?.linkedinPeopleUrl === 'string' ? job.linkedinPeopleUrl : '';
    const url = canonical(people.replace(/people\/$/i, ''));
    const label = typeof job?.company === 'string' ? job.company : '';
    return url?.includes('/company/') && label && people === `${url}people/`
      ? [{ canonicalCompanyKey: url.split('/')[4], linkedinCompanyUrl: url, companyDisplay: label, verified: true }]
      : [];
  });
}
export function buildCompanyIdentityIndex({ companyMapRows = [], aliasRows = [], trackedCompanyRows = [] } = {}) {
  const identities = new Map(), tokens = new Map(), quarantined = new Set(), conflicts = new Set();
  for (const row of companyMapRows.filter(row => row.status === 'verified')) { const key = row.canonicalCompanyKey || row.linkedin_company_url.split('/')[4]; const identity = identities.get(key) || { canonicalCompanyKey: key, linkedinCompanyUrl: row.linkedin_company_url, companyDisplay: row.company_display, tokens: new Set() }; if (identity.linkedinCompanyUrl !== row.linkedin_company_url) throw new Error('Contradictory canonical company URL'); if (row.company_display.localeCompare(identity.companyDisplay) < 0) identity.companyDisplay=row.company_display; identities.set(key, identity); for (const value of [row.company_key, row.company_display, key]) if (normalizeCompanyAlias(value)) identity.tokens.add(normalizeCompanyAlias(value)); }
  for (const row of aliasRows) { const key = normalizeCompanyAlias(row.alias_normalized); if (row.status === 'quarantined') { quarantined.add(key); continue; } const identity = identities.get(row.canonical_company_key); if (identity && identity.linkedinCompanyUrl === row.linkedin_company_url) identity.tokens.add(key); }
  for (const row of trackedCompanyRows) {
    const identity = identities.get(row.canonicalCompanyKey);
    const token = normalizeCompanyAlias(row.companyDisplay);
    // An archive label cannot create a new exact alias just because the row
    // carries a reviewed company URL.  It may only reassert a label already
    // independently reviewed for that same identity.
    if (identity && row.linkedinCompanyUrl === identity.linkedinCompanyUrl && row.verified === true && identity.tokens.has(token)) identity.tokens.add(token);
  }
  for (const identity of identities.values()) for (const token of identity.tokens) { const set = tokens.get(token) || new Set(); set.add(identity.canonicalCompanyKey); tokens.set(token, set); }
  for (const [token, set] of tokens) if (set.size > 1 || quarantined.has(token)) conflicts.add(token);
  return { identities, tokens, quarantined, conflicts };
}
export function resolveCompanyIdentity(index, { companyLabel = '', companyLinkedinUrl = null } = {}) { const token = normalizeCompanyAlias(companyLabel), url = companyLinkedinUrl && canonical(companyLinkedinUrl); if (url) { const match = [...index.identities.values()].find(identity => identity.linkedinCompanyUrl === url); if (!match) return { status: 'unresolved', reason: 'unknown_url', candidates: [] }; const labelIds = token ? index.tokens.get(token) : null; if (token && (index.conflicts.has(token) || !labelIds || labelIds.size !== 1 || !labelIds.has(match.canonicalCompanyKey))) return { status: 'unresolved', reason: 'contradictory_evidence', candidates: [] }; return { status: 'resolved', ...match, quality: 'company_url_exact' }; } const ids = index.tokens.get(token); if (!token || index.conflicts.has(token) || !ids || ids.size !== 1) return { status: 'unresolved', reason: index.conflicts.has(token) ? 'collision' : 'missing', candidates: [] }; const identity = index.identities.get([...ids][0]); return { status: 'resolved', ...identity, quality: 'connections_headline_exact' }; }
function score(token, observed) { const a = new Set(token.split(' ')), b = new Set(observed.split(' ')); const overlap = [...a].filter(x => b.has(x)).length; const compact=observed.replace(/\s/g,''), words=token.split(' '); const acronym = words.map(x => x[0]).join('') === compact; const compoundAbbrev = words.map(x => x.slice(0, 2)).join('') === compact; const compound = token.replace(/\s/g, '').startsWith(compact); return overlap * 10 + (acronym ? 8 : 0) + (compound ? 6 : 0) + (compoundAbbrev ? 7 : 0); }
export function generateCompanyCandidates(index, observedText, { limit = 5 } = {}) { const observed = normalizeCompanyAlias(observedText); const cap=Math.max(0,Math.min(5,Number.isInteger(limit)?limit:5)); if (!observed || index.conflicts.has(observed) || cap===0) return []; return [...index.identities.values()].map(identity => ({ identity, score: Math.max(...[...identity.tokens].map(token => score(token, observed))) })).filter(x => x.score > 0).sort((a,b) => b.score - a.score || a.identity.canonicalCompanyKey.localeCompare(b.identity.canonicalCompanyKey)).slice(0,cap).map(({ identity }) => ({ canonicalCompanyKey: identity.canonicalCompanyKey, companyDisplay: identity.companyDisplay, linkedinCompanyUrl: identity.linkedinCompanyUrl })); }
export const suggestAliasCandidates = (index, label, options = {}) => generateCompanyCandidates(index, label, options).map(x => x.canonicalCompanyKey);
export const computeCatalogRevision = index => hash(JSON.stringify([...index.identities.values()].map(i => [i.canonicalCompanyKey, i.linkedinCompanyUrl, i.companyDisplay, [...i.tokens].sort()]).sort()));
export const computeAliasMappingRevision = rows => hash(rows.slice().sort((a,b)=>`${a.alias_normalized}|${a.status}`.localeCompare(`${b.alias_normalized}|${b.status}`)).map(row => aliasHeader.map(key => String(row[key])).join('\t')).join('\n'));
