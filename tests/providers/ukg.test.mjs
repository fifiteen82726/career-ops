import test from 'node:test';
import assert from 'node:assert/strict';

import ukg, {
  fetchUkgBoardProof,
  parseUkgLanding,
  parseUkgSearch,
  resolveUkgBoard,
} from '../../providers/ukg.mjs';

const identifier = 'recruiting.ultipro.com:ACM1000:12345678-1234-1234-1234-123456789abc';
const careersUrl = 'https://recruiting.ultipro.com/ACM1000/JobBoard/12345678-1234-1234-1234-123456789abc/';
const landingHtml = `
  <input name="__RequestVerificationToken" type="hidden" value="csrf-token" />
  <img alt="Acme Holdings &amp; Co. Brand" data-automation="navbar-large-logo" />
`;

function response({ text = '', json = {}, cookie = '' } = {}) {
  return {
    text: async () => text,
    json: async () => json,
    headers: {
      get: name => name.toLowerCase() === 'set-cookie' ? cookie : null,
      getSetCookie: () => cookie ? [cookie] : [],
    },
  };
}

test('UKG resolves only fixed first-party board coordinates', () => {
  assert.deepEqual(resolveUkgBoard({ careers_url: careersUrl }), {
    host: 'recruiting.ultipro.com',
    tenant: 'ACM1000',
    board: '12345678-1234-1234-1234-123456789abc',
    identifier,
  });
  assert.deepEqual(resolveUkgBoard({ ukg_slug: identifier }), {
    host: 'recruiting.ultipro.com',
    tenant: 'ACM1000',
    board: '12345678-1234-1234-1234-123456789abc',
    identifier,
  });
  assert.equal(resolveUkgBoard({ careers_url: careersUrl.replace('recruiting.', 'evil.') }), null);
  assert.equal(resolveUkgBoard({ ukg_slug: 'recruiting.ultipro.com:../bad:123' }), null);
  assert.ok(ukg.detect({ careers_url: careersUrl }));
});

test('UKG landing proof decodes the board owner and CSRF token', () => {
  assert.deepEqual(parseUkgLanding(landingHtml), {
    owner: 'Acme Holdings & Co.',
    csrfToken: 'csrf-token',
  });
});

test('UKG search response normalizes stable first-party jobs', () => {
  const parsed = parseUkgSearch({
    totalCount: 1,
    opportunities: [{
      Id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      Title: 'Data Engineer',
      PostedDate: '2026-09-09T12:00:00Z',
      Locations: [{ Address: { City: 'New York', State: { Code: 'NY' }, Country: { Code: 'USA' } } }],
    }],
  }, resolveUkgBoard({ ukg_slug: identifier }), 'Acme');
  assert.equal(parsed.total, 1);
  assert.deepEqual(parsed.jobs, [{
    title: 'Data Engineer',
    url: `${careersUrl}OpportunityDetail?opportunityId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
    company: 'Acme',
    location: 'New York, NY, USA',
    postedAt: Date.parse('2026-09-09T12:00:00Z'),
  }]);
});

test('UKG proof and provider reuse the bounded public JSON endpoint', async () => {
  const calls = [];
  const ctx = {
    fetchResponse: async (url, options = {}) => {
      calls.push({ url, options });
      if (options.method === 'POST') return response({ json: {
        totalCount: 1,
        opportunities: [{ Id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', Title: 'Analytics Engineer' }],
      } });
      return response({ text: landingHtml, cookie: '.AspNetCore.Antiforgery=value; path=/; httponly' });
    },
  };
  const proof = await fetchUkgBoardProof(identifier, ctx);
  assert.equal(proof.owner, 'Acme Holdings & Co.');
  assert.equal(proof.jobs[0].title, 'Analytics Engineer');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.headers['x-requestverificationtoken'], 'csrf-token');
  assert.match(calls[1].options.headers.cookie, /AspNetCore\.Antiforgery/);

  calls.length = 0;
  const jobs = await ukg.fetch({ name: 'Acme', careers_url: careersUrl }, { ...ctx, maxPages: 1 });
  assert.equal(jobs.length, 1);
  assert.equal(calls.length, 2);
});
