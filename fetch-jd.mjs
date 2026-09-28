#!/usr/bin/env node
/**
 * fetch-jd.mjs — read a job description from its ATS's public API instead of
 * the rendered page (#2582).
 *
 * A headless caller that wants a JD today has one option: fetch the posting
 * page and strip HTML. That is 10-30k tokens of nav and markup on a
 * server-rendered board, and on a JS-rendered one (Ashby, Greenhouse's
 * embedded boards) it returns an unrendered shell — correctly detected as thin
 * and discarded — so the caller falls through to WebFetch, which hits the same
 * shell and fails the same way. Meanwhile the ATS's own public JSON endpoint,
 * the one liveness checks already use, ships the full JD body for free.
 *
 *   node fetch-jd.mjs <url> [--json]
 *
 * JD text on stdout, exit 0, when a known ATS answers with real content.
 * Exit 1 with empty stdout and no stderr noise otherwise — a miss is the
 * expected "fall back to the browser path" case, not an error condition, and
 * a visible miss is the whole point: never a fabricated JD.
 *
 * Coverage is JD_TEXT_API_ATS (liveness-api.mjs): Greenhouse, Lever, Ashby,
 * Workday. Every fetch runs through fetchJdViaKnownApi() in browser-extract.mjs
 * — the same dispatch its own `jd` mode uses — so this script and the
 * interactive extractor cannot drift on which ATS is API-fetchable.
 */

import { fetchJdViaKnownApi, fetchJdResultViaKnownApi } from './browser-extract.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const TEXT_CAP = 20_000; // a batch report reads the whole JD; no token-budget reason to cap tighter
const TIMEOUT_MS = 15_000;

export function parseArgs(args) {
  const json = args.includes('--json');
  const url = args.find(arg => !arg.startsWith('--'));
  return { url, json };
}

/** Keep the machine contract small and distinct from the text compatibility path. */
export function formatJdResult(result) {
  if (!result) return { outcome: 'unavailable', reason: 'unsupported_or_inconclusive' };
  if (typeof result.outcome === 'string') return result;
  return {
    outcome: 'success', provider: result.ats || 'official', url: result.url,
    title: result.title || '', text: result.text,
  };
}

async function main() {
  const { url, json } = parseArgs(process.argv.slice(2));

  if (!url) {
    console.error('usage: node fetch-jd.mjs <url>');
    process.exit(1);
  }

  const result = json
    ? await fetchJdResultViaKnownApi(url, TEXT_CAP, TIMEOUT_MS)
    : await fetchJdViaKnownApi(url, TEXT_CAP, TIMEOUT_MS);
  // No stderr, by design: the caller's browser/WebFetch fallback is the
  // intended next step, and warning on every non-covered host would make the
  // normal path look broken.
  if (!result || result.outcome && result.outcome !== 'success') {
    if (json) process.stdout.write(`${JSON.stringify(formatJdResult(result))}\n`);
    process.exitCode = 1;
    return;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(formatJdResult(result))}\n`);
    return;
  }

  const header = result.title ? `${result.title}\n\n` : '';
  process.stdout.write(header + result.text);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`fetch-jd: unexpected error — ${err?.message || err}`);
    process.exit(1);
  });
}
