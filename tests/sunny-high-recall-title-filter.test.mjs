import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';

import { buildTitleFilter } from '../title-keywords.mjs';

const config = yaml.load(readFileSync(new URL('../portals.yml', import.meta.url), 'utf8'));

const shouldPass = [
  'Senior Data Engineer - Revenue Data Platform',
  'Senior Data Platform Engineer',
  'Data Intelligence Engineer',
  'Data Intelligent Engineer',
  'Data Automation Engineer',
  'Senior Data Management Professional - Data Automation Engineer - People Data',
  'Senior Analytics Engineer, Finance',
  'Advanced Forward Engineering - Data Engineer - Senior',
  'Senior Data Architect/Data Engineer, Aladdin Engineering - Vice President',
  'ETL Developer',
  'ELT Engineer',
  'BI Developer',
  'Business Intelligence Engineer',
  'Finance Analyst',
  'SQL Developer',
  'Database Engineer',
  'Reporting Developer',
];

const shouldFail = [
  'Forward Deployed Engineer',
  'Data Entry Operator',
  'Machine Learning Engineer, Data Platform',
  'AI Engineer - Data',
  'Software Engineer, Data Platform',
  'Clinical Data Manager',
  'Data Engineering Intern',
];

for (const filterName of ['title_filter', 'title_filter_full']) {
  test(`${filterName} discovers broad Sunny title variants`, () => {
    const matches = buildTitleFilter(config[filterName]);
    const missed = shouldPass.filter(title => !matches(title));
    assert.deepEqual(missed, [], `unexpected misses: ${missed.join(' | ')}`);
  });

  test(`${filterName} preserves Sunny hard title exclusions`, () => {
    const matches = buildTitleFilter(config[filterName]);
    const leaked = shouldFail.filter(title => matches(title));
    assert.deepEqual(leaked, [], `unexpected leaks: ${leaked.join(' | ')}`);
  });
}
