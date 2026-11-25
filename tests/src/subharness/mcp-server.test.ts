// The MCP server the persona's tools reach the CLI through (src/subharness/mcp-server.ts, docs/keys.md). The server is
// pure over a peer: a fake peer stands for the core here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MCP_TOOL_PREFIX, createMcpServer } from '../../../src/subharness/mcp-server.ts';
import type { BridgeAnswer, BridgeCall, McpPeer } from '../../../src/subharness/mcp-server.ts';

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

// The first tool's function gets a name, so the reads stay three segments deep.
const firstToolFunction = TOOLS[0]?.function;

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

const replyOf = (value: object | null): Reply => value ?? {};

// the server

test('initialize answers the client protocol version, the tools capability and the server name', async () => {
  // Catches: a server that answers with another protocol version, which the CLI drops, so the persona has no tools at all.
  const { peer } = fakePeer();
  const reply = replyOf(await createMcpServer(peer).handle(rpc(1, 'initialize', { protocolVersion: '2025-06-18' })));
  assert.equal(reply.id, 1);
  assert.equal(reply.result?.protocolVersion, '2025-06-18');
  assert.deepEqual(reply.result?.capabilities, { tools: {} });
  assert.equal((reply.result?.serverInfo as { name?: string } | undefined)?.name, 'nep');
});

test("tools/list gives the persona's definitions as MCP tools with their names bare and their parameters as inputSchema", async () => {
  // Catches: a list that drops the schema (the model then calls with no arguments) or prefixes a name the CLI prefixes again.
  const { peer } = fakePeer();
  const reply = replyOf(await createMcpServer(peer).handle(rpc(2, 'tools/list')));
  assert.deepEqual(reply.result?.tools, [
    {
      name: 'intention_update',
      description: 'Update an intention',
      inputSchema: firstToolFunction?.parameters,
    },
    { name: 'web_search', description: 'Search the web', inputSchema: { type: 'object', properties: {} } },
  ]);
});

test('tools/call forwards the bare name, the arguments and the meta to the peer and returns its text', async () => {
  // Catches: a call answered by the server itself (the prototype's stub), so the persona's tool never runs in the turn.
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
  // Catches: a prefixed name reaching the gateway, which knows no such tool and refuses every call of the persona's.
  const { peer, calls } = fakePeer();
  await createMcpServer(peer).handle(rpc(4, 'tools/call', { name: `${MCP_TOOL_PREFIX}web_search`, arguments: {} }));
  assert.equal(calls[0]?.name, 'web_search');
});

test('a refused call reaches the CLI as an error result that names the code', async () => {
  // Catches: a JSON-RPC error or no answer at all, which leaves the CLI waiting and the turn hanging.
  const refusal = Object.assign(new Error('refused'), { code: 'turn-unknown' });
  const { peer } = fakePeer(() => Promise.reject(refusal));
  const reply = replyOf(
    await createMcpServer(peer).handle(rpc(5, 'tools/call', { name: 'web_search', arguments: {} }))
  );
  assert.equal(reply.result?.isError, true);
  const content = reply.result?.content as Array<{ text?: string }> | undefined;
  const [firstPart] = content ?? [];
  assert.ok(firstPart?.text?.includes('turn-unknown'), JSON.stringify(reply));
});

test('a notification gets no answer and an unknown method gets method-not-found', async () => {
  // Catches: an answer to notifications/initialized, which the CLI reads as a protocol error and drops the server.
  const { peer } = fakePeer();
  const server = createMcpServer(peer);
  assert.equal(await server.handle(rpc(undefined, 'notifications/initialized')), null);
  assert.equal(replyOf(await server.handle(rpc(6, 'resources/list'))).error?.code, -32601);
});
