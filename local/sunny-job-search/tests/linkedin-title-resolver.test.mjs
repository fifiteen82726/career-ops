import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRequestBatch, validateDecisionBatch } from '../linkedin-title-resolver.mjs';

test('title resolver emits PII-minimized bounded requests and accepts only supplied high-confidence candidates', () => {
  const prepared = makeRequestBatch({ batchId: 'b'.repeat(32), cases: [{
    cardFingerprint: 'a'.repeat(64), headline: 'Data Scientist @ AMEX | Example Person', employerLabel: 'AMEX', classification: 'explicit_employer',
    candidates: [{ canonicalCompanyKey: 'american-express', companyDisplay: 'American Express', linkedinCompanyUrl: 'https://www.linkedin.com/company/american-express/' }],
  }] });
  assert.equal(prepared.requests.length, 1);
  assert.equal(/Example Person/.test(JSON.stringify(prepared)), false);
  const validated = validateDecisionBatch({ batchId: prepared.batchId, requests: prepared.requests, decisions: { schemaVersion: 1, batchId: prepared.batchId, decisions: [{ schemaVersion: 1, requestId: prepared.requests[0].requestId, decision: 'resolved', canonicalCompanyKey: 'american-express', confidence: 0.98, reasonCode: 'recognized_brand_alias' }] } });
  assert.equal(validated.get(prepared.requests[0].requestId).decision, 'resolved');
});

test('a supplied candidate still needs local evidence compatibility', () => {
  const prepared = makeRequestBatch({ batchId: 'c'.repeat(32), cases: [{
    headline: 'Engineer at Totally Different', employerLabel: 'Totally Different', classification: 'explicit_employer',
    candidates: [{ canonicalCompanyKey: 'american-express', companyDisplay: 'American Express', linkedinCompanyUrl: 'https://www.linkedin.com/company/american-express/' }],
  }] });
  const result = validateDecisionBatch({ batchId: prepared.batchId, requests: prepared.requests, decisions: { schemaVersion: 1, batchId: prepared.batchId, decisions: [{ schemaVersion: 1, requestId: prepared.requests[0].requestId, decision: 'resolved', canonicalCompanyKey: 'american-express', confidence: .99, reasonCode: 'recognized_brand_alias' }] } });
  assert.equal(result.get(prepared.requests[0].requestId).decision, 'unresolved');
});

test('private card names are never exported as employer evidence', () => {
  const prepared = makeRequestBatch({ batchId: 'd'.repeat(32), cases: [{
    fullName: 'Jane Person', headline: 'Engineer at Jane Person Consulting', employerLabel: 'Jane Person Consulting', classification: 'explicit_employer',
    candidates: [{ canonicalCompanyKey: 'jane-person-consulting', companyDisplay: 'Jane Person Consulting', linkedinCompanyUrl: 'https://www.linkedin.com/company/jane-person-consulting/' }],
  }] });
  assert.deepEqual(prepared.requests, []);
});
