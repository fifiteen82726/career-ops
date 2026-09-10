/**
 * Pure, deterministic source → ATS identity/date reconciliation. No I/O, clock,
 * state mutation, Sheet upload, job-history change, or admission policy effect.
 *
 * reconcileSourceToAts({ source, ats, window: { start, end } })
 *
 * source: { source, job_url, job_url_verified?, ats_url?, provider?, board_identifier?,
 *   requisition_id?, posted_at_raw, verified_posted_at, observed_at }
 * ats: { job_url, job_url_verified, provider?, board_identifier?, requisition_id?,
 *   authoritative_posted_at, observed_at }
 *
 * `source.ats_url` must be an observed outbound link / verified redirect target,
 * never a URL guessed from the company or title. A direct source.job_url can
 * match too. `source.job_url_verified === true` explicitly identifies that URL
 * as an upstream-verified direct, individual official ATS job; its conflicts
 * block a match even when the scoped requisition agrees. Source/provider names
 * never imply this flag, so aggregator URLs are not compared as ATS targets.
 * `ats.job_url_verified === true` asserts the same upstream verification on the
 * ATS side, and is still sufficient when a direct source URL matches exactly.
 * This helper cannot verify ownership by comparing strings. Alternatively both
 * records may carry the same complete provider/board/requisition triple from
 * verified source/API evidence. Board and requisition IDs remain case-sensitive;
 * provider names are case-insensitive. Explicit conflicting evidence wins over
 * a positive match. There is no fuzzy company/title or cross-board ID matching.
 *
 * Verified publication fields must come from the corresponding source. Generic
 * posted_at, updated_at, first_seen, discovery times, and relative date text are
 * never promoted. source.discovered_at is accepted only as an observation time.
 * Optional posted_at_kind identifies non-publication dates; optional is_repost
 * or repost_status records a known/suspected/explicitly unknown repost state.
 * Absence of a repost flag is not proof that a job has never been reposted;
 * output preserves explicit booleans and uses null for an unknown flag.
 *
 * Dates accept YYYY-MM-DD or an ISO timestamp with seconds and an explicit
 * timezone. Calendar dates keep the publisher's stated day (no ambient timezone
 * or UTC day conversion). Date differences, missing dates/observation times,
 * and repost signals require review. Windows are inclusive calendar-day ranges.
 * `publication_date` is set only on a reconciled result; ATS evidence is always
 * retained separately, including when its older date blocks a fresh source date.
 */

// Generic names such as refId may be requisitions on a custom ATS; preserve them.
const TRACKING_KEYS = new Set(['gh_src', 'lever-source', 'lever-origin']);
const NON_PUBLICATION_KINDS = new Set(['first_seen', 'observed_at', 'discovered_at', 'crawled_at', 'ingested_at', 'updated_at']);
const CLEAR_REPOST_KINDS = new Set(['', 'none', 'not_detected', 'not_reposted', 'original']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const raw = value => typeof value === 'string' ? value : '';
const clean = value => raw(value).trim();
const identifier = value => typeof value === 'string' ? value.trim()
  : Number.isSafeInteger(value) ? String(value) : '';

export function canonicalAtsJobUrl(value) {
  try {
    const url = new URL(clean(value));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || TRACKING_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    // Unknown query params and hash routes may hold job identity. Path case,
    // trailing slashes, protocol, and host aliases are deliberately preserved.
    url.searchParams.sort();
    return url.toString();
  } catch { return ''; }
}

function calendarDay(value) {
  const text = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const stamp = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === text ? text : null;
}

function timestamp(value) {
  const text = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(text)) return null;
  if (!calendarDay(text.slice(0, 10)) || !Number.isFinite(Date.parse(text))) return null;
  return text;
}

function publicationDay(value) {
  return calendarDay(value) || (timestamp(value) ? clean(value).slice(0, 10) : null);
}

function requisition(record) {
  return { provider: clean(record.provider).toLowerCase(), board_identifier: identifier(record.board_identifier),
    requisition_id: identifier(record.requisition_id) };
}

function matchIdentity(source, ats, reasons) {
  const sourceJobUrl = canonicalAtsJobUrl(source.job_url);
  const verifiedDirectSource = source.job_url_verified === true;
  const explicitTarget = clean(source.ats_url);
  const atsUrl = canonicalAtsJobUrl(ats.job_url);
  const sourceAtsUrl = explicitTarget ? canonicalAtsJobUrl(explicitTarget)
    : verifiedDirectSource || sourceJobUrl === atsUrl ? sourceJobUrl : '';
  const sourceReq = requisition(source);
  const atsReq = requisition(ats);
  const identityReasons = [];
  if (verifiedDirectSource && !sourceJobUrl) identityReasons.push('invalid_source_job_url');
  if (explicitTarget && !sourceAtsUrl) identityReasons.push('invalid_source_ats_url');
  if (clean(ats.job_url) && !atsUrl) identityReasons.push('invalid_ats_job_url');
  for (const field of ['provider', 'board_identifier', 'requisition_id']) {
    if (sourceReq[field] && atsReq[field] && sourceReq[field] !== atsReq[field]) {
      identityReasons.push(`${field}_conflict`);
    }
  }
  if (explicitTarget && sourceAtsUrl && atsUrl && sourceAtsUrl !== atsUrl) identityReasons.push('ats_url_conflict');
  if (verifiedDirectSource && sourceJobUrl
    && ((atsUrl && sourceJobUrl !== atsUrl) || (sourceAtsUrl && sourceJobUrl !== sourceAtsUrl))) {
    identityReasons.push('ats_url_conflict');
  }
  const fullReq = Object.values(sourceReq).every(Boolean) && Object.values(atsReq).every(Boolean);
  const reqMatch = fullReq && Object.keys(sourceReq).every(key => sourceReq[key] === atsReq[key]);
  const sameUrl = Boolean(sourceAtsUrl && atsUrl && sourceAtsUrl === atsUrl);
  const urlMatch = sameUrl && ats.job_url_verified === true;
  if (!reqMatch && sameUrl && !urlMatch) identityReasons.push('ats_job_url_unverified');
  if (!reqMatch && !urlMatch && !identityReasons.length) identityReasons.push('exact_job_identity_unresolved');
  const conflict = identityReasons.some(reason => reason.endsWith('_conflict'));
  const matchedBy = identityReasons.length ? null : urlMatch ? 'canonical_ats_url' : reqMatch ? 'scoped_requisition' : null;
  reasons.push(...identityReasons);
  return { status: conflict ? 'conflict' : matchedBy ? 'matched' : 'unresolved', matched_by: matchedBy,
    source_name: raw(source.source), source_ats_url_raw: raw(source.ats_url), ats_job_url_raw: raw(ats.job_url),
    source_job_url: raw(source.job_url), source_ats_url: sourceAtsUrl, ats_job_url: atsUrl,
    source_job_url_verified: verifiedDirectSource,
    source_requisition: sourceReq, ats_requisition: atsReq };
}

/** Returns a new JSON-serializable result. Malformed rows return review results. */
export function reconcileSourceToAts(input) {
  const source = object(input?.source) ? input.source : {};
  const ats = object(input?.ats) ? input.ats : {};
  const requestedWindow = object(input?.window) ? input.window : {};
  const reasons = [];
  if (!object(input?.source)) reasons.push('invalid_source_record');
  if (!object(input?.ats)) reasons.push('invalid_ats_record');
  const start = calendarDay(requestedWindow.start);
  const end = calendarDay(requestedWindow.end);
  if (!start || !end || start > end) reasons.push('invalid_window');
  const identity = matchIdentity(source, ats, reasons);
  const sourceDate = publicationDay(source.verified_posted_at);
  const atsDate = publicationDay(ats.authoritative_posted_at);
  const sourceObserved = raw(source.observed_at ?? source.discovered_at);
  const atsObserved = raw(ats.observed_at);
  const dates = { source_raw_posted_at: raw(source.posted_at_raw),
    source_verified_posted_at: raw(source.verified_posted_at), source_verified_posted_date: sourceDate,
    ats_authoritative_posted_at: raw(ats.authoritative_posted_at), ats_authoritative_posted_date: atsDate,
    source_observed_at: sourceObserved, ats_observed_at: atsObserved,
    source_first_seen: raw(source.first_seen), ats_first_seen: raw(ats.first_seen),
    source_posted_at_kind: raw(source.posted_at_kind), ats_posted_at_kind: raw(ats.posted_at_kind) };
  for (const [side, record, day, observation] of [
    ['source', source, sourceDate, sourceObserved], ['ats', ats, atsDate, atsObserved],
  ]) {
    if (!day) reasons.push(`${side}_publication_date_unknown`);
    if (NON_PUBLICATION_KINDS.has(clean(record.posted_at_kind).toLowerCase())) reasons.push(`${side}_date_not_publication`);
    const observed = timestamp(observation);
    if (!observed) reasons.push(`${side}_observation_timestamp_unknown`);
    const published = timestamp(side === 'source' ? record.verified_posted_at : record.authoritative_posted_at);
    if (observed && (published ? Date.parse(published) > Date.parse(observed)
      : day && day > observed.slice(0, 10))) reasons.push(`${side}_publication_after_observation`);
    if (record.is_repost === true || !CLEAR_REPOST_KINDS.has(clean(record.repost_status).toLowerCase())) {
      reasons.push(`${side}_repost_requires_review`);
    }
  }
  if (sourceDate && atsDate && sourceDate !== atsDate) {
    reasons.push(atsDate < sourceDate ? 'ats_date_older_than_source' : 'ats_date_newer_than_source');
  }
  const uniqueReasons = [...new Set(reasons)].sort();
  const status = uniqueReasons.length ? 'review' : 'reconciled';
  return { schema_version: 1, read_only: true, status, reasons: uniqueReasons, identity, dates,
    repost: { source_is_repost: typeof source.is_repost === 'boolean' ? source.is_repost : null,
      source_status: raw(source.repost_status),
      ats_is_repost: typeof ats.is_repost === 'boolean' ? ats.is_repost : null, ats_status: raw(ats.repost_status) },
    publication_date: status === 'reconciled' ? atsDate : null,
    freshness: { status: status === 'review' ? 'review'
      : atsDate >= start && atsDate <= end ? 'within_window' : 'outside_window',
      window_start: raw(requestedWindow.start), window_end: raw(requestedWindow.end) },
    interpretation: '此結果只核對已提供的職缺身分及日期證據；不自動發布、更新掃描紀錄或放行申請。' };
}
