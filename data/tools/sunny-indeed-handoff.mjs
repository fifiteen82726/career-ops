/**
 * Connector boundary for the scheduler worker. Node never calls or emulates
 * Indeed; the worker discovers its own capability, performs one scoped search,
 * and returns this contract for normal lead ingestion.
 */
import { ingestLeadRows } from './sunny-company-leads.mjs';

const clean = value => String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
export function buildIndeedHandoff({ scope, runId, query = 'data', now = new Date() } = {}) {
  if (!['nyc', 'remote'].includes(scope)) throw new Error('scope must be nyc or remote');
  return { schema_version: 1, source: 'indeed', scope, run_id: clean(runId) || `indeed-${scope}-${new Date(now).toISOString()}`,
    capability: 'mcp__codex_apps__indeed_job_search_search_jobs', location: scope === 'nyc' ? 'New York, NY' : 'Remote',
    query: clean(query), limit: 25, result_contract: ['title', 'company', 'location', 'url', 'posted_date', 'work_settings', 'sponsored'],
    limitation: 'Discover the connector in this scheduler context. If unavailable, return capability_unavailable; do not fabricate results.' };
}
export function normalizeIndeedResults(rows) {
  if (!Array.isArray(rows)) throw new Error('Indeed connector result must be an array');
  return rows.map(row => ({ company: clean(row.company), title: clean(row.title), location: clean(row.location),
    url: clean(row.url), posted_at: clean(row.posted_date), work_settings: clean(row.work_settings), sponsored: row.sponsored })).filter(row => row.company && row.title && row.url);
}
export async function ingestIndeedConnectorResult({ scope, runId, results }, options = {}) {
  const handoff = buildIndeedHandoff({ scope, runId });
  const rows = normalizeIndeedResults(results);
  return { handoff, ...await ingestLeadRows(rows, { ...options, source: 'indeed', scope, runId: handoff.run_id }) };
}
