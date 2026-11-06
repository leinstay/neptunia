// The MCP server her tools reach the CLI through, and the bridge that carries its calls to the core (spec
// .agents/docs/specs/2026-11-06-core-on-subscription.md, "The MCP server and the bridge"). The server is pure over a
// peer: a fake peer stands for the core here. The bridge is tested through its tokens, and the wire pair
// (`bridgePeer`, `serveBridge`) over the protocol's loopback, which encodes every envelope as the socket would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MCP_TOOL_PREFIX, createMcpServer } from '../src/subharness/mcp-server.ts';
import type { BridgeAnswer, BridgeCall, McpPeer } from '../src/subharness/mcp-server.ts';
import { bridgePeer, createToolBridge, serveBridge } from '../src/subharness/tool-bridge.ts';
import { bareToolName } from '../src/tools/gateway.ts';
import { createLoopback } from '../src/protocol/wire.ts';

/** Two of her tool definitions as a core request carries them (chat-completions `tools`). */
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
    function: { name: 'status_show', description: 'Show the status', parameters: { type: 'object', properties: {} } },
  },
];

/** A peer that lists TOOLS and records every call, answering each with `answer`. */
function fakePeer(
  answer: (call: BridgeCall) => Promise<BridgeAnswer> = () => Promise.resolve({ text: 'done', isError: false })
) {
  const calls: Array<BridgeCall> = [];
  const peer: McpPeer = {
    list: () => Promise.resolve(TOOLS),
    call: (call) => {
      calls.push(call);
      return answer(call);
    },
  };
  return { peer, calls };
}

const rpc = (id: number | undefined, method: string, params?: object) => ({
  jsonrpc: '2.0',
  ...(id === undefined ? {} : { id }),
  method,
  ...(params === undefined ? {} : { params }),
});

type Reply = { jsonrpc?: string; id?: unknown; result?: Record<string, unknown>; error?: { code?: number } };
const replyOf = (value: object | null): Reply => (value ?? {}) as Reply;

// the server

test('initialize answers the client protocol version, the tools capability and the server name', async () => {
  // Catches: a server that answers with another protocol version, which the CLI drops, so she has no tools at all.
  const { peer } = fakePeer();
  const reply = replyOf(await createMcpServer(peer).handle(rpc(1, 'initialize', { protocolVersion: '2025-06-18' })));
  assert.equal(reply.id, 1);
  assert.equal(reply.result?.protocolVersion, '2025-06-18');
  assert.deepEqual(reply.result?.capabilities, { tools: {} });
  assert.equal((reply.result?.serverInfo as { name?: string } | undefined)?.name, 'nep');
});

test('tools/list gives her definitions as MCP tools with their names bare and their parameters as inputSchema', async () => {
  // Catches: a list that drops the schema (the model then calls with no arguments) or prefixes a name the CLI prefixes again.
  const { peer } = fakePeer();
  const reply = replyOf(await createMcpServer(peer).handle(rpc(2, 'tools/list')));
  assert.deepEqual(reply.result?.tools, [
    {
      name: 'intention_update',
      description: 'Update an intention',
      inputSchema: TOOLS[0]?.function.parameters,
    },
    { name: 'status_show', description: 'Show the status', inputSchema: { type: 'object', properties: {} } },
  ]);
});

test('tools/call forwards the bare name, the arguments and the meta to the peer and returns its text', async () => {
  // Catches: a call answered by the server itself (the prototype's stub), so her tool never runs in the turn.
  const { peer, calls } = fakePeer(() => Promise.resolve({ text: 'intention 7 is done', isError: false }));
  const reply = replyOf(
    await createMcpServer(peer).handle(
      rpc(3, 'tools/call', {
        name: 'intention_update',
        arguments: { id: '7', status: 'done' },
        _meta: { 'claudecode/toolUseId': 'toolu_1' },
      })
    )
  );
  assert.deepEqual(calls, [
    { name: 'intention_update', arguments: { id: '7', status: 'done' }, meta: { 'claudecode/toolUseId': 'toolu_1' } },
  ]);
  assert.deepEqual(reply.result, { content: [{ type: 'text', text: 'intention 7 is done' }], isError: false });
});

test('tools/call strips the mcp__nep__ prefix before the peer sees the name', async () => {
  // Catches: a prefixed name reaching the gateway, which knows no such tool and refuses every call of hers.
  const { peer, calls } = fakePeer();
  await createMcpServer(peer).handle(rpc(4, 'tools/call', { name: `${MCP_TOOL_PREFIX}status_show`, arguments: {} }));
  assert.equal(calls[0]?.name, 'status_show');
});

test('a refused call reaches the CLI as an error result that names the code', async () => {
  // Catches: a JSON-RPC error or no answer at all, which leaves the CLI waiting and her turn hanging.
  const refusal = Object.assign(new Error('refused'), { code: 'turn-unknown' });
  const { peer } = fakePeer(() => Promise.reject(refusal));
  const reply = replyOf(
    await createMcpServer(peer).handle(rpc(5, 'tools/call', { name: 'status_show', arguments: {} }))
  );
  assert.equal(reply.result?.isError, true);
  const content = reply.result?.content as Array<{ text?: string }> | undefined;
  assert.ok(content?.[0]?.text?.includes('turn-unknown'), JSON.stringify(reply));
});

test('a notification gets no answer and an unknown method gets method-not-found', async () => {
  // Catches: an answer to notifications/initialized, which the CLI reads as a protocol error and drops the server.
  const { peer } = fakePeer();
  const server = createMcpServer(peer);
  assert.equal(await server.handle(rpc(undefined, 'notifications/initialized')), null);
  assert.equal(replyOf(await server.handle(rpc(6, 'resources/list'))).error?.code, -32601);
});

test('bareToolName strips the server prefix and leaves a bare name alone', () => {
  // Catches: a name stripped twice or a bare name cut, so the gateway refuses a call she wrote correctly.
  assert.equal(bareToolName('mcp__nep__draw_create'), 'draw_create');
  assert.equal(bareToolName('draw_create'), 'draw_create');
});

// the bridge

/** A bridge whose tokens are `tok-1`, `tok-2`, ... */
function bridgeRig() {
  let n = 0;
  return createToolBridge({ token: () => `tok-${(n += 1)}` });
}

test('the bridge lists the tools of the session its token opened', async () => {
  // Catches: the bridge listing the whole registry, which offers her tools the turn did not grant.
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
  const answer = await bridge.call(token, { name: 'mcp__nep__status_show', arguments: {}, meta: null });
  assert.deepEqual(answer, { text: 'shown', isError: false });
  assert.equal(seen[0]?.name, 'status_show');
});

test('a token the bridge never gave is refused with turn-unknown', async () => {
  // Catches: any local process that reaches the socket running her tools without the turn's token.
  const bridge = bridgeRig();
  bridge.open({ tools: TOOLS, call: () => Promise.resolve({ text: '', isError: false }) });
  await assert.rejects(bridge.call('forged', { name: 'status_show', arguments: {}, meta: null }), {
    code: 'turn-unknown',
  });
  await assert.rejects(bridge.list('forged'), { code: 'turn-unknown' });
});

test('a closed session refuses its token', async () => {
  // Catches: a token that outlives its turn, so a late or replayed call acts in a turn that is over.
  const bridge = bridgeRig();
  const session = bridge.open({ tools: TOOLS, call: () => Promise.resolve({ text: '', isError: false }) });
  session.close();
  await assert.rejects(bridge.call(session.token, { name: 'status_show', arguments: {}, meta: null }), {
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
  await assert.rejects(peer.call({ name: 'status_show', arguments: {}, meta: null }), { code: 'turn-unknown' });
});
