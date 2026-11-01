// The plugin registry (src/plugins/registry.ts): which tools of a plugin the core takes (spec test 2), how they stand
// in the gateway's registry beside the core's own (spec test 3) and how a call reaches the plugin or fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPluginRegistry } from '../src/plugins/registry.ts';
import type { PluginPort } from '../src/plugins/registry.ts';
import type { ToolAnswer, ToolCallBody } from '../src/protocol/plugin.ts';
import { checkSkill } from '../src/tools/gateway.ts';
import { echoManifest, echoTool, quiet } from './fixtures/plugin-rig.ts';

const CONTEXT = { requester: { id: 'u1', roleIds: [] }, conversationId: 'c1', idempotencyKey: 'k1' };
const GRANT = { bot: { access: { 'echo.say': { users: ['self-id'] } } } };

const registryOf = () => createPluginRegistry({ manifests: () => [echoManifest()], log: quiet });

function portOf(
  answer: ToolAnswer | (() => ToolAnswer),
  closed = false
): PluginPort & { requests: Array<Omit<ToolCallBody, 'deadlineAt'>> } {
  const requests: Array<Omit<ToolCallBody, 'deadlineAt'>> = [];
  return {
    requests,
    isClosed: () => closed,
    callTool: (request) => {
      requests.push(request);
      return Promise.resolve(typeof answer === 'function' ? answer() : answer);
    },
  };
}

function gate(registry: ReturnType<typeof registryOf>, config: unknown) {
  return checkSkill({
    skill: 'echo.say',
    args: { text: 'hi' },
    principal: { kind: 'persona' },
    requester: { id: 'u1', roleIds: [] },
    audience: { conversationId: 'c1' },
    context: { config, selfId: 'self-id', registry: registry.skills() },
  });
}

test('takes the tool the manifest declares and lists it as a skill with the manifest fields', () => {
  const registry = registryOf();
  assert.deepEqual(registry.register('echo', [echoTool()]), { accepted: ['echo.say'], refused: [] });
  assert.deepEqual(registry.tools(), ['echo.say']);
  const skill = registry.skills().get('echo.say');
  assert.equal(skill?.family, 'echo');
  assert.equal(skill?.kind, 'read');
  assert.equal(skill?.ownerOnly, false);
  assert.equal(skill?.costClass, 'free');
  assert.equal(skill?.effects, 'read');
  assert.deepEqual(skill?.argsSchema, echoTool().schema);
});

test('refuses a tool outside the prefix and a tool the manifest does not declare, and keeps the declared one', () => {
  const registry = registryOf();
  const outside = { ...echoTool(), name: 'other.say' };
  const undeclared = { ...echoTool(), name: 'echo.extra' };
  const outcome = registry.register('echo', [outside, echoTool(), undeclared]);
  assert.deepEqual(outcome.accepted, ['echo.say']);
  assert.deepEqual(outcome.refused, [
    { name: 'other.say', reason: 'wrong-prefix' },
    { name: 'echo.extra', reason: 'not-declared' },
  ]);
  assert.deepEqual(registry.tools(), ['echo.say']);
  assert.equal(registry.skills().has('other.say'), false);
});

test('refuses a declared tool whose rights differ from the manifest, so a plugin cannot widen its own rights', () => {
  const registry = registryOf();
  const widened = { ...echoTool(), rights: { kind: 'read', member: true } };
  assert.deepEqual(registry.register('echo', [widened]), {
    accepted: [],
    refused: [{ name: 'echo.say', reason: 'differs-from-manifest' }],
  });
  assert.deepEqual(registry.tools(), []);
});

test('refuses an entry that is not shaped as a declaration', () => {
  const registry = registryOf();
  const outcome = registry.register('echo', [{ name: 'echo.say' }]);
  assert.deepEqual(outcome.refused, [{ name: 'echo.say', reason: 'invalid-declaration' }]);
});

test('refuses every tool of a plugin no enabled manifest names, and an empty list registers nothing', () => {
  const registry = registryOf();
  assert.deepEqual(registry.register('ghost', [{ ...echoTool(), name: 'ghost.say' }]).refused, [
    { name: 'ghost.say', reason: 'unknown-plugin' },
  ]);
  assert.deepEqual(registry.register('echo', []), { accepted: [], refused: [] });
});

test('reads the manifests at the moment of the call: a plugin enabled later can register', () => {
  const enabled: Array<ReturnType<typeof echoManifest>> = [];
  const registry = createPluginRegistry({ manifests: () => enabled, log: quiet });
  assert.equal(registry.register('echo', [echoTool()]).accepted.length, 0);
  enabled.push(echoManifest());
  assert.deepEqual(registry.register('echo', [echoTool()]).accepted, ['echo.say']);
});

test('the gateway refuses a plugin tool she was not granted, and lets it through once she is', () => {
  const registry = registryOf();
  registry.register('echo', [echoTool()]);
  const refused = gate(registry, { bot: { access: {} } });
  assert.deepEqual(refused.ok, false);
  assert.equal(refused.ok ? '' : refused.code, 'not-allowed');
  assert.deepEqual(gate(registry, GRANT), { ok: true });
});

test('the gateway checks the arguments of a plugin tool against the manifest schema', () => {
  const registry = registryOf();
  registry.register('echo', [echoTool()]);
  const result = checkSkill({
    skill: 'echo.say',
    args: { text: 'hi', extra: 1 },
    principal: { kind: 'persona' },
    requester: { id: 'u1', roleIds: [] },
    audience: { conversationId: 'c1' },
    context: { config: GRANT, selfId: 'self-id', registry: registry.skills() },
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.code, 'invalid-args');
});

test('a call goes to the plugin that registered the tool and answers what the plugin answered', async () => {
  const registry = registryOf();
  registry.register('echo', [echoTool()]);
  const port = portOf({ status: 'ok', data: { text: 'echo: hi' } });
  registry.attach('echo', port);
  assert.equal(registry.connected('echo'), true);
  assert.deepEqual(await registry.call('echo.say', { text: 'hi' }, CONTEXT), {
    status: 'ok',
    data: { text: 'echo: hi' },
  });
  assert.deepEqual(port.requests, [
    {
      tool: 'echo.say',
      args: { text: 'hi' },
      requester: { id: 'u1', roleIds: [] },
      conversationId: 'c1',
      idempotencyKey: 'k1',
    },
  ]);
});

test('a call to a tool no plugin registered is an unknown skill', async () => {
  assert.deepEqual(await registryOf().call('echo.say', {}, CONTEXT), { status: 'invalid', code: 'unknown-skill' });
});

test('a call to a plugin with no open link says so, and the tool stays listed so her grants do not flicker', async () => {
  const registry = registryOf();
  registry.register('echo', [echoTool()]);
  assert.deepEqual(await registry.call('echo.say', { text: 'hi' }, CONTEXT), {
    status: 'failed',
    code: 'plugin-not-connected',
  });
  registry.attach('echo', portOf({ status: 'ok' }, true));
  assert.equal(registry.connected('echo'), false);
  assert.deepEqual(await registry.call('echo.say', { text: 'hi' }, CONTEXT), {
    status: 'failed',
    code: 'plugin-not-connected',
  });
  assert.deepEqual(registry.tools('echo'), ['echo.say']);
});

test('the last link attached for a plugin takes the calls', async () => {
  const registry = registryOf();
  registry.register('echo', [echoTool()]);
  registry.attach('echo', portOf({ status: 'ok', data: { text: 'old' } }));
  registry.attach('echo', portOf({ status: 'ok', data: { text: 'new' } }));
  assert.deepEqual((await registry.call('echo.say', { text: 'x' }, CONTEXT)).data, { text: 'new' });
});

test('an answer with a status the engine does not know becomes failed, and a non-text data.text is dropped', async () => {
  const registry = registryOf();
  registry.register('echo', [echoTool()]);
  registry.attach('echo', portOf({ status: 'great' }));
  assert.deepEqual(await registry.call('echo.say', { text: 'x' }, CONTEXT), {
    status: 'failed',
    code: 'invalid-answer',
  });
  const odd = { status: 'ok', data: { text: 7 } } as unknown as ToolAnswer;
  registry.attach('echo', portOf(odd));
  assert.deepEqual(await registry.call('echo.say', { text: 'x' }, CONTEXT), { status: 'ok', data: {} });
});

test('forget drops every tool of a plugin, so a disabled plugin has no tool left', async () => {
  const registry = registryOf();
  registry.register('echo', [echoTool()]);
  registry.attach('echo', portOf({ status: 'ok' }));
  registry.forget('echo');
  assert.deepEqual(registry.tools(), []);
  assert.equal(registry.skills().size, 0);
  assert.deepEqual(await registry.call('echo.say', {}, CONTEXT), { status: 'invalid', code: 'unknown-skill' });
});

function memberRegistry(member: boolean) {
  const tool = { ...echoTool(), name: 'echo.set', effect: 'write', rights: { kind: 'write', member } };
  const registry = createPluginRegistry({
    manifests: () => [{ ...echoManifest(), tools: [tool] as never }],
    log: quiet,
  });
  registry.register('echo', [tool]);
  return registry;
}

const setCall = (registry: ReturnType<typeof memberRegistry>) =>
  checkSkill({
    skill: 'echo.set',
    args: { text: 'hi' },
    principal: { kind: 'persona' },
    requester: { id: 'u1', roleIds: [] },
    audience: { conversationId: 'c1' },
    context: {
      config: { bot: { access: { 'echo.set': { users: ['self-id'] } } } },
      selfId: 'self-id',
      registry: registry.skills(),
    },
  });

test('a write tool declared open to members runs for a requester with no grant of their own', () => {
  assert.deepEqual(setCall(memberRegistry(true)), { ok: true });
});

test('a write tool not declared open to members is refused for a requester with no grant of their own', () => {
  const result = setCall(memberRegistry(false));
  assert.equal(result.ok ? '' : result.code, 'requester-denied');
});
