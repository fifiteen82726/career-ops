// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

const PORTAL = 'https://www.paycomonline.net/v4/ats/web.php/portal';
const KEY_RE = /^[0-9a-f]{32}$/i;
const PAGE_SIZE = 500;
const MAX_PAGES = 100;

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function resolvePaycomBoard(entry) {
  const explicit = clean(entry?.paycom_slug || entry?.slug);
  if (KEY_RE.test(explicit)) return { slug: explicit.toUpperCase() };
  for (const raw of [entry?.careers_url, entry?.api]) {
    let url;
    try { url = new URL(String(raw || '')); } catch { continue; }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'www.paycomonline.net') continue;
    const match = url.pathname.match(/\/v4\/ats\/web\.php\/portal\/([0-9a-f]{32})(?:\/|$)/i);
    if (match) return { slug: match[1].toUpperCase() };
  }
  return null;
}

export function parsePaycomSession(html, slug) {
  if (!KEY_RE.test(slug)) return null;
  const source = String(html || '');
  const start = source.indexOf('configsFromHost = ');
  if (start < 0) return null;
  const valueStart = start + 'configsFromHost = '.length;
  const end = source.indexOf(';\n', valueStart);
  if (end < 0) return null;
  let config;
  try { config = JSON.parse(source.slice(valueStart, end)); } catch { return null; }
  const token = clean(config?.sessionJWT);
  if (!token) return null;
  let library = {};
  try { library = JSON.parse(config?.libConfig || '{}'); } catch { /* use default */ }
  const rawMantle = clean(library?.atsPortalMantleServiceUrl)
    || 'https://portal-applicant-tracking.us-cent.paycomonline.net/';
  let mantle;
  try { mantle = new URL(rawMantle); } catch { return null; }
  if (mantle.protocol !== 'https:' || (mantle.hostname !== 'paycomonline.net'
    && !mantle.hostname.endsWith('.paycomonline.net'))) return null;
  mantle.pathname = `${mantle.pathname.replace(/\/+$/, '')}/`;
  mantle.search = '';
  mantle.hash = '';
  return { slug: slug.toUpperCase(), mantle: mantle.href, token };
}

function filters() {
  return {
    distanceFrom: 0,
    workEnvironments: [],
    positionTypes: [],
    educationLevels: [],
    categories: [],
    travelTypes: [],
    shiftTypes: [],
    otherFilters: [],
    keywordSearchText: '',
    location: '',
    sortOption: 'N',
  };
}

function authHeaders(session) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: session.token,
    locale: 'en-US',
  };
}

export function parsePaycomSearch(body, slug, companyName) {
  if (!Array.isArray(body?.jobPostingPreviews)) return { total: 0, jobs: [] };
  const jobs = [];
  for (const posting of body.jobPostingPreviews) {
    const id = clean(posting?.jobId);
    const title = clean(posting?.jobTitle);
    if (!/^\d+$/.test(id) || !title) continue;
    const job = {
      title,
      url: `${PORTAL}/${slug.toUpperCase()}/jobs/${id}`,
      company: companyName,
      location: clean(posting?.locations || posting?.location || posting?.remoteType),
    };
    const postedAt = Date.parse(String(posting?.postedOn || ''));
    if (Number.isFinite(postedAt)) job.postedAt = postedAt;
    jobs.push(job);
  }
  const total = Number(body?.jobPostingPreviewsCount);
  return { total: Number.isFinite(total) && total >= 0 ? total : jobs.length, jobs };
}

async function openSession(slug, ctx) {
  const html = await ctx.fetchText(`${PORTAL}/${slug}/career-page`, {
    redirect: 'error',
    headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0' },
    maxBytes: 1_048_576,
  });
  const session = parsePaycomSession(html, slug);
  if (!session) throw new Error('paycom: public session metadata missing or unsafe');
  return session;
}

async function searchPage(session, ctx, skip, take) {
  return ctx.fetchJson(`${session.mantle}api/ats/job-posting-previews/search`, {
    method: 'POST',
    redirect: 'error',
    headers: authHeaders(session),
    body: JSON.stringify({ skip, take, filtersForQuery: filters() }),
  });
}

export async function fetchPaycomBoardProof(slug, ctx) {
  if (!KEY_RE.test(slug)) throw new Error('paycom: invalid client key');
  const key = slug.toUpperCase();
  const session = await openSession(key, ctx);
  const search = await searchPage(session, ctx, 0, 1);
  const parsed = parsePaycomSearch(search, key, '');
  const first = search?.jobPostingPreviews?.[0];
  if (!first?.jobId || !parsed.jobs.length) return { owner: null, jobs: [], payload: search };
  const detail = await ctx.fetchJson(
    `${session.mantle}api/ats/job-postings/${encodeURIComponent(String(first.jobId))}`,
    { redirect: 'error', headers: authHeaders(session) },
  );
  let structured = {};
  try { structured = JSON.parse(detail?.jobPosting?.googleJobJson || '{}'); } catch { /* missing owner */ }
  const organization = structured?.hiringOrganization;
  const owner = clean(typeof organization === 'string' ? organization : organization?.name) || null;
  return { owner, jobs: parsed.jobs, payload: search };
}

/** @type {Provider} */
export default {
  id: 'paycom',

  detect(entry) {
    const board = resolvePaycomBoard(entry);
    return board ? { url: `${PORTAL}/${board.slug}/career-page` } : null;
  },

  async fetch(entry, ctx) {
    const board = resolvePaycomBoard(entry);
    if (!board) throw new Error(`paycom: cannot derive client key for ${entry.name}`);
    const session = await openSession(board.slug, ctx);
    const pageCap = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0
      ? Math.min(ctx.maxPages, MAX_PAGES) : MAX_PAGES;
    const jobs = [];
    let total = Infinity;
    for (let page = 0; page < pageCap && page * PAGE_SIZE < total; page += 1) {
      const body = await searchPage(session, ctx, page * PAGE_SIZE, PAGE_SIZE);
      const parsed = parsePaycomSearch(body, board.slug, entry.name);
      jobs.push(...parsed.jobs);
      total = parsed.total;
      if (parsed.jobs.length < PAGE_SIZE) break;
    }
    return jobs;
  },

  dedupKey(job) {
    return String(job?.url || '').match(/\/jobs\/(\d+)(?:[/?#]|$)/)?.[1] || null;
  },
};
