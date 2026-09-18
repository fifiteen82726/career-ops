#!/usr/bin/env node
// Deliberately title-only: no browser and no model client is available here.
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { buildCompanyIdentityIndex, computeAliasMappingRevision, computeCatalogRevision, generateCompanyCandidates, loadVerifiedTrackedCompanyRows, normalizeCompanyAlias, parseCompanyAliases, parseCompanyMapRows, resolveCompanyIdentity } from './company-identities.mjs';
import { canonicalLinkedinUrl, normalizeConnectionCard } from './linkedin-capture.mjs';
import { aliasEvidenceFingerprint, makeRequestBatch, validateDecisionBatch } from './linkedin-title-resolver.mjs';
import { persistAlias } from './company-alias-store.mjs';

export { canonicalLinkedinUrl };
export const SOURCE_STATUSES = new Set(['ok', 'partial', 'linkedin_not_authenticated', 'linkedin_challenge', 'error']);
// A compact title handoff is only safe to prepare from a complete Connections
// capture.  Every other source result is a transient referral-step outcome;
// the retry wrapper decides whether to try once more or continue the scan.
export const RETRYABLE_SOURCE_STATUSES = new Set(['partial', 'linkedin_not_authenticated', 'linkedin_challenge', 'error']);
const DAY = 86400000, hash = v => createHash('sha256').update(String(v)).digest('hex');
// An absent ledger is a real state, not a freshly timestamped empty object.
// This lets prepare and finalize agree even when they execute at different times.
const ABSENT_LEDGER_HASH = hash('sunny-title-ledger-absent-v1');
const iso = v => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v;
const fields = (v, allowed, label) => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${label} must be object`); for (const k of Object.keys(v)) if (!allowed.includes(k)) throw new Error(`${label} has unknown field ${k}`); };
const ny = now => new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
const canonicalApplyUrl = raw => { const u=new URL(raw); if(!/^https?:$/.test(u.protocol)) throw new Error('invalid application URL'); for(const k of [...u.searchParams.keys()]) if(/^(utm_|gclid$|fbclid$)/i.test(k)) u.searchParams.delete(k); u.hash=''; return u.toString().replace(/\/$/,''); };

export function emptyState(now = new Date()) { return { schemaVersion:3, sourceStatus:'ok', sourceWarning:'', updatedAt:now.toISOString(), timeZone:'America/New_York', connections:[], matches:[], retainedHashes:[] }; }
export function migrateReferralState(state, {now=new Date()}={}) {
  if (!state) return emptyState(now); if (state.schemaVersion === 3) return structuredClone(state);
  if (![1,2].includes(state.schemaVersion) || !Array.isArray(state.connections) || !Array.isArray(state.matches)) throw new Error('unsupported referral state');
  // Historical matches are immutable audit evidence.  They cannot be recreated
  // from legacy URL-less employer observations, so preserve their exact keys.
  const legacyMatches=(state.matches||[]).filter(m=>m&&typeof m==='object'&&typeof m.matchKey==='string'&&canonicalLinkedinUrl(m.profileUrl)?.includes('/in/')&&typeof m.jobScanDate==='string'&&typeof m.canonicalApplyUrl==='string').map(m=>structuredClone(m));
  return { schemaVersion:3, sourceStatus:SOURCE_STATUSES.has(state.sourceStatus)?state.sourceStatus:'error', sourceWarning:String(state.sourceWarning||''), updatedAt:state.updatedAt||now.toISOString(), timeZone:'America/New_York', matches:legacyMatches, retainedHashes:(state.seenProfileHashes||[]).filter(x=>/^[a-f0-9]{64}$/.test(x?.sha256)).map(x=>({sha256:x.sha256,lastSeenAt:x.lastSeenAt})), connections:state.connections.map(old=>({ profileUrl:canonicalLinkedinUrl(old.profileUrl),fullName:String(old.fullName||''),headline:String(old.headline||''),connectedLabelRaw:String(old.connectedLabelRaw||''),connectedAtEarliest:old.connectedAtEarliest||null,connectedAtLatest:old.connectedAtLatest||null,connectedDatePrecision:old.connectedDatePrecision||'unknown',cardFingerprint:old.cardFingerprint||null,classification:'legacy',employerLabel:null,disposition:'resolved',firstSeenAt:old.firstSeenAt||state.updatedAt||now.toISOString(),lastObservedAt:old.lastObservedAt||state.updatedAt||now.toISOString(),unresolvedCache:null,employers:(old.employers||old.currentEmployments||[]).filter(x=>x?.isCurrent!==false).map(x=>({employerLabel:String(x.employerLabel||x.employer||''),canonicalCompanyKey:null,linkedinCompanyUrl:canonicalLinkedinUrl(x.companyLinkedinUrl)||null,title:String(x.title||''),resolutionSource:'legacy_verified',evidenceFingerprint:hash(`${x.employerLabel||x.employer||''}|legacy`),verifiedAt:old.employmentVerifiedAt||state.updatedAt||now.toISOString()})) })).filter(x=>x.profileUrl?.includes('/in/')) };
}
export const migrateReferralStateV1ToV2 = migrateReferralState;
export function validateReferralState(state, { now = null } = {}) {
  fields(state,['schemaVersion','sourceStatus','sourceWarning','updatedAt','timeZone','connections','matches','retainedHashes'],'state');
  if(state.schemaVersion!==3||!SOURCE_STATUSES.has(state.sourceStatus)||!iso(state.updatedAt)||state.timeZone!=='America/New_York'||!Array.isArray(state.connections)||!Array.isArray(state.matches)||!Array.isArray(state.retainedHashes)) throw new Error('invalid referral state');
  const seen=new Set(); for(const c of state.connections) { fields(c,['profileUrl','fullName','headline','connectedLabelRaw','connectedAtEarliest','connectedAtLatest','connectedDatePrecision','cardFingerprint','classification','employerLabel','disposition','firstSeenAt','lastObservedAt','employers','unresolvedCache'],'connection'); if (now && iso(c.lastObservedAt) && (+now - Date.parse(c.lastObservedAt)) > 90 * DAY) throw new Error('expired connection PII');
    if(!canonicalLinkedinUrl(c.profileUrl)?.includes('/in/')||seen.has(c.profileUrl)||!iso(c.firstSeenAt)||!iso(c.lastObservedAt)||Date.parse(c.firstSeenAt)>Date.parse(c.lastObservedAt)||!Array.isArray(c.employers)||!['resolved','unresolved','deferred'].includes(c.disposition)||(c.employerLabel!==null&&typeof c.employerLabel!=='string')||!['legacy','explicit_employer','former_only','ambiguous_employer','unsafe_employer','missing_employer'].includes(c.classification)) throw new Error('invalid connection');
    if(c.connectedAtEarliest!==null&&!date(c.connectedAtEarliest) || c.connectedAtLatest!==null&&!date(c.connectedAtLatest) || (c.connectedAtEarliest && c.connectedAtLatest && c.connectedAtEarliest > c.connectedAtLatest) || !['day','exact_day','relative_day','relative_week','range','unknown'].includes(c.connectedDatePrecision) || !(c.cardFingerprint===null||/^[a-f0-9]{64}$/.test(c.cardFingerprint)) || (c.classification === 'legacy' && c.cardFingerprint !== null) || (c.classification !== 'legacy' && c.cardFingerprint === null)) throw new Error('invalid connection dates');
    const legacy = c.classification === 'legacy';
    if(c.disposition==='resolved' ? ((legacy ? c.employers.length < 1 : c.employers.length!==1) || c.unresolvedCache!==null) : (c.employers.length!==0 || (c.disposition==='deferred' ? c.unresolvedCache!==null : !c.unresolvedCache))) throw new Error('invalid disposition membership');
    if(c.unresolvedCache) { fields(c.unresolvedCache,['catalogRevision','aliasRevision','cardEvidenceFingerprint','candidateEvidenceFingerprint'],'unresolved cache'); if(!/^[a-f0-9]{64}$/.test(c.unresolvedCache.catalogRevision)||!/^[a-f0-9]{64}$/.test(c.unresolvedCache.aliasRevision)||!/^[a-f0-9]{64}$/.test(c.unresolvedCache.cardEvidenceFingerprint)||!/^[a-f0-9]{64}$/.test(c.unresolvedCache.candidateEvidenceFingerprint)) throw new Error('invalid unresolved cache'); }
    if (now && (+now - Date.parse(c.lastObservedAt)) > 90 * DAY) throw new Error('expired connection PII');
    seen.add(c.profileUrl); for(const e of c.employers) { fields(e,['employerLabel','canonicalCompanyKey','linkedinCompanyUrl','title','resolutionSource','evidenceFingerprint','verifiedAt'],'employer'); const employerSlug=e.linkedinCompanyUrl&&canonicalLinkedinUrl(e.linkedinCompanyUrl)?.split('/')[4]; if(typeof e.employerLabel!=='string'||typeof e.title!=='string'||!['connections_headline_exact','connections_headline_ai_alias','legacy_verified','manual_review'].includes(e.resolutionSource)||!/^[a-f0-9]{64}$/.test(e.evidenceFingerprint)||!iso(e.verifiedAt)||(e.canonicalCompanyKey!==null&&!/^[a-z0-9][a-z0-9.-]{0,127}$/.test(e.canonicalCompanyKey))||(e.linkedinCompanyUrl!==null&&!canonicalLinkedinUrl(e.linkedinCompanyUrl)?.includes('/company/'))||(e.canonicalCompanyKey!==null&&employerSlug!==e.canonicalCompanyKey)||(e.canonicalCompanyKey===null&&e.resolutionSource!=='legacy_verified')) throw new Error('invalid employer'); } }
  const matchKeys=new Set(); for(const m of state.matches) { fields(m,['matchKey','jobScanDate','canonicalApplyUrl','profileUrl','fullName','currentTitle','currentEmployer','connectedLabelRaw','connectedAtEarliest','connectedAtLatest','lastObservedAt','matchQuality'],'match'); let apply; try { apply=canonicalApplyUrl(m.canonicalApplyUrl); } catch { throw new Error('invalid match'); } const profile=canonicalLinkedinUrl(m.profileUrl); if(!/^[^|]+\|https?:\/\/[^|]+\|https:\/\/www\.linkedin\.com\/in\/[^/]+\/$/.test(m.matchKey)||m.matchKey!==`${m.jobScanDate}|${apply}|${profile}`||matchKeys.has(m.matchKey)||!date(m.jobScanDate)||!profile?.includes('/in/')||!['company_url_exact','reviewed_alias'].includes(m.matchQuality)||!iso(m.lastObservedAt)||!date(m.connectedAtEarliest)||!date(m.connectedAtLatest)||m.connectedAtEarliest>m.connectedAtLatest) throw new Error('invalid match'); matchKeys.add(m.matchKey); }
  const hashes=new Set(); for(const h of state.retainedHashes) { fields(h,['sha256','lastSeenAt'],'retained hash'); if(!/^[a-f0-9]{64}$/.test(h.sha256)||!iso(h.lastSeenAt)||hashes.has(h.sha256) || (now && (+now - Date.parse(h.lastSeenAt)) > 365 * DAY)) throw new Error('invalid retained hash'); hashes.add(h.sha256); } return true;
}
export function loadAndMigrateReferralState(path,{now=new Date(),write=false}={}) { const state=migrateReferralState(JSON.parse(readFileSync(path,'utf8')),{now}); validateReferralState(state); const kept=retained(state,+now); state.connections=kept.connections; state.retainedHashes=kept.hashes; state.matches=state.matches.filter(m=>state.connections.some(c=>c.profileUrl===m.profileUrl)); validateReferralState(state,{now}); if(write) writeReferralStateAtomic(path,state); return state; }
export function writeReferralStateAtomic(path,state) { validateReferralState(state); const temp=resolve(dirname(path),`.${randomUUID()}.tmp`); writeFileSync(temp,`${JSON.stringify(state,null,2)}\n`,{mode:0o600,flag:'wx'}); try { chmodSync(temp,0o600); const fd=openSync(temp,'r'); try { fsyncSync(fd); } finally { closeSync(fd); } renameSync(temp,path); chmodSync(path,0o600); } finally { if(existsSync(temp)) unlinkSync(temp); } }
function retained(state,now) { const hashes=[...state.retainedHashes], connections=[]; for(const c of state.connections) { if((now-Date.parse(c.lastObservedAt))/DAY>90) hashes.push({sha256:hash(c.profileUrl),lastSeenAt:c.lastObservedAt}); else connections.push(c); } return {connections,hashes:hashes.filter(x=>(now-Date.parse(x.lastSeenAt))/DAY<=365).filter((x,i,a)=>a.findIndex(y=>y.sha256===x.sha256)===i)}; }
function stateConnection(card,id,source,at,firstSeenAt=at) { return {profileUrl:card.profileUrl,fullName:card.fullName,headline:card.headline,connectedLabelRaw:card.connectedLabelRaw,connectedAtEarliest:card.connectedAtEarliest,connectedAtLatest:card.connectedAtLatest,connectedDatePrecision:card.connectedDatePrecision,cardFingerprint:card.cardFingerprint,classification:card.classification,employerLabel:card.employerLabel||null,disposition:'resolved',firstSeenAt,lastObservedAt:at,unresolvedCache:null,employers:[{employerLabel:card.employerLabel,canonicalCompanyKey:id.canonicalCompanyKey,linkedinCompanyUrl:id.linkedinCompanyUrl,title:'',resolutionSource:source,evidenceFingerprint:hash(`${card.employerLabel}|${id.canonicalCompanyKey}`),verifiedAt:at}]}; }
function unresolved(card,catalogRevision,aliasRevision,at,deferred=false,firstSeenAt=at,candidates=[]) { return {profileUrl:card.profileUrl,fullName:card.fullName,headline:card.headline,connectedLabelRaw:card.connectedLabelRaw,connectedAtEarliest:card.connectedAtEarliest,connectedAtLatest:card.connectedAtLatest,connectedDatePrecision:card.connectedDatePrecision,cardFingerprint:card.cardFingerprint,classification:card.classification,employerLabel:card.employerLabel||null,disposition:deferred?'deferred':'unresolved',firstSeenAt,lastObservedAt:at,employers:[],unresolvedCache:deferred?null:{catalogRevision,aliasRevision,cardEvidenceFingerprint:hash(`${card.cardFingerprint}|${card.employerLabel||''}`),candidateEvidenceFingerprint:hash(JSON.stringify(candidates.map(c=>[c.canonicalCompanyKey,c.linkedinCompanyUrl,c.companyDisplay])))} }; }
export function prepareTitleResolution({state,capture,identityIndex,catalogRevision,aliasRevision,now=new Date(),deadlineAt=new Date(now.getTime()+600000).toISOString(),batchId}) {
  const prior=migrateReferralState(state,{now}); validateReferralState(prior); const expired=retained(prior,now.getTime()); prior.connections=expired.connections; prior.retainedHashes=expired.hashes; prior.matches=prior.matches.filter(m=>prior.connections.some(c=>c.profileUrl===m.profileUrl)); validateReferralState(prior,{now}); if(!capture||!SOURCE_STATUSES.has(capture.sourceStatus)||!iso(capture.observedAt)||!Array.isArray(capture.connections)) throw new Error('invalid capture'); const result={connections:prior.connections,hashes:prior.retainedHashes}, saved=new Map(result.connections.map(c=>[c.profileUrl,c])), candidates=[]; let exact=0,reused=0;
  // Current catalog authority applies even if the source is skipped.  Do not
  // keep a resolved employer or old match after its reviewed identity was
  // removed, quarantined, or now contradicts the stored evidence.
  for (const [profileUrl, connection] of saved) if (connection.disposition === 'resolved' && connection.classification !== 'legacy') {
    const employer = connection.employers[0];
    const current = resolveCompanyIdentity(identityIndex, { companyLabel: connection.employerLabel || '', companyLinkedinUrl: employer?.linkedinCompanyUrl || null });
    if (current.status !== 'resolved' || current.canonicalCompanyKey !== employer?.canonicalCompanyKey) {
      saved.set(profileUrl, { ...connection, disposition:'unresolved', employers:[], unresolvedCache:{catalogRevision,aliasRevision,cardEvidenceFingerprint:hash(`${connection.cardFingerprint}|${connection.employerLabel||''}`),candidateEvidenceFingerprint:hash('[]')} });
      prior.matches = prior.matches.filter(match => match.profileUrl !== profileUrl);
    }
  }
  if(['ok','partial'].includes(capture.sourceStatus)) for(const raw of capture.connections.slice(0,50)) { const card=normalizeConnectionCard(raw,{now}), previous=saved.get(card.profileUrl), same=previous?.cardFingerprint===card.cardFingerprint;
    // A cached resolution is only reusable while its canonical identity is
    // still present and its observed token is not quarantined.
    const oldKey=previous?.employers?.[0]?.canonicalCompanyKey;
    const stillResolved = resolveCompanyIdentity(identityIndex, { companyLabel: previous?.employerLabel || '' });
    if(same&&previous.disposition==='resolved'&&stillResolved.status==='resolved'&&stillResolved.canonicalCompanyKey===oldKey){reused++;continue;}
    if (!same && previous) { saved.delete(card.profileUrl); prior.matches = prior.matches.filter(match => match.profileUrl !== card.profileUrl); }
    const found=card.classification==='explicit_employer'?resolveCompanyIdentity(identityIndex,{companyLabel:card.employerLabel}):{status:'unresolved'}; if(found.status==='resolved'){saved.set(card.profileUrl,stateConnection(card,found,'connections_headline_exact',capture.observedAt,previous?.firstSeenAt||capture.observedAt));exact++;continue;} const list=card.classification==='explicit_employer'?generateCompanyCandidates(identityIndex,card.employerLabel,{limit:5}):[]; const cardEvidenceFingerprint=hash(`${card.cardFingerprint}|${card.employerLabel||''}`), candidateEvidenceFingerprint=hash(JSON.stringify(list.map(c=>[c.canonicalCompanyKey,c.linkedinCompanyUrl,c.companyDisplay]))); if(same&&previous?.disposition==='unresolved'&&previous.unresolvedCache?.catalogRevision===catalogRevision&&previous.unresolvedCache?.aliasRevision===aliasRevision&&previous.unresolvedCache?.cardEvidenceFingerprint===cardEvidenceFingerprint&&previous.unresolvedCache?.candidateEvidenceFingerprint===candidateEvidenceFingerprint){reused++;continue;} if(list.length)candidates.push({...card,candidates:list}); else saved.set(card.profileUrl,unresolved(card,catalogRevision,aliasRevision,capture.observedAt,false,previous?.firstSeenAt||capture.observedAt,list)); }
  candidates.sort((a,b)=>`${a.employerLabel}|${a.cardFingerprint}`.localeCompare(`${b.employerLabel}|${b.cardFingerprint}`)); const batch=makeRequestBatch({cases:candidates,batchId});
  // A single de-duplicated public request can represent several private cards.
  // Keep all references in the private context; no request ID is derived from a
  // profile URL or person name.
  const requestRefs=[]; const queued=new Set(); for(const request of batch.requests) for(const candidate of candidates) {
    const same = request.observedEmployerLabel === candidate.employerLabel && JSON.stringify(request.candidates) === JSON.stringify(candidate.candidates);
    if (same) { queued.add(candidate.profileUrl); requestRefs.push({requestId:request.requestId,profileUrl:candidate.profileUrl,cardFingerprint:candidate.cardFingerprint,employerLabel:candidate.employerLabel}); }
  }
  for(const c of candidates) { const previous=saved.get(c.profileUrl); saved.set(c.profileUrl,unresolved(c,catalogRevision,aliasRevision,capture.observedAt,!queued.has(c.profileUrl),previous?.firstSeenAt||capture.observedAt,c.candidates)); }
  const retainedProfiles=new Set(saved.keys());
  const next={...prior,sourceStatus:capture.sourceStatus,sourceWarning:String(capture.sourceWarning||''),updatedAt:capture.observedAt,connections:[...saved.values()],matches:prior.matches.filter(match=>retainedProfiles.has(match.profileUrl)),retainedHashes:result.hashes}; validateReferralState(next); return {state:next,batch,requestRefs,exact,reused,deferred:candidates.length-batch.requests.length,deadlineAt,catalogRevision,aliasRevision};
}
// Pure finalization used by the CLI and tests. The caller supplies an
// authoritative index and persistence operation; model output never becomes an
// identity until it is both locally validated and durably accepted by the store.
export function finalizeTitleResolution({ prepared, identityIndex, catalogRevision, aliasRevision, decisions, now = new Date(), persist = () => ({ status: 'rejected' }) }) {
  if (!prepared || prepared.catalogRevision !== catalogRevision || prepared.aliasRevision !== aliasRevision) throw new Error('stale prepared resolution');
  const decisionMap = validateDecisionBatch({ batchId: prepared.batch.batchId, requests: prepared.batch.requests, decisions });
  const state = structuredClone(prepared.state);
  const refsByRequest = new Map();
  for (const ref of prepared.requestRefs || []) refsByRequest.set(ref.requestId, [...(refsByRequest.get(ref.requestId) || []), ref]);
  for (const request of prepared.batch.requests) {
    const decision = decisionMap.get(request.requestId);
    const refs = refsByRequest.get(request.requestId) || [];
    if (decision.decision === 'resolved') {
      const identity = identityIndex.identities.get(decision.canonicalCompanyKey);
      const supplied = request.candidates.some(c => c.canonicalCompanyKey === decision.canonicalCompanyKey && c.linkedinCompanyUrl === identity?.linkedinCompanyUrl);
      if (identity && supplied) {
        // Alias storage is a separate durable authority.  A lock/write/rename
        // failure must not turn a bounded AI suggestion into a ledger abort or
        // an asserted resolution; leave this request as completed unresolved.
        let result; try { result = persist({ request, decision, identity, refs }); } catch { result = { status: 'rejected' }; }
        if (['persisted','reused'].includes(result?.status)) for (const ref of refs) {
          const card = state.connections.find(c => c.profileUrl === ref.profileUrl && c.cardFingerprint === ref.cardFingerprint);
          // Resolution is not a new browser observation. Preserve the capture
          // timestamp so a repeat with the same cards is a true no-op.
          if (card) Object.assign(card, stateConnection({...card, employerLabel: ref.employerLabel}, identity, 'connections_headline_ai_alias', card.lastObservedAt, card.firstSeenAt));
        }
      }
    }
  }
  for (const connection of state.connections) if (connection.disposition === 'unresolved' && !connection.unresolvedCache) connection.unresolvedCache = { catalogRevision, aliasRevision, cardEvidenceFingerprint:hash(`${connection.cardFingerprint}|${connection.employerLabel||''}`), candidateEvidenceFingerprint:hash('[]') };
  validateReferralState(state);
  return { state, decisions: decisionMap };
}
export function validateCapture(capture) { if(!capture||!iso(capture.observedAt)||!SOURCE_STATUSES.has(capture.sourceStatus)||!Array.isArray(capture.connections)) throw new Error('invalid capture'); return true; }
export function mergeCapture(previous,capture,{now=new Date()}={}) { const index=buildCompanyIdentityIndex({}); const compact={...capture,connections:(capture?.connections||[]).map(({profileUrl,fullName,headline='',connectedLabelRaw})=>({profileUrl,fullName,headline,connectedLabelRaw}))}; return prepareTitleResolution({state:previous,capture:compact,identityIndex:index,catalogRevision:computeCatalogRevision(index),aliasRevision:hash(''),now}).state; }
// Alias persistence can change authority for cards other than the decision
// currently being handled. Re-evaluate every observed title against the final
// index so a newly exact alias resolves consistently and a quarantine clears
// the same token everywhere.
export function settleTitleAuthority(state, identityIndex, catalogRevision, aliasRevision, now = new Date()) {
  for (const connection of state.connections) {
    if (connection.classification === 'legacy') continue;
    const found = connection.classification === 'explicit_employer' ? resolveCompanyIdentity(identityIndex, { companyLabel: connection.employerLabel || '' }) : { status:'unresolved' };
    if (found.status === 'resolved') {
      const existing = connection.employers[0];
      // Finalization re-checks authority, but is not a new browser observation.
      // Rebuilding an identical record here would silently extend the 90-day
      // PII window and make a no-op second run write the ledger again.
      if (connection.disposition === 'resolved' && existing?.canonicalCompanyKey === found.canonicalCompanyKey && existing?.linkedinCompanyUrl === found.linkedinCompanyUrl) continue;
      const source = connection.employers[0]?.resolutionSource === 'connections_headline_ai_alias' ? 'connections_headline_ai_alias' : 'connections_headline_exact';
      Object.assign(connection, stateConnection(connection, found, source, connection.lastObservedAt, connection.firstSeenAt));
    } else if (connection.disposition === 'resolved' || connection.disposition === 'unresolved') {
      const candidates = connection.classification === 'explicit_employer'
        ? generateCompanyCandidates(identityIndex, connection.employerLabel || '', { limit: 5 })
        : [];
      const cardEvidenceFingerprint = hash(`${connection.cardFingerprint}|${connection.employerLabel||''}`);
      const candidateEvidenceFingerprint = hash(JSON.stringify(candidates.map(c=>[c.canonicalCompanyKey,c.linkedinCompanyUrl,c.companyDisplay])));
      const priorCache = connection.unresolvedCache;
      const evidenceUnchanged = connection.disposition === 'unresolved'
        && priorCache?.cardEvidenceFingerprint === cardEvidenceFingerprint
        && priorCache?.candidateEvidenceFingerprint === candidateEvidenceFingerprint;
      // Alias persistence changes revisions for all cards.  Preserve an
      // already-completed unresolved decision only when the card and the
      // offered candidates are identical under that final authority.  A
      // changed candidate set cannot be settled from an old decision; leave
      // it eligible for the next prepare pass.
      if (evidenceUnchanged) {
        connection.unresolvedCache = { catalogRevision, aliasRevision, cardEvidenceFingerprint, candidateEvidenceFingerprint };
      } else {
        Object.assign(connection, unresolved(connection, catalogRevision, aliasRevision, connection.lastObservedAt, candidates.length > 0, connection.firstSeenAt, candidates));
      }
    }
  }
  validateReferralState(state);
  return state;
}
export function buildReferralMatches({jobs=[],state,identityIndex=null,now=new Date()}) { validateReferralState(state); const recent=v=>date(v)&&(Date.parse(`${ny(now)}T12:00:00Z`)-Date.parse(`${v}T12:00:00Z`))/DAY>=0&&(Date.parse(`${ny(now)}T12:00:00Z`)-Date.parse(`${v}T12:00:00Z`))/DAY<14, latest=new Map(); for(const j of jobs)try{const u=canonicalApplyUrl(j.applyUrl);if(recent(j.scanDate)&&(!latest.has(u)||latest.get(u).scanDate<j.scanDate))latest.set(u,{...j,url:u});}catch{} const matches=[], seen=new Set(); for(const c of state.connections) if(recent(c.connectedAtEarliest)&&recent(c.connectedAtLatest)) for(const e of c.employers) for(const j of latest.values()) { const enriched = !e.canonicalCompanyKey && e.resolutionSource==='legacy_verified' && identityIndex ? resolveCompanyIdentity(identityIndex,{companyLabel:e.employerLabel,companyLinkedinUrl:e.linkedinCompanyUrl}) : null; const current = e.canonicalCompanyKey && identityIndex ? identityIndex.identities.get(e.canonicalCompanyKey) : null; const key=e.canonicalCompanyKey || (enriched?.status==='resolved' ? enriched.canonicalCompanyKey : null), matchKey=`${j.scanDate}|${j.url}|${c.profileUrl}`; if(key&&(!identityIndex || (current && current.linkedinCompanyUrl===e.linkedinCompanyUrl) || (enriched?.status==='resolved' && enriched.canonicalCompanyKey===key))&&(j.canonicalCompanyKey||j.company_key)===key&&!seen.has(matchKey)) { seen.add(matchKey); matches.push({matchKey,jobScanDate:j.scanDate,canonicalApplyUrl:j.url,profileUrl:c.profileUrl,fullName:c.fullName,currentTitle:e.title,currentEmployer:e.employerLabel,connectedLabelRaw:c.connectedLabelRaw,connectedAtEarliest:c.connectedAtEarliest,connectedAtLatest:c.connectedAtLatest,lastObservedAt:c.lastObservedAt,matchQuality:e.resolutionSource==='connections_headline_ai_alias'?'reviewed_alias':'company_url_exact'}); } } return matches; }
function indexFor(mapPath,aliasPath,archivePath=null,portalsPath=null) { const aliases=existsSync(aliasPath)?parseCompanyAliases(readFileSync(aliasPath,'utf8')):[], archive=archivePath&&existsSync(archivePath)?boundedJson(archivePath,'archive'):null, portalsText=portalsPath&&existsSync(portalsPath)?readFileSync(portalsPath,'utf8'):'', index=buildCompanyIdentityIndex({companyMapRows:parseCompanyMapRows(readFileSync(mapPath,'utf8')),aliasRows:aliases,trackedCompanyRows:loadVerifiedTrackedCompanyRows({portalsText,archive})}); return {index,aliases,catalogRevision:computeCatalogRevision(index),aliasRevision:computeAliasMappingRevision(aliases)}; }
function archiveJobs(archivePath, index) {
  const archive=boundedJson(archivePath,'archive');
  if (archive.schemaVersion !== 1 || !Array.isArray(archive.jobs)) throw new Error('invalid archive');
  return archive.jobs.map(job => {
    if (!job || typeof job !== 'object' || !date(job.scanDate) || typeof job.applyUrl !== 'string') throw new Error('invalid archive job');
    const identity=resolveCompanyIdentity(index,{companyLabel:typeof job.company==='string'?job.company:'',companyLinkedinUrl:job.linkedinPeopleUrl?.replace(/people\/$/,'') || null});
    return {...job, canonicalCompanyKey:identity.status==='resolved'?identity.canonicalCompanyKey:null};
  });
}
const RUN_FILES = ['capture.json', 'context.json', 'requests.json', 'decisions.json'];
function parseFlags(rest, allowed) { const flags={}; for(let i=0;i<rest.length;i+=2) { const key=rest[i]; if(!key?.startsWith('--') || rest[i+1]===undefined || !allowed.has(key.slice(2)) || Object.hasOwn(flags,key.slice(2))) throw new Error('Unknown command or flag'); flags[key.slice(2)]=rest[i+1]; } return flags; }
function boundedJson(path, label, maxBytes = 1_000_000) { if (!existsSync(path) || statSync(path).size > maxBytes) throw new Error(`invalid ${label}`); try { const value=JSON.parse(readFileSync(path,'utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; } catch { throw new Error(`invalid ${label}`); } }
function writePrivate(path, value) { writeFileSync(path, `${JSON.stringify(value,null,2)}\n`, {mode:0o600,flag:'wx'}); chmodSync(path,0o600); }
function createRun(path) { if (existsSync(path)) throw new Error('run directory already exists'); mkdirSync(path,{recursive:false,mode:0o700}); chmodSync(path,0o700); }
function cleanupRun(path) { if (!existsSync(path)) return; for (const name of RUN_FILES) { const file=resolve(path,name); if (existsSync(file)) unlinkSync(file); } rmdirSync(path); }
function freshRunPath() { const path=mkdtempSync(resolve(tmpdir(), 'sunny-title-run-')); rmdirSync(path); return path; }

/** Execute a referral operation once, then once more with a fresh run on error.
 * The caller owns its job scan; this helper deliberately returns a skip rather
 * than throwing after the retry so optional referral work never blocks it. */
export async function runReferralWithRetry({ runOnce, onStatus = () => {}, onSkip = () => {}, makeRun = freshRunPath, removeRun = cleanupRun }) {
  let error;
  for (let attempt=1; attempt<=2; attempt+=1) {
    const runDir=makeRun(attempt);
    try { return {status:'ok',attempt,result:await runOnce(attempt,runDir)}; }
    catch (caught) { error=caught; try { removeRun(runDir); } catch {} }
  }
  const result={status:'skipped_after_retry',attempt:2,error:String(error?.message||'referral failed').slice(0,160)};
  onStatus(result); onSkip(result); return result;
}
export const runTitleReferralWithRetry = runReferralWithRetry;

export async function runCli(args,io=process) {
  const [command,...rest]=args;
  const allowed={status:new Set(['state','now']), 'prepare-title':new Set(['capture','run-dir','state','catalog','alias','archive','now']), 'finalize-title':new Set(['run-dir','decisions','state','catalog','alias','archive','now'])};
  if (!Object.hasOwn(allowed,command)) throw new Error('Unknown command or flag');
  const flags=parseFlags(rest,allowed[command]);
  const root=resolve(process.env.CAREER_OPS_ROOT||getCareerOpsRoot()), data=resolve(root,'data'), now=flags.now?new Date(flags.now):new Date();
  if (!existsSync(root) || Number.isNaN(+now)) throw new Error('invalid root or now');
  const statePath=resolve(flags.state||`${data}/sunny-linkedin-referrals.json`), mapPath=resolve(flags.catalog||`${data}/sunny-linkedin-company-map.tsv`), aliasPath=resolve(flags.alias||`${data}/sunny-linkedin-company-aliases.tsv`), archivePath=resolve(flags.archive||`${data}/sunny-job-search-archive.json`), portalsPath=resolve(root,'portals.yml');
  if(command==='status') { const state=existsSync(statePath)?loadAndMigrateReferralState(statePath,{now}):emptyState(now); io.stdout.write(JSON.stringify({connections:state.connections.length,matches:state.matches.length})+'\n'); return; }
  if (!flags['run-dir']) throw new Error('run directory required');
  const run=resolve(flags['run-dir']);
  if (command==='prepare-title') {
    const capture=boundedJson(resolve(flags.capture||''),'capture'); validateCapture(capture); if (!existsSync(mapPath)) throw new Error('company map required');
    if (RETRYABLE_SOURCE_STATUSES.has(capture.sourceStatus)) throw new Error(`retryable capture status: ${capture.sourceStatus}`);
    createRun(run); writePrivate(resolve(run,'capture.json'),capture);
    const before=existsSync(statePath)?loadAndMigrateReferralState(statePath,{now}):emptyState(now), ctx=indexFor(mapPath,aliasPath,archivePath,portalsPath);
    const prepared=prepareTitleResolution({state:before,capture,identityIndex:ctx.index,catalogRevision:ctx.catalogRevision,aliasRevision:ctx.aliasRevision,now});
    const context={schemaVersion:1,batchId:prepared.batch.batchId,catalogRevision:ctx.catalogRevision,aliasRevision:ctx.aliasRevision,state:prepared.state,requestRefs:prepared.requestRefs};
    writePrivate(resolve(run,'requests.json'),prepared.batch); writePrivate(resolve(run,'context.json'),context);
    io.stdout.write(JSON.stringify({requests:prepared.batch.requests.length,exact:prepared.exact,deferred:prepared.deferred})+'\n'); return;
  }
  const context=boundedJson(resolve(run,'context.json'),'context'), requests=boundedJson(resolve(run,'requests.json'),'requests');
  if (context.schemaVersion!==1 || context.batchId!==requests.batchId || !Array.isArray(context.requestRefs) || !existsSync(mapPath) || !existsSync(archivePath)) throw new Error('malformed title handoff');
  let decisions; try { decisions=boundedJson(resolve(flags.decisions||resolve(run,'decisions.json')),'decisions'); } catch { decisions={schemaVersion:1,batchId:requests.batchId,decisions:[]}; }
  if (!existsSync(aliasPath)) writeFileSync(aliasPath,'alias_normalized\tcanonical_company_key\tlinkedin_company_url\tresolution_source\tconfidence\tevidence_fingerprint\tcatalog_revision\tresolved_on\tstatus\n',{mode:0o600});
  const ctx=indexFor(mapPath,aliasPath,archivePath,portalsPath);
  const prepared={state:context.state,batch:requests,requestRefs:context.requestRefs,catalogRevision:context.catalogRevision,aliasRevision:context.aliasRevision};
  const finished=finalizeTitleResolution({prepared,identityIndex:ctx.index,catalogRevision:ctx.catalogRevision,aliasRevision:ctx.aliasRevision,decisions,now,persist:({request,decision,identity})=>persistAlias({path:aliasPath,proposal:{alias_normalized:request.observedEmployerLabel,canonical_company_key:identity.canonicalCompanyKey,linkedin_company_url:identity.linkedinCompanyUrl,resolution_source:'ai_title',confidence:decision.confidence,evidence_fingerprint:aliasEvidenceFingerprint({employerEvidence:request.employerEvidence,candidates:request.candidates,decision}),catalog_revision:ctx.catalogRevision},catalog:ctx.index,today:ny(now)})});
  const finalCtx=indexFor(mapPath,aliasPath,archivePath,portalsPath); settleTitleAuthority(finished.state,finalCtx.index,finalCtx.catalogRevision,finalCtx.aliasRevision,now);
  finished.state.matches=buildReferralMatches({jobs:archiveJobs(archivePath,finalCtx.index),state:finished.state,identityIndex:finalCtx.index,now}); finished.state.updatedAt=now.toISOString(); writeReferralStateAtomic(statePath,finished.state);
  cleanupRun(run); io.stdout.write('{"finalized":true}\n');
}
if(process.argv[1]===new URL(import.meta.url).pathname)runCli(process.argv.slice(2)).catch(e=>{process.stderr.write(`${e.message}\n`);process.exitCode=1;});
