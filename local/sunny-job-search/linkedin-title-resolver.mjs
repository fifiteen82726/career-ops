import { createHash, randomUUID } from 'node:crypto';

const MAX_REQUESTS = 10;
const MAX_CANDIDATES = 5;
const REASONS = new Set(['recognized_brand_alias', 'exact_candidate_context', 'insufficient_evidence', 'ambiguous']);
const clean = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const hash = value => createHash('sha256').update(value).digest('hex');
// This is deliberately independent of model output.  A decision can only
// select a supplied candidate when the observed company evidence itself has a
// deterministic relation to that candidate (exact token, acronym, or the
// conservative two-character compound abbreviation used for AMEX).
function compatible(observed, candidate) {
  const left = clean(observed).toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, ' ').replace(/\s+/g, ' ').trim();
  const right = clean(candidate).toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!left || !right) return false;
  if (left === right || (Math.min(left.length, right.length) >= 3 && (left.startsWith(right) || right.startsWith(left)) && Math.abs(left.length - right.length) <= 1)) return true;
  const compact = left.replace(/\s/g, ''), words = right.split(' ').filter(Boolean);
  return compact === words.map(word => word[0]).join('') || compact === words.map(word => word.slice(0, 2)).join('');
}

// A request intentionally excludes person names, profile URLs and the full card
// headline.  It carries only the bounded employer clause the model may classify.
export function minimizeEmployerEvidence(headline, employerLabel, fullName = '') {
  const label = clean(employerLabel);
  const privateName = clean(fullName).toLocaleLowerCase();
  if (!label || label.length > 160 || (privateName && label.toLocaleLowerCase().includes(privateName)) || /(?:https?:\/\/|www\.|@[^\s]+\.[^\s]+|\+?\d[\d .()-]{7,}\b)/i.test(label)) return null;
  // The local parser already established the single current-employer clause.
  // Exporting that full clause adds no classification power but can leak names,
  // role history, URLs, or contact details.  Keep only company evidence.
  return `at ${label}`;
}

export function makeRequestId({ employerEvidence, candidates }) {
  return hash(JSON.stringify({ employerEvidence, candidates: candidates.map(({ canonicalCompanyKey, linkedinCompanyUrl }) => ({ canonicalCompanyKey, linkedinCompanyUrl })) })).slice(0, 32);
}

export function makeRequestBatch({ batchId = randomUUID().replaceAll('-', ''), cases = [] } = {}) {
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(batchId)) throw new Error('Invalid batch ID');
  const requests = [];
  const normalized = [];
  for (const item of cases) {
    if (item.classification !== 'explicit_employer') continue;
    const evidence = minimizeEmployerEvidence(item.headline, item.employerLabel, item.fullName);
    const candidates = Array.isArray(item.candidates) ? item.candidates.slice(0, MAX_CANDIDATES).map(candidate => ({ canonicalCompanyKey: clean(candidate.canonicalCompanyKey), companyDisplay: clean(candidate.companyDisplay), linkedinCompanyUrl: clean(candidate.linkedinCompanyUrl) })) : [];
    if (!evidence || candidates.length < 1 || candidates.length > MAX_CANDIDATES || candidates.some(c => !/^[a-z0-9][a-z0-9.-]{0,127}$/.test(c.canonicalCompanyKey) || !/^https:\/\/www\.linkedin\.com\/company\/[^/?#]+\/$/.test(c.linkedinCompanyUrl))) continue;
    const requestId = makeRequestId({ employerEvidence: evidence, candidates });
    normalized.push({ requestId, employerEvidence: evidence, observedEmployerLabel: clean(item.employerLabel), classification: 'explicit_employer', candidates });
  }
  for (const request of normalized.sort((a, b) => a.requestId.localeCompare(b.requestId))) {
    if (requests.length === MAX_REQUESTS) break;
    if (!requests.some(existing => existing.requestId === request.requestId)) requests.push(request);
  }
  return { schemaVersion: 1, batchId, requests };
}

export function validateDecisionBatch({ batchId, requests, decisions }) {
  if (!Array.isArray(requests) || !/^[a-zA-Z0-9_-]{16,128}$/.test(batchId)) throw new Error('Malformed decision envelope');
  if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions) || decisions.schemaVersion !== 1 || decisions.batchId !== batchId || !Array.isArray(decisions.decisions) || Object.keys(decisions).some(key => !['schemaVersion','batchId','decisions'].includes(key))) throw new Error('Malformed decision envelope');
  decisions = decisions.decisions;
  const byId = new Map(requests.map(request => [request.requestId, request]));
  const output = new Map();
  for (const decision of decisions) {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision) || decision.schemaVersion !== 1 || typeof decision.requestId !== 'string' || !byId.has(decision.requestId) || output.has(decision.requestId)) throw new Error('Malformed, unknown, or duplicate decision');
    const allowed = decision.decision === 'resolved'
      ? ['schemaVersion', 'requestId', 'decision', 'canonicalCompanyKey', 'confidence', 'reasonCode']
      : ['schemaVersion', 'requestId', 'decision', 'reasonCode'];
    if (Object.keys(decision).some(key => !allowed.includes(key)) || !['resolved', 'unresolved'].includes(decision.decision) || !REASONS.has(decision.reasonCode) || (decision.decision === 'resolved' && !['recognized_brand_alias','exact_candidate_context'].includes(decision.reasonCode)) || (decision.decision === 'unresolved' && !['insufficient_evidence','ambiguous'].includes(decision.reasonCode)) ) throw new Error('Invalid decision fields');
    const request = byId.get(decision.requestId);
    if (decision.decision === 'resolved') {
      const validCandidate = request.candidates.find(candidate => candidate.canonicalCompanyKey === decision.canonicalCompanyKey);
      if (!validCandidate || !compatible(request.observedEmployerLabel, validCandidate.companyDisplay) || !Number.isFinite(decision.confidence) || decision.confidence < .95 || decision.confidence > 1) output.set(decision.requestId, { decision: 'unresolved', reasonCode: 'insufficient_evidence' });
      else output.set(decision.requestId, { decision: 'resolved', canonicalCompanyKey: validCandidate.canonicalCompanyKey, linkedinCompanyUrl: validCandidate.linkedinCompanyUrl, confidence: decision.confidence, reasonCode: decision.reasonCode });
    } else output.set(decision.requestId, { decision: 'unresolved', reasonCode: decision.reasonCode });
  }
  for (const request of requests) if (!output.has(request.requestId)) output.set(request.requestId, { decision: 'unresolved', reasonCode: 'insufficient_evidence' });
  return output;
}

export function aliasEvidenceFingerprint({ employerEvidence, candidates, decision }) {
  return hash(JSON.stringify({ employerEvidence, candidates: candidates.map(c => [c.canonicalCompanyKey, c.linkedinCompanyUrl]), decision }));
}
