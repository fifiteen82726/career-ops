#!/usr/bin/env node

/**
 * Fail-closed identity and health gate for Sunny's bulk ATS discovery.
 * A reachable board is not enough: it may belong to another employer whose
 * slug happens to resemble the DOL name.  Greenhouse, Ashby and Lever publish
 * an owner; every other provider needs an exact, user-reviewed official URL.
 */

import { ATS, boardIdentityMatches, boardTitleOwner } from '../../verify-portals.mjs';
import { asciiFold } from '../../lib/ascii-fold.mjs';

export const OWNER_PUBLISHING_PROVIDERS = new Set(['greenhouse', 'ashby', 'lever']);
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

export async function fetchPublishedBoardOwner(resolved, ctx) {
  const provider = String(resolved?.vendor || resolved?.provider || '').toLowerCase();
  if (!OWNER_PUBLISHING_PROVIDERS.has(provider)) return { owner: null, reason: 'provider-has-no-owner-endpoint' };
  const slug = String(resolved?.slug || '').trim();
  if (!slug) return { owner: null, error: 'missing board slug' };
  const spec = ATS[provider];
  try {
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
