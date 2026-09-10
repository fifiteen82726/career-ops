import test from 'node:test';
import assert from 'node:assert/strict';
import avature, { parseArticles } from '../providers/avature.mjs';

const origin = 'https://apply.example.test';
const article = (id, extra = '', attrs = 'class="article--result "') =>
  `<article ${attrs}><a href="/en_US/careers/JobDetail/Role/${id}" class="link">Role ${id}</a>${extra}</article>`;
const page = (start, count, total) => `${total === undefined ? '' : `<div data-total="${total}"></div>`}${Array.from({ length: count }, (_, i) => article(start + i)).join('')}`;

async function scan(fetchText, overrides = {}) {
  const urls = [];
  const warnings = [];
  const previous = console.error;
  console.error = (...args) => warnings.push(args.join(' '));
  try {
    const jobs = await avature.fetch({ name: 'Example', api: `${origin}/en_US/careers/SearchJobs`, ...overrides }, {
      fetchText: async url => { urls.push(url); return fetchText(new URL(url)); },
      sleep: async () => {},
    });
    return { jobs, urls, warnings };
  } finally {
    console.error = previous;
  }
}

test('result class is an exact token independent of base class, order, attributes, and quote style', () => {
  const html = article(1) + article(2, '', "data-total='999+' class='featured article--result article'")
    + article(3, '', 'class="article--resultish"') + article(4, '', 'class="article--result-empty"');
  assert.deepEqual(parseArticles(html, origin).map(row => row.id), ['1', '2']);
});

test('Deloitte-style href-first title and unmarked subtitles preserve unknown date and location', () => {
  const [row] = parseArticles(article(1, '<span>Deloitte US</span> | <span>Deloitte Transactions and Business Analytics LLP</span> | <span>Rosslyn, Virginia, United States</span>'), origin);
  assert.equal(row.title, 'Role 1');
  assert.equal(row.url, `${origin}/en_US/careers/JobDetail/Role/1`);
  assert.equal(row.postedAt, undefined);
  assert.equal(row.location, '');
});

test('single-quoted title href is accepted without changing title identity', () => {
  const [row] = parseArticles("<article class='article--result'><a class='link other' href='/careers/JobDetail/R-D/12'>R&amp;D</a></article>", origin);
  assert.equal(row.title, 'R&D');
  assert.equal(row.id, '12');
});

test('invalid Posted dates stay unknown instead of rolling into the following month', () => {
  for (const date of ['31-Feb-2026', '29-Feb-2025', '31-Apr-2026', '00-May-2026', '32-May-2026', '01-XYZ-2026']) {
    assert.equal(parseArticles(article(1, `Posted ${date}`, 'class="article article--result"'), origin)[0].postedAt, undefined, date);
  }
  assert.equal(parseArticles(article(1, 'Posted 29-Feb-2024'), origin)[0].postedAt, Date.UTC(2024, 1, 29));
});

test('actual ten-row page size advances offsets by ten and exact total can terminate cleanly', async () => {
  const result = await scan(url => {
    const offset = Number(url.searchParams.get('jobOffset'));
    return page(offset + 1, Math.min(10, 25 - offset), 25);
  });
  assert.equal(result.jobs.length, 25);
  assert.deepEqual(result.urls.map(url => new URL(url).searchParams.get('jobOffset')), ['0', '10', '20']);
  assert.deepEqual(result.warnings, []);
});

test('offset self-healing retries the inferred ten-row offset, not the old six-row offset', async () => {
  const result = await scan(url => {
    const offset = Number(url.searchParams.get('offset') || 0);
    return page(offset + 1, offset === 0 ? 10 : 2, 12);
  });
  assert.equal(result.jobs.length, 12);
  assert.ok(result.urls.some(url => url.endsWith('?offset=10')));
  assert.deepEqual(result.warnings, []);
});

test('known remaining jobs at the configured cap produce explicit partial/truncated warning', async () => {
  const result = await scan(url => page(Number(url.searchParams.get('jobOffset')) + 1, 10, '999+'), { max_pages: 2 });
  assert.equal(result.jobs.length, 20);
  assert.equal(result.urls.length, 2);
  assert.match(result.warnings.join(' '), /avature.*(?:partial|truncated).*max_pages=2/i);
});

test('repeated nonadvancing pages with known remaining jobs warn after one fallback attempt', async () => {
  const result = await scan(() => page(1, 10, 100));
  assert.equal(result.jobs.length, 10);
  assert.equal(result.urls.length, 3);
  assert.match(result.warnings.join(' '), /(?:partial|truncated).*non.advancing/i);
});

test('empty page cannot silently claim completion when an advertised total remains', async () => {
  const result = await scan(url => url.searchParams.get('jobOffset') === '0' ? page(1, 10, 100) : '');
  assert.equal(result.jobs.length, 10);
  assert.match(result.warnings.join(' '), /(?:partial|truncated)/i);
});

test('unknown total at a full-page cap warns; an exact reached total does not', async () => {
  const unknown = await scan(() => page(1, 10), { max_pages: 1 });
  assert.match(unknown.warnings.join(' '), /(?:partial|truncated)/i);
  const complete = await scan(() => page(1, 10, 10), { max_pages: 1 });
  assert.deepEqual(complete.warnings, []);
});

test('offset accounts for all result rows even when a malformed job row cannot be parsed', async () => {
  const result = await scan(url => {
    const offset = Number(url.searchParams.get('jobOffset'));
    if (offset === 0) return page(1, 9, 11) + '<article class="article--result">Missing job link</article>';
    return offset === 10 ? page(11, 1, 11) : '';
  });
  assert.equal(result.jobs.length, 10);
  assert.ok(result.urls.some(url => url.endsWith('?jobOffset=10')));
  assert.match(result.warnings.join(' '), /(?:partial|truncated)/i);
});

test('an unknown or HTTP-200 challenge first page cannot be healthy empty', async () => {
  for (const html of [
    '<div>no articles</div>',
    '<html><title>Just a moment...</title><div>Verify you are human</div></html>',
    '<h1>Access Denied</h1>',
    '<form><h1>Login</h1><input type="password"></form>',
  ]) {
    await assert.rejects(scan(() => html), /avature:.*(?:blocked|unrecognized|parse)/i);
  }
});

test('an explicit zero total or legitimate no-jobs message can be healthy empty', async () => {
  for (const html of ['<div data-total="0"></div>', '<p>No jobs found.</p>', '<div>No results found.</div>']) {
    const result = await scan(() => html);
    assert.deepEqual(result.jobs, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.urls.length, 1);
  }
});

test('a blocked/login page wins over an apparent zero total or no-jobs message', async () => {
  await assert.rejects(scan(() => '<h1>Access Denied</h1><div data-total="0">No jobs found.</div>'), /avature:.*blocked/i);
  await assert.rejects(scan(() => '<h1>Sign in</h1><form><input type="password"></form><div data-total="0"></div>'), /avature:.*blocked/i);
});

test('a later challenge without a known total cannot silently finish a healthy scan', async () => {
  await assert.rejects(scan(url => url.searchParams.get('jobOffset') === '0' ? page(1, 10) : '<h1>Access Denied</h1>'), /avature:.*blocked/i);
});

test('protocol-relative job links resolve correctly and unsafe URL schemes or credentials are rejected', () => {
  const withUrl = href => `<article class="article--result"><a class="link" href="${href}">Example</a></article>`;
  const [row] = parseArticles(withUrl('//jobs.example.test/careers/JobDetail/Role/1'), origin);
  assert.equal(row.url, 'https://jobs.example.test/careers/JobDetail/Role/1');
  for (const href of ['javascript:/JobDetail/Role/2', 'data:text/html,/JobDetail/Role/3', 'ftp://example.test/JobDetail/Role/4', 'https://user:secret@example.test/JobDetail/Role/5', 'http://[broken/JobDetail/Role/6']) {
    assert.deepEqual(parseArticles(withUrl(href), origin), [], href);
  }
});
