// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

import { decodeEntities } from './_html-entities.mjs';

const HOST_RE = /^recruiting2?\.ultipro\.com$/i;
const TENANT_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 50;
const MAX_PAGES = 100;

function clean(value) {
  return decodeEntities(String(value ?? '')).replace(/\s+/g, ' ').trim();
}

function coordinates(host, tenant, board) {
  if (!HOST_RE.test(host) || !TENANT_RE.test(tenant) || !UUID_RE.test(board)) return null;
  const canonicalHost = host.toLowerCase();
  const canonicalBoard = board.toLowerCase();
  return {
    host: canonicalHost,
    tenant,
    board: canonicalBoard,
    identifier: `${canonicalHost}:${tenant}:${canonicalBoard}`,
  };
}

export function resolveUkgBoard(entry) {
  const explicit = clean(entry?.ukg_slug || entry?.slug);
  if (explicit) {
    const [host, tenant, board, ...extra] = explicit.split(':');
    if (!extra.length) {
      const resolved = coordinates(host, tenant, board);
      if (resolved) return resolved;
    }
  }
  for (const raw of [entry?.careers_url, entry?.api]) {
    let url;
    try { url = new URL(String(raw || '')); } catch { continue; }
    if (url.protocol !== 'https:' || !HOST_RE.test(url.hostname)) continue;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[1]?.toLowerCase() !== 'jobboard') continue;
    const resolved = coordinates(url.hostname, parts[0], parts[2]);
    if (resolved) return resolved;
  }
  return null;
}

function boardUrl(board) {
  return `https://${board.host}/${encodeURIComponent(board.tenant)}/JobBoard/${board.board}/`;
}

function tagAttribute(tag, name) {
  return decodeEntities(String(tag || '').match(new RegExp(`(?:^|\\s)${name}=["']([^"']*)["']`, 'i'))?.[1] || '');
}

export function parseUkgLanding(html) {
  const source = String(html || '');
  let csrfToken = '';
  for (const tag of source.match(/<input\b[^>]*>/gi) || []) {
    if (tagAttribute(tag, 'name') === '__RequestVerificationToken') {
      csrfToken = clean(tagAttribute(tag, 'value'));
      break;
    }
  }
  let owner = '';
  for (const tag of source.match(/<img\b[^>]*>/gi) || []) {
    if (!/^navbar-(?:small|large)-logo$/i.test(tagAttribute(tag, 'data-automation'))) continue;
    owner = clean(tagAttribute(tag, 'alt'))
      .replace(/\s+(?:default\s+)?brand(?:ing)?\s*$/i, '')
      .trim();
    if (owner) break;
  }
  if (/^(?:external|careers?|jobs?|opportunities)$/i.test(owner)) owner = '';
  return { owner: owner || null, csrfToken };
}

function locationText(opportunity) {
  const values = [];
  for (const location of opportunity?.Locations || []) {
    const address = location?.Address || {};
    const value = [address.City, address.State?.Code || address.State?.Name,
      address.Country?.Code || address.Country?.Name].map(clean).filter(Boolean).join(', ')
      || clean(location?.LocalizedName || location?.LocalizedDescription);
    if (value && !values.includes(value)) values.push(value);
  }
  return values.join('; ');
}

export function parseUkgSearch(body, board, companyName) {
  if (!board || !Array.isArray(body?.opportunities)) return { total: 0, jobs: [] };
  const base = boardUrl(board);
  const jobs = [];
  for (const opportunity of body.opportunities) {
    const id = clean(opportunity?.Id);
    const title = clean(opportunity?.Title);
    if (!UUID_RE.test(id) || !title) continue;
    const job = {
      title,
      url: `${base}OpportunityDetail?opportunityId=${id.toLowerCase()}`,
      company: companyName,
      location: locationText(opportunity),
    };
    const postedAt = Date.parse(String(opportunity?.PostedDate || ''));
    if (Number.isFinite(postedAt)) job.postedAt = postedAt;
    jobs.push(job);
  }
  const total = Number(body?.totalCount);
  return { total: Number.isFinite(total) && total >= 0 ? total : jobs.length, jobs };
}

function responseCookies(response) {
  const raw = typeof response.headers?.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers?.get?.('set-cookie') || ''];
  return raw.flatMap(header => String(header).split(/,(?=\s*[A-Za-z0-9_.-]+=)/))
    .map(value => value.split(';')[0].trim()).filter(Boolean).join('; ');
}

function query(skip, top) {
  return {
    opportunitySearch: {
      Top: top,
      Skip: skip,
      QueryString: '',
      OrderBy: [{ Value: 'postedDateDesc', PropertyName: 'PostedDate', Ascending: false }],
      Filters: [],
    },
  };
}

async function openSession(board, ctx) {
  if (typeof ctx?.fetchResponse !== 'function') throw new Error('ukg: fetchResponse transport is required');
  const response = await ctx.fetchResponse(boardUrl(board), {
    redirect: 'error', headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0' },
  });
  const landing = parseUkgLanding(await response.text());
  if (!landing.csrfToken) throw new Error('ukg: request verification token missing');
  return { ...landing, cookie: responseCookies(response) };
}

async function searchPage(board, session, ctx, skip, top) {
  const url = `${boardUrl(board)}JobBoardView/LoadSearchResults`;
  const response = await ctx.fetchResponse(url, {
    method: 'POST',
    redirect: 'error',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json; charset=utf-8',
      'x-requestverificationtoken': session.csrfToken,
      'user-agent': 'Mozilla/5.0',
      ...(session.cookie ? { cookie: session.cookie } : {}),
    },
    body: JSON.stringify(query(skip, top)),
  });
  return response.json();
}

export async function fetchUkgBoardProof(identifier, ctx) {
  const board = resolveUkgBoard({ ukg_slug: identifier });
  if (!board) throw new Error('ukg: invalid board coordinates');
  const session = await openSession(board, ctx);
  const payload = await searchPage(board, session, ctx, 0, 1);
  return {
    owner: session.owner,
    jobs: parseUkgSearch(payload, board, '').jobs,
    payload,
  };
}

/** @type {Provider} */
export default {
  id: 'ukg',

  detect(entry) {
    const board = resolveUkgBoard(entry);
    return board ? { url: boardUrl(board) } : null;
  },

  async fetch(entry, ctx) {
    const board = resolveUkgBoard(entry);
    if (!board) throw new Error(`ukg: cannot derive board coordinates for ${entry.name}`);
    const session = await openSession(board, ctx);
    const pageCap = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0
      ? Math.min(ctx.maxPages, MAX_PAGES)
      : Number.isInteger(entry?.max_pages) && entry.max_pages > 0
        ? Math.min(entry.max_pages, MAX_PAGES) : MAX_PAGES;
    const jobs = [];
    let total = Infinity;
    for (let page = 0; page < pageCap && page * PAGE_SIZE < total; page += 1) {
      const payload = await searchPage(board, session, ctx, page * PAGE_SIZE, PAGE_SIZE);
      const parsed = parseUkgSearch(payload, board, entry.name);
      jobs.push(...parsed.jobs);
      total = parsed.total;
      if (!Array.isArray(payload?.opportunities) || payload.opportunities.length < PAGE_SIZE) break;
    }
    return jobs;
  },

  dedupKey(job) {
    return String(job?.url || '').match(/[?&]opportunityId=([0-9a-f-]{36})(?:&|$)/i)?.[1]?.toLowerCase() || null;
  },
};
