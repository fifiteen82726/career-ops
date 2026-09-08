import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('discovery config template separates NYC and remote scopes and both run modes', () => {
  const cfg = yaml.load(readFileSync(join(ROOT, 'templates/sunny-company-discovery.example.yml'), 'utf8'));

  assert.equal(cfg.schema_version, 1);
  assert.equal(cfg.source_modes.backfill.days, 20);
  assert.equal(cfg.source_modes.incremental.days, 1);
  assert.equal(cfg.source_modes.incremental.linkedin_date_posted, 'past_24_hours');
  assert.equal(cfg.scopes.nyc.indeed.location, 'New York, NY');
  assert.equal(cfg.scopes.nyc.indeed.radius, 50);
  assert.equal(cfg.scopes.remote.indeed.location, 'remote');
  assert.equal(cfg.scopes.remote.indeed.remote_only, true);
});

test('v2 review template starts empty and requires all three identity layers', () => {
  const cfg = yaml.load(readFileSync(join(ROOT, 'templates/sunny-company-identity-reviews-v2.example.yml'), 'utf8'));

  assert.equal(cfg.schema_version, 2);
  assert.deepEqual(cfg.reviews, []);
});
