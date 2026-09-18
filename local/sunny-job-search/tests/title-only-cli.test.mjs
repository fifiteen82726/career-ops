import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildReferralMatches, emptyState, migrateReferralState, prepareTitleResolution, runCli, runReferralWithRetry } from '../referrals.mjs';
import { buildSnapshot } from '../../../data/tools/build-sunny-job-search-index.mjs';
import { buildCompanyIdentityIndex, computeAliasMappingRevision, computeCatalogRevision, parseCompanyMapRows } from '../company-identities.mjs';

const HEADER = 'company_key\tcompany_display\tlinkedin_company_url\tlinkedin_people_url\tverification_source\tverified_on\tstatus\n';
const ALIAS = 'alias_normalized\tcanonical_company_key\tlinkedin_company_url\tresolution_source\tconfidence\tevidence_fingerprint\tcatalog_revision\tresolved_on\tstatus\n';
const NOW = '2026-09-16T16:00:00.000Z';
const silent = { stdout: { write() {} }, stderr: { write() {} } };

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'sunny-title-mvp-')), data=join(root,'data'); mkdirSync(data);
  const names=['Acme','Bravo','Cedar','Delta','Echo','Fjord','Grove','Harbor','Indigo','American Express','Zenith'];
  const key=name=>name.toLowerCase().replace(/ /g,'-');
  writeFileSync(join(data,'sunny-linkedin-company-map.tsv'), HEADER+names.map(name=>`${key(name)}\t${name}\thttps://www.linkedin.com/company/${key(name)}/\thttps://www.linkedin.com/company/${key(name)}/people/\treview\t2026-09-16\tverified`).join('\n')+'\n');
  writeFileSync(join(data,'sunny-linkedin-company-aliases.tsv'),ALIAS); chmodSync(join(data,'sunny-linkedin-company-aliases.tsv'),0o600);
  writeFileSync(join(data,'sunny-linkedin-referrals.json'),JSON.stringify({schemaVersion:3,sourceStatus:'ok',sourceWarning:'',updatedAt:NOW,timeZone:'America/New_York',connections:[],matches:[],retainedHashes:[]}));
  const jobs=names.slice(0,9).map((name,i)=>({scanDate:'2026-09-15',applyUrl:`https://jobs.example.test/${i}`,company:name,linkedinPeopleUrl:`https://www.linkedin.com/company/${key(name)}/people/`,priority:'priority',priorityLabel:'P',score:90,recommendation:'yes',title:'Engineer',category:'Data',location:'NYC',workMode:'hybrid',primaryGap:'-',resume:'-',referralMessage:'-'}));
  writeFileSync(join(data,'sunny-job-search-archive.json'),JSON.stringify({schemaVersion:1,jobs}));
  return {root,data,jobs};
}
function captureFor(root) {
  const exact=['Acme','Bravo','Cedar','Delta','Echo','Fjord','Grove','Harbor','Indigo'];
  const cards=[...exact.map((name,i)=>({profileUrl:`https://www.linkedin.com/in/exact-${i}/`,fullName:`Exact ${i}`,headline:`Engineer at ${name}`,connectedLabelRaw:'Connected yesterday'})),
    {profileUrl:'https://www.linkedin.com/in/amex/',fullName:'AI One',headline:'Analyst at AMEX',connectedLabelRaw:'Connected yesterday'},
    {profileUrl:'https://www.linkedin.com/in/zen/',fullName:'AI Two',headline:'Engineer at Zenit',connectedLabelRaw:'Connected yesterday'},
    {profileUrl:'https://www.linkedin.com/in/american/',fullName:'Unresolved One',headline:'Engineer at American',connectedLabelRaw:'Connected yesterday'},
    {profileUrl:'https://www.linkedin.com/in/zeni/',fullName:'Unresolved Two',headline:'Engineer at Zeni',connectedLabelRaw:'Connected yesterday'},
    ...Array.from({length:7},(_,i)=>({profileUrl:`https://www.linkedin.com/in/skip-${i}/`,fullName:`Skip ${i}`,headline:`Engineer at Unknown ${i}`,connectedLabelRaw:'Connected yesterday'}))];
  const path=join(root,'capture.json'); writeFileSync(path,JSON.stringify({observedAt:NOW,sourceStatus:'ok',sourceWarning:'',connections:cards})); chmodSync(path,0o600); return path;
}
async function withRoot(root, work) { const before=process.env.CAREER_OPS_ROOT; process.env.CAREER_OPS_ROOT=root; try { return await work(); } finally { if(before===undefined) delete process.env.CAREER_OPS_ROOT; else process.env.CAREER_OPS_ROOT=before; } }

test('offline 20-card title-only golden is idempotent and publishes only resolved contacts', async () => {
  const {root,data,jobs}=fixture(), capture=captureFor(root), run=join(root,'run-one');
  await withRoot(root, async () => {
    await runCli(['prepare-title','--capture',capture,'--run-dir',run,'--now',NOW],silent);
    const batch=JSON.parse(readFileSync(join(run,'requests.json'))); assert.equal(batch.requests.length,4);
    const byLabel=Object.fromEntries(batch.requests.map(r=>[r.observedEmployerLabel,r]));
    writeFileSync(join(run,'decisions.json'),JSON.stringify({schemaVersion:1,batchId:batch.batchId,decisions:[
      {schemaVersion:1,requestId:byLabel.AMEX.requestId,decision:'resolved',canonicalCompanyKey:'american-express',confidence:.99,reasonCode:'recognized_brand_alias'},
      {schemaVersion:1,requestId:byLabel.Zenit.requestId,decision:'resolved',canonicalCompanyKey:'zenith',confidence:.99,reasonCode:'recognized_brand_alias'},
    ]})); chmodSync(join(run,'decisions.json'),0o600);
    await runCli(['finalize-title','--run-dir',run,'--decisions',join(run,'decisions.json'),'--now','2026-09-16T16:01:00.000Z'],silent);
  });
  const first=JSON.parse(readFileSync(join(data,'sunny-linkedin-referrals.json'))), aliases=readFileSync(join(data,'sunny-linkedin-company-aliases.tsv'),'utf8');
  assert.equal(first.connections.length,20); assert.equal(first.connections.filter(c=>c.disposition==='resolved').length,11); assert.equal(first.matches.length,9); assert.equal(aliases.trim().split('\n').length-1,2);
  assert.equal(first.connections.find(c=>c.profileUrl==='https://www.linkedin.com/in/american/').disposition,'unresolved');
  assert.equal(first.connections.find(c=>c.profileUrl==='https://www.linkedin.com/in/zeni/').disposition,'unresolved');
  const snapshot=buildSnapshot({schemaVersion:1,jobs},new Date('2026-09-16T16:01:00Z'),first); assert.equal(snapshot.jobs.filter(job=>job.referralContacts.length).length,9);
  const beforeAliases=aliases, runTwo=join(root,'run-two');
  await withRoot(root,()=>runCli(['prepare-title','--capture',capture,'--run-dir',runTwo,'--now','2026-09-16T16:02:00.000Z'],silent));
  const secondBatch=JSON.parse(readFileSync(join(runTwo,'requests.json'))); assert.equal(secondBatch.requests.length,0); assert.equal(readFileSync(join(data,'sunny-linkedin-company-aliases.tsv'),'utf8'),beforeAliases);
  writeFileSync(join(runTwo,'decisions.json'),JSON.stringify({schemaVersion:1,batchId:secondBatch.batchId,decisions:[]})); chmodSync(join(runTwo,'decisions.json'),0o600);
  await withRoot(root,()=>runCli(['finalize-title','--run-dir',runTwo,'--decisions',join(runTwo,'decisions.json'),'--now','2026-09-16T16:03:00.000Z'],silent));
  const second=JSON.parse(readFileSync(join(data,'sunny-linkedin-referrals.json'))); assert.deepEqual(second.matches.map(m=>m.matchKey),first.matches.map(m=>m.matchKey)); assert.equal(second.connections.find(c=>c.profileUrl==='https://www.linkedin.com/in/amex/').lastObservedAt,NOW); assert.equal(statSync(join(data,'sunny-linkedin-referrals.json')).mode&0o777,0o600);
});

test('retry wrapper uses exactly one retry and returns a compact skip without touching job data', async () => {
  let calls=0; const runs=[]; const success=await runReferralWithRetry({makeRun:attempt=>`run-${attempt}`,removeRun:run=>runs.push(`clean:${run}`),runOnce:async (attempt,run)=>{calls+=1; runs.push(run); if(attempt===1) throw new Error('temporary browser error'); return 'done';}});
  assert.deepEqual(success,{status:'ok',attempt:2,result:'done'}); assert.equal(calls,2);
  assert.deepEqual(runs,['run-1','clean:run-1','run-2']);
  const root=mkdtempSync(join(tmpdir(),'sunny-retry-jobs-')), jobs=join(root,'jobs.json'); writeFileSync(jobs,'unchanged'); let status;
  const skipped=await runReferralWithRetry({runOnce:async()=>{throw new Error('source unavailable');},onStatus:value=>{status=value;}});
  assert.equal(skipped.status,'skipped_after_retry'); assert.equal(skipped.attempt,2); assert.equal(status.status,'skipped_after_retry'); assert.equal(readFileSync(jobs,'utf8'),'unchanged');
});

test('retry wrapper gives actual prepare-title a fresh path after a capture failure', async () => {
  const {root,data}=fixture(), capture=captureFor(root); let calls=0;
  await withRoot(root, async () => {
    const result=await runReferralWithRetry({runOnce:async (attempt,runDir) => {
      calls+=1;
      const attemptCapture=attempt===1
        ? join(root,'capture-error.json')
        : capture;
      if (attempt===1) writeFileSync(attemptCapture,JSON.stringify({observedAt:NOW,sourceStatus:'error',sourceWarning:'capture unavailable',connections:[]}));
      await runCli(['prepare-title','--capture',attemptCapture,'--run-dir',runDir,'--now',NOW],silent);
      const batch=JSON.parse(readFileSync(join(runDir,'requests.json')));
      writeFileSync(join(runDir,'decisions.json'),JSON.stringify({schemaVersion:1,batchId:batch.batchId,decisions:[]}));
      await runCli(['finalize-title','--run-dir',runDir,'--decisions',join(runDir,'decisions.json'),'--now',NOW],silent);
    }});
    assert.equal(result.status,'ok'); assert.equal(result.attempt,2); assert.equal(calls,2);
  });
  assert.equal(JSON.parse(readFileSync(join(data,'sunny-linkedin-referrals.json'))).connections.length,20);
});

test('two retryable captures skip before title persistence and continue the ordinary scan', async () => {
  const {root,data}=fixture(), capture=join(root,'capture-error.json');
  writeFileSync(capture,JSON.stringify({observedAt:NOW,sourceStatus:'linkedin_challenge',sourceWarning:'challenge',connections:[]}));
  const ledger=join(data,'sunny-linkedin-referrals.json'), jobs=join(data,'sunny-job-search-archive.json');
  const beforeLedger=readFileSync(ledger,'utf8'), beforeJobs=readFileSync(jobs,'utf8'); let continued=0;
  await withRoot(root, async () => {
    const result=await runReferralWithRetry({runOnce:(attempt,runDir)=>runCli(['prepare-title','--capture',capture,'--run-dir',runDir,'--now',NOW],silent),onSkip:()=>{continued+=1;}});
    assert.equal(result.status,'skipped_after_retry'); assert.equal(result.attempt,2);
  });
  assert.equal(continued,1); assert.equal(readFileSync(ledger,'utf8'),beforeLedger); assert.equal(readFileSync(jobs,'utf8'),beforeJobs);
});

test('legacy migration and current archive recomputation preserve the documented counts', () => {
  const old={schemaVersion:1,sourceStatus:'ok',updatedAt:NOW,connections:Array.from({length:20},(_,i)=>({profileUrl:`https://www.linkedin.com/in/legacy-${i}/`,fullName:`Legacy ${i}`,currentEmployments:Array.from({length:i===0?2:1},(_,j)=>({employer:`Employer ${i}-${j}`,title:'Engineer',isCurrent:true}))})),matches:Array.from({length:16},(_,i)=>({matchKey:`2026-09-15|https://jobs.example.test/legacy-${i%9}|https://www.linkedin.com/in/legacy-${i%12}/`,jobScanDate:'2026-09-15',canonicalApplyUrl:`https://jobs.example.test/legacy-${i%9}`,profileUrl:`https://www.linkedin.com/in/legacy-${i%12}/`,fullName:`Legacy ${i%12}`,currentTitle:'Engineer',currentEmployer:'Employer',connectedLabelRaw:'Connected yesterday',connectedAtEarliest:'2026-09-15',connectedAtLatest:'2026-09-15',lastObservedAt:NOW,matchQuality:'company_url_exact'}))};
  const migrated=migrateReferralState(old,{now:new Date(NOW)}); assert.equal(migrated.connections.length,20); assert.equal(migrated.connections.reduce((n,c)=>n+c.employers.length,0),21); assert.equal(migrated.matches.length,16); assert.equal(new Set(migrated.matches.map(m=>m.profileUrl)).size,12); assert.equal(new Set(migrated.matches.map(m=>m.canonicalApplyUrl)).size,9);
  const rows=Array.from({length:10},(_,i)=>`co-${i}\tCo ${i}\thttps://www.linkedin.com/company/co-${i}/\thttps://www.linkedin.com/company/co-${i}/people/\treview\t2026-09-16\tverified`).join('\n');
  const index=buildCompanyIdentityIndex({companyMapRows:parseCompanyMapRows(HEADER+rows+'\n')});
  const employers=[0,1,1,1,2,2,3,3,4,4,5,5];
  const capture={observedAt:NOW,sourceStatus:'ok',sourceWarning:'',connections:employers.map((company,i)=>({profileUrl:`https://www.linkedin.com/in/current-${i}/`,fullName:`Current ${i}`,headline:`Engineer at Co ${company}`,connectedLabelRaw:'Connected yesterday'}))};
  const prepared=prepareTitleResolution({state:emptyState(new Date(NOW)),capture,identityIndex:index,catalogRevision:computeCatalogRevision(index),aliasRevision:computeAliasMappingRevision([]),now:new Date(NOW)});
  const jobCompanies=[0,0,0,1,1,2,2,3,4,5];
  const jobs=jobCompanies.map((company,i)=>({scanDate:'2026-09-15',applyUrl:`https://jobs.example.test/current-${i}`,canonicalCompanyKey:`co-${company}`}));
  const matches=buildReferralMatches({state:prepared.state,jobs,identityIndex:index,now:new Date(NOW)});
  assert.equal(matches.length,19);
  assert.equal(new Set(matches.map(m=>m.profileUrl)).size,12); assert.equal(new Set(matches.map(m=>m.canonicalApplyUrl)).size,10);
});
