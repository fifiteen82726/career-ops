// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { decodeEntities } from './_html-entities.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { fetchTextWithRetry } from './_http.mjs';

// Findly/mCloud career sites expose a public JSONP endpoint. Branded pages
// publish the API base and numeric organization id in `window.cws_opts` and
// initialize CWS.jobs with the same org_id. The list response includes stable
// public URLs, locations, descriptions, and real posting timestamps.
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 50;
const MAX_PAGES_CAP = 500;

/** @param {any} entry */
export function resolveConfig(entry) {
  let api;
  let careers;
  try {
    api = new URL(String(entry?.api || ''));
    careers = new URL(String(entry?.careers_url || ''));
  } catch {
    return null;
  }
  if (api.protocol !== 'https:' || careers.protocol !== 'https:') return null;
  const organization = String(entry?.mcloud?.organization || '').trim();
  if (!/^\d+$/.test(organization)) return null;
  const configuredSize = Number(entry?.mcloud?.pageSize);
  const pageSize = Number.isInteger(configuredSize) && configuredSize > 0
    ? Math.min(configuredSize, 500)
    : DEFAULT_PAGE_SIZE;
  return { api: api.href.replace(/\/$/, ''), origin: careers.origin, organization, pageSize };
}

/** Parse a JSONP response without evaluating its JavaScript wrapper. */
export function parseJsonp(text) {
  const raw = String(text || '').trim();
  const start = raw.indexOf('(');
  const end = raw.lastIndexOf(')');
  if (start <= 0 || end <= start) throw new Error('mcloud: invalid JSONP response');
  try {
    return JSON.parse(raw.slice(start + 1, end));
  } catch {
    throw new Error('mcloud: invalid JSONP payload');
  }
}

function absoluteJobUrl(raw, origin) {
  try {
    const u = new URL(String(raw || ''), origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    // Some payloads still publish http:// for a branded site that enforces
    // HTTPS. Normalize same-host job links so output never downgrades users.
    if (u.hostname === new URL(origin).hostname) u.protocol = 'https:';
    return u.href;
  } catch {
    return '';
  }
}

/** @param {any} json @param {any} entry */
export function parseMcloudResponse(json, entry) {
  const cfg = resolveConfig(entry);
  if (!cfg) return [];
  const rows = Array.isArray(json?.queryResult) ? json.queryResult : [];
  return rows.map((job) => {
    const title = decodeEntities(String(job?.title || '')).replace(/\s+/g, ' ').trim();
    const url = absoluteJobUrl(job?.url, cfg.origin);
    if (!title || !url || job?.id == null) return null;
    const parts = [job?.primary_city, job?.primary_state, job?.primary_country]
      .map((v) => String(v || '').trim()).filter(Boolean);
    const posted = Date.parse(String(job?.open_date || ''));
    return {
      title,
      url,
      company: String(job?.company_name || entry.name || '').trim(),
      location: [...new Set(parts)].join(', '),
      description: htmlToText(job?.description),
      ...(Number.isFinite(posted) ? { postedAt: posted } : {}),
    };
  }).filter(Boolean);
}

function maxPages(entry, ctx) {
  const raw = Number(entry?.max_pages);
  const configured = Number.isInteger(raw) && raw > 0
    ? Math.min(raw, MAX_PAGES_CAP)
    : DEFAULT_MAX_PAGES;
  const probe = Number(ctx?.maxPages);
  return Number.isInteger(probe) && probe > 0 ? Math.min(configured, probe) : configured;
}

/** @type {Provider} */
export default {
  id: 'mcloud',

  detect(entry) {
    try {
      const u = new URL(String(entry?.api || ''));
      return u.hostname.endsWith('.m-cloud.io') ? { url: u.href } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry);
    if (!cfg) throw new Error(`mcloud: invalid api/careers_url/organization for ${entry?.name || 'portal'}`);
    const jobs = [];
    const seen = new Set();
    const pageCap = maxPages(entry, ctx);
    let total = Infinity;
    for (let page = 0; page < pageCap && jobs.length < total; page++) {
      const url = new URL(cfg.api);
      url.searchParams.set('Organization', cfg.organization);
      url.searchParams.set('Limit', String(cfg.pageSize));
      url.searchParams.set('offset', String(page * cfg.pageSize + 1));
      url.searchParams.set('sortfield', 'open_date');
      url.searchParams.set('sortorder', 'descending');
      url.searchParams.set('callback', 'CWS.jobs.jobCallback');
      const payload = parseJsonp(await fetchTextWithRetry(ctx, url.href, { redirect: 'error' }));
      if (Number.isFinite(payload?.totalHits) && payload.totalHits >= 0) total = payload.totalHits;
      const pageJobs = parseMcloudResponse(payload, entry);
      if (pageJobs.length === 0) break;
      for (const job of pageJobs) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push(job);
      }
      if ((payload?.queryResult?.length || 0) < cfg.pageSize) break;
    }
    return jobs;
  },
};
