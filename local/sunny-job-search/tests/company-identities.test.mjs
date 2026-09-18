import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCompanyIdentityIndex, loadVerifiedTrackedCompanyRows, parseCompanyAliases, parseCompanyMapRows, resolveCompanyIdentity, suggestAliasCandidates } from '../company-identities.mjs';
import { parseAliasTsv } from '../company-alias-store.mjs';

const map = 'company_key\tcompany_display\tlinkedin_company_url\tlinkedin_people_url\tverification_source\tverified_on\tstatus\ncapital-one\tCapital One\thttps://www.linkedin.com/company/capital-one/\thttps://www.linkedin.com/company/capital-one/people/\treview\t2026-09-16\tverified\n';
const aliases = 'alias_normalized\tcanonical_company_key\tlinkedin_company_url\tresolution_source\tconfidence\tevidence_fingerprint\tcatalog_revision\tresolved_on\tstatus\ncapital one bank\tcapital-one\thttps://www.linkedin.com/company/capital-one/\tai_title\t0.99\t' + 'a'.repeat(64) + '\t' + 'b'.repeat(64) + '\t2026-09-16\taccepted\n';

test('resolves exact URL and reviewed aliases but never fuzzy candidates', () => {
  const index = buildCompanyIdentityIndex({ companyMapRows: parseCompanyMapRows(map), aliasRows: parseCompanyAliases(aliases) });
  assert.equal(resolveCompanyIdentity(index, { companyLinkedinUrl: 'https://www.linkedin.com/company/capital-one/' }).quality, 'company_url_exact');
  assert.equal(resolveCompanyIdentity(index, { companyLabel: 'Capital One Bank' }).quality, 'connections_headline_exact');
  assert.equal(resolveCompanyIdentity(index, { companyLabel: 'Capital Onee' }).status, 'unresolved');
  assert.equal(suggestAliasCandidates(index, 'Capital Onee')[0], 'capital-one');
});

test('quarantines a syntactically valid collision without disabling other identities', () => {
  const rows = parseCompanyMapRows(`${map}other\tCapital One\thttps://www.linkedin.com/company/other/\thttps://www.linkedin.com/company/other/people/\treview\t2026-09-16\tverified\n`);
  const index = buildCompanyIdentityIndex({ companyMapRows: rows, aliasRows: [] });
  assert.equal(resolveCompanyIdentity(index, { companyLabel: 'Capital One' }).reason, 'collision');
  assert.equal(resolveCompanyIdentity(index, { companyLabel: 'capital-one' }).status, 'resolved');
});

test('quarantines a collision in any reviewed namespace, including a canonical slug', () => {
  const rows = parseCompanyMapRows(`${map}capital-one\tOther display\thttps://www.linkedin.com/company/other/\thttps://www.linkedin.com/company/other/people/\treview\t2026-09-16\tverified\n`);
  const index = buildCompanyIdentityIndex({ companyMapRows: rows, aliasRows: [] });
  assert.equal(resolveCompanyIdentity(index, { companyLabel: 'capital-one' }).reason, 'collision');
  assert.equal(resolveCompanyIdentity(index, { companyLinkedinUrl: 'https://www.linkedin.com/company/capital-one/' }).status, 'resolved');
});

test('rejects unsafe raw aliases before normalization and does not trust an archive label as an alias', () => {
  const unsafe = aliases.replace('capital one bank', 'https://www.linkedin.com/in/person');
  assert.throws(() => parseCompanyAliases(unsafe), /Invalid/);
  assert.throws(() => parseAliasTsv(unsafe), /Invalid/);
  const index = buildCompanyIdentityIndex({ companyMapRows: parseCompanyMapRows(map), aliasRows: [] });
  // Archive metadata may corroborate a reviewed URL, but it cannot teach an
  // arbitrary free-form label to the exact resolver.
  assert.equal(resolveCompanyIdentity(index, { companyLabel: 'Totally Different Name' }).status, 'unresolved');
});

test('tracked archive rows preserve reviewed display evidence instead of teaching arbitrary labels', () => {
  const archive = { jobs: [{
    company: 'Completely Unreviewed Brand Name',
    linkedinPeopleUrl: 'https://www.linkedin.com/company/capital-one/people/',
  }] };
  const tracked = loadVerifiedTrackedCompanyRows({
    portalsText: 'location:\n  country: United States\n', archive,
  });
  const index = buildCompanyIdentityIndex({ companyMapRows: parseCompanyMapRows(map), trackedCompanyRows: tracked });
  assert.equal(tracked[0].companyDisplay, 'Completely Unreviewed Brand Name');
  assert.equal(resolveCompanyIdentity(index, { companyLabel: 'Completely Unreviewed Brand Name' }).status, 'unresolved');
  assert.equal(resolveCompanyIdentity(index, { companyLabel: 'Capital One' }).status, 'resolved');
});

test('uses the reviewed LinkedIn slug grammar consistently, including a terminal dot', () => {
  const rows = parseCompanyMapRows('company_key\tcompany_display\tlinkedin_company_url\tlinkedin_people_url\tverification_source\tverified_on\tstatus\naperia-solutions-inc.\tAperia Solutions\thttps://www.linkedin.com/company/aperia-solutions-inc./\thttps://www.linkedin.com/company/aperia-solutions-inc./people/\treview\t2026-09-16\tverified\n');
  const index = buildCompanyIdentityIndex({ companyMapRows: rows });
  assert.equal(resolveCompanyIdentity(index, { companyLabel: 'Aperia Solutions' }).canonicalCompanyKey, 'aperia-solutions-inc.');
});
