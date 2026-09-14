// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { decodeEntities } from './_html-entities.mjs';
import { fetchTextWithRetry } from './_http.mjs';
import { createHostPacer } from './_host-pacer.mjs';

const HOST = 'recruiting.paylocity.com';
const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const BOARD_PATH_RE = new RegExp(`^/recruiting/jobs/All/(${GUID})/?$`, 'i');
const { pace: paylocityPacer } = createHostPacer({ minimumIntervalMs: 1000 });
const RETRY_POLICY = { retries: 3, baseDelayMs: 1000, maxDelayMs: 15000 };

function boardUrl(entry) {
  try {
    const url = new URL(String(entry?.careers_url || ''));
    const match = url.protocol === 'https:' && url.hostname === HOST
      ? url.pathname.match(BOARD_PATH_RE)
      : null;
    return match ? `https://${HOST}/recruiting/jobs/All/${match[1].toLowerCase()}/` : null;
  } catch {
    return null;
  }
}

function text(value) {
  return decodeEntities(String(value || '')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parsePaylocityPage(html, companyName) {
  const match = String(html || '').match(/window\.pageData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/i);
  if (!match) return [];
  let data;
  try { data = JSON.parse(match[1]); } catch { return []; }
  if (!Array.isArray(data?.Jobs)) return [];
  return data.Jobs.filter(job => job?.JobId && job?.JobTitle).map(job => {
    const location = [job?.JobLocation?.City, job?.JobLocation?.State, job?.IsRemote ? 'Remote' : '']
      .map(value => text(value)).filter(Boolean).join(', ')
      || text(job?.LocationName);
    const postedAt = Date.parse(job?.PublishedDate || '');
    const description = text(job?.Description);
    return {
      title: text(job.JobTitle),
      url: `https://${HOST}/recruiting/Jobs/Details/${encodeURIComponent(String(job.JobId))}`,
      company: companyName,
      location,
      ...(Number.isFinite(postedAt) ? { postedAt } : {}),
      ...(description ? { description } : {}),
    };
  });
}

/** @type {Provider} */
export default {
  id: 'paylocity',
  detect(entry) {
    const url = boardUrl(entry);
    return url ? { url } : null;
  },
  async fetch(entry, ctx) {
    const url = boardUrl(entry);
    if (!url) throw new Error(`paylocity: cannot derive exact board URL for ${entry.name}`);
    const html = await paylocityPacer(() => fetchTextWithRetry(ctx, url, {
      redirect: 'error',
      headers: { 'user-agent': 'Mozilla/5.0' },
      timeoutMs: 30_000,
      maxBytes: 2_000_000,
    }, RETRY_POLICY), ctx);
    return parsePaylocityPage(html, entry.name);
  },
};
