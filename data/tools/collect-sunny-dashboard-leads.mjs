#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as yaml from 'js-yaml';

import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { parseHimalayasResponse } from '../../providers/himalayas.mjs';
import { parseJobicyResponse } from '../../providers/jobicy.mjs';
import {
  directAtsCandidateFromLeadUrl,
  joinLeadToDol,
  loadDolEvidence,
} from './sunny-company-expansion.mjs';

const FREEHIRE_API = 'https://freehire.me/api/v1/jobs/search';
const FREEHIRE_COMPANIES_API = 'https://freehire.me/api/v1/companies';
const HIMALAYAS_API = 'https://himalayas.app/jobs/api/search';
const JOBICY_API = 'https://jobicy.com/api/v2/remote-jobs';
const OPENJOBS_DATA = 'https://raw.githubusercontent.com/Outscal/OpenJobs/main/data/companies_v2.json';
const PAYLOCITY_DATA = 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/paylocity_companies_clean.json';
const BAMBOOHR_DATA = 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/bamboohr_companies.json';
const THEMUSE_API = 'https://www.themuse.com/api/public/jobs';
const JOBRIGHT_BASE = 'https://jobright.ai';
const JOBRIGHT_LIST_API = `${JOBRIGHT_BASE}/swan/mini-sites/list`;

export const NEWGRAD_JOBS_CATEGORIES = ['data_analysis', 'data_engineer'];

export const SUNNY_FREEHIRE_CATEGORIES = [
  'data_engineering',
  'data_analytics',
  'business_analysis',
  'finance',
  'operations',
];

export const SUNNY_HIMALAYAS_QUERIES = [
  'data',
  'analyst',
  'analytics',
  'business intelligence',
  'etl',
  'sql',
];

// freehire also indexes republishers. Only rows declared as first-party ATS
// sources may cross this discovery boundary. DOL and ATS-owner validation are
// still required later; this allowlist is not an admission decision.
export const FREEHIRE_DIRECT_SOURCES = new Set([
  'ashby', 'ashbygraphql', 'avature', 'bamboohr', 'breezy', 'comeet',
  'cornerstone', 'eightfold', 'gem', 'getro', 'greenhouse', 'icims', 'jibe',
  'jobvite', 'lever', 'oracle', 'paylocity', 'personio', 'phenom', 'pinpoint',
  'recruitee', 'rippling', 'smartrecruiters', 'successfactors', 'teamtailor',
  'ukg', 'workable', 'workday', 'zohorecruit',
]);

function clean(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function iso(value) {
  if (value === null || value === undefined || value === '') return '';
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function safeHttpsUrl(value, hosts) {
  try {
    const url = new URL(clean(value));
    return url.protocol === 'https:' && hosts.some(host => (
      url.hostname === host || url.hostname.endsWith(`.${host}`)
    )) ? url.href : '';
  } catch {
    return '';
  }
}

async function defaultRequestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    headers: {
      accept: 'application/json',
      'user-agent': 'career-ops-sunny-company-discovery/1.0',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${new URL(url).hostname}: HTTP ${response.status}`);
  return response.json();
}

async function defaultRequestText(url) {
  const response = await fetch(url, {
    redirect: 'error',
    headers: { accept: 'text/html', 'user-agent': 'career-ops-sunny-company-discovery/1.0' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${new URL(url).hostname}: HTTP ${response.status}`);
  return response.text();
}

function dedupe(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const company = clean(row?.company);
    const title = clean(row?.title);
    const url = clean(row?.url);
    if (!company || !title || !url || seen.has(url)) continue;
    seen.add(url);
    out.push({ ...row, company, title, url });
  }
  return out;
}

export function freehireSearchUrl({
  scope, offset = 0, limit = 100, mode = 'incremental', purpose = 'jobs',
} = {}) {
  if (!['nyc', 'remote'].includes(scope)) throw new Error('scope must be nyc or remote');
  if (!['backfill', 'incremental'].includes(mode)) throw new Error('mode must be backfill or incremental');
  if (!['jobs', 'companies'].includes(purpose)) throw new Error('purpose must be jobs or companies');
  const url = new URL(FREEHIRE_API);
  url.searchParams.set('collections', 'us-h1b-sponsor');
  if (purpose === 'jobs') url.searchParams.set('category', SUNNY_FREEHIRE_CATEGORIES.join(','));
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('sort', 'posted_at');
  url.searchParams.set('order', 'desc');
  if (mode === 'incremental') url.searchParams.set('open_within_days', '3');
  if (scope === 'nyc') {
    url.searchParams.set('cities', 'New York City,Jersey City,Newark');
  } else {
    url.searchParams.set('countries', 'US');
    url.searchParams.set('work_mode', 'remote');
  }
  return url.href;
}

function freehireDirectUrl(row, source) {
  const direct = safeHttpsUrl(row?.url, [
    'greenhouse.io', 'ashbyhq.com', 'lever.co', 'myworkdayjobs.com', 'icims.com',
    'smartrecruiters.com', 'workable.com', 'bamboohr.com', 'paylocity.com',
    'oraclecloud.com', 'eightfold.ai', 'gem.com', 'jobvite.com', 'rippling.com',
    'recruitee.com', 'personio.com', 'teamtailor.com', 'pinpointhq.com',
    'successfactors.com', 'phenompeople.com', 'dayforcehcm.com',
  ]);
  if (direct) return direct;

  // Some boards publish through an official wrapper URL. freehire retains the
  // provider's exact board:job coordinates; the downstream owner API still
  // has to verify the board before it can enter portals.yml.
  const coordinate = clean(row?.external_id).match(/^([A-Za-z0-9._-]+):([A-Za-z0-9-]+)$/);
  if (!coordinate) return '';
  const [, board, job] = coordinate;
  if (source === 'greenhouse') return `https://job-boards.greenhouse.io/${board}/jobs/${job}`;
  if (source === 'ashby' || source === 'ashbygraphql') return `https://jobs.ashbyhq.com/${board}/${job}`;
  if (source === 'lever') return `https://jobs.lever.co/${board}/${job}`;
  return '';
}

function normalizeFreehireRow(row) {
  const source = clean(row?.source).toLowerCase();
  if (!FREEHIRE_DIRECT_SOURCES.has(source)) return null;
  const url = freehireDirectUrl(row, source);
  if (!url) return null;
  return {
    company: clean(row?.company),
    title: clean(row?.title),
    location: clean(row?.location),
    posted_at: iso(row?.posted_at),
    url,
    ats_source: source,
    source_job_id: clean(row?.external_id ?? row?.public_slug),
  };
}

export async function collectFreehireLeads({
  scope,
  mode = 'incremental',
  purpose = 'jobs',
  pageSize = 100,
  maxPages = mode === 'backfill' ? 100 : 5,
  requestJson = defaultRequestJson,
} = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('pageSize must be 1..100');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('maxPages must be 1..100');
  const rows = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const payload = await requestJson(freehireSearchUrl({ scope, offset, limit: pageSize, mode, purpose }));
    if (!payload || !Array.isArray(payload.data)) throw new Error('freehire: expected a data array');
    const ignored = payload.meta?.ignored_params;
    if (Array.isArray(ignored) && ignored.length) throw new Error(`freehire ignored filters: ${ignored.join(', ')}`);
    rows.push(...payload.data.map(normalizeFreehireRow).filter(Boolean));
    const returned = payload.data.length;
    const total = Number(payload.meta?.total ?? returned);
    offset += returned;
    if (!returned || offset >= total) break;
  }
  return dedupe(rows);
}

export async function collectFreehireCompanyDirectoryLeads({
  requestJson = defaultRequestJson,
  companyEligible = () => true,
  concurrency = 10,
} = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) {
    throw new Error('concurrency must be an integer from 1 to 20');
  }
  const companies = [];
  let offset = 0;
  while (true) {
    const url = new URL(FREEHIRE_COMPANIES_API);
    url.searchParams.set('collections', 'us-h1b-sponsor');
    url.searchParams.set('limit', '100');
    url.searchParams.set('offset', String(offset));
    const payload = await requestJson(url.href);
    if (!payload || !Array.isArray(payload.data)) throw new Error('freehire companies: expected a data array');
    companies.push(...payload.data.filter(company => clean(company?.slug) && clean(company?.name)
      && Number(company?.job_count) > 0 && companyEligible(company)));
    offset += payload.data.length;
    if (!payload.data.length || offset >= Number(payload.meta?.total ?? offset)) break;
  }

  const output = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, companies.length || 1) }, async () => {
    while (cursor < companies.length) {
      const company = companies[cursor++];
      const slug = encodeURIComponent(clean(company.slug));
      try {
        const payload = await requestJson(`${FREEHIRE_COMPANIES_API}/${slug}`);
        for (const job of payload?.data?.jobs || []) {
          const normalized = normalizeFreehireRow({ ...job, company: clean(company.name) });
          if (normalized) output.push(normalized);
        }
      } catch {
        // A single company detail failure cannot turn the whole directory into zero results.
      }
    }
  }));

  const seen = new Set();
  return output.filter(row => {
    const key = `${row.company.toLowerCase()}\t${row.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function collectJobicyLeads({ scope, requestJson = defaultRequestJson } = {}) {
  if (scope !== 'remote') throw new Error('Jobicy is a remote-only source');
  const url = new URL(JOBICY_API);
  url.searchParams.set('count', '200');
  url.searchParams.set('geo', 'usa');
  url.searchParams.set('tag', 'data');
  const payload = await requestJson(url.href);
  if (!payload || !Array.isArray(payload.jobs)) throw new Error('jobicy: expected a jobs array');
  return dedupe(parseJobicyResponse(payload).map(row => ({
    ...row,
    posted_at: iso(row.postedAt),
    ats_source: 'jobicy',
  })));
}

export async function collectHimalayasLeads({
  scope,
  mode = 'incremental',
  queries = SUNNY_HIMALAYAS_QUERIES,
  maxPagesPerQuery = mode === 'backfill' ? 5 : 1,
  requestJson = defaultRequestJson,
} = {}) {
  if (scope !== 'remote') throw new Error('Himalayas is a remote-only source');
  if (!['backfill', 'incremental'].includes(mode)) throw new Error('mode must be backfill or incremental');
  if (!Number.isInteger(maxPagesPerQuery) || maxPagesPerQuery < 1 || maxPagesPerQuery > 25) {
    throw new Error('maxPagesPerQuery must be 1..25');
  }
  const rows = [];
  for (const query of queries) {
    for (let page = 1; page <= maxPagesPerQuery; page += 1) {
      const url = new URL(HIMALAYAS_API);
      url.searchParams.set('q', query);
      url.searchParams.set('country', 'US');
      url.searchParams.set('sort', 'recent');
      url.searchParams.set('page', String(page));
      const payload = await requestJson(url.href);
      if (!payload || !Array.isArray(payload.jobs)) throw new Error('himalayas: expected a jobs array');
      rows.push(...parseHimalayasResponse(payload).map(row => ({
        ...row,
        posted_at: iso(row.postedAt),
        ats_source: 'himalayas',
      })));
      const limit = Number(payload.limit || 20);
      const total = Number(payload.totalCount ?? payload.jobs.length);
      if (!payload.jobs.length || page * limit >= total) break;
    }
  }
  return dedupe(rows);
}

export async function collectOpenJobsLeads({ scope, requestJson = defaultRequestJson } = {}) {
  if (scope !== 'remote') throw new Error('OpenJobs is a company-directory source and uses the national/remote scope');
  const payload = await requestJson(OPENJOBS_DATA);
  if (!Array.isArray(payload)) throw new Error('OpenJobs: expected a company array');
  const rows = [];
  const seen = new Set();
  for (const company of payload) {
    const name = clean(company?.name);
    if (!name) continue;
    for (const raw of [...(company?.ats_links || []), ...(company?.list_urls || [])]) {
      const url = clean(raw);
      if (!directAtsCandidateFromLeadUrl(url)) continue;
      const key = `${name.toLowerCase()}\t${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        company: name,
        title: 'OpenJobs ATS directory entry',
        location: Array.isArray(company?.countries) ? company.countries.map(clean).filter(Boolean).join(', ') : '',
        posted_at: '',
        url,
        ats_source: 'openjobs',
      });
    }
  }
  return rows;
}

export function parseNewgradJobsPage(html, expectedCategory) {
  const match = String(html || '').match(
    /<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!match) throw new Error('newgrad-jobs: __NEXT_DATA__ payload missing');
  let payload;
  try { payload = JSON.parse(match[1]); }
  catch { throw new Error('newgrad-jobs: malformed __NEXT_DATA__ payload'); }
  const page = payload?.props?.pageProps;
  if (!page || !Array.isArray(page.initialJobs)) throw new Error('newgrad-jobs: initialJobs array missing');
  if (page?.pathInfo?.type !== 'newgrad' || page?.pathInfo?.country !== 'us'
    || page?.pathInfo?.category !== expectedCategory || page?.pathInfo?.isValidPath !== true) {
    throw new Error(`newgrad-jobs: unexpected category payload for ${expectedCategory}`);
  }
  const total = Number(page.initialTotal);
  return { jobs: page.initialJobs, total: Number.isFinite(total) && total >= 0 ? total : page.initialJobs.length };
}

function normalizeNewgradJob(raw) {
  const nested = raw?.properties && typeof raw.properties === 'object';
  const source = nested ? raw.properties : raw;
  const id = clean(raw?.jobId ?? raw?.id);
  if (!/^[a-z0-9_-]+$/i.test(id)) return null;
  const company = clean(source?.company);
  const title = clean(source?.title);
  if (!company || !title || /^no$/i.test(clean(source?.h1bSponsored))) return null;
  return {
    company,
    title,
    location: clean(source?.location),
    posted_at: iso(nested ? raw?.postedAt : raw?.postedDate),
    url: `${JOBRIGHT_BASE}/jobs/info/${encodeURIComponent(id)}`,
    ats_source: 'newgradjobs',
    source_job_id: id,
    work_model: clean(source?.workModel),
    h1b_status: clean(source?.h1bSponsored),
    company_size: clean(source?.companySize),
  };
}

function newgradJobInScope(row, scope) {
  if (scope === 'remote') return /^remote$/i.test(row.work_model);
  return /(?:new york|jersey city|newark|hoboken|white plains|stamford|long island)/i.test(row.location);
}

/**
 * newgrad-jobs embeds JobRight's public U.S. data pages. These records are
 * company leads only; downstream DOL and first-party ATS-owner checks remain
 * the admission gate for portals.yml.
 */
export async function collectNewgradJobsLeads({
  scope,
  mode = 'incremental',
  categories = NEWGRAD_JOBS_CATEGORIES,
  pageSize = 50,
  maxPagesPerCategory = mode === 'backfill' ? 100 : 1,
  requestText = defaultRequestText,
  requestJson = defaultRequestJson,
} = {}) {
  if (!['nyc', 'remote'].includes(scope)) throw new Error('scope must be nyc or remote');
  if (!['backfill', 'incremental'].includes(mode)) throw new Error('mode must be backfill or incremental');
  if (!Array.isArray(categories) || !categories.length
    || categories.some(category => !NEWGRAD_JOBS_CATEGORIES.includes(category))) {
    throw new Error('newgrad-jobs categories must be data_analysis or data_engineer');
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new Error('pageSize must be 1..50');
  if (!Number.isInteger(maxPagesPerCategory) || maxPagesPerCategory < 1 || maxPagesPerCategory > 100) {
    throw new Error('maxPagesPerCategory must be 1..100');
  }

  const rows = [];
  for (const category of categories) {
    const pageUrl = `${JOBRIGHT_BASE}/minisites-jobs/newgrad/us/${category}?embed=true`;
    const first = parseNewgradJobsPage(await requestText(pageUrl), category);
    rows.push(...first.jobs.map(normalizeNewgradJob).filter(Boolean));
    let position = first.jobs.length;
    for (let page = 1; page < maxPagesPerCategory && position < first.total; page += 1) {
      const url = new URL(JOBRIGHT_LIST_API);
      url.searchParams.set('position', String(position));
      url.searchParams.set('count', String(pageSize));
      const payload = await requestJson(url.href, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ category: `newgrad:us:${category}` }),
      });
      if (payload?.success !== true || !Array.isArray(payload?.result?.jobList)) {
        throw new Error(`newgrad-jobs: malformed list response for ${category}`);
      }
      const batch = payload.result.jobList;
      rows.push(...batch.map(normalizeNewgradJob).filter(Boolean));
      if (!batch.length) break;
      position += batch.length;
      const total = Number(payload.result.total);
      if (Number.isFinite(total) && total >= 0 && position >= total) break;
    }
  }
  return dedupe(rows.filter(row => newgradJobInScope(row, scope)));
}

export async function collectTheMuseLeads({
  scope,
  maxPages = 100,
  requestJson = defaultRequestJson,
} = {}) {
  if (!['nyc', 'remote'].includes(scope)) throw new Error('scope must be nyc or remote');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('maxPages must be 1..100');
  const rows = [];
  let pageCount = 1;
  for (let page = 0; page < Math.min(pageCount, maxPages); page += 1) {
    const url = new URL(THEMUSE_API);
    url.searchParams.set('page', String(page));
    const payload = await requestJson(url.href);
    if (!payload || !Array.isArray(payload.results)) throw new Error(`The Muse: expected results array on page ${page}`);
    if (page === 0) pageCount = Math.max(1, Number(payload.page_count) || 1);
    for (const job of payload.results) {
      const company = clean(job?.company?.name);
      const title = clean(job?.name);
      const target = clean(job?.refs?.landing_page);
      const locations = (Array.isArray(job?.locations) ? job.locations : [])
        .map(item => clean(item?.name)).filter(Boolean);
      const location = locations.join(', ');
      const inScope = scope === 'nyc'
        ? /(?:new york|jersey city|newark|hoboken|white plains|stamford|long island)/i.test(location)
        : /(?:remote|anywhere|flexible)/i.test(location);
      if (!company || !title || !inScope || !safeHttpsUrl(target, ['www.themuse.com'])) continue;
      rows.push({
        company,
        title,
        location,
        posted_at: iso(job?.publication_date),
        url: target,
        ats_source: 'themuse',
      });
    }
  }
  return dedupe(rows);
}

export async function collectPaylocityLeads({ scope, requestJson = defaultRequestJson } = {}) {
  if (scope !== 'remote') throw new Error('Paylocity directory uses the national/remote scope');
  const payload = await requestJson(PAYLOCITY_DATA);
  if (!Array.isArray(payload)) throw new Error('Paylocity directory: expected a company array');
  return payload.filter(row => Number(row?.jobs) > 0
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean(row?.guid))
    && clean(row?.name)).map(row => ({
    company: clean(row.name),
    title: 'Paylocity ATS directory entry',
    location: '',
    posted_at: '',
    url: `https://recruiting.paylocity.com/recruiting/jobs/All/${clean(row.guid).toLowerCase()}/`,
    ats_source: 'paylocity',
  }));
}

export async function collectBambooHRLeads({ scope, requestJson = defaultRequestJson } = {}) {
  if (scope !== 'remote') throw new Error('BambooHR directory uses the national/remote scope');
  const payload = await requestJson(BAMBOOHR_DATA);
  if (!Array.isArray(payload)) throw new Error('BambooHR directory: expected a tenant array');
  return [...new Set(payload.map(clean).filter(tenant => /^[a-z0-9][a-z0-9-]*$/i.test(tenant)))]
    .map(tenant => ({
      company: tenant,
      title: 'BambooHR ATS directory entry',
      location: '',
      posted_at: '',
      url: `https://${tenant.toLowerCase()}.bamboohr.com/careers`,
      ats_source: 'bamboohr',
    }));
}

function parseArgs(argv) {
  const args = { source: '', scope: '', mode: 'incremental', purpose: 'jobs', output: '', maxPages: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--source') args.source = argv[++index];
    else if (token === '--scope') args.scope = argv[++index];
    else if (token === '--mode') args.mode = argv[++index];
    else if (token === '--purpose') args.purpose = argv[++index];
    else if (token === '--output') args.output = resolve(argv[++index]);
    else if (token === '--max-pages') args.maxPages = Number(argv[++index]);
    else if (token === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (args.help) return args;
  if (!['freehire', 'himalayas', 'jobicy', 'openjobs', 'paylocity', 'bamboohr', 'themuse', 'newgradjobs'].includes(args.source)) throw new Error('--source must be freehire, himalayas, jobicy, openjobs, paylocity, bamboohr, themuse, or newgradjobs');
  if (!['nyc', 'remote'].includes(args.scope)) throw new Error('--scope must be nyc or remote');
  if (!['backfill', 'incremental'].includes(args.mode)) throw new Error('--mode must be backfill or incremental');
  if (!['jobs', 'companies', 'universe'].includes(args.purpose)) throw new Error('--purpose must be jobs, companies, or universe');
  if (args.source !== 'freehire' && args.purpose !== 'jobs') throw new Error('--purpose companies is only supported by freehire');
  if (!['freehire', 'themuse', 'newgradjobs'].includes(args.source) && args.scope !== 'remote') throw new Error(`${args.source} is remote-only`);
  if (args.maxPages !== undefined && (!Number.isInteger(args.maxPages) || args.maxPages < 1 || args.maxPages > 100)) {
    throw new Error('--max-pages must be an integer from 1 to 100');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node data/tools/collect-sunny-dashboard-leads.mjs --source <freehire|himalayas|jobicy|openjobs|paylocity|bamboohr|themuse|newgradjobs> --scope <nyc|remote> --mode <backfill|incremental> [--purpose <jobs|companies|universe>] [--max-pages N] [--output JSON]');
    return;
  }
  const now = new Date();
  let jobs;
  if (args.source === 'freehire') {
    if (args.purpose === 'universe') {
      const dataRoot = getCareerOpsRoot();
      const config = yaml.load(readFileSync(resolve(dataRoot, 'profiles/sunny-company-discovery.yml'), 'utf8')) || {};
      const employers = loadDolEvidence(config, dataRoot);
      jobs = await collectFreehireCompanyDirectoryLeads({
        companyEligible: company => joinLeadToDol({ source_company: company.name }, employers).status === 'dol_accepted',
      });
    } else {
      jobs = await collectFreehireLeads({
        scope: args.scope,
        mode: args.mode,
        purpose: args.purpose,
        ...(args.maxPages === undefined ? {} : { maxPages: args.maxPages }),
      });
    }
  } else if (args.source === 'himalayas') {
    jobs = await collectHimalayasLeads({
      scope: args.scope,
      mode: args.mode,
      ...(args.maxPages === undefined ? {} : { maxPagesPerQuery: args.maxPages }),
    });
  } else if (args.source === 'jobicy') {
    jobs = await collectJobicyLeads({ scope: args.scope });
  } else if (args.source === 'openjobs') {
    jobs = await collectOpenJobsLeads({ scope: args.scope });
  } else if (args.source === 'themuse') {
    jobs = await collectTheMuseLeads({
      scope: args.scope,
      ...(args.maxPages === undefined ? {} : { maxPages: args.maxPages }),
    });
  } else if (args.source === 'paylocity') {
    jobs = await collectPaylocityLeads({ scope: args.scope });
  } else if (args.source === 'newgradjobs') {
    jobs = await collectNewgradJobsLeads({
      scope: args.scope,
      mode: args.mode,
      ...(args.maxPages === undefined ? {} : { maxPagesPerCategory: args.maxPages }),
    });
  } else {
    jobs = await collectBambooHRLeads({ scope: args.scope });
  }
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const output = args.output || resolve(
    getCareerOpsRoot(),
    `data/company-discovery/inbox/${args.source}-${args.scope}-${args.mode}-${timestamp}.json`,
  );
  mkdirSync(dirname(output), { recursive: true });
  const payload = {
    schema_version: 1,
    run_id: `${args.source}-${args.scope}-${args.mode}-${timestamp}`,
    source: args.source,
    scope: args.scope,
    mode: args.mode,
    collected_at: now.toISOString(),
    date_capability: args.source === 'freehire' && args.mode === 'incremental'
      ? 'first observed by source within 3 days; ATS date remains authoritative for job qualification'
      : 'source dates retained as company-lead evidence; ATS date remains authoritative for job qualification',
    jobs,
  };
  writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ source: args.source, scope: args.scope, mode: args.mode, leads: jobs.length, output }, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
