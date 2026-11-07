// Publication restrictions through the real turn runner and the explicit person-command path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntention } from '../src/intentions/model.ts';
import { issueContext } from '../src/memory/db/scope.ts';
import { drawTurn, fakeImages } from './fixtures/turn-draws.ts';
import { world, useIface } from './fixtures/turn-world.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';

useIface('fake');

const NOW = Date.parse('2026-11-03T12:00:00Z');

test('an internal turn refuses direct drawing in another conversation before generation', async () => {
  const images = fakeImages();
  const context = issueContext({ kind: 'internal', newId: () => 'ctx:draw-internal', now: () => NOW });
  const result = await drawTurn({
    images,
    setup: () => {
      world().channel({ id: '555', name: 'destination' });
    },
    answers: [toolAnswer('', [call('draw.create', { place: '555', text: 'private scene' })]), '<skip/>'],
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
    answers: [toolAnswer('', [call('draw.create', { place: '555', text: 'ordinary scene' })]), '<skip/>'],
    runner: { memoryContext: () => internalContext() },
  });
  assert.equal(images.calls.length, 1);
  assert.equal(result.port.messagesIn('555')[0].attachments.length, 1);
});

test('a turn that inherited a restriction refuses a group destination while its own context is ordinary', async () => {
  // Bug: a finished errand or a due intention of an internal turn publishes its private result to a group.
  const images = fakeImages();
  const result = await drawTurn({
    images,
    setup: () => {
      world().channel({ id: '555', name: 'destination' });
    },
    answers: [toolAnswer('', [call('draw.create', { place: '555', text: 'private scene' })]), '<skip/>'],
    params: {
      publicationBoundary: { kind: 'internal-turn', origin: { iface: 'fake', conversationId: 'cli-origin' } },
    },
  });
  assert.deepEqual(images.calls, []);
  assert.deepEqual(result.port.messagesIn('555'), []);
});

test('an internal turn hands its restriction to the errand and the intention it creates, and both survive a reload', () => {
  // Bug: the deferred record forgets where it came from, so its later turn publishes freely.
  const boundary = { kind: 'internal-turn', origin: { iface: 'cli', conversationId: 'dm-owner' } } as const;
  const made = createIntention({
    id: 'i1',
    purpose: 'write it up',
    now: NOW,
    provenance: { kind: 'self', turnId: 't', scope: 'dm', placeId: 'dm-owner', publicationBoundary: boundary },
  } as never);
  if (!made.ok) throw new Error(made.code);
  const reloaded = JSON.parse(JSON.stringify(made.intention)) as typeof made.intention;
  assert.deepEqual(reloaded.provenance.publicationBoundary, boundary);
});
