// Publication restrictions through the real turn runner and the explicit person-command path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueContext } from '../src/memory/db/scope.ts';
import type { TurnParams } from '../src/turn/outcome.ts';
import { coreTurn } from './fixtures/turn-harness.ts';
import { drawTurn, fakeImages } from './fixtures/turn-draws.ts';
import { rawMessage } from './fixtures/turn-kit.ts';
import { world, useIface } from './fixtures/turn-world.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';

useIface('fake');

const NOW = Date.parse('2026-11-03T12:00:00Z');

test('an explicit person message operation starts an ordinary destination turn without its supplied draft', async () => {
  let turns: Awaited<ReturnType<typeof coreTurn>>['turns'] | null = null;
  const contexts: Array<unknown> = [];
  const result = await coreTurn({
    answers: ['<skip/>', '<msg>destination answer</msg>'],
    content: 'θυμάσαι το κουνέλι από την παλιά συζήτηση;',
    setup: () =>
      world().seed('c2', [
        {
          ...rawMessage({ id: 'destination-trigger', content: 'θυμάσαι το κουνέλι από την παλιά συζήτηση;', ts: NOW }),
          channelId: 'c2',
        },
      ]),
    runner: {
      memoryContext: (spec: Parameters<typeof issueContext>[0]) =>
        issueContext({ ...spec, iface: 'fake', newId: () => 'ctx:destination', now: () => NOW }),
      recall: {
        available: () => true,
        prefetch: (args: Record<string, unknown>) => {
          contexts.push(args.memoryContext);
          return Promise.resolve({ status: 'ok', excerpts: [] });
        },
      },
    },
    adminExtra: {
      turns: {
        runTurn: (args: TurnParams) => {
          if (!turns) throw new Error('destination runner was not attached');
          return turns.runTurn(args);
        },
      },
    },
  });
  turns = result.turns;
  contexts.length = 0;
  await result.admin.run(
    'message.create',
    {
      channelId: 'c2',
      replyTo: 'destination-trigger',
      text: 'private draft must not transfer',
    },
    { actor: 'owner', asOwner: true, userId: 'u1', channelId: 'cli:dm:owner' }
  );
  assert.ok(contexts.length > 0, 'destination turn must perform prefetch');
  for (const context of contexts) {
    assert.ok(context && typeof context === 'object' && 'kind' in context && 'iface' in context);
    assert.equal(context.kind, 'group');
    assert.equal(context.iface, 'fake');
  }
  assert.ok(result.port.messagesIn('c2').some((message) => message.text === 'destination answer'));
  assert.equal(JSON.stringify(result.llm.calls.at(-1)).includes('private draft must not transfer'), false);
});

test('an internal turn refuses direct drawing in another conversation before generation', async () => {
  const images = fakeImages();
  const context = issueContext({ kind: 'internal', newId: () => 'ctx:draw-internal', now: () => NOW });
  const result = await drawTurn({
    images,
    setup: () => {
      world().channel({ id: '555', name: 'destination' });
    },
    answers: [toolAnswer('', [call('draw.create', { channel: '555', text: 'private scene' })]), '<skip/>'],
    runner: { memoryContext: () => context },
  });
  assert.deepEqual(images.calls, []);
  assert.deepEqual(result.port.messagesIn('555'), []);
  assert.ok(
    result.logs.some(
      (entry) => entry.msg === 'skills: called' && entry.skill === 'draw.create' && entry.status === 'denied'
    )
  );
});

test('an unissued internal flag does not create a trusted publication restriction', async () => {
  const { internalContext } = await import('../src/memory/db/scope.ts');
  const images = fakeImages();
  const result = await drawTurn({
    images,
    setup: () => {
      world().channel({ id: '555', name: 'destination' });
    },
    answers: [toolAnswer('', [call('draw.create', { channel: '555', text: 'ordinary scene' })]), '<skip/>'],
    runner: { memoryContext: () => internalContext() },
  });
  assert.equal(images.calls.length, 1);
  assert.equal(result.port.messagesIn('555')[0].attachments.length, 1);
});
