// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

const BASE = 'https://jobs.dayforcehcm.com';
const DEFAULT_LOCALE = 'en-US';
const PAGE_SIZE = 25;
const DEFAULT_MAX_PAGES = 200;

function safeSegment(value) {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(String(value || ''));
}

export function parseDayforceSlug(value) {
  const parts = String(value || '').split('/').filter(Boolean);
  if (parts.length < 1 || parts.length > 2 || parts.some(part => !safeSegment(part))) return null;
  return { namespace: parts[0], site: parts[1] || 'CANDIDATEPORTAL' };
}

export function resolveDayforceTenant(entry) {
  const explicit = parseDayforceSlug(entry?.dayforce_slug || '');
  if (explicit) return { ...explicit, locale: entry?.locale || DEFAULT_LOCALE };
  let url;
  try { url = new URL(String(entry?.careers_url || entry?.api || '')); }
  catch { return null; }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'jobs.dayforcehcm.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || !/^[a-z]{2}-[A-Z]{2}$/i.test(parts[0])) return null;
  const slug = parseDayforceSlug(parts.slice(1, 3).join('/'));
  return slug ? { ...slug, locale: parts[0] } : null;
}

function tenantUrl(tenant) {
  return `${BASE}/${tenant.locale}/${encodeURIComponent(tenant.namespace)}/${encodeURIComponent(tenant.site)}`;
}

function parsePostedAt(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function jobLocation(posting) {
  const locations = [];
  for (const item of posting?.postingLocations || []) {
    const value = String(item?.formattedAddress || '').trim()
      || [item?.cityName, item?.stateCode, item?.isoCountryCode].map(v => String(v || '').trim()).filter(Boolean).join(', ');
    if (value && !locations.includes(value)) locations.push(value);
  }
  return locations.join('; ') || (posting?.hasVirtualLocation ? 'Remote' : '');
}

export function parseDayforceResponse(body, tenant, companyName) {
  if (!Array.isArray(body?.jobPostings)) return [];
  const base = tenantUrl(tenant);
  const jobs = [];
  for (const posting of body.jobPostings) {
    const id = String(posting?.jobPostingId ?? '').trim();
    const title = String(posting?.jobTitle || '').trim();
    if (!/^\d+$/.test(id) || !title) continue;
    const job = {
      title,
      url: `${base}/jobs/${id}`,
      company: companyName,
      location: jobLocation(posting),
    };
    const description = String(posting?.jobDescription || '').trim();
    if (description) job.description = description;
    const postedAt = parsePostedAt(posting?.postingStartTimestampUTC);
    if (postedAt !== undefined) job.postedAt = postedAt;
    jobs.push(job);
  }
  return jobs;
}

function csrfCookie(response) {
  const raw = typeof response.headers?.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers?.get?.('set-cookie') || ''];
  return raw.flatMap(header => String(header).split(/,(?=\s*[A-Za-z0-9_.-]+=)/))
    .map(value => value.split(';')[0].trim())
    .filter(value => value.includes('next-auth'))
    .join('; ');
}

/** @type {Provider} */
export default {
  id: 'dayforce',

  detect(entry) {
    const tenant = resolveDayforceTenant(entry);
    return tenant ? { url: tenantUrl(tenant) } : null;
  },

  async fetch(entry, ctx) {
    const tenant = resolveDayforceTenant(entry);
    if (!tenant) throw new Error(`dayforce: cannot derive board coordinates for ${entry.name}`);
    if (typeof ctx.fetchResponse !== 'function') throw new Error('dayforce: fetchResponse transport is required');
    const ns = encodeURIComponent(tenant.namespace);
    const site = encodeURIComponent(tenant.site);
    const siteContext = await ctx.fetchJson(
      `${BASE}/api/geo/${ns}/sitecontext/${ns}/${site}/${tenant.locale}`,
      { redirect: 'error', headers: { accept: 'application/json' } },
    );
    if (siteContext?.isDisabled === true) return [];
    const boardCode = String(siteContext?.jobBoardCode || tenant.site);

    const csrfResponse = await ctx.fetchResponse(`${BASE}/api/auth/csrf`, {
      redirect: 'error', headers: { accept: 'application/json' },
    });
    const csrfBody = await csrfResponse.json();
    const token = String(csrfBody?.csrfToken || '').trim();
    if (!token) throw new Error('dayforce: CSRF token missing');
    const cookie = csrfCookie(csrfResponse);
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-csrf-token': token,
      ...(cookie ? { cookie } : {}),
    };
    const maxPages = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0
      ? ctx.maxPages
      : Number.isInteger(entry?.max_pages) && entry.max_pages > 0
        ? Math.min(entry.max_pages, DEFAULT_MAX_PAGES)
        : DEFAULT_MAX_PAGES;
    const jobs = [];
    let total = Infinity;
    for (let page = 0; page < maxPages && page * PAGE_SIZE < total; page += 1) {
      const paginationStart = page * PAGE_SIZE;
      const body = await ctx.fetchJson(`${BASE}/api/geo/${ns}/jobposting/search`, {
        method: 'POST', redirect: 'error', headers,
        body: JSON.stringify({
          clientNamespace: tenant.namespace,
          jobBoardCode: boardCode,
          cultureCode: tenant.locale,
          paginationStart,
        }),
      });
      const pageJobs = parseDayforceResponse(body, tenant, entry.name);
      jobs.push(...pageJobs);
      total = Number.isFinite(Number(body?.maxCount)) ? Number(body.maxCount) : jobs.length;
      if (!Array.isArray(body?.jobPostings) || body.jobPostings.length < PAGE_SIZE) break;
    }
    return jobs;
  },

  dedupKey(job) {
    return String(job?.url || '').match(/\/jobs\/(\d+)(?:[/?#]|$)/)?.[1] || null;
  },
};
