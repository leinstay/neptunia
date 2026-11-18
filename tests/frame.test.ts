// src/turn/request/frame.ts: the turn frame, the facts of one turn fixed before any block of its request. The lists are
// the root tags of the trees of the turn frame plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FrameError,
  frameOf,
  framedRequest,
  turnKindOf,
  type BlockName,
  type TurnKind,
} from '../src/turn/request/frame.ts';
import { AUTHOR, DM, DM_CHAIN, PARTNER, ROOM_CHAIN, frameInput, wakeInput } from './fixtures/frame-input.ts';

type Mode = Parameters<typeof turnKindOf>[0];
type TriggerKind = Parameters<typeof turnKindOf>[1];
type WakeKind = Parameters<typeof turnKindOf>[2];

// The owner on 2026-11-17: the block of custom emoji and stickers is <media>.
// The owner on 2026-11-17: the legend `<media>` stands right after `<meanwhile>` in every list.
// The owner's decision of 2026-11-11 (cache layout): what repeats between turns first, the turn's own blocks after
// `<chat>` and `<found>` a root tag of its own (.agents/docs/specs/2026-11-11-cache-layout-contract.md).
const REPLY_LIST: ReadonlyArray<BlockName> = [
  'persona',
  'self',
  'surroundings',
  'memory',
  'meanwhile',
  'media',
  'chat',
  'recall',
  'found',
  'inner',
  'spatial_awareness',
  'task',
];
// The owner's decision of 2026-11-11 (cache layout): `<meanwhile>` before the turn's own blocks.
const SERVICE_LIST: ReadonlyArray<BlockName> = [
  'persona',
  'self',
  'memory',
  'meanwhile',
  'media',
  'recall',
  'found',
  'inner',
  'spatial_awareness',
  'task',
];
// The owner's decision of 2026-11-11 (cache layout): `<meanwhile>`, then the turn's own blocks. The world block went on 2026-11-16.
// Changed: a diary entry is a service turn built as the heartbeat's, so `<meanwhile>`, `<recall>` and `<found>` left
// its list on purpose.
const DIARY_LIST: ReadonlyArray<BlockName> = [
  'persona',
  'self',
  'memory',
  'media',
  'inner',
  'spatial_awareness',
  'task',
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

test('a heartbeat reads its own list', () => {
  // Bug: the heartbeat keeps `<chat>` or `<surroundings>` of the place its wake rode in on.
  // Changed: the expectation was the service list; a heartbeat lists people and places in `<memory>` and draws
  // `<fragments>`, with no `<meanwhile>`, `<media>`, `<recall>` or `<found>` (spec 2026-11-17-heartbeat-own-request).
  const frame = frameOf(wakeInput('heartbeat'));
  assert.equal(frame.kind, 'heartbeat');
  assert.deepEqual(frame.blocks, ['persona', 'self', 'memory', 'inner', 'fragments', 'spatial_awareness', 'task']);
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

test('a diary post reads the service list after meanwhile', () => {
  // Bug: the writer's request is still built as a reply in the mirror.
  const frame = frameOf(wakeInput(null, { mode: 'diary', triggerKind: null }));
  assert.equal(frame.kind, 'diary');
  assert.deepEqual(frame.blocks, DIARY_LIST);
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

test('a one-to-one chat has no name and no root, and its row holds no name', () => {
  // Bug: the unnamed row renders as an empty path, or a home server is made up as its root.
  // The owner's decision of 2026-11-10: one handle per person; a request names the partner by handle and holds no platform id.
  const frame = frameOf(frameInput({ chain: DM_CHAIN, dm: DM }));
  assert.equal(frame.place?.name, null);
  // The owner's decision of 2026-11-11 (a place reads in words): a request no longer shows a path with the scope word
  // `private`, so the assertion on `pathShown`'s `['fake', 'private', '@uzoe1']` is gone; the reference is tested in
  // tests/request-text.test.ts and tests/request-surroundings.test.ts.
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

test('a diary post is nowhere and awake says so', () => {
  // Bug: the writer inherits the mirror's place, and the post reads as a reply there.
  const frame = frameOf(wakeInput(null, { mode: 'diary', triggerKind: null, chain: ROOM_CHAIN }));
  assert.equal(frame.place, null);
  assert.equal(frame.scope, 'internal');
  assert.equal(frame.awake, 'diary');
});

// ---- which requests are the frame's own ----

test("every inner turn's request is the frame's own, with a place and without", () => {
  // Bug: a service or an intention keeps the old emission with `<wake>`, so its request has no `<meanwhile>` or `<memory>`.
  const inputs = [
    wakeInput('heartbeat'),
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
  ['inner', 'inner', 'intention_due', 'intention'],
  ['inner', 'inner', 'attend', 'intention'],
  ['inner', 'inner', 'errand_deadline', 'intention'],
  ['inner', 'inner', 'feedback', 'feedback'],
  ['diary', null, null, 'diary'],
];

for (const [mode, triggerKind, wakeKind, kind] of KIND_CASES) {
  test(`turnKindOf gives ${kind} for mode ${mode}, trigger ${String(triggerKind)}, wake ${String(wakeKind)}`, () => {
    // Bug: the three fields the callers still pass map to the wrong list of blocks.
    assert.equal(turnKindOf(mode, triggerKind, wakeKind), kind);
  });
}
