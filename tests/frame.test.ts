// src/turn/request/frame.ts: the turn frame, the facts of one turn fixed before any block of its request. The lists are
// the root tags of the trees of the turn frame plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FrameError,
  REQUIRED_BY_KIND,
  blocksOf,
  frameOf,
  framedRequest,
  pathShown,
  turnKindOf,
  type BlockName,
  type TurnKind,
} from '../src/turn/request/frame.ts';
import { AUTHOR, DM, DM_CHAIN, PARTNER, ROOM_CHAIN, frameInput, wakeInput } from './fixtures/frame-input.ts';

type Mode = Parameters<typeof turnKindOf>[0];
type TriggerKind = Parameters<typeof turnKindOf>[1];
type WakeKind = Parameters<typeof turnKindOf>[2];

const REPLY_LIST: ReadonlyArray<BlockName> = [
  'persona',
  'self',
  'surroundings',
  'memory',
  'recall',
  'inner',
  'meanwhile',
  'spatial_awareness',
  'chat',
  'task',
];
const SERVICE_LIST: ReadonlyArray<BlockName> = [
  'persona',
  'self',
  'memory',
  'recall',
  'inner',
  'meanwhile',
  'spatial_awareness',
  'task',
];
const SELFREFLECTION_LIST: ReadonlyArray<BlockName> = [
  'persona',
  'self',
  'memory',
  'recall',
  'inner',
  'meanwhile',
  'virtual_world',
  'spatial_awareness',
  'task',
];

const KINDS: ReadonlyArray<TurnKind> = [
  'reply',
  'heartbeat',
  'selfimprovement',
  'intention',
  'feedback',
  'errand_result',
  'selfreflection_plan',
  'selfreflection',
];

// ---- the list of each kind ----

test('a reply reads the ordinary turn in the plan order', () => {
  // Bug: a tag is missing from the list or out of order, and slice 4 emits a request without it.
  const frame = frameOf(frameInput());
  assert.equal(frame.kind, 'reply');
  assert.deepEqual(frame.blocks, REPLY_LIST);
});

test('an errand result in a place reads the ordinary turn', () => {
  // Bug: a finished errand is taken for a service and loses the chat it answers.
  const frame = frameOf(frameInput({ triggerKind: 'errand' }));
  assert.equal(frame.kind, 'errand_result');
  assert.deepEqual(frame.blocks, REPLY_LIST);
});

test('a heartbeat reads the service list', () => {
  // Bug: the heartbeat keeps `<chat>` or `<surroundings>` of the place its wake rode in on.
  const frame = frameOf(wakeInput('heartbeat'));
  assert.equal(frame.kind, 'heartbeat');
  assert.deepEqual(frame.blocks, SERVICE_LIST);
});

test('a selfimprovement wake reads the service list', () => {
  // Bug: only the heartbeat is treated as her own time, and selfimprovement gets a chat.
  const frame = frameOf(wakeInput('selfimprovement'));
  assert.equal(frame.kind, 'selfimprovement');
  assert.deepEqual(frame.blocks, SERVICE_LIST);
});

test('an intention with a place reads the ordinary turn in that place', () => {
  // Bug: an intention is always nowhere, and she cannot see the room she meant to begin in.
  const frame = frameOf(wakeInput('intention_due', { chain: ROOM_CHAIN }));
  assert.equal(frame.kind, 'intention');
  assert.equal(frame.place?.id, 'place:room');
  assert.deepEqual(frame.blocks, REPLY_LIST);
});

test('an intention without a place reads the service list and is nowhere', () => {
  // Bug: an intention with no place throws as a reply with no place, and the due intention is lost.
  const frame = frameOf(wakeInput('intention_due'));
  assert.equal(frame.kind, 'intention');
  assert.equal(frame.place, null);
  assert.deepEqual(frame.blocks, SERVICE_LIST);
});

test('a feedback wake with a place reads the ordinary turn in that place', () => {
  // Bug: feedback about an action in a room arrives with no sight of that room.
  const frame = frameOf(wakeInput('feedback', { chain: ROOM_CHAIN }));
  assert.equal(frame.kind, 'feedback');
  assert.deepEqual(frame.blocks, REPLY_LIST);
});

test('a feedback wake without a place reads the service list and is nowhere', () => {
  // Bug: feedback with no cause place is read as a reply with no place and throws.
  const frame = frameOf(wakeInput('feedback'));
  assert.equal(frame.kind, 'feedback');
  assert.equal(frame.place, null);
  assert.deepEqual(frame.blocks, SERVICE_LIST);
});

test('a selfreflection post reads the service list with her virtual world after meanwhile', () => {
  // Bug: the writer's request is still built as a reply in the mirror, or the world block goes missing.
  const frame = frameOf(wakeInput(null, { mode: 'selfreflection', triggerKind: null }));
  assert.equal(frame.kind, 'selfreflection');
  assert.deepEqual(frame.blocks, SELFREFLECTION_LIST);
});

test('the selfreflection planner reads the same list as the writer', () => {
  // Bug: the planner has no entry in the table, and slice 6 finds an undefined list.
  assert.deepEqual(blocksOf('selfreflection_plan', null), SELFREFLECTION_LIST);
});

// ---- what a kind may not omit ----

test('every kind requires the persona, herself, her whereabouts and the task, and only a reply requires the chat', () => {
  // Bug: the list a kind may not omit forgets a kind, so a request goes out with no task.
  for (const kind of KINDS) {
    for (const block of ['persona', 'self', 'spatial_awareness', 'task'] as const)
      assert.ok(REQUIRED_BY_KIND[kind].includes(block), `${kind} requires ${block}`);
    assert.equal(REQUIRED_BY_KIND[kind].includes('chat'), kind === 'reply', kind);
  }
});

test('what a kind requires is on the list of that kind, with a place and without', () => {
  // Bug: the two tables drift apart, and a required block can never be emitted.
  const place = frameOf(frameInput()).place;
  for (const kind of KINDS) {
    for (const given of [place, null]) {
      const list = blocksOf(kind, given);
      for (const block of REQUIRED_BY_KIND[kind]) assert.ok(list.includes(block), `${kind} lists ${block}`);
    }
  }
});

// ---- the place, the counterpart, why she is awake ----

test('a reply without a place throws a FrameError with its code', () => {
  // Bug: the reply is built with no place, and she answers nowhere or into the wrong room.
  assert.throws(
    () => frameOf(frameInput({ chain: [] })),
    (error: unknown) => error instanceof FrameError && error.code === 'PLACE_REQUIRED'
  );
});

test('a room has its path by names from the interface down, and its root', () => {
  // Bug: the path comes in the chain's order, leaf first, and `<surroundings>` names the room before the server.
  const frame = frameOf(frameInput());
  assert.deepEqual(frame.place, {
    id: 'place:room',
    name: 'γενικά',
    kind: 'channel',
    path: ['fake', 'Αγορά', 'γενικά'],
  });
  assert.equal(frame.root?.id, 'place:root');
  assert.equal(frame.scope, 'group');
});

test("a one-to-one chat has no name and no root, and a request shows its path ending in the partner's handle", () => {
  // Bug: the unnamed row renders as an empty path, or a home server is made up as its root.
  // The owner's decision of 2026-11-10: one handle per person; a request names the partner by handle and holds no platform id.
  const frame = frameOf(frameInput({ chain: DM_CHAIN, dm: DM }));
  assert.equal(frame.place?.name, null);
  const place = frame.place ?? { id: '', name: null, kind: null, path: [] };
  assert.deepEqual(pathShown(frame, place, 'unnamed', '@uzoe1'), ['fake', 'private', '@uzoe1']);
  assert.equal(frame.root, null);
  assert.equal(frame.scope, 'dm');
});

test('a heartbeat has no place even when its wake rides on a room, and awake names the wake', () => {
  // Bug: the transport anchor of a wake is taken for where she is.
  const frame = frameOf(wakeInput('heartbeat', { chain: ROOM_CHAIN }));
  assert.equal(frame.place, null);
  assert.equal(frame.root, null);
  assert.equal(frame.scope, 'internal');
  assert.equal(frame.awake, 'wake');
  assert.equal(frame.wakeKind, 'heartbeat');
});

test('the counterpart of a group is the author of the trigger, and the frame answers that message', () => {
  // Bug: the counterpart stays empty in a group, or the answered message is lost.
  const frame = frameOf(frameInput());
  assert.deepEqual(frame.counterpart, AUTHOR);
  assert.deepEqual(frame.answers, { messageId: 'm1', authorId: '1111' });
  assert.equal(frame.awake, 'message');
});

test('the counterpart of a one-to-one chat is the partner when no message of theirs triggers the turn', () => {
  // Bug: the counterpart is read off the trigger, so an errand result in a one-to-one chat talks to nobody.
  const frame = frameOf(frameInput({ triggerKind: 'errand', chain: DM_CHAIN, dm: DM, trigger: null, author: null }));
  assert.deepEqual(frame.counterpart, PARTNER);
  assert.equal(frame.answers, null);
  assert.equal(frame.awake, 'errand');
});

test('a group turn with no trigger has no counterpart', () => {
  // Bug: an errand result whose origin message is gone invents an author.
  const frame = frameOf(frameInput({ triggerKind: 'errand', trigger: null, author: null }));
  assert.equal(frame.counterpart, null);
  assert.equal(frame.answers, null);
});

test('a selfreflection post is nowhere and awake says so', () => {
  // Bug: the writer inherits the mirror's place, and the post reads as a reply there.
  const frame = frameOf(wakeInput(null, { mode: 'selfreflection', triggerKind: null, chain: ROOM_CHAIN }));
  assert.equal(frame.place, null);
  assert.equal(frame.scope, 'internal');
  assert.equal(frame.awake, 'selfreflection');
});

// ---- which requests are the frame's own ----

test("every inner turn's request is the frame's own, with a place and without", () => {
  // Bug: a service or an intention keeps the old emission with `<wake>`, so its request has no `<meanwhile>` or `<memory>`.
  const inputs = [
    wakeInput('heartbeat'),
    wakeInput('selfimprovement'),
    wakeInput('intention_due'),
    wakeInput('intention_due', { chain: ROOM_CHAIN }),
    wakeInput('feedback'),
    wakeInput('feedback', { chain: ROOM_CHAIN }),
    frameInput({ triggerKind: 'errand' }),
  ];
  for (const input of inputs) {
    const frame = frameOf(input);
    assert.equal(framedRequest(frame), true, `${frame.kind} ${frame.place?.id ?? 'nowhere'}`);
  }
});

// ---- the kind of a turn ----

const KIND_CASES: ReadonlyArray<[Mode, TriggerKind, WakeKind, TurnKind]> = [
  ['reply', 'mention', null, 'reply'],
  ['reply', 'reply', null, 'reply'],
  ['reply', 'followUp', null, 'reply'],
  ['reply', 'overheard', null, 'reply'],
  ['reply', 'private', null, 'reply'],
  ['reply', 'missed', null, 'reply'],
  ['interject', null, null, 'reply'],
  ['initiate', null, null, 'reply'],
  ['elsewhere', null, null, 'reply'],
  ['reply', 'errand', null, 'errand_result'],
  ['interject', 'errand', null, 'errand_result'],
  ['inner', 'inner', 'heartbeat', 'heartbeat'],
  ['inner', 'inner', 'selfimprovement', 'selfimprovement'],
  ['inner', 'inner', 'intention_due', 'intention'],
  ['inner', 'inner', 'attend', 'intention'],
  ['inner', 'inner', 'errand_deadline', 'intention'],
  ['inner', 'inner', 'feedback', 'feedback'],
  ['selfreflection', null, null, 'selfreflection'],
];

for (const [mode, triggerKind, wakeKind, kind] of KIND_CASES) {
  test(`turnKindOf gives ${kind} for mode ${mode}, trigger ${String(triggerKind)}, wake ${String(wakeKind)}`, () => {
    // Bug: the three fields the callers still pass map to the wrong list of blocks.
    assert.equal(turnKindOf(mode, triggerKind, wakeKind), kind);
  });
}
