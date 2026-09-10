import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';

const root = new URL('../', import.meta.url);

test('LinkedIn is not an enabled company or job discovery source', () => {
  const profile = yaml.load(readFileSync(new URL('profiles/sunny-company-discovery.yml', root), 'utf8')) || {};
  assert.notEqual(profile?.sources?.linkedin, true);

  const portals = yaml.load(readFileSync(new URL('portals.yml', root), 'utf8')) || {};
  const violations = (portals.tracked_companies || []).filter(row => row?.enabled !== false).filter(row =>
    /^www\.linkedin\.com$/i.test(new URL(String(row?.careers_url || 'https://invalid.local')).hostname)
      || /site:linkedin\.com|linkedin\.com\/jobs|linkedin\.com\/company\/[^\s)]+\/jobs/i.test(String(row?.scan_query || '')),
  );
  assert.deepEqual(violations.map(row => row.name), []);
});
