#!/usr/bin/env node

/**
 * Fail-closed identity and health gate for Sunny's bulk ATS discovery.
 * A reachable board is not enough: it may belong to another employer whose
 * slug happens to resemble the DOL name. Greenhouse, Ashby, Lever and Workday
 * publish an owner; every other provider needs an exact reviewed official URL.
 */

import { ATS, boardIdentityMatches, boardTitleOwner } from '../../verify-portals.mjs';
import { asciiFold } from '../../lib/ascii-fold.mjs';
import { decodeEntities } from '../../providers/_html-entities.mjs';
import { parseIcimsSearchPage } from '../../providers/icims.mjs';
import { fetchPaycomBoardProof } from '../../providers/paycom.mjs';
import { fetchUkgBoardProof } from '../../providers/ukg.mjs';
import { isIP } from 'node:net';

export const OWNER_PUBLISHING_PROVIDERS = new Set([
  'greenhouse', 'ashby', 'lever', 'workday', 'paylocity', 'bamboohr',
  'smartrecruiters', 'gem', 'workable', 'icims', 'recruitee', 'breezy',
  'teamtailor', 'personio', 'rippling', 'jobvite',
  'jibeapply', 'pinpoint', 'dayforce', 'paycom',
  'ukg',
]);
export const WRITABLE_IDENTITIES = new Set(['owner_verified', 'reviewed_official_link']);
export const WRITABLE_HEALTH = new Set(['live', 'partial']);

const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'plc', 'corp',
  'corporation', 'co', 'company', 'gmbh', 'ag', 'sa', 'sas', 'sarl', 'bv', 'nv',
]);

export function canonicalIdentityTokens(value) {
  const words = asciiFold(String(value || '').replace(/\s+&\s+/g, ' and '), { punctuation: 'delete' })
    .split(' ')
    .filter(Boolean);
  if (words.length > 1 && words[0] === 'the') words.shift();
  while (words.length > 1 && LEGAL_SUFFIXES.has(words.at(-1))) words.pop();
  return words;
}

export function normalizeEvidenceUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:') return '';
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

export function reviewedUrlVerdict(companyName, careersUrl, reviews) {
  const targetUrl = normalizeEvidenceUrl(careersUrl);
  const review = (reviews || []).find(row =>
    ['accept', 'reject'].includes(row?.verdict)
      && boardIdentityMatches(companyName, row?.identity || row?.company || '')
      && normalizeEvidenceUrl(row?.careers_url || row?.url) === targetUrl,
  );
  return review || null;
}

export function classifyPublishedOwner(companyName, boardOwner, ownerError = '') {
  if (ownerError) return { identity_status: 'owner_unreachable', reason: ownerError };
  if (!boardOwner) return { identity_status: 'owner_unreachable', reason: 'published ATS owner missing' };
  if (boardIdentityMatches(companyName, boardOwner)) {
    return { identity_status: 'owner_verified', reason: 'published ATS owner exactly matches DOL company identity' };
  }
  return { identity_status: 'review_required', reason: `published ATS owner mismatch: ${boardOwner}` };
}

export function extractIcimsOwner(html) {
  const source = String(html || '');
  const metaTags = source.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    if (!/property=["']og:site_name["']/i.test(tag)) continue;
    const value = tag.match(/content=["']([^"']+)["']/i)?.[1];
    const owner = decodeEntities(value || '').trim();
    if (owner && !/^(?:careers|jobs|icims)$/i.test(owner)) return owner;
  }
  const title = decodeEntities(source.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '')
    .replace(/\s+/g, ' ').trim();
  if (!title || /^(?:careers|jobs|job search|icims)$/i.test(title)) return null;
  const patterns = [
    /^iCIMS\s*[-–|]\s*(.+)$/i,
    /^Careers at\s+(.+?)(?:\s*[|–-].*)?$/i,
    /^Search Jobs\s*[|–-]\s*(.+?)\s+Careers(?:\s*[|–-].*)?$/i,
    /^(.+?)\s+(?:Careers|Jobs)(?:\s*[|–-].*)?$/i,
  ];
  for (const pattern of patterns) {
    const owner = title.match(pattern)?.[1]?.trim();
    if (owner && !/^(?:careers|jobs|job search|icims|search)$/i.test(owner)) return owner;
  }
  return null;
}

export function extractIcimsHiringOrganization(html) {
  for (const match of String(html || '').matchAll(
    /<script\b[^>]*(?<![\w-])type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    let payload;
    try { payload = JSON.parse(match[1]); } catch { continue; }
    const pending = Array.isArray(payload) ? [...payload] : [payload];
    while (pending.length) {
      const node = pending.shift();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node['@graph'])) pending.push(...node['@graph']);
      const owner = String(node?.hiringOrganization?.name || '').trim();
      if (owner) return owner;
    }
  }
  return null;
}

export async function fetchPublishedBoardOwner(resolved, ctx, { includePayload = false } = {}) {
  const provider = String(resolved?.vendor || resolved?.provider || '').toLowerCase();
  if (!OWNER_PUBLISHING_PROVIDERS.has(provider)) return { owner: null, reason: 'provider-has-no-owner-endpoint' };
  const slug = String(resolved?.slug || '').trim();
  if (!slug) return { owner: null, error: 'missing board slug' };
  try {
    if (provider === 'ukg') {
      const [host, tenant, board, ...extra] = slug.split(':');
      if (extra.length || !/^recruiting2?\.ultipro\.com$/i.test(host || '')
        || !/^[a-z0-9][a-z0-9_-]*$/i.test(tenant || '')
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(board || '')) {
        return { owner: null, error: 'invalid UKG board coordinates' };
      }
      const expected = `https://${host.toLowerCase()}/${tenant}/JobBoard/${board.toLowerCase()}/`;
      if (normalizeEvidenceUrl(resolved?.careers_url) !== normalizeEvidenceUrl(expected)) {
        return { owner: null, error: 'UKG URL does not match board coordinates' };
      }
      const proof = await fetchUkgBoardProof(slug, ctx);
      return includePayload ? { owner: proof.owner, payload: proof.payload } : { owner: proof.owner };
    }
    if (provider === 'paycom') {
      if (!/^[0-9a-f]{32}$/i.test(slug)) return { owner: null, error: 'invalid Paycom client key' };
      const key = slug.toUpperCase();
      const expected = `https://www.paycomonline.net/v4/ats/web.php/portal/${key}/career-page`;
      if (normalizeEvidenceUrl(resolved?.careers_url) !== normalizeEvidenceUrl(expected)) {
        return { owner: null, error: 'Paycom URL does not match client key' };
      }
      const proof = await fetchPaycomBoardProof(key, ctx);
      return includePayload ? { owner: proof.owner, payload: proof.payload } : { owner: proof.owner };
    }
    if (provider === 'dayforce') {
      const [namespace, site, ...extra] = slug.split('/');
      if (extra.length || ![namespace, site].every(value => /^[a-z0-9][a-z0-9_-]*$/i.test(value || ''))) {
        return { owner: null, error: 'invalid Dayforce board coordinates' };
      }
      const expected = `https://jobs.dayforcehcm.com/en-US/${namespace}/${site}`;
      if (normalizeEvidenceUrl(resolved?.careers_url) !== normalizeEvidenceUrl(expected)) {
        return { owner: null, error: 'Dayforce URL does not match board coordinates' };
      }
      const body = await ctx.fetchJson(
        `https://jobs.dayforcehcm.com/api/geo/${encodeURIComponent(namespace)}/sitecontext/${encodeURIComponent(namespace)}/${encodeURIComponent(site)}/en-US`,
        { redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' } },
      );
      if (body?.isDisabled === true) return { owner: null, error: 'Dayforce board is disabled' };
      const owner = String(body?.candidateCorrespondenceClientName || '').trim() || null;
      return includePayload ? { owner, payload: body } : { owner };
    }
    if (provider === 'recruitee') {
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return { owner: null, error: 'invalid Recruitee tenant' };
      const expected = `https://${slug.toLowerCase()}.recruitee.com`;
      if (normalizeEvidenceUrl(resolved?.careers_url) !== expected) return { owner: null, error: 'Recruitee URL does not match tenant' };
      const body = await ctx.fetchJson(`${expected}/api/offers/`, {
        redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
      });
      const owner = String(body?.offers?.[0]?.company_name || '').trim() || null;
      return includePayload ? { owner, payload: body } : { owner };
    }
    if (provider === 'breezy') {
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return { owner: null, error: 'invalid Breezy tenant' };
      const expected = `https://${slug.toLowerCase()}.breezy.hr`;
      if (normalizeEvidenceUrl(resolved?.careers_url) !== expected) return { owner: null, error: 'Breezy URL does not match tenant' };
      const body = await ctx.fetchJson(`${expected}/json`, {
        redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
      });
      const owner = String(body?.[0]?.company?.name || '').trim() || null;
      return includePayload ? { owner, payload: body } : { owner };
    }
    if (provider === 'teamtailor') {
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return { owner: null, error: 'invalid Teamtailor tenant' };
      const expected = `https://${slug.toLowerCase()}.teamtailor.com/jobs`;
      if (normalizeEvidenceUrl(resolved?.careers_url) !== expected) return { owner: null, error: 'Teamtailor URL does not match tenant' };
      const xml = await ctx.fetchText(`https://${slug.toLowerCase()}.teamtailor.com/jobs.rss`, {
        redirect: 'error', headers: { accept: 'application/rss+xml, application/xml', 'user-agent': 'Mozilla/5.0' },
        maxBytes: 262_144,
      });
      const channel = String(xml || '').match(/<channel\b[^>]*>([\s\S]*?)<item\b/i)?.[1] || String(xml || '');
      const owner = decodeEntities(channel.match(/<title\b[^]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
      return includePayload ? { owner: owner || null, payload: xml } : { owner: owner || null };
    }
    if (provider === 'personio') {
      if (!/^[a-z0-9][a-z0-9-]*\.jobs\.personio\.(?:de|com)$/i.test(slug)) return { owner: null, error: 'invalid Personio tenant host' };
      const expected = `https://${slug.toLowerCase()}`;
      if (normalizeEvidenceUrl(resolved?.careers_url) !== expected) return { owner: null, error: 'Personio URL does not match tenant host' };
      const xml = await ctx.fetchText(`${expected}/xml`, {
        redirect: 'error', headers: { accept: 'application/xml', 'user-agent': 'Mozilla/5.0' }, maxBytes: 262_144,
      });
      const owner = decodeEntities(String(xml || '').match(/<subcompany\b[^>]*>([\s\S]*?)<\/subcompany>/i)?.[1] || '').trim();
      return includePayload ? { owner: owner || null, payload: xml } : { owner: owner || null };
    }
    if (provider === 'rippling') {
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return { owner: null, error: 'invalid Rippling board identifier' };
      const expected = `https://ats.rippling.com/${slug}/jobs`;
      if (normalizeEvidenceUrl(resolved?.careers_url) !== expected) return { owner: null, error: 'Rippling URL does not match board identifier' };
      const html = await ctx.fetchText(expected, {
        redirect: 'error', headers: { 'user-agent': 'Mozilla/5.0' }, maxBytes: 262_144,
      });
      const title = decodeEntities(String(html || '').match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '').trim();
      const owner = title.replace(/^Open Roles\s*[|–-]\s*/i, '').replace(/\s*[|–-]\s*(?:Open Roles|Careers|Jobs)\s*$/i, '').trim();
      return { owner: owner || null };
    }
    if (provider === 'jobvite') {
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return { owner: null, error: 'invalid Jobvite company slug' };
      const expected = `https://jobs.jobvite.com/${slug}`;
      if (normalizeEvidenceUrl(resolved?.careers_url) !== expected) return { owner: null, error: 'Jobvite URL does not match company slug' };
      const html = await ctx.fetchText(`${expected}?fr=true&nl=1`, {
        redirect: 'error', headers: { 'user-agent': 'Mozilla/5.0' }, maxBytes: 262_144,
      });
      const title = decodeEntities(String(html || '').match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '').trim();
      const owner = title.replace(/^Jobs at\s+/i, '').replace(/\s+(?:Careers|Jobs)\s*$/i, '').trim();
      return { owner: owner || null };
    }
    if (provider === 'jibeapply') {
      const host = slug.toLowerCase();
      if (isIP(host) || host.length > 253 || !host.includes('.') || host.split('.').some(label =>
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
        return { owner: null, error: 'invalid Jibe careers hostname' };
      }
      const expected = `https://${host}`;
      if (normalizeEvidenceUrl(resolved?.careers_url) !== expected) {
        return { owner: null, error: 'Jibe URL does not match careers hostname' };
      }
      const body = await ctx.fetchJson(`${expected}/api/jobs?page=1&limit=1`, {
        redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
      });
      const owner = String(body?.jobs?.[0]?.data?.hiring_organization || '').trim() || null;
      return includePayload ? { owner, payload: body } : { owner };
    }
    if (provider === 'pinpoint') {
      if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(slug)) {
        return { owner: null, error: 'invalid Pinpoint tenant' };
      }
      const expected = `https://${slug.toLowerCase()}.pinpointhq.com`;
      if (normalizeEvidenceUrl(resolved?.careers_url) !== expected) {
        return { owner: null, error: 'Pinpoint URL does not match tenant' };
      }
      const html = await ctx.fetchText(expected, {
        redirect: 'error', headers: { 'user-agent': 'Mozilla/5.0' }, maxBytes: 262_144,
      });
      const title = decodeEntities(String(html || '').match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '')
        .replace(/\s+/g, ' ').trim();
      const owner = title.match(/^Jobs at\s+(.+?)\s*\|/i)?.[1]?.trim() || null;
      return { owner };
    }
    if (provider === 'icims') {
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return { owner: null, error: 'invalid iCIMS portal host' };
      const board = new URL(String(resolved?.careers_url || ''));
      const expectedHost = `${slug.toLowerCase()}.icims.com`;
      if (board.protocol !== 'https:' || board.hostname.toLowerCase() !== expectedHost) {
        return { owner: null, error: 'iCIMS URL does not match portal host' };
      }
      const origin = `https://${expectedHost}`;
      const html = await ctx.fetchText(`${origin}/jobs/search?ss=1`, {
        redirect: 'error', headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en-US,en;q=0.9' },
        maxBytes: 1_048_576,
      });
      const titleOwner = extractIcimsOwner(html);
      if (titleOwner) return { owner: titleOwner };
      const first = parseIcimsSearchPage(html, origin, '')[0];
      if (!first?.url) return { owner: null };
      const detail = await ctx.fetchText(`${first.url}?in_iframe=1`, {
        redirect: 'error', headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en-US,en;q=0.9' },
        maxBytes: 1_048_576,
      });
      return { owner: extractIcimsHiringOrganization(detail) };
    }
    if (provider === 'workable') {
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug) || slug.toLowerCase() === 'j') {
        return { owner: null, error: 'invalid Workable account identifier' };
      }
      const expected = `https://apply.workable.com/${slug}`;
      if (normalizeEvidenceUrl(resolved?.careers_url) !== normalizeEvidenceUrl(expected)) {
        return { owner: null, error: 'Workable URL does not match account identifier' };
      }
      const body = await ctx.fetchJson(
        `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`,
        { redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' } },
      );
      const owner = String(body?.name || '').trim() || null;
      return includePayload ? { owner, payload: body } : { owner };
    }
    if (provider === 'smartrecruiters') {
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) {
        return { owner: null, error: 'invalid SmartRecruiters company identifier' };
      }
      const expected = `https://careers.smartrecruiters.com/${slug}`;
      if (normalizeEvidenceUrl(resolved?.careers_url) !== normalizeEvidenceUrl(expected)) {
        return { owner: null, error: 'SmartRecruiters URL does not match company identifier' };
      }
      const body = await ctx.fetchJson(
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=1&offset=0&status=PUBLIC`,
        { redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' } },
      );
      const owner = String(body?.content?.[0]?.company?.name || '').trim() || null;
      return includePayload ? { owner, payload: body } : { owner };
    }
    if (provider === 'gem') {
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) return { owner: null, error: 'invalid Gem board identifier' };
      const expected = `https://jobs.gem.com/${slug}`;
      if (normalizeEvidenceUrl(resolved?.careers_url) !== normalizeEvidenceUrl(expected)) {
        return { owner: null, error: 'Gem URL does not match board identifier' };
      }
      const html = await ctx.fetchText(expected, {
        redirect: 'error', headers: { 'user-agent': 'Mozilla/5.0' }, maxBytes: 262_144,
      });
      const title = decodeEntities(String(html || '').match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '')
        .replace(/\s+Careers\s*$/i, '').trim();
      return { owner: title || null };
    }
    if (provider === 'bamboohr') {
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return { owner: null, error: 'invalid BambooHR tenant' };
      const expected = `https://${slug.toLowerCase()}.bamboohr.com/careers`;
      if (normalizeEvidenceUrl(resolved?.careers_url) !== expected) {
        return { owner: null, error: 'BambooHR URL does not match tenant' };
      }
      const html = await ctx.fetchText(expected, {
        redirect: 'error', headers: { 'user-agent': 'Mozilla/5.0' }, maxBytes: 262_144,
      });
      const owner = decodeEntities(String(html || '').match(
        /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i,
      )?.[1] || '').trim();
      return { owner: owner || null };
    }
    if (provider === 'paylocity') {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slug)) {
        return { owner: null, error: 'invalid Paylocity board identifier' };
      }
      const expected = `https://recruiting.paylocity.com/recruiting/jobs/All/${slug.toLowerCase()}`;
      if (normalizeEvidenceUrl(resolved?.careers_url) !== expected) {
        return { owner: null, error: 'Paylocity URL does not match board identifier' };
      }
      const html = await ctx.fetchText(`${expected}/`, {
        redirect: 'error', headers: { 'user-agent': 'Mozilla/5.0' }, maxBytes: 262_144,
      });
      const title = decodeEntities(String(html || '').match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '')
        .replace(/\s+-\s+Job Opportunities\s*$/i, '').trim();
      return { owner: title || null };
    }
    if (provider === 'workday') {
      const [tenant, instance, site] = slug.split('|');
      if (![tenant, instance, site].every(value => /^[A-Za-z0-9._-]+$/.test(value || ''))) {
        return { owner: null, error: 'invalid Workday board coordinates' };
      }
      const board = new URL(String(resolved?.careers_url || ''));
      const expectedHost = `${tenant}.${instance}.myworkdayjobs.com`.toLowerCase();
      if (board.protocol !== 'https:' || board.hostname.toLowerCase() !== expectedHost
        || !board.pathname.split('/').filter(Boolean).includes(site)) {
        return { owner: null, error: 'Workday URL does not match board coordinates' };
      }
      const origin = `https://${expectedHost}`;
      const jobsUrl = `${origin}/wday/cxs/${tenant}/${site}/jobs`;
      const body = await ctx.fetchJson(jobsUrl, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'Mozilla/5.0',
          origin,
          referer: `${origin}/${site}/`,
        },
        body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: '' }),
      });
      const externalPath = String(body?.jobPostings?.[0]?.externalPath || '');
      if (!externalPath.startsWith('/job/') || externalPath.includes('..') || externalPath.includes('\\')) {
        return { owner: null, error: 'Workday board has no safe published job detail' };
      }
      const detail = await ctx.fetchJson(`${origin}/wday/cxs/${tenant}/${site}${externalPath}`, {
        redirect: 'error',
        headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
      });
      return { owner: String(detail?.hiringOrganization?.name || '').trim() || null };
    }
    const spec = ATS[provider];
    if (spec.ownerKind === 'json') {
      const body = await ctx.fetchJson(spec.ownerUrl(slug), { redirect: 'error' });
      return { owner: spec.ownerName(body) };
    }
    const html = await ctx.fetchText(spec.ownerUrl(slug), { redirect: 'error', maxBytes: 8192 });
    return { owner: spec.ownerName?.(html) || boardTitleOwner(html) };
  } catch (error) {
    return { owner: null, error: String(error?.message || error) };
  }
}

export function classifyDiscoveryCandidate({
  company,
  resolved,
  unresolved,
  boardOwner = null,
  ownerError = '',
  reviews = [],
  checkedAt = new Date().toISOString(),
  runId = '',
} = {}) {
  const name = String(company?.name || resolved?.name || unresolved?.name || '').trim();
  const base = {
    schemaVersion: 2,
    runId,
    name,
    checkedAt,
  };
  if (!resolved) {
    const reason = String(unresolved?.reason || 'resolver-returned-no-record');
    const errors = unresolved?.errors || [];
    const transient = /unknown|network|timeout|429|5\d\d|error/i.test(reason)
      && !/no supported ATS board found|no board found/i.test(reason);
    return {
      ...base,
      status: 'unresolved',
      identity_status: 'unresolved',
      health_status: transient ? 'transient_error' : 'dead',
      reason,
      ...(errors.length ? { errors } : {}),
    };
  }

  const provider = String(resolved.vendor || resolved.provider || '').toLowerCase();
  const jobCount = Number(resolved.jobCount ?? resolved.job_count ?? 0);
  const healthStatus = resolved.partial === true ? 'partial' : (jobCount > 0 ? 'live' : 'live_empty');
  let identityStatus = 'review_required';
  let identityReason = 'official-board ownership needs exact review';

  if (OWNER_PUBLISHING_PROVIDERS.has(provider)) {
    const ownerVerdict = classifyPublishedOwner(name, boardOwner, ownerError);
    identityStatus = ownerVerdict.identity_status;
    identityReason = ownerVerdict.reason;
  } else {
    const review = reviewedUrlVerdict(name, resolved.careers_url, reviews);
    if (review?.verdict === 'accept') {
      identityStatus = 'reviewed_official_link';
      identityReason = String(review.reason || 'exact accepted official careers URL review');
    }
  }

  return {
    ...base,
    status: identityStatus === 'owner_verified' || identityStatus === 'reviewed_official_link' ? 'resolved' : 'review_required',
    provider,
    slug: resolved.slug || '',
    careers_url: resolved.careers_url || '',
    ...(resolved.api ? { api: resolved.api } : {}),
    jobCount,
    ...(resolved.partial === true ? { partial: true } : {}),
    boardOwner,
    careersUrl: resolved.careers_url || '',
    evidence: {
      kind: identityStatus === 'owner_verified' ? 'published-board-owner' : 'reviewed-official-url',
      boardOwner: boardOwner || '',
      careersUrl: resolved.careers_url || '',
    },
    identity_status: identityStatus,
    health_status: healthStatus,
    reason: identityReason,
  };
}

export function isWritableDiscoveryRecord(record) {
  return WRITABLE_IDENTITIES.has(record?.identity_status)
    && WRITABLE_HEALTH.has(record?.health_status)
    && Boolean(normalizeEvidenceUrl(record?.careers_url));
}
