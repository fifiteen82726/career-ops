// Sunny's approved Balanced A4 Education layout uses two compact rows per school:
// institution + date, then degree/GPA + location. The payload keeps its semantic
// field meaning; CSS changes only the visual order of the existing title/org nodes.
import { readFileSync } from 'fs';
import { join } from 'path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ROOT } from './helpers.mjs';

const templatePath = join(ROOT, 'output', 'cv-template-balanced-a4.html');
const payloadPath = join(
  ROOT,
  'output',
  'cv-yi-yun-liao-zuora-sr-analyst-revenue-operations-analytics-balanced-a4.json',
);

const template = readFileSync(templatePath, 'utf8');
const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));

test('Balanced A4 Education keeps the approved two-row semantic layout', () => {
assert.ok(template.includes('flex-direction: column-reverse;'));
assert.match(template, /\.edu-org\s*\{[^}]*white-space:\s*nowrap;/s);
assert.match(template, /\.edu-item\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/s);
assert.match(template, /\.edu-location\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*2;/s);
assert.doesNotMatch(template, /\.edu-location\s*\{[^}]*position:\s*absolute;/s);

const [nyu, fuJen] = payload.education || [];
const expectations = [
  [nyu?.org, 'New York University, Stern | Courant', 'NYU uses the approved one-line institution label'],
  [nyu?.year, 'Jan 2021 - May 2023', 'NYU uses the full approved date range'],
  [nyu?.location, 'New York, NY', 'NYU includes its second-row location'],
  [fuJen?.org, 'Fu Jen Catholic University', 'Fu Jen institution label is preserved'],
  [fuJen?.year, 'Sep 2015 - Jun 2019', 'Fu Jen uses the full approved date range'],
  [fuJen?.location, 'New Taipei City, Taiwan', 'Fu Jen includes its second-row location'],
];

for (const [actual, expected, message] of expectations) assert.equal(actual, expected, message);
});
