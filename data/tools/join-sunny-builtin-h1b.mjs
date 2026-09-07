#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as yaml from 'js-yaml';
import { normalizeCompanyIdentity } from './build-sunny-h1b-ats-universe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

function clean(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

function parseTsv(path) {
  const lines = readFileSync(path, 'utf8').trimEnd().split(/\r?\n/);
  if (!lines[0]) return [];
  const columns = lines[0].split('\t');
  return lines.slice(1).filter(Boolean).map(line => {
    const values = line.split('\t');
    return Object.fromEntries(columns.map((column, index) => [column, values[index] ?? '']));
  });
}

function employerNames(row) {
  return [row?.EMPLOYER_NAME ?? row?.employer_name, row?.DBA ?? row?.dba]
    .map(clean)
    .filter(Boolean);
}

function employerKey(row) {
  return clean(row?.EMPLOYER_NAME ?? row?.employer_name);
}

function reviewHasEvidence(review) {
  try {
    const url = new URL(clean(review?.careers_url ?? review?.url));
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function aggregateLeads(leads) {
  const groups = new Map();
  for (const lead of leads || []) {
    const company = clean(lead?.company);
    const url = clean(lead?.url);
    if (!company || !url) continue;
    const key = normalizeCompanyIdentity(company);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { company, urls: new Set() });
    groups.get(key).urls.add(url);
  }
  return [...groups.values()].map(group => ({ ...group, urls: [...group.urls].sort() }));
}

export function joinBuiltinCompanies({ leads = [], employers = [], reviews = [] } = {}) {
  const identities = new Map();
  for (const employer of employers) {
    for (const name of employerNames(employer)) {
      const identity = normalizeCompanyIdentity(name);
      if (!identity) continue;
      if (!identities.has(identity)) identities.set(identity, new Map());
      identities.get(identity).set(employerKey(employer), employer);
    }
  }

  const accepted = [];
  const needsReview = [];
  for (const lead of aggregateLeads(leads)) {
    const leadIdentity = normalizeCompanyIdentity(lead.company);
    const exact = [...(identities.get(leadIdentity)?.values() || [])];
    if (exact.length === 1) {
      const employer = exact[0];
      accepted.push({
        company: lead.company,
        employer_name: employerKey(employer),
        dba: clean(employer?.DBA ?? employer?.dba),
        transfer_positions: Number(employer?.transfer_positions || 0),
        match_type: 'exact',
        source_urls: lead.urls,
      });
      continue;
    }
    if (exact.length > 1) {
      needsReview.push({ company: lead.company, reason: 'ambiguous normalized DOL identity', source_urls: lead.urls });
      continue;
    }

    const reviewed = (reviews || []).filter(review =>
      review?.verdict === 'accept'
      && normalizeCompanyIdentity(review?.source_company) === leadIdentity
      && reviewHasEvidence(review));
    const reviewedEmployers = new Map();
    for (const review of reviewed) {
      const reviewIdentity = normalizeCompanyIdentity(review?.identity ?? review?.company);
      for (const employer of identities.get(reviewIdentity)?.values() || []) {
        reviewedEmployers.set(employerKey(employer), employer);
      }
    }
    if (reviewedEmployers.size === 1) {
      const employer = [...reviewedEmployers.values()][0];
      accepted.push({
        company: lead.company,
        employer_name: employerKey(employer),
        dba: clean(employer?.DBA ?? employer?.dba),
        transfer_positions: Number(employer?.transfer_positions || 0),
        match_type: 'reviewed_alias',
        source_urls: lead.urls,
      });
    } else {
      needsReview.push({
        company: lead.company,
        reason: reviewedEmployers.size > 1 ? 'ambiguous reviewed DOL identity' : 'no exact DOL identity or accepted alias',
        source_urls: lead.urls,
      });
    }
  }
  return { accepted, needsReview };
}

function parseArgs(argv) {
  const args = {
    leads: resolve(ROOT, 'data/cache/dol/sunny-builtin-company-leads-2026-09-07.tsv'),
    employers: resolve(ROOT, 'data/cache/dol/sunny-ny-metro-h1b-employers-fy2026q3.tsv'),
    reviews: resolve(ROOT, 'profiles/sunny-h1b-ats-identity-reviews.yml'),
    output: resolve(ROOT, 'data/cache/dol/sunny-expansion-candidates-2026-09-07.yml'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--leads') args.leads = resolve(argv[++index]);
    else if (token === '--employers') args.employers = resolve(argv[++index]);
    else if (token === '--reviews') args.reviews = resolve(argv[++index]);
    else if (token === '--output') args.output = resolve(argv[++index]);
    else if (token === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node data/tools/join-sunny-builtin-h1b.mjs [--leads TSV] [--employers TSV] [--reviews YAML] [--output YAML]');
    return;
  }
  const reviewsDoc = yaml.load(readFileSync(args.reviews, 'utf8')) || {};
  const result = joinBuiltinCompanies({
    leads: parseTsv(args.leads),
    employers: parseTsv(args.employers),
    reviews: reviewsDoc.reviews || [],
  });
  const document = {
    companies: result.accepted.map(row => ({ name: row.company })),
    accepted: result.accepted,
    needs_review: result.needsReview,
  };
  writeFileSync(args.output, yaml.dump(document, { lineWidth: 120, noRefs: true }));
  console.log(JSON.stringify({ accepted: result.accepted.length, needsReview: result.needsReview.length, output: args.output }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(); }
  catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
