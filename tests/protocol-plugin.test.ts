// The plugin side of the protocol (src/protocol/plugin.ts): the two envelope types and their bodies, and servePlugin,
// the plugin's end of the link. The core's end is driven by hand over the loopback, as a core would answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENVELOPE_TYPES, createLoopback, envelope, validateEnvelope } from '../src/protocol/index.ts';
import { PLUGIN_IFACE, servePlugin, validateToolCall, validateToolRegister } from '../src/protocol/plugin.ts';
import type { ToolAnswer, ToolCallBody } from '../src/protocol/plugin.ts';
import { echoHandler, echoTool, quiet, rawClient } from './fixtures/plugin-rig.ts';

const NOW = Date.parse('2026-11-01T09:00:00Z');

function call(overrides: Partial<ToolCallBody> = {}): ToolCallBody {
  return {
    tool: 'echo.say',
    args: { text: 'hi' },
    requester: { id: 'u1', roleIds: [] },
    conversationId: 'c1',
    deadlineAt: NOW + 5000,
    idempotencyKey: 'k1',
    ...overrides,
  };
}

/** A plugin served over a loopback whose core end is a hand-driven client; the hello is answered `ok`. */
async function served(handle: (call: ToolCallBody) => ToolAnswer | Promise<ToolAnswer>, answerHello = 'ok') {
  const { core, client } = createLoopback();
  const raw = rawClient(core);
  const plugin = servePlugin({
    transport: client,
    name: 'echo',
    token: 'secret',
    tools: [echoTool()],
    handle,
    now: () => NOW,
    log: quiet,
  });
  // Rejections of `registered` are the tests' to assert.
  plugin.registered.catch(() => {});
  const hello = await raw.next((value) => value.type === 'hello', 'the hello');
  raw.send('ack', { status: answerHello, ackedSeq: 0 }, `ack:${hello.id}`, hello.id);
  return { raw, plugin, hello };
}

test('the two plugin envelope types are known to the envelope check', () => {
  assert.ok(ENVELOPE_TYPES.includes('tool.register'));
  assert.ok(ENVELOPE_TYPES.includes('tool.call'));
  assert.deepEqual(validateEnvelope(envelope('tool.register', { tools: [] }, { id: 'r1' })), { ok: true });
  assert.deepEqual(validateEnvelope(envelope('tool.call', call(), { id: 'c1' })), { ok: true });
});

test('a tool.register whose tools are not a list is invalid, and an empty list is valid', () => {
  assert.deepEqual(validateToolRegister({ tools: [] }), { ok: true });
  assert.deepEqual(validateToolRegister({}), { ok: false, reason: 'body.tools:type' });
  assert.deepEqual(validateToolRegister({ tools: 'echo.say' }), { ok: false, reason: 'body.tools:type' });
  assert.deepEqual(validateToolRegister({ tools: [echoTool(), 7] }), { ok: false, reason: 'body.tools.1:type' });
});

test('a tool.call without a tool, arguments, deadline or key is invalid, each for its own field', () => {
  assert.deepEqual(validateToolCall(call()), { ok: true });
  assert.deepEqual(validateToolCall({ ...call(), tool: '' }), { ok: false, reason: 'body.tool:type' });
  assert.deepEqual(validateToolCall({ ...call(), args: [] }), { ok: false, reason: 'body.args:type' });
  assert.deepEqual(validateToolCall({ ...call(), deadlineAt: 'soon' }), { ok: false, reason: 'body.deadlineAt:type' });
  assert.deepEqual(validateToolCall({ ...call(), idempotencyKey: '' }), {
    ok: false,
    reason: 'body.idempotencyKey:type',
  });
  assert.deepEqual(validateToolCall({ ...call(), requester: 'u1' }), { ok: false, reason: 'body.requester:type' });
});

test('servePlugin says hello under the plugin namespace with its token, then registers its tools once the hello is acked', async () => {
  const { raw, hello, plugin } = await served(echoHandler());
  assert.equal((hello.body as Record<string, unknown>).iface, PLUGIN_IFACE);
  assert.equal((hello.body as Record<string, unknown>).token, 'secret');
  const register = await raw.next((value) => value.type === 'tool.register', 'the tool.register');
  assert.deepEqual(
    (register.body as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name),
    ['echo.say']
  );
  raw.send('ack', { status: 'ok', accepted: ['echo.say'], refused: [] }, `ack:${register.id}`, register.id);
  assert.deepEqual(await plugin.registered, { accepted: ['echo.say'], refused: [] });
});

test('servePlugin reports the refused tools of the register ack', async () => {
  const { raw, plugin } = await served(echoHandler());
  const register = await raw.next((value) => value.type === 'tool.register', 'the tool.register');
  const refused = [{ name: 'echo.say', reason: 'not-declared' }];
  raw.send('ack', { status: 'ok', accepted: [], refused }, `ack:${register.id}`, register.id);
  assert.deepEqual(await plugin.registered, { accepted: [], refused });
});

test('servePlugin rejects registered with "hello refused" when the core does not accept the hello', async () => {
  const { plugin } = await served(echoHandler(), 'invalid');
  await assert.rejects(plugin.registered, /hello refused/);
});

test('servePlugin answers a tool.call with the handler answer as an action_result for that call', async () => {
  const seen: Array<ToolCallBody> = [];
  const { raw } = await served(echoHandler(seen));
  raw.send('tool.call', call(), 'call-1');
  const result = await raw.next((value) => value.type === 'action_result' && value.replyTo === 'call-1', 'the result');
  assert.deepEqual(result.body, { status: 'ok', data: { text: 'echo: hi' } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.idempotencyKey, 'k1');
});

test('servePlugin refuses a call whose deadline has passed and never runs the handler', async () => {
  const seen: Array<ToolCallBody> = [];
  const { raw } = await served(echoHandler(seen));
  raw.send('tool.call', call({ deadlineAt: NOW - 1 }), 'late-1');
  const result = await raw.next((value) => value.replyTo === 'late-1', 'the result');
  assert.deepEqual(result.body, { status: 'failed', code: 'deadline-passed' });
  assert.equal(seen.length, 0);
});

test('servePlugin answers a call for a tool it did not register as invalid', async () => {
  const seen: Array<ToolCallBody> = [];
  const { raw } = await served(echoHandler(seen));
  raw.send('tool.call', call({ tool: 'echo.shout' }), 'x-1');
  const result = await raw.next((value) => value.replyTo === 'x-1', 'the result');
  assert.deepEqual(result.body, { status: 'invalid', code: 'unknown-tool' });
  assert.equal(seen.length, 0);
});

test('servePlugin answers failed when the handler throws, and the next call still runs', async () => {
  let first = true;
  const { raw } = await served(() => {
    if (first) {
      first = false;
      throw new Error('boom');
    }
    return { status: 'ok', data: { text: 'second' } };
  });
  raw.send('tool.call', call(), 'a-1');
  const failed = await raw.next((value) => value.replyTo === 'a-1', 'the first result');
  assert.deepEqual(failed.body, { status: 'failed', code: 'handler-threw' });
  raw.send('tool.call', call({ idempotencyKey: 'k2' }), 'a-2');
  const ok = await raw.next((value) => value.replyTo === 'a-2', 'the second result');
  assert.deepEqual(ok.body, { status: 'ok', data: { text: 'second' } });
});
