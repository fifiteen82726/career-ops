import { extractConnectionCards } from './linkedin-dom-extractors.mjs';

export const CONNECTIONS_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';
const exactConnectionsUrl = value => { try { const url = new URL(value); return url.href === CONNECTIONS_URL; } catch { return false; } };
const deadline = async (run, until) => {
  const remaining = until - Date.now(); if (remaining <= 0) throw new Error('deadline');
  let id; try { return await Promise.race([run(remaining), new Promise((_, reject) => { id = setTimeout(() => reject(new Error('deadline')), remaining); })]); } finally { clearTimeout(id); }
};

// This adapter is for the trusted Node REPL browser runtime only.  Normal Node
// processes must use the capture file produced by this adapter; they never load
// an installed browser agent.
export function createInstalledLinkedinBridge(agent, { browserName = 'Brave', browserId = null, profileId = null } = {}) {
  if (!agent?.browsers?.list || !agent?.browsers?.get) throw new Error('Installed browser interface unavailable');
  return {
    async connectionsTab({ create = true, deadlineAt = Date.now() + 600000 } = {}) {
      const check = () => { if (Date.now() >= deadlineAt) throw new Error('deadline'); };
      check();
      const listed = await agent.browsers.list(); const all = Array.isArray(listed) ? listed : listed?.browsers || [];
      check();
      const matches = all.filter(item => (!browserId || (item.id || item.browserId) === browserId) && (!profileId || item.profileId === profileId) && String(item.name || item.browserName || '').toLowerCase() === browserName.toLowerCase());
      if (matches.length !== 1) throw new Error('Named Brave browser unavailable or ambiguous');
      const browser = await agent.browsers.get(matches[0].id || matches[0].browserId);
      check(); if (!browser?.tabs?.list || !browser?.tabs?.get || !browser?.tabs?.new) throw new Error('browser tabs unavailable');
      const listedTabs = await browser.tabs.list(); check(); const tabs = Array.isArray(listedTabs) ? listedTabs : listedTabs?.tabs || [];
      const exact = tabs.filter(tab => exactConnectionsUrl(tab.url)); if (exact.length > 1) throw new Error('Connections tab ambiguous');
      if (exact.length === 1) { const tab=await browser.tabs.get(exact[0].id || exact[0].tabId); check(); if(!exactConnectionsUrl(tab?.url)) throw new Error('Connections URL invariant'); return tab; }
      if (!create) return null;
      const tab = await browser.tabs.new(); check(); if(!tab?.goto) throw new Error('tab unavailable'); await tab.goto(CONNECTIONS_URL); check(); if(!exactConnectionsUrl(tab.url)) throw new Error('Connections URL invariant'); return tab;
    },
  };
}

export async function captureConnectionsOnly({ agent, bridge = null, now = () => new Date(), deadlineMs = 600000 } = {}) {
  const until = now().getTime() + Math.min(600000, Math.max(1, deadlineMs));
  try {
    const tab = await deadline(() => (bridge || createInstalledLinkedinBridge(agent)).connectionsTab({ create: true, deadlineAt: until }), until);
    if (!exactConnectionsUrl(tab?.url)) throw new Error('Connections URL invariant');
    const result = await deadline(ms => tab.playwright.evaluate(extractConnectionCards, { limit: 50 }, { timeoutMs: ms }), until);
    return { observedAt: now().toISOString(), sourceStatus: result?.sourceStatus || 'partial', sourceWarning: '', connections: Array.isArray(result?.cards) ? result.cards.slice(0, 50) : [] };
  } catch (error) { return { observedAt: now().toISOString(), sourceStatus: error.message === 'deadline' ? 'partial' : 'error', sourceWarning: 'connections capture unavailable', connections: [] }; }
}
