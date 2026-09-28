/** Durable page ledger for bounded ATS continuation runs.
 *
 * A provider owns fetching pages; this ledger owns the ordering guarantee:
 * payload first, downstream acknowledgement second, then cursor advance.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function idFor(key) { return createHash('sha256').update(JSON.stringify(key)).digest('hex'); }
function read(file, key) {
  if (!existsSync(file)) return { schema_version: 1, key, pages: {}, complete: false, incomplete: [] };
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (value.schema_version !== 1 || JSON.stringify(value.key) !== JSON.stringify(key) || !value.pages || typeof value.pages !== 'object') throw new Error('Invalid provider continuation ledger; refusing to overwrite');
  return value;
}
function atomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${randomUUID()}`;
  try { writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`); renameSync(temp, file); } finally { if (existsSync(temp)) unlinkSync(temp); }
}

export function createProviderContinuation({ dataRoot, key }) {
  if (!dataRoot || !key?.provider || !key?.board_identifier || !key?.window?.posted_after || !key?.window?.posted_before) return null;
  const file = join(dataRoot, 'data/company-discovery/continuations', `${idFor(key)}.json`);
  const mutate = fn => { const doc = read(file, key); const out = fn(doc); atomic(file, doc); return out; };
  return {
    key, file,
    snapshot: () => read(file, key),
    /** Save exactly what was received before a caller can move its cursor. */
    savePage(identity, payload, meta = {}) {
      if (!identity) throw new Error('Continuation page identity is required');
      return mutate(doc => {
        const old = doc.pages[identity];
        if (old && JSON.stringify(old.payload) !== JSON.stringify(payload)) throw new Error(`Continuation page identity changed: ${identity}`);
        doc.pages[identity] ||= { identity, payload, meta, saved_at: new Date().toISOString(), acknowledged: false };
        return doc.pages[identity];
      });
    },
    acknowledge(identity) { return mutate(doc => { if (!doc.pages[identity]) throw new Error(`Unknown continuation page: ${identity}`); doc.pages[identity].acknowledged = true; doc.pages[identity].acknowledged_at ||= new Date().toISOString(); return doc.pages[identity]; }); },
    pending() { return Object.values(read(file, key).pages).filter(page => !page.acknowledged); },
    state(patch = {}) { return mutate(doc => { Object.assign(doc, patch, { updated_at: new Date().toISOString() }); return doc; }); },
    incomplete(evidence) { return mutate(doc => { doc.complete = false; doc.incomplete = [...(doc.incomplete || []), evidence]; return doc; }); },
    complete() { return mutate(doc => { if (Object.values(doc.pages).some(page => !page.acknowledged)) throw new Error('Cannot complete continuation with unacknowledged payload'); doc.complete = true; doc.completed_at ||= new Date().toISOString(); return doc; }); },
  };
}
