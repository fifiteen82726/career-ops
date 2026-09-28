// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { safeEncodeURIComponent } from './_safe-url.mjs';

// JibeApply provider — hits the /api/jobs endpoint on the same hostname.
// Auto-detects from careers_url pattern `https://<slug>.jibeapply.com`.
// iCIMS acquired Jibe in 2019; some tenants run it on a branded custom
// domain instead. The JSON API at /api/jobs is stable across all tenants.

// Safety cap on pagination — applied regardless of what the upstream reports
// as totalCount, so a misbehaving/compromised API can't drive this into
// fetching thousands of pages. Every known real tenant (10/page) stays well
// under the default of 50 pages (500 jobs); override with `max_pages` on the
// portal entry for a tenant that genuinely exceeds it — each page is a
// sequential round-trip, so raising the default for everyone isn't free.
const DEFAULT_MAX_PAGES = 50;
const MAX_PAGES_CAP = 500;

// Fallback page size when a response carries no jobs and no usable `count`
// (e.g. an empty first page). Confirmed live against real tenants — JibeApply
// reports this as `filter.displayLimit` and it has been 10 on every tenant
// observed so far.
const DEFAULT_PAGE_SIZE = 10;

/** Resolve the page cap: a positive integer `max_pages` on the entry, capped. */
function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

function toApiUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (!/^[a-z0-9-]+\.jibeapply\.com$/i.test(u.hostname)) return null;
  if (!u.pathname.startsWith('/api/')) {
    u.pathname = '/api' + (u.pathname.startsWith('/') ? u.pathname : '/' + u.pathname);
  }
  return u.href;
}

// Validate an explicit entry.api URL (any HTTPS hostname — used for iCIMS-hosted,
// branded JibeApply sites that share the same JSON schema).
function validateExplicitApi(apiUrl) {
  let u;
  try { u = new URL(apiUrl); } catch { return null; }
  return u.protocol === 'https:' ? u.href : null;
}

export function parseJibeapplyResponse(json, entry) {
  let origin = '';
  try { origin = new URL(entry.careers_url || '').origin; } catch { /* ignore */ }
  // careers_url isn't required to be a well-formed absolute URL for fetch()
  // to succeed (an explicit entry.api bypasses it entirely — see toApiUrl
  // callers below) — fall back to api's origin so job URLs stay absolute
  // instead of silently degrading to a relative "/jobs/<slug>" path.
  if (!origin) {
    try { origin = new URL(entry.api || '').origin; } catch { /* ignore */ }
  }
  const items = Array.isArray(json?.jobs) ? json.jobs : [];
  return items
    .map(item => {
      if (item == null) return null;
      const d = item.data ?? item;
      const title = String(d.title || '').trim();
      const slug = d.slug || d.req_id;
      if (!title || !slug) return null;
      // A lone surrogate in slug throws URIError out of encodeURIComponent and
      // aborts the whole page's .map(); drop just this job (the trailing
      // .filter(Boolean) removes the null).
      const encodedSlug = safeEncodeURIComponent(slug);
      if (encodedSlug === null) return null;
      return {
        title,
        url: `${origin}/jobs/${encodedSlug}`,
        company: String(d.hiring_organization || entry.name || '').trim(),
        location: d.full_location || [d.city, d.country].filter(Boolean).join(', '),
      };
    })
    .filter(Boolean);
}

/** @type {Provider} */
export default {
  id: 'jibeapply',

  detect(entry) {
    const url = entry.careers_url;
    if (typeof url !== 'string') return null;
    const apiUrl = toApiUrl(url);
    if (!apiUrl) return null;
    return { url: apiUrl };
  },

  async fetch(entry, ctx) {
    const url = entry.careers_url;
    if (typeof url !== 'string' || !url) throw new Error('jibeapply: careers_url required');

    // Prefer an explicit entry.api (allows iCIMS-hosted, branded JibeApply sites
    // that share the same JSON schema but aren't on jibeapply.com).
    const apiUrl = (typeof entry.api === 'string' && validateExplicitApi(entry.api))
      || toApiUrl(url);
    if (!apiUrl) throw new Error(`jibeapply: cannot derive API URL for ${entry.name}`);
    // A continuation ledger is optional so legacy provider callers remain
    // arrays-only.  When supplied, an unacknowledged page is replayed before
    // any cursor request.  The scanner acknowledges only after its normal
    // intake transaction has persisted the returned jobs.
    const continuation = ctx?.continuation;
    const prior = continuation?.snapshot?.();
    const replay = continuation?.pending?.() || [];
    const savedPages = new Set(replay.map(page => page.identity));
    const replayJobs = replay.flatMap(page => Array.isArray(page.payload?.jobs) ? page.payload.jobs : []);
    const resume = prior?.observed_total != null && prior?.page_size > 0 && Number(prior?.next_page) > 1;
    const first = resume ? null : await ctx.fetchJson(apiUrl, { redirect: 'error' });
    const total = resume ? prior.observed_total : (first.totalCount ?? 0);
    // Use the actual number of items returned as page size — some implementations
    // set `count` to the total rather than the per-page count.
    const pageSize = resume ? prior.page_size : (first.jobs?.length || first.count || DEFAULT_PAGE_SIZE);
    // Page 1 must be durable before any later page is requested.  A process
    // loss after this point therefore replays this payload instead of silently
    // treating a later cursor as evidence that it was consumed.
    if (continuation && !resume && !savedPages.has('page:1')) {
      continuation.savePage('page:1', first, { page: 1, total, page_size: pageSize });
      savedPages.add('page:1');
    }
    const allJobs = [...replayJobs, ...(first?.jobs ?? [])];
    let incomplete = false;
    let stopReason = '';
    let startPage = Math.max(2, Number(prior?.next_page) || 2);

    if (total > pageSize && pageSize > 0) {
      // `max_pages` is bounded work for this invocation, never a permanent
      // cursor ceiling.  A four-page board with max_pages:2 must resume at
      // pages 3–4 next time instead of declaring its first two pages final.
      const maxPages = resolveMaxPages(entry);
      const pages = Math.ceil(total / pageSize);
      // Sequential, not concurrent (mirrors providers/4dayweek.mjs, thehub.mjs,
      // arbeitnow.mjs, workday.mjs) — a single tenant's API has no reason to
      // receive a burst of parallel requests, and a mid-run failure stops
      // cleanly with whatever pages were already gathered instead of
      // discarding them (Promise.all would fail the whole batch on one error).
      // Cursor state is page identity, never aggregate row count: duplicate
      // jobs or a partial final page cannot move the next page incorrectly.
      startPage = Math.max(2, Number(prior?.next_page) || 2);
      const invocationBudget = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : maxPages;
      const invocationPages = Math.min(pages, resume ? startPage + invocationBudget - 1 : invocationBudget);
      for (let page = startPage; page <= invocationPages; page++) {
        const u2 = new URL(apiUrl);
        u2.searchParams.set('page', String(page));
        let json;
        try {
          json = await ctx.fetchJson(u2.toString(), { redirect: 'error' });
        } catch (err) {
          incomplete = true;
          stopReason = `page_${page}_failure`;
          console.error(`⚠️  jibeapply: ${entry.name} page ${page} fetch failed — ${err.message} (returning ${allJobs.length} jobs fetched so far)`);
          break;
        }
        const identity = `page:${page}`;
        continuation?.savePage?.(identity, json, { page, total, page_size: pageSize });
        savedPages.add(identity);
        allJobs.push(...(json.jobs ?? []));
        continuation?.state?.({ next_page: page + 1, observed_total: total, page_size: pageSize, fetched_pages: [...savedPages], unique_job_ids: [...new Set(allJobs.map(job => String(job?.data?.slug || job?.slug || job?.data?.req_id || job?.req_id || '')))].filter(Boolean), stop_reason: '' });
      }

      // The cap is silent by design (it's a safety net, not a working limit),
      // but a tenant that actually exceeds it needs to be surfaced —
      // otherwise the user has no way to notice postings are missing from
      // their scan.
      if (Math.ceil(total / pageSize) > invocationPages) {
        incomplete = true;
        stopReason ||= invocationPages < pages ? 'invocation_budget' : 'page_cap';
        console.error(
          `⚠️  jibeapply: ${entry.name} has more postings than max_pages allows ` +
          `(fetched ${allJobs.length} of ${total}) — ` +
          `set max_pages on this portal entry to raise the cap (current: ${maxPages})`,
        );
      }
    }

    const parsed = parseJibeapplyResponse({ jobs: allJobs }, entry);
    if (continuation) {
      // First page is a page too.  It is durable before the cursor is allowed
      // to pass it, and its identity stays stable across a replay.
      const nextPage = incomplete ? Math.max(2, startPage + [...savedPages].filter(identity => /^page:\d+$/.test(identity) && Number(identity.slice(5)) >= startPage).length) : Math.ceil(total / pageSize) + 1;
      continuation.state({ next_page: nextPage, observed_total: total, page_size: pageSize, stop_reason: stopReason || (incomplete ? 'still_incomplete' : 'complete') });
      parsed.continuationPages = continuation.pending().map(page => page.identity);
      parsed.continuationComplete = !incomplete;
    }
    if (incomplete) {
      parsed.jibeapplyTruncated = true;
      parsed.jibeapplyContinuation = { next_page: Math.ceil(allJobs.length / pageSize) + 1, total, page_size: pageSize, fetched: allJobs.length, stop_reason: stopReason };
      continuation?.incomplete?.({ type: stopReason || 'still_incomplete', provider: 'jibeapply', complete: false });
    }
    return parsed;
  },
};
