import assert from 'node:assert/strict';
import test from 'node:test';
import { extractConnectionCards } from '../linkedin-dom-extractors.mjs';

test('the serialized extractor rejects a wrong page', () => {
  const previous = globalThis.document;
  globalThis.document = { location: { href: 'https://www.linkedin.com/feed/' }, querySelector: () => null, querySelectorAll: () => [] };
  try { assert.equal(extractConnectionCards({ limit: 50 }).sourceStatus, 'partial'); }
  finally { globalThis.document = previous; }
});

test('the title-only extractor has no profile or Experience API surface', () => {
  const source = extractConnectionCards.toString();
  assert.doesNotMatch(source, /experience|screenshot|accessibility|\.click\(/i);
  assert.match(source, /connections/);
});

test('a plain checkpoint notice in main fails closed before card extraction', () => {
  const previous = globalThis.document;
  const notice = { textContent: 'Verify your identity to continue' };
  globalThis.document = {
    location: { href: 'https://www.linkedin.com/mynetwork/invite-connect/connections/' },
    querySelector: selector => selector === 'main, [role="main"]' ? { hidden: false } : null,
    querySelectorAll: selector => /main p/.test(selector) ? [notice] : [],
  };
  try { assert.equal(extractConnectionCards({ limit: 50 }).sourceStatus, 'linkedin_challenge'); }
  finally { globalThis.document = previous; }
});

test('the extractor requires the actual labelled Connections collection and excludes nested cards', () => {
  const source = extractConnectionCards.toString();
  assert.match(source, /suggested|people you may know/i);
  assert.match(source, /closest\?\.\('\[role="listitem"\]'\) === card/);
});

test('Recently added must be explicitly associated with the selected Connections list', () => {
  const source = extractConnectionCards.toString();
  assert.match(source, /aria-controls/);
  assert.match(source, /aria-labelledby/);
  assert.match(source, /suggested|people you may know/i);
  // A selected control which names another collection must fail closed.  A
  // shared panel is not an association: it can contain Suggestions too.
  assert.match(source, /controls\.length\) return false/);
  assert.doesNotMatch(source, /node\.closest\?\.\('\[role="tabpanel"/);
});
