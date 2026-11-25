// The bridge that carries the calls of the MCP server to the core (src/subharness/tool-bridge.ts, docs/keys.md). The
// bridge is tested through its tokens, and the wire pair (`bridgePeer`, `serveBridge`) over the protocol's loopback,
// which encodes every envelope as the socket would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BridgeCall } from '../../../src/subharness/mcp-server.ts';
import { bridgePeer, createToolBridge, serveBridge } from '../../../src/subharness/tool-bridge.ts';
import { createLoopback } from '../../fixtures/loopback.ts';

/** Two of the persona's tool definitions as a core request carries them (chat-completions `tools`). */
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'intention_update',
      description: 'Update an intention',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' }, status: { type: 'string', enum: ['done', 'open'] } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: { name: 'web_search', description: 'Search the web', parameters: { type: 'object', properties: {} } },
  },
];

// the bridge

/** A bridge whose tokens are `tok-1`, `tok-2`, ... */
function bridgeRig() {
  let n = 0;
  return createToolBridge({ token: () => `tok-${(n += 1)}` });
}

test('the bridge lists the tools of the session its token opened', async () => {
  // Catches: the bridge listing the whole registry, which offers the persona tools the turn did not grant.
  const bridge = bridgeRig();
  const { token } = bridge.open({ tools: TOOLS.slice(1), call: () => Promise.resolve({ text: '', isError: false }) });
  assert.deepEqual(await bridge.list(token), TOOLS.slice(1));
});

test('the bridge hands a call to its session with the prefix stripped', async () => {
  // Catches: the session receiving `mcp__nep__x`, which the step loop then plans as an unknown skill.
  const bridge = bridgeRig();
  const seen: Array<BridgeCall> = [];
  const { token } = bridge.open({
    tools: TOOLS,
    call: (call) => {
      seen.push(call);
      return Promise.resolve({ text: 'shown', isError: false });
    },
  });
  const answer = await bridge.call(token, { name: 'mcp__nep__web_search', arguments: {}, meta: null });
  assert.deepEqual(answer, { text: 'shown', isError: false });
  assert.equal(seen[0]?.name, 'web_search');
});

test('a token the bridge never gave is refused with turn-unknown', async () => {
  // Catches: any local process that reaches the socket running the persona's tools without the turn's token.
  const bridge = bridgeRig();
  bridge.open({ tools: TOOLS, call: () => Promise.resolve({ text: '', isError: false }) });
  await assert.rejects(bridge.call('forged', { name: 'web_search', arguments: {}, meta: null }), {
    code: 'turn-unknown',
  });
  await assert.rejects(bridge.list('forged'), { code: 'turn-unknown' });
});

test('a closed session refuses its token', async () => {
  // Catches: a token that outlives its turn, so a late or replayed call acts in a turn that is over.
  const bridge = bridgeRig();
  const session = bridge.open({ tools: TOOLS, call: () => Promise.resolve({ text: '', isError: false }) });
  session.close();
  await assert.rejects(bridge.call(session.token, { name: 'web_search', arguments: {}, meta: null }), {
    code: 'turn-unknown',
  });
});

// the wire pair

test('a peer over the socket lists and calls through the bridge on the other end', async () => {
  // Catches: a wire format the two ends read differently, so the CLI sees no tools or never gets an answer.
  const bridge = bridgeRig();
  const seen: Array<BridgeCall> = [];
  const { token } = bridge.open({
    tools: TOOLS,
    call: (call) => {
      seen.push(call);
      return Promise.resolve({ text: `ran ${call.name}`, isError: false });
    },
  });
  const { core, client } = createLoopback();
  serveBridge(core, bridge);
  const peer = bridgePeer(client, token);
  assert.deepEqual(await peer.list(), TOOLS);
  const answer = await peer.call({ name: 'intention_update', arguments: { id: '7' }, meta: { k: 'v' } });
  assert.deepEqual(answer, { text: 'ran intention_update', isError: false });
  assert.deepEqual(seen, [{ name: 'intention_update', arguments: { id: '7' }, meta: { k: 'v' } }]);
});

test('a peer with a wrong token is refused with turn-unknown across the socket', async () => {
  // Catches: the socket end that skips the token check the bridge does in process.
  const bridge = bridgeRig();
  bridge.open({ tools: TOOLS, call: () => Promise.resolve({ text: 'ran', isError: false }) });
  const { core, client } = createLoopback();
  serveBridge(core, bridge);
  const peer = bridgePeer(client, 'forged');
  await assert.rejects(peer.call({ name: 'web_search', arguments: {}, meta: null }), { code: 'turn-unknown' });
});
