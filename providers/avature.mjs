// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
import { decodeEntities } from './_html-entities.mjs';
import { sleep } from './_http.mjs';

// Avature provider — parses the public Avature career-site job list.
// Auto-detects from a careers_url on `*.avature.net`; a branded custom domain
// that proxies Avature needs an explicit `provider: avature` + `api:` pointing
// at the Avature origin (or its /careers/SearchJobs URL).
//
//   GET {origin}/careers/SearchJobs?jobOffset=N
//
// returns a server-rendered page of <article class="article--result"> blocks.
// Page sizes vary by tenant (e.g. 6 or 10). Advance by the observed number of
// result rows, not a fixed size. max_pages (default 50) bounds the scan; an
// incomplete scan emits an explicit warning for callers' partial-run tracking.
//
// Pagination parameter name is `jobOffset` on classic tenants, but some branded
// tenants ignore it and page via a bare `offset` instead (e.g. jobs.siemens.com:
// `?jobOffset=6` returns page 1 unchanged, `?offset=6` advances). This is
// self-healing: we start with `jobOffset`, and if the first paginated page comes
// back identical to page 0 (every id already seen → the param is inert), we
// retry that page once with `offset` and adopt whichever key actually advances.
// So a new branded tenant needs no configuration. An entry can still pin the key
// explicitly via `offset_param` (disables the auto-switch) as an escape hatch.
//
// Location isn't rendered in every tenant's list (the subtitle is Job ID /
// hire-type / posted-date); we extract it when a marker is present and leave it
// empty otherwise. postedAt comes from the "Posted DD-Mon-YYYY" subtitle.

const DEFAULT_MAX_PAGES = 50; // override via entry.max_pages
const HARD_MAX_PAGES = 200;
// Pause between successive page requests. Small pages make large boards
// request-heavy; firing those with no
// gap risks the tenant's WAF rate-limiting the burst. Mirrors workday's
// INTER_PAGE_DELAY_MS — only boards that paginate past page 0 pay it.
const INTER_PAGE_DELAY_MS = 250;
// The bare key we self-heal to when the primary (`jobOffset`) proves inert.
const FALLBACK_OFFSET_PARAM = 'offset';

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** @param {import('./_types.js').PortalEntry} entry */
function resolveConfig(entry) {
  const raw = entry.api || entry.careers_url || '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  // Honour an explicit SearchJobs path (branded tenants may prefix a locale,
  // e.g. /en_US/searchjobs/SearchJobs); otherwise default to the classic path.
  const searchPath = /\/SearchJobs\b/i.test(u.pathname) ? u.pathname.replace(/\/+$/, '') : '/careers/SearchJobs';
  return { searchUrl: `${u.origin}${searchPath}`, origin: u.origin };
}

/** @param {string} s */
function clean(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// "Posted 02-May-2026" → epoch ms (UTC midnight). Undefined when absent/unparseable.
/** @param {string} block */
function parsePosted(block) {
  const m = block.match(/Posted\s+(\d{1,2})-([A-Za-z]{3})-(\d{4})(?!\d)/);
  if (!m) return undefined;
  const mon = MONTHS[m[2].toLowerCase()];
  if (mon === undefined) return undefined;
  const year = Number(m[3]);
  const day = Number(m[1]);
  const ms = Date.UTC(year, mon, day);
  const date = new Date(ms);
  return date.getUTCFullYear() === year && date.getUTCMonth() === mon && date.getUTCDate() === day ? ms : undefined;
}

// Best-effort location: some tenants tag it with a list-item-location span or a
// map-marker glyph; most (e.g. Synopsys) render none, so this returns ''.
/** @param {string} block */
function parseLocation(block) {
  const m =
    block.match(/list-item-location[^>]*>([\s\S]*?)<\/span>/i) ||
    block.match(/class="[^"]*\blocation\b[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div|li)>/i) ||
    block.match(/glyphicon-map-marker[\s\S]{0,80}?>([^<]{2,60})</i);
  return m ? clean(m[1]) : '';
}

/** @param {string} attributes @param {string} name */
function attribute(attributes, name) {
  return attributes.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'))?.[2] || '';
}

/** @param {string} htmlText */
function resultBlocks(htmlText) {
  return [...htmlText.matchAll(/<article\b([^>]*)>[\s\S]*?<\/article\s*>/gi)]
    .filter(match => attribute(match[1], 'class').split(/\s+/).includes('article--result'))
    .map(match => match[0]);
}

/** @param {string[]} blocks @param {string} origin */
function parseBlocks(blocks, origin) {
  const out = [];
  for (const block of blocks) {
    // JobDetail path may or may not sit under /careers/ (branded tenants vary),
    // so anchor on JobDetail/ itself rather than a fixed prefix. Prefer the
    // `class="link"` title anchor (most tenants); fall back to any JobDetail
    // anchor for tenants (e.g. Rohde & Schwarz) whose title link carries no
    // class. Share/mailto buttons url-encode the path (%2FJobDetail%2F) so they
    // never match the literal `/JobDetail/` and can't be mistaken for the title.
    const anchors = [...block.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)]
      .map(match => ({ href: attribute(match[1], 'href'), classes: attribute(match[1], 'class').split(/\s+/), title: clean(match[2]) }))
      .filter(anchor => /\/JobDetail\//.test(anchor.href) && anchor.title);
    const anchor = anchors.find(item => item.classes.includes('link')) || anchors[0];
    if (!anchor) continue;
    const title = anchor.title;
    if (!title) continue;
    let resolved;
    try {
      resolved = new URL(decodeEntities(anchor.href), origin);
    } catch {
      continue;
    }
    if (!['https:', 'http:'].includes(resolved.protocol) || resolved.username || resolved.password) continue;
    const url = resolved.href;
    const idM = url.match(/\/JobDetail\/[^/]*\/(\d+)/);
    out.push({
      id: idM ? idM[1] : url,
      title,
      url,
      location: parseLocation(block),
      postedAt: parsePosted(block),
    });
  }
  return out;
}

/** @param {string} htmlText @param {string} origin */
export function parseArticles(htmlText, origin) {
  return parseBlocks(resultBlocks(htmlText), origin);
}

// A total such as "999+" is only a lower bound, never completion evidence.
/** @param {string} htmlText */
function parseTotal(htmlText) {
  const match = htmlText.match(/\bdata-total\s*=\s*(["'])\s*(\d[\d,]*)(\+?)\s*\1/i);
  if (!match) return null;
  const count = Number(match[2].replaceAll(',', ''));
  return Number.isSafeInteger(count) ? { count, exact: !match[3] } : null;
}

// HTTP 200 is not proof that a career-site response is a usable jobs page.
// Check blocking evidence before accepting a declared zero or no-results text.
/** @param {string} htmlText @param {{ count: number, exact: boolean } | null} total */
function emptyPageEvidence(htmlText, total) {
  const visible = clean(htmlText.replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, ''));
  const loginHeading = /<(?:h1|title)\b[^>]*>\s*(?:sign\s*in|log\s*in|login)\b/i.test(htmlText);
  const passwordField = [...htmlText.matchAll(/<input\b([^>]*)>/gi)].some(match => attribute(match[1], 'type').toLowerCase() === 'password');
  if (loginHeading || passwordField || /\b(?:access denied|verify (?:that )?you are human|checking your browser|captcha|authentication required|sign in to (?:continue|access)|log in to (?:continue|access))\b/i.test(visible) || /\b(?:cf-chl|challenge-platform|g-recaptcha|h-captcha)\b/i.test(htmlText)) {
    return 'blocked';
  }
  if (total?.exact && total.count === 0) return 'empty';
  if (!total && /\b(?:no (?:jobs|results) (?:were )?found|no jobs match(?:ing)?\b|there are (?:currently )?no (?:open )?(?:jobs|positions)\b)/i.test(visible)) return 'empty';
  return 'unrecognized';
}

/** @type {Provider} */
export default {
  id: 'avature',

  detect(entry) {
    const url = entry.api || entry.careers_url || '';
    if (typeof url !== 'string') return null;
    try {
      const host = new URL(url).host.toLowerCase();
      if (host === 'avature.net' || host.endsWith('.avature.net')) return { url };
    } catch {
      /* not absolute */
    }
    return null;
  },

  async fetch(entry, ctx) {
    const cfg = resolveConfig(entry);
    if (!cfg) throw new Error(`avature: cannot resolve origin for ${entry.name}`);
    const maxPages = Math.min(
      HARD_MAX_PAGES,
      Number.isFinite(entry.max_pages) && entry.max_pages > 0 ? Number(entry.max_pages) : DEFAULT_MAX_PAGES,
    );

    // Pagination key. An explicit `offset_param` pins it (and disables the
    // auto-switch below); otherwise start with `jobOffset` and self-heal. A
    // non-string/empty override falls back to the default so a malformed entry
    // can't produce `?=N`.
    const pinned = typeof entry.offset_param === 'string' && entry.offset_param.trim();
    let offsetParam = pinned ? entry.offset_param.trim() : 'jobOffset';
    let canHeal = !pinned; // once the key is pinned, never auto-switch

    const jobs = [];
    const seen = new Set();

    const getPage = async (param, offset) => {
      const htmlText = await ctx.fetchText(`${cfg.searchUrl}?${param}=${offset}`, {
        redirect: 'error',
        headers: { accept: 'text/html' },
      });
      const blocks = resultBlocks(htmlText);
      const total = parseTotal(htmlText);
      if (blocks.length === 0) {
        const evidence = emptyPageEvidence(htmlText, total);
        if (evidence === 'blocked') throw new Error(`avature: blocked or login response for ${entry.name} at offset=${offset}`);
        if (offset === 0 && evidence !== 'empty') throw new Error(`avature: unrecognized first-page markup for ${entry.name}; no result rows or confirmed no-jobs evidence`);
      }
      return { articles: parseBlocks(blocks, cfg.origin), rowCount: blocks.length, total };
    };
    // Absorb a page's articles, returning how many were not already seen.
    const absorb = (articles) => {
      let fresh = 0;
      for (const art of articles) {
        if (seen.has(art.id)) continue;
        seen.add(art.id);
        fresh++;
        jobs.push({
          title: art.title,
          url: art.url,
          company: entry.name,
          location: art.location,
          postedAt: art.postedAt,
        });
      }
      return fresh;
    };

    let offset = 0;
    let pageSize = 0;
    let knownTotal = null;
    let stopped = false;
    let skippedRows = false;
    const warn = reason => console.error(`⚠️ avature: ${entry.name} partial/truncated: ${reason} (${jobs.length} unique jobs collected; advertised total ${knownTotal ? `${knownTotal.count}${knownTotal.exact ? '' : '+'}` : 'unknown'})`);
    const observe = pageData => {
      if (pageData.rowCount > pageData.articles.length) skippedRows = true;
      if (!knownTotal) knownTotal = pageData.total;
      else if (pageData.total && (pageData.total.count !== knownTotal.count || !pageData.total.exact)) {
        knownTotal = { count: Math.max(knownTotal.count, pageData.total.count), exact: false };
      }
    };
    for (let page = 0; page < maxPages; page++) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
      let pageData = await getPage(offsetParam, offset);
      observe(pageData);
      let fresh = absorb(pageData.articles);

      // Self-heal: the first paginated page didn't advance — either it repeated
      // page 0 (all-dup) or came back empty because the primary key is inert
      // (some tenants echo page 0 for an unknown param, others return nothing).
      // Retry this page once with the fallback key; if it advances, adopt it for
      // the remainder. Only on page 1; later repeats stop with a partial warning
      // instead of being assumed to prove the board is exhausted.
      // NOTE: fresh === 0 must be evaluated before the empty-page break below,
      // or an inert key that returns an empty page 1 would exit without healing.
      if (fresh === 0 && canHeal && page === 1) {
        canHeal = false;
        await sleep(INTER_PAGE_DELAY_MS, ctx);
        const alternative = await getPage(FALLBACK_OFFSET_PARAM, offset);
        observe(alternative);
        const altFresh = absorb(alternative.articles);
        if (altFresh > 0) {
          offsetParam = FALLBACK_OFFSET_PARAM;
          pageData = alternative;
          fresh = altFresh;
        }
      }

      if (knownTotal?.exact && jobs.length === knownTotal.count && !skippedRows) {
        stopped = true;
        break;
      }
      if (fresh === 0) {
        if (pageData.rowCount > 0 || skippedRows || (knownTotal && (!knownTotal.exact || jobs.length < knownTotal.count))) {
          warn('non-advancing or empty page before confirmed exhaustion');
        }
        stopped = true;
        break;
      }
      pageSize ||= pageData.rowCount;
      offset += pageData.rowCount;
      // A short page is a useful end signal only when no advertised total says
      // otherwise. First-page length alone cannot tell us a tenant's page cap.
      if (!knownTotal && pageData.rowCount < pageSize) {
        if (skippedRows) warn('unparseable result rows');
        stopped = true;
        break;
      }
    }
    if (!stopped) warn(`max_pages=${maxPages} reached`);
    return jobs;
  },
};
