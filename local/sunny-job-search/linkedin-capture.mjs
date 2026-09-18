import { createHash } from 'node:crypto';

export function canonicalLinkedinUrl(raw) {
  try {
    const url = new URL(raw);
    // The capture boundary accepts exactly the authority emitted by the
    // Connections page.  Do not silently upgrade a bare host or a deceptive
    // authority into a trusted canonical profile URL.
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'www.linkedin.com' || url.username || url.password || url.port) return null;
    const match = url.pathname.match(/^\/(in|company)\/([^/?#]+)\/?$/i);
    if (!match || /%(?![0-9a-f]{2})/i.test(match[2])) return null;
    const slug = decodeURIComponent(match[2]);
    if (!slug || /[\\/\u0000-\u001f]/.test(slug)) return null;
    return `https://www.linkedin.com/${match[1].toLowerCase()}/${encodeURIComponent(slug).replace(/%2F/gi, '')}/`;
  } catch { return null; }
}

export function normalizeHeadline(value) { return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim(); }

function nyDate(now) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const v = Object.fromEntries(p.filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return `${v.year}-${v.month}-${v.day}`;
}
function shift(date, days) { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }

export function parseConnectionDate(label, { now = new Date(), timeZone = 'America/New_York' } = {}) {
  const raw = String(label || '').trim(); const today = nyDate(now);
  const relative = raw.match(/^connected\s+(?:(yesterday)|(\d+)\s+days?\s+ago|(\d+)\s+weeks?\s+ago)$/i);
  if (relative) {
    if (relative[3]) { const latest = shift(today, -Number(relative[3]) * 7); return { earliest: shift(latest, -7), latest, precision: 'relative_week', stableDateIdentity: null, timeZone }; }
    const day = shift(today, -(relative[1] ? 1 : Number(relative[2]))); return { earliest: day, latest: day, precision: 'relative_day', stableDateIdentity: day, timeZone };
  }
  const absolute = raw.replace(/^connected\s+(?:on\s+)?/i, '');
  const months = { jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11 };
  const named = absolute.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/) || absolute.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/)?.slice(0, 4).map((x, i, a) => i === 1 ? a[2] : i === 2 ? a[1] : x);
  if (named && months[named[1].toLowerCase()] !== undefined) { const probe = new Date(Date.UTC(Number(named[3]), months[named[1].toLowerCase()], Number(named[2]))); const day = probe.toISOString().slice(0, 10); if (probe.getUTCFullYear() === Number(named[3]) && probe.getUTCMonth() === months[named[1].toLowerCase()] && probe.getUTCDate() === Number(named[2]) && day <= today) return { earliest: day, latest: day, precision: 'day', stableDateIdentity: day, timeZone }; }
  return { earliest: null, latest: null, precision: 'unknown', stableDateIdentity: null, timeZone };
}

export function classifyHeadline(headline) {
  const value = normalizeHeadline(headline);
  if (!value) return { classification: 'missing_employer', employerLabel: null };
  if (/(?:ignore\s+(?:previous|all)|\bsystem\s*:|\bassistant\s*:|<\/?(?:script|instruction))/i.test(value)) return { classification: 'unsafe_employer', employerLabel: null };
  if (/\b(?:client|agency)\b/i.test(value)) return { classification: 'ambiguous_employer', employerLabel: null };
  // Do not reject the whole headline merely because its first clause is former:
  // “Former Engineer at Old Co · Engineer at American Express” has one
  // independently explicit current clause below.
  const barePrefix = value.match(/^([A-Za-z][\w-]*)\s+@\s+/);
  if (barePrefix && !/^(?:engineer|developer|designer|manager|director|analyst|scientist|architect|consultant|ds|swe)$/i.test(barePrefix[1])) return { classification: 'ambiguous_employer', employerLabel: null };
  // Classify each relation in its own clause.  A former relation must not
  // poison a later, explicit current one ("Ex-Engineer at Old · Engineer at
  // Current"), but is never itself eligible as current evidence.
  const relations = [...value.matchAll(/\s(?:@|at)\s+([^@·|]+?)(?=$|\s(?:@|at)\s|[·|])/gi)].map(m => {
    const clauseStart = Math.max(value.lastIndexOf('·', m.index), value.lastIndexOf('|', m.index)) + 1;
    const clause = value.slice(clauseStart, m.index);
    return { employer: m[1].trim(), former: /\b(?:ex|former|formerly|previously)\b\s*-?/i.test(clause) };
  }).filter(x => x.employer);
  const current = relations.filter(x => !x.former).map(x => x.employer);
  if (current.length === 1) return { classification: 'explicit_employer', employerLabel: current[0] };
  if (relations.length && current.length === 0) return { classification: 'former_only', employerLabel: null };
  if (/\b(?:ex|former|previously)\s*[-@]?/i.test(value)) return { classification: 'former_only', employerLabel: null };
  return current.length > 1 ? { classification: 'ambiguous_employer', employerLabel: null } : { classification: 'missing_employer', employerLabel: null };
}

export function makeCardFingerprint({ profileUrl, headline, stableDateIdentity }) {
  return createHash('sha256').update([canonicalLinkedinUrl(profileUrl) || '', normalizeHeadline(headline).toLocaleLowerCase(), stableDateIdentity || ''].join('\n')).digest('hex');
}

export function normalizeConnectionCard(raw, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['profileUrl','fullName','headline','connectedLabelRaw'].includes(key))) throw new Error('Invalid compact connection card');
  for (const key of ['profileUrl','fullName','headline','connectedLabelRaw']) if (typeof raw[key] !== 'string') throw new Error('Invalid compact connection card');
  const profileUrl = canonicalLinkedinUrl(raw?.profileUrl); if (!profileUrl?.includes('/in/')) throw new Error('Invalid LinkedIn profile URL');
  const fullName=raw.fullName.trim(), headline = normalizeHeadline(raw.headline), connectedLabelRaw=raw.connectedLabelRaw.trim(); if(!fullName || fullName.length>300 || headline.length>500 || connectedLabelRaw.length>80) throw new Error('Invalid compact connection card'); const date = parseConnectionDate(connectedLabelRaw, options); const classification = classifyHeadline(headline);
  return { profileUrl, fullName, headline, connectedLabelRaw, connectedAtEarliest: date.earliest, connectedAtLatest: date.latest, connectedDatePrecision: date.precision, stableDateIdentity: date.stableDateIdentity, cardFingerprint: makeCardFingerprint({ profileUrl, headline, stableDateIdentity: date.stableDateIdentity }), ...classification };
}
