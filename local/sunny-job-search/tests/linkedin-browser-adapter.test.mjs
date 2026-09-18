import assert from 'node:assert/strict';
import test from 'node:test';
import { CONNECTIONS_URL, captureConnectionsOnly, createInstalledLinkedinBridge } from '../linkedin-browser-adapter.mjs';

test('the installed bridge selects one explicit Brave browser and only opens Connections', async () => {
  const destinations = [];
  const tab = { id: 'tab', url: CONNECTIONS_URL, playwright: { evaluate: async () => ({ sourceStatus: 'partial', cards: [] }) } };
  const agent = { browsers: { list: async () => [{ id: 'brave', name: 'Brave' }], get: async () => ({ tabs: { list: async () => [], new: async () => ({ ...tab, goto: async url => destinations.push(url) }), get: async () => tab } }) } };
  const bridge = createInstalledLinkedinBridge(agent);
  await bridge.connectionsTab();
  assert.deepEqual(destinations, [CONNECTIONS_URL]);
  assert.ok(destinations.every(url => url === CONNECTIONS_URL));
});

test('missing or ambiguous Brave is a source error without navigation', async () => {
  for (const browsers of [[], [{id:'a',name:'Brave'}, {id:'b',name:'Brave'}]]) {
    const capture = await captureConnectionsOnly({ agent: { browsers: { list: async () => browsers, get: async () => null } }, deadlineMs: 10 });
    assert.equal(capture.sourceStatus, 'error');
    assert.deepEqual(capture.connections, []);
  }
});
