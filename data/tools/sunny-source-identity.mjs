/** Stable source-gap identities shared by planning, recovery, and controller state. */
export function isSourceKey(key) { return /^source(?:-v[23])?\|/.test(String(key || '')); }
export function parseSourceKey(key) {
  const parts = String(key || '').split('|');
  if (parts[0] === 'source') return { version: 1, key: String(key), type: parts[2] || 'error', legacy_board: parts[1] || '' };
  if (parts[0] === 'source-v2' && parts.length >= 6) return { version: 2, key: String(key), provider: parts[1], board_identifier: decodeURIComponent(parts[2]), window: { posted_after: parts[3], posted_before: parts[4] }, type: parts[5] };
  if (parts[0] === 'source-v3' && parts.length >= 7) return { version: 3, key: String(key), origin_run_id: decodeURIComponent(parts[1]), provider: parts[2], board_identifier: decodeURIComponent(parts[3]), window: { posted_after: parts[4], posted_before: parts[5] }, type: parts[6] };
  return null;
}
export function sourceIdentityKey({ runId, provider, board, window, type, legacyBoard }) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedBoard = String(board || '').trim();
  if (normalizedProvider && normalizedBoard && window?.posted_after && window?.posted_before) {
    if (runId) return `source-v3|${encodeURIComponent(String(runId))}|${normalizedProvider}|${encodeURIComponent(normalizedBoard)}|${window.posted_after}|${window.posted_before}|${String(type || 'error')}`;
    return `source-v2|${normalizedProvider}|${encodeURIComponent(normalizedBoard)}|${window.posted_after}|${window.posted_before}|${String(type || 'error')}`;
  }
  return `source|${legacyBoard || normalizedBoard || 'unknown'}|${String(type || 'error')}`;
}
