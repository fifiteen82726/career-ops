import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchJdViaKnownApi } from '../browser-extract.mjs';

test('fetchJdViaKnownApi dispatches iCIMS through the validated detail route', async () => {
  const prior = globalThis.fetch;
  const url = 'https://careers-acme.icims.com/jobs/42/analytics-engineer/job';
  globalThis.fetch = async (request, options) => {
    assert.equal(String(request), `${url}?in_iframe=1`);
    assert.equal(options.headers.accept, 'text/html');
    return new Response('<script type="application/ld+json">{"@type":"JobPosting","title":"Analytics Engineer","description":"<p>Own data models and pipelines.</p>"}</script>');
  };
  try {
    const result = await fetchJdViaKnownApi(url, 5_000, 1_000);
    assert.equal(result?.ats, 'icims');
    assert.equal(result?.title, 'Analytics Engineer');
    assert.match(result?.text || '', /Own data models/);
  } finally { globalThis.fetch = prior; }
});
