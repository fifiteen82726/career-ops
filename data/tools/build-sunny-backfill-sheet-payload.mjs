#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const HISTORY_START_INDEX = 68;
const SHEET_ROWS = {
  backfill: 4,
  master: 23,
  excluded: 49,
  seen: 69,
};

const evaluations = new Map(Object.entries({
  'https://careers.duolingo.com/jobs/8759720002?gh_jid=8759720002': [79, 'Data Analysis', 'Marketing analytics manager title and cross-functional leadership scope are a seniority stretch'],
  'https://job-boards.greenhouse.io/vercel/jobs/5895013004': [83, 'Data Engineering', 'Staff-level ownership is above current seniority despite strong data-platform alignment'],
  'https://job-boards.greenhouse.io/gusto/jobs/8119978': [91, 'Business Intelligence', 'Limited direct customer-experience analytics domain evidence'],
  'https://jobs.ashbyhq.com/adonis/4a9f7dfd-52aa-486c-b2d9-1d481ce2d0f8': [94, 'Data Engineering', 'No direct healthcare claims or revenue-cycle data experience'],
  'https://jobs.ashbyhq.com/imprint/25409da3-c86f-4824-a292-bbd20a0f2f11': [87, 'Data Engineering', 'JD asks for 5+ years of hands-on platform/infrastructure engineering'],
  'https://www.fanduel.careers/open-positions?gh_jid=8070473': [86, 'Data Analysis', 'JD asks for 4+ years and direct sports-product analytics experience'],
  'http://www.hioscar.com/careers/8146196?gh_jid=8146196': [76, 'Data Analysis', 'Manager/client-facing clinical analytics scope exceeds demonstrated leadership depth'],
  'https://careers.datadoghq.com/detail/8141967/?gh_jid=8141967': [89, 'Data Engineering', 'Limited direct revenue-data and finance-systems domain evidence'],
  'https://jobs.ashbyhq.com/permitflow/4b6778b7-c5c8-412f-b6eb-7e60c6243434': [88, 'Data Analysis', 'No direct construction/permitting product-domain evidence'],
  'https://jobs.ashbyhq.com/doctronic/27a0e05a-c336-4daf-92bf-0e7961c4f2ae': [85, 'Data Engineering', 'JD asks for 5+ years and first-data-engineer end-to-end ownership'],
  'https://jobs.ashbyhq.com/patlytics/f5d00d27-e018-4581-a227-67d93c1a727c': [82, 'Data Engineering', 'Lead/founding ownership and patent-domain depth are not demonstrated'],
  'https://jobs.ashbyhq.com/sailorhealth/55702dde-a7c4-458c-96aa-487c0f4b3561': [90, 'Analytics Engineering', 'Founding-role ambiguity and healthcare-domain ramp are the main risks'],
  'https://guidehouse.wd1.myworkdayjobs.com/external/job/US---Remote-Any-location/AWS-Lakehouse-Data-Engineer_43865': [92, 'Data Engineering', 'Must confirm H-1B compatibility with the Public Trust onboarding requirement'],
  'https://guidehouse.wd1.myworkdayjobs.com/external/job/US---Remote-Any-location/Data-Platform-Lead_41871': [84, 'Data Engineering', 'Lead-level consulting ownership and up to 25% travel are the main gaps'],
  'https://guidehouse.wd1.myworkdayjobs.com/external/job/US---Remote-Any-location/Data-Infrastructure-Engineer_43344': [85, 'Data Engineering', 'JD asks for 6+ years and Public Trust eligibility'],
  'https://guidehouse.wd1.myworkdayjobs.com/external/job/US---Remote-Any-location/Databricks-Data-Engineer_42292-1': [95, 'Data Engineering', 'Consulting delivery and Unity Catalog depth are less explicit on the resume'],
  'https://job-boards.greenhouse.io/webflow/jobs/8165290': [83, 'Data Engineering', 'Staff scope and 5+ years exceed current demonstrated seniority'],
  'https://www.qventus.com/company/working-qventus/job?gh_jid=4381957009': [82, 'Data Engineering', 'Healthcare integration and interface-engine experience are not explicit'],
  'https://www.qventus.com/company/working-qventus/job?gh_jid=4378754009': [84, 'Data Engineering', 'Healthcare operational-data domain depth is not demonstrated'],
  'https://companycam.com/job?gh_jid=7915940003': [80, 'Data Analysis', 'JD asks for 5+ years of product analytics and experimentation ownership'],
  'https://boards.greenhouse.io/robinhood/jobs/8120681?t=gh_src=&gh_jid=8120681': [82, 'Data Engineering', 'Role emphasizes financial-data validation and controls more than end-to-end platform ownership'],
  'https://jobs.dropbox.com/listing/8126572?gh_jid=8126572': [79, 'Data Analysis', 'JD asks for direct People/Recruiting Analytics experience'],
  'https://job-boards.greenhouse.io/wppmedia/jobs/5389587008': [78, 'Data Analysis', 'Direct agency/media performance analytics experience is limited'],
  'https://job-boards.greenhouse.io/wppmedia/jobs/5389068008': [80, 'Data Analysis', 'JD prefers 3–5 years of media analytics or agency research experience'],
  'https://progyny.wd5.myworkdayjobs.com/progyny/job/New-York-New-York/Manager--Medical-Economics---Analytics_JR101135': [68, 'Data Analysis', 'JD asks for 5–7 years plus 1–3 years of people management'],
  'https://progyny.wd5.myworkdayjobs.com/progyny/job/New-York-New-York/Senior-Analyst--Financial-Modeling---Analytics_JR101131': [72, 'Finance Data Analysis', 'Traditional FP&A depth and forward-looking financial planning are less explicit'],
  'https://progyny.wd5.myworkdayjobs.com/progyny/job/New-York-New-York/Analyst--Medical-Economics---Analytics_JR101106': [84, 'Finance Data Analysis', 'No direct healthcare pricing or medical-economics experience'],
  'https://job-boards.greenhouse.io/doordashusa/jobs/8160815': [88, 'Data Analysis', 'Direct advertising measurement and client-facing campaign analytics are limited'],
  'https://job-boards.greenhouse.io/thenewyorktimes/jobs/4725675005': [80, 'Data Analysis', 'JD asks for 5+ years and direct ad-tech measurement experience'],
  'https://job-boards.greenhouse.io/thenewyorktimes/jobs/4725227005': [94, 'Data Analysis', 'Direct newsroom/media audience-insights domain experience is limited'],
  'https://job-boards.greenhouse.io/sonyinteractiveentertainmentglobal/jobs/6142044004': [65, 'Data Analysis', 'JD requires 4+ years of IBM Planning Analytics development'],
  'https://jobs.ashbyhq.com/spade/0e0ae162-6a3a-4b36-a434-74ccceacee49': [95, 'Data Analysis', 'Payments transaction-enrichment domain is new to the resume'],
  'https://jobs.lever.co/duetti/f96cd6f2-da9b-43f5-b0c3-d7eabf1f1e9b': [84, 'Data Engineering', 'Music royalty accounting and catalog-data domain are new'],
  'https://job-boards.greenhouse.io/mammothbrands/jobs/8144676': [78, 'Data Analysis', 'Direct grocery/CPG retail analytics and manager-level scope are limited'],
  'https://hex.tech/careers/6175815004/?gh_jid=6175815004': [75, 'Analytics Engineering', 'JD asks for 8+ years despite excellent SQL/dbt full-stack data alignment'],
  'https://www.amazon.jobs/en/jobs/10524945/business-intelligence-engineer-internal-audit-data-analytics-support': [96, 'Business Intelligence Engineering', 'Internal-audit controls and compliance analytics are the main domain gap'],
}));

const forcedExclusions = new Map(Object.entries({
  'https://wexinc.wd5.myworkdayjobs.com/wexinc/job/US---Remote/Senior-Director--Semantic-Data-Platform_R22790': 'Senior Director role asks for 15+ years; outside Sunny seniority target',
  'https://jobs.ashbyhq.com/adonis/777f31b6-51b7-4c93-a3e7-7bb4feca1c20': 'Engineering Manager role asks for 8+ years and 2+ years people management',
  'https://etsy.wd5.myworkdayjobs.com/Etsy_Careers/job/Brooklyn-New-York/Senior-Director--Product-Analytics_JR5815-1': 'Senior Director product-analytics leadership is outside Sunny seniority target',
  'https://target.wd5.myworkdayjobs.com/targetcareers/job/7000-Target-Pkwy-NNCD-0375-Brooklyn-ParkMN-55445/Data-Engineer---Finance-Technology-Solutions_R0000444866': 'Assigned office is Brooklyn Park, Minnesota, not Brooklyn, New York',
  'https://target.wd5.myworkdayjobs.com/targetcareers/job/7000-Target-Pkwy-NNCD-0375-Brooklyn-ParkMN-55445/Lead-Data-Engineer---Finance-Technology--Hadoop--PySpark--Scala-Java-_R0000444860': 'Assigned office is Brooklyn Park, Minnesota, not Brooklyn, New York',
  'https://target.wd5.myworkdayjobs.com/targetcareers/job/7000-Target-Pkwy-N-Brooklyn-ParkMN-55445-4301/Sr-Engineer---Agentic-Data-Platform_R0000444911': 'Assigned office is Brooklyn Park, Minnesota, not Brooklyn, New York',
  'https://job-boards.greenhouse.io/webflow/jobs/8137782': 'Director of Analytics Engineering is outside Sunny seniority target',
  'https://stripe.com/jobs/search?gh_jid=8106026': 'GTM sales/strategy operations manager asks for 7+ years; not a data-platform role',
  'https://job-boards.greenhouse.io/sonyinteractiveentertainmentglobal/jobs/6167071004': 'Senior finance data-governance consultant asks for 8+ years',
  'https://careers.datadoghq.com/detail/8128810/?gh_jid=8128810': 'Manager role asks for 6+ years plus 2+ years managing a team',
  'https://job-boards.greenhouse.io/mammothbrands/jobs/8167118': 'Senior Manager retail analytics scope is above Sunny seniority target',
  'https://zoetis.wd5.myworkdayjobs.com/broadbean_external/job/US-Remote/Customer-Master-Data-Specialist_JR00021520-2': 'Customer-service master-data maintenance role is not analytics or data engineering',
  'https://job-boards.greenhouse.io/enigmaio/jobs/8156768': 'JD could not be retrieved for semantic verification; do not qualify from title alone',
}));

const linkedinSlugs = new Map(Object.entries({
  'Duolingo': 'duolingo',
  'Vercel': 'vercel',
  'Gusto': 'gusto',
  'Adonis': 'adonis-technology',
  'Imprint': 'imprint-payments',
  'FanDuel': 'fanduel',
  'Oscar Health': 'oscar-health',
  'Datadog, Inc.': 'datadog',
  'PermitFlow Inc.': 'permitflow',
  'Patlytics, Inc': 'patlytics',
  'Guidehouse Inc.': 'guidehouse',
  'Webflow, Inc.': 'webflow-inc-',
  'Qventus Inc.': 'qventus',
  'CompanyCam, Inc.': 'companycam',
  'Robinhood': 'robinhood',
  'Dropbox, Inc.': 'dropbox',
  'WPP Media': 'wpp-media',
  'Progyny, Inc.': 'progyny',
  'DoorDash': 'doordash',
  'The New York Times': 'the-new-york-times',
  'SONY INTERACTIVE ENTERTAINMENT': 'playstation',
  'Spade': 'spade',
  'Duetti, Inc.': 'duetti',
  'Mammoth Brands Inc.': 'mammoth-brands',
  'Hex Technologies Inc.': 'hex-technologies',
  'Amazon.com Services LLC': 'amazon',
}));

const referralTemplate = `Thank you so much for connecting with me. I really appreciate your time and support.

I’m very interested in the following position at [company name]

[Job apply link]

Would you feel comfortable referring me for this role? I’ve attached my resume for your reference. Here is my information in case it’s needed for the referral:

---

First Name: Yi-Yun
Last Name: Liao
Email: yiyunliao21@gmail.com
Phone: 929-313-3362`;

function parseTsv(path) {
  const lines = readFileSync(path, 'utf8').trimEnd().split(/\r?\n/);
  const headers = lines.shift().split('\t');
  return lines.filter(Boolean).map(line => {
    const values = line.split('\t');
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
  });
}

function stringValue(value) { return { userEnteredValue: { stringValue: String(value ?? '') } }; }
function numberValue(value) { return { userEnteredValue: { numberValue: Number(value) } }; }
function formulaValue(value) { return { userEnteredValue: { formulaValue: value } }; }
function rowData(cells) { return { values: cells }; }

function recommendation(score) {
  if (score >= 85) return '立即投遞';
  if (score >= 75) return '建議投遞';
  return '低優先';
}

function workMode(location) {
  if (/remote/i.test(location)) return /New York|NYC/i.test(location) ? 'US remote / NYC option' : 'US fully remote';
  if (/hybrid/i.test(location)) return 'NYC hybrid';
  return 'NYC Metro onsite/hybrid';
}

function qualifiedRows(history, jdRows) {
  const jdByUrl = new Map(jdRows.map(row => [row.url, row]));
  return [...evaluations.entries()]
    .map(([url, [score, category, gap]]) => {
      const historyRow = history.find(row => row.url === url);
      const jd = jdByUrl.get(url) || {};
      if (!historyRow) throw new Error(`Qualified URL missing from history: ${url}`);
      return { ...historyRow, score, category, gap, applyUrl: jd.applyUrl || url };
    })
    .sort((a, b) => b.score - a.score || a.company.localeCompare(b.company));
}

function qualifiedCells(row, index) {
  const link = row.applyUrl;
  const rec = recommendation(row.score);
  const linkedin = linkedinSlugs.get(row.company);
  const referral = referralTemplate.replace('[company name]', row.company).replace('[Job apply link]', link);
  return [
    numberValue(index + 1),
    numberValue(row.score),
    formulaValue(`=HYPERLINK("${link.replaceAll('"', '""')}","${rec}")`),
    stringValue(row.company),
    stringValue(row.title),
    stringValue(row.category),
    stringValue(row.location),
    stringValue(workMode(row.location)),
    stringValue(row.posted_at),
    stringValue(row.gap),
    stringValue(resumeForRole(row.category, row.title)),
    stringValue(link),
    linkedin ? formulaValue(`=HYPERLINK("https://www.linkedin.com/company/${linkedin}/people/","找內推人")`) : stringValue(''),
    stringValue(referral),
  ];
}

function resumeForRole(category, title) {
  if (/Engineering/i.test(category || '') || /\b(engineer|architect)\b/i.test(title || '')) return 'Data Engineer';
  return 'Data Analyst';
}

function exclusionReason(row) {
  if (forcedExclusions.has(row.url)) return forcedExclusions.get(row.url);
  if (!row.posted_at) return 'ATS 未提供可驗證發布日期；依 Sunny 20 天規則排除';
  const usRemote = /(US Remote|U\.S\. Remote|USA Remote|Remote USA|Remote - USA|Remote, USA|Remote, United States|Remote- United States|Remote \(U\.S\.\)|United States - Remote|US - Remote|Remote Nationwide)/i;
  const metro = /New York|NYC|Manhattan|Brooklyn(?! Park)|Queens|Bronx|Staten Island|Long Island City|Jersey City|Newark|Hoboken|Secaucus|Weehawken|Fort Lee|Yonkers|White Plains|Stamford/i;
  if (!usRemote.test(row.location) && !metro.test(row.location)) return '非 NYC Metro onsite/hybrid，亦非可驗證的 US fully remote';
  return 'Title/JD 語意不屬於 Sunny 的 Data Engineering／Analytics／BI 或 Data/Finance Analysis 目標職類';
}

function classification(history, qualified) {
  const qualifiedUrls = new Set(qualified.map(row => row.url));
  return history.map(row => qualifiedUrls.has(row.url)
    ? { ...row, qualityResult: 'Qualified', note: 'Scored in Backfill 2026-09-01' }
    : { ...row, qualityResult: 'Excluded', note: exclusionReason(row) });
}

function requestForRows(sheetId, startRowIndex, rows) {
  return {
    updateCells: {
      start: { sheetId, rowIndex: startRowIndex, columnIndex: 0 },
      rows,
      fields: 'userEnteredValue',
    },
  };
}

function chunk(array, offset, limit) { return array.slice(offset, offset + limit); }

function main() {
  const section = process.argv[2];
  const offset = Number(process.argv[3] || 0);
  const limit = Number(process.argv[4] || 100);
  const ids = JSON.parse(process.argv[5] || '{}');
  const history = parseTsv('data/sunny-scan-history.tsv').slice(HISTORY_START_INDEX);
  const jdRows = JSON.parse(readFileSync('outputs/sunny-backfill-jds-2026-09-01.json', 'utf8'));
  const secondPassJds = JSON.parse(readFileSync('outputs/sunny-backfill-second-pass-jds-2026-09-01.json', 'utf8'));
  jdRows.push(...secondPassJds);
  const qualified = qualifiedRows(history, jdRows);
  const classified = classification(history, qualified);
  const excluded = classified.filter(row => row.qualityResult === 'Excluded');

  let requests = [];
  if (section === 'qualified') {
    const rows = qualified.map((row, index) => rowData(qualifiedCells(row, index)));
    requests = [
      requestForRows(ids.backfill, SHEET_ROWS.backfill, rows),
      requestForRows(ids.master, SHEET_ROWS.master, rows),
      { copyPaste: {
        source: { sheetId: ids.master, startRowIndex: 4, endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 14 },
        destination: { sheetId: ids.master, startRowIndex: SHEET_ROWS.master, endRowIndex: SHEET_ROWS.master + rows.length, startColumnIndex: 0, endColumnIndex: 14 },
        pasteType: 'PASTE_FORMAT',
        pasteOrientation: 'NORMAL',
      } },
      requestForRows(ids.master, SHEET_ROWS.master, rows),
    ];
  } else if (section === 'seen') {
    const rows = chunk(classified, offset, limit).map(row => rowData([
      stringValue(row.first_seen), stringValue(row.company), stringValue(row.title), stringValue(row.posted_at),
      stringValue(row.qualityResult), stringValue(row.fingerprint), stringValue(row.url), stringValue(row.note),
    ]));
    if (rows.length) requests = [requestForRows(ids.seen, SHEET_ROWS.seen + offset, rows)];
  } else if (section === 'excluded') {
    const rows = chunk(excluded, offset, limit).map(row => rowData([
      stringValue(row.company), stringValue(row.title), stringValue(row.location), stringValue(row.posted_at),
      stringValue(row.note), stringValue(row.url), stringValue(row.fingerprint),
    ]));
    if (rows.length) requests = [requestForRows(ids.excluded, SHEET_ROWS.excluded + offset, rows)];
  } else if (section === 'summary') {
    requests = [
      { updateCells: {
        range: { sheetId: ids.summary, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 3 },
        rows: [rowData([stringValue('20 天 high-recall backfill 完成 2026-09-01')])], fields: 'userEnteredValue',
      } },
      { updateCells: {
        start: { sheetId: ids.summary, rowIndex: 4, columnIndex: 1 },
        rows: [
          rowData([numberValue(1316), stringValue('Enabled, live-verified H-1B ATS/company entries')]),
          rowData([numberValue(2), stringValue('Configured broad job boards')]),
          rowData([numberValue(132083), stringValue('Before deterministic filters')]),
          rowData([numberValue(123836), stringValue('Broad title filter removals')]),
          rowData([numberValue(6427), stringValue('Outside NYC Metro onsite/hybrid or US remote')]),
          rowData([numberValue(851), stringValue('Outside 20-day window or unverifiable')]),
          rowData([numberValue(158), stringValue('Deduped by scanner')]),
          rowData([numberValue(810), stringValue('New history rows from this backfill')]),
          rowData([numberValue(0), stringValue('All 810 were first-seen in repo history')]),
          rowData([numberValue(810), stringValue('Written to Seen Jobs')]),
          rowData([numberValue(qualified.length), stringValue('Scored in Backfill 2026-09-01 and appended to Master')]),
          rowData([numberValue(excluded.length), stringValue('Written to Excluded')]),
          rowData([numberValue(16), stringValue('Authoritative data/scan-runs.tsv errors value')]),
          rowData([numberValue(7), stringValue("Lowe's, Wells Fargo, Corewell Health, Dick's Sporting Goods, Circle K, Trinity Health, Adventist Health")]),
          rowData([stringValue('Daily 12:00 ET'), stringValue('Recurring scan now uses a 3-day overlap plus dedup')]),
        ],
        fields: 'userEnteredValue',
      } },
      { updateCells: {
        start: { sheetId: ids.summary, rowIndex: 19, columnIndex: 0 },
        rows: [rowData([stringValue('Office enrichment warnings'), numberValue(1), stringValue('Thrive Market Greenhouse office enrichment timed out; main board remained usable')])],
        fields: 'userEnteredValue',
      } },
    ];
  } else if (section === 'reconcile') {
    const originalQualified = new Set([
      'https://careers.duolingo.com/jobs/8759720002?gh_jid=8759720002',
      'https://job-boards.greenhouse.io/vercel/jobs/5895013004',
      'https://job-boards.greenhouse.io/gusto/jobs/8119978',
      'https://jobs.ashbyhq.com/adonis/4a9f7dfd-52aa-486c-b2d9-1d481ce2d0f8',
      'https://jobs.ashbyhq.com/imprint/25409da3-c86f-4824-a292-bbd20a0f2f11',
      'https://www.fanduel.careers/open-positions?gh_jid=8070473',
      'http://www.hioscar.com/careers/8146196?gh_jid=8146196',
      'https://careers.datadoghq.com/detail/8141967/?gh_jid=8141967',
      'https://jobs.ashbyhq.com/permitflow/4b6778b7-c5c8-412f-b6eb-7e60c6243434',
      'https://jobs.ashbyhq.com/doctronic/27a0e05a-c336-4daf-92bf-0e7961c4f2ae',
      'https://jobs.ashbyhq.com/patlytics/f5d00d27-e018-4581-a227-67d93c1a727c',
      'https://jobs.ashbyhq.com/sailorhealth/55702dde-a7c4-458c-96aa-487c0f4b3561',
      'https://guidehouse.wd1.myworkdayjobs.com/external/job/US---Remote-Any-location/AWS-Lakehouse-Data-Engineer_43865',
      'https://guidehouse.wd1.myworkdayjobs.com/external/job/US---Remote-Any-location/Data-Platform-Lead_41871',
      'https://guidehouse.wd1.myworkdayjobs.com/external/job/US---Remote-Any-location/Data-Infrastructure-Engineer_43344',
      'https://guidehouse.wd1.myworkdayjobs.com/external/job/US---Remote-Any-location/Databricks-Data-Engineer_42292-1',
      'https://job-boards.greenhouse.io/webflow/jobs/8165290',
      'https://www.qventus.com/company/working-qventus/job?gh_jid=4381957009',
      'https://www.qventus.com/company/working-qventus/job?gh_jid=4378754009',
      'https://companycam.com/job?gh_jid=7915940003',
    ]);
    const promoted = qualified.filter(row => !originalQualified.has(row.url));
    const oldExcluded = history.filter(row => !originalQualified.has(row.url));
    for (const row of promoted) {
      const historyIndex = history.findIndex(item => item.url === row.url);
      const excludedIndex = oldExcluded.findIndex(item => item.url === row.url);
      requests.push({ updateCells: {
        start: { sheetId: ids.seen, rowIndex: SHEET_ROWS.seen + historyIndex, columnIndex: 4 },
        rows: [rowData([stringValue('Qualified'), stringValue(row.fingerprint), stringValue(row.url), stringValue('Scored in Backfill 2026-09-01 after broader JD review')])],
        fields: 'userEnteredValue',
      } });
      requests.push({ updateCells: {
        range: { sheetId: ids.excluded, startRowIndex: SHEET_ROWS.excluded + excludedIndex, endRowIndex: SHEET_ROWS.excluded + excludedIndex + 1, startColumnIndex: 0, endColumnIndex: 7 },
        rows: [rowData(Array.from({ length: 7 }, () => stringValue('')))],
        fields: 'userEnteredValue',
      } });
    }
    requests.push({ updateCells: {
      range: { sheetId: ids.backfill, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 14 },
      rows: [
        rowData([stringValue('Sunny Job Backfill — 2026-09-01')]),
        rowData([stringValue('20 天 high-recall baseline；1316 個 H-1B ATS，依 JD 語意評分並以 dedup 只保留首次發現。')]),
      ],
      fields: 'userEnteredValue',
    } });
  } else if (section === 'counts') {
    console.log(JSON.stringify({ history: history.length, qualified: qualified.length, excluded: excluded.length }));
    return;
  } else {
    throw new Error(`Unknown section: ${section}`);
  }

  console.log(JSON.stringify({ requests, counts: { history: history.length, qualified: qualified.length, excluded: excluded.length } }));
}

main();
