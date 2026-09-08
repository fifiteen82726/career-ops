import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as yaml from 'js-yaml';

import {
  commitPortalAdmissions,
  evaluateAtsCandidate,
  isScannableAdmission,
  joinLeadToDol,
  portalBoardKey,
  validateV2Review,
} from '../data/tools/sunny-company-expansion.mjs';

const employers = [{
  EMPLOYER_NAME: 'Example Holdings, Inc.',
  DBA: 'Example',
  transfer_positions: '12',
  ny_transfer_positions: '3',
}];

test('exact DBA match is accepted but normalized collisions require review', () => {
  const joined = joinLeadToDol({ source_company: 'Example' }, employers);
  assert.equal(joined.status, 'dol_accepted');
  assert.equal(joined.match_type, 'dba_exact');
  assert.equal(joined.dol_legal_name, 'Example Holdings, Inc.');

  const collidingEmployers = [
    { EMPLOYER_NAME: 'Acme Holdings, Inc.', DBA: 'Acme', transfer_positions: '4' },
    { EMPLOYER_NAME: 'Acme Services LLC', DBA: 'Acme', transfer_positions: '6' },
  ];
  assert.equal(
    joinLeadToDol({ source_company: 'Acme' }, collidingEmployers).status,
    'dol_ambiguous',
  );
});

test('DOL gate rejects missing transfer evidence and Meta explicitly', () => {
  assert.equal(joinLeadToDol({ source_company: 'Unknown' }, employers).status, 'dol_rejected');
  assert.match(
    joinLeadToDol({ source_company: 'Meta' }, [{
      EMPLOYER_NAME: 'Meta Platforms, Inc.', transfer_positions: '9169',
    }]).reason,
    /excluded/i,
  );
  assert.equal(joinLeadToDol({ source_company: 'Zero' }, [{
    EMPLOYER_NAME: 'Zero Inc.', transfer_positions: '0',
  }]).status, 'dol_rejected');
});

const validReview = {
  source_brand: 'Example',
  dol_legal_name: 'Example Holdings, Inc.',
  dol_dba: 'Example',
  dol_evidence_urls: ['https://example.com/legal'],
  ats_provider: 'greenhouse',
  board_identifier: 'example',
  board_owner: 'Example',
  careers_url: 'https://job-boards.greenhouse.io/example',
  official_evidence_urls: ['https://example.com/careers'],
  verdict: 'accept',
  reviewed_at: '2026-09-08',
  reason: 'Official legal disclosure and careers link.',
};

test('v2 review must prove source, DOL, and ATS identities', () => {
  assert.equal(validateV2Review(validReview).accepted, true);
  assert.equal(validateV2Review({ ...validReview, board_owner: 'Other Co' }).accepted, false);
  assert.equal(validateV2Review({ ...validReview, dol_evidence_urls: [] }).accepted, false);
  assert.equal(validateV2Review({
    ...validReview,
    careers_url: 'https://job-boards.greenhouse.io/another',
  }).accepted, false);
});

test('official careers only and non-ATS records are not writable portals', () => {
  assert.equal(isScannableAdmission({ status: 'official_careers_only' }), false);
  assert.equal(isScannableAdmission({
    status: 'accepted', health_status: 'live', provider: 'websearch', careers_url: 'https://example.com/jobs',
  }), false);
  assert.equal(isScannableAdmission({
    status: 'accepted', health_status: 'live', provider: 'greenhouse', board_identifier: 'example',
    careers_url: 'https://job-boards.greenhouse.io/example', identity_status: 'owner_verified',
  }), true);
  assert.equal(isScannableAdmission({
    status: 'accepted', health_status: 'live', provider: 'greenhouse', board_identifier: 'example',
    careers_url: 'https://job-boards.greenhouse.io/example',
  }), false, 'an ATS URL is not enough without owner or reviewed identity proof');
});

test('published ATS owner must match an accepted brand or DOL identity', async () => {
  const dolMatch = joinLeadToDol({ source_company: 'Example' }, employers);
  const candidate = {
    employer_name: 'Example Holdings, Inc.',
    provider: 'greenhouse',
    identifier: 'example',
    careers_url: 'https://job-boards.greenhouse.io/example',
    verification: 'live',
    job_count: '7',
  };
  const accepted = await evaluateAtsCandidate(dolMatch, candidate, {
    fetchContext: {
      fetchJson: async () => ({ name: 'Example' }),
      fetchText: async () => '',
    },
  });
  const mismatch = await evaluateAtsCandidate(dolMatch, candidate, {
    fetchContext: {
      fetchJson: async () => ({ name: 'Another Employer' }),
      fetchText: async () => '',
    },
  });

  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.identity_status, 'owner_verified');
  assert.equal(mismatch.status, 'identity_review');
  assert.equal(isScannableAdmission(mismatch), false);
});

test('portal board identity is exact, so clear never collides with clearstreet', () => {
  assert.notEqual(
    portalBoardKey({ provider: 'greenhouse', board_identifier: 'clear' }),
    portalBoardKey({ provider: 'greenhouse', board_identifier: 'clearstreet' }),
  );
});

test('staged portal commit validates, appends idempotently, and preserves live file on failure', async (t) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'sunny-company-portals-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const portalsPath = join(dataRoot, 'portals.yml');
  writeFileSync(portalsPath, yaml.dump({
    title_filter: { positive: ['word:data'] },
    tracked_companies: [{
      name: 'Existing',
      provider: 'greenhouse',
      careers_url: 'https://job-boards.greenhouse.io/existing',
      enabled: true,
    }],
  }), 'utf8');

  const admission = {
    status: 'accepted',
    preferred_name: 'Example',
    provider: 'greenhouse',
    board_identifier: 'example',
    careers_url: 'https://job-boards.greenhouse.io/example',
    health_status: 'live',
    identity_status: 'owner_verified',
  };
  const first = await commitPortalAdmissions([admission], {
    dataRoot,
    validate: async stagedPath => {
      assert.match(readFileSync(stagedPath, 'utf8'), /Example/);
      return { ok: true };
    },
  });
  const second = await commitPortalAdmissions([admission], {
    dataRoot,
    validate: async () => ({ ok: true }),
  });

  assert.equal(first.added, 1);
  assert.equal(second.added, 0);
  assert.equal(yaml.load(readFileSync(portalsPath, 'utf8')).tracked_companies.length, 2);

  const beforeFailure = readFileSync(portalsPath, 'utf8');
  await assert.rejects(
    commitPortalAdmissions([{
      ...admission,
      preferred_name: 'Broken',
      board_identifier: 'broken',
      careers_url: 'https://job-boards.greenhouse.io/broken',
    }], {
      dataRoot,
      validate: async () => ({ ok: false, error: 'schema rejected' }),
    }),
    /schema rejected/,
  );
  assert.equal(readFileSync(portalsPath, 'utf8'), beforeFailure);
});
