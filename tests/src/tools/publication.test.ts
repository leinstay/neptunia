// The trusted publication boundary restricts one adapter binding without changing shared adapter authority.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import {
  bindPublicationPort,
  publicationRefusal,
  turnBoundary,
  type PublicationBoundary,
} from '../../../src/tools/publication.ts';
import { issueContext } from '../../../src/memory/db/scope.ts';
import { createStore } from '../../../src/memory/store.ts';
import { diaryRows, entryOf } from '../../fixtures/diary-mirror.ts';
import { ROOT, sceneRunner } from '../../fixtures/diary-requests-recorded.ts';
import { mirrorScene, type Scene, T0 } from '../../fixtures/mirror-scene.ts';
import { directorAnswer } from '../../fixtures/scene-answer.ts';
import { call, toolAnswer } from '../../fixtures/tool-answers.ts';
import { drawTurn, fakeImages } from '../../fixtures/turn-draws.ts';
import { freshWorld, useIface, world } from '../../fixtures/turn-world.ts';

const boundary: PublicationBoundary = { kind: 'internal-turn', origin: { iface: 'fake', chatId: 'origin' } };

test('a publication boundary distinguishes equal chat IDs on different interfaces', () => {
  assert.equal(publicationRefusal(boundary, { iface: 'fake', chatId: 'origin' }), null);
  assert.deepEqual(publicationRefusal(boundary, { iface: 'other', chatId: 'origin' }), {
    status: 'denied',
    code: 'not-allowed',
    reason: 'publication-boundary',
  });
});

test('a bound port retains private replies while an independent ordinary binding remains unrestricted', async () => {
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self', now: () => 1000 });
  const restricted = bindPublicationPort(port, boundary);
  const ordinary = bindPublicationPort(port, null);
  const refused = await restricted.send({ iface: 'fake', chatId: 'group' }, { text: 'private body' });
  assert.deepEqual([refused.status, refused.error?.code], ['failed', 'not-allowed']);
  assert.deepEqual(port.messagesIn('group'), []);
  const privateAnswer = await restricted.send(boundary.origin, { text: 'private answer' });
  assert.equal(privateAnswer.status, 'ok');
  assert.equal(restricted.messagesIn('origin')[0].text, 'private answer');
  const ordinaryAnswer = await ordinary.send({ iface: 'fake', chatId: 'group' }, { text: 'ordinary answer' });
  assert.equal(ordinaryAnswer.status, 'ok');
  assert.equal(port.messagesIn('group')[0].text, 'ordinary answer');
});

test('a bound port blocks edits and reaction additions but preserves reads and deletion', async () => {
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self', now: () => 1000 });
  port.seed('group', { messageId: 'own', authorId: 'self', text: 'original' });
  const ref = { iface: 'fake', chatId: 'group', messageId: 'own' };
  const restricted = bindPublicationPort(port, boundary);
  const edit = await restricted.edit(ref, { text: 'private replacement' });
  const reaction = await restricted.react(ref, 'yes');
  assert.deepEqual(
    [edit.status, edit.error?.code, reaction.status, reaction.error?.code],
    ['failed', 'not-allowed', 'failed', 'not-allowed']
  );
  assert.equal(port.messagesIn('group')[0].text, 'original');
  assert.equal(port.messagesIn('group')[0].reactions.size, 0);
  const read = await restricted.fetchMessages(ref, ['own']);
  assert.equal(read.status, 'ok');
  if (read.status !== 'ok') throw new Error('ordinary stored read was refused');
  assert.equal(read.messages.length, 1);
  assert.equal((await restricted.delete(ref)).status, 'ok');
});

test('a bound port preserves the receiver and own members of an adapter subtype', async () => {
  const fake = createFakeAdapter({ iface: 'fake', selfId: 'self', now: () => 1000 });
  const port = {
    ...fake,
    marker: 'receiver-731',
    send(...args: Parameters<typeof fake.send>) {
      assert.equal(this, port);
      assert.equal(this.marker, 'receiver-731');
      return fake.send(...args);
    },
  };
  const bound = bindPublicationPort(port, boundary);
  assert.equal(bound.marker, 'receiver-731');
  assert.equal((await bound.send(boundary.origin, { text: 'private answer' })).status, 'ok');
  assert.equal(port.messagesIn('origin')[0].text, 'private answer');
});

test('a diary turn under an open context keeps no boundary, so its entry is a group row its mirrors take', () => {
  // Bug: the open mark restricts the diary's entry as an internal turn's, and no mirror ever takes its copy.
  const origin = { iface: 'discord', chatId: 'c1' };
  const diaryDraft = (open: boolean) => ({
    nowhere: true,
    mode: 'diary',
    memoryContext: issueContext({ kind: 'group', iface: 'discord', destination: null, open, now: () => 0 }),
  });
  assert.equal(turnBoundary(diaryDraft(true), origin), undefined);
  assert.equal(turnBoundary(diaryDraft(false), origin), undefined);
});

const TEXT = 'ήσυχο βράδυ στο λιμάνι';

const ROOT_PLACE = 'fake:root:g1';

const D1 = 'fake:channel:d1';

/** A model whose plan is a thought and whose writer says `answer`; it keeps every request. */
function modelSaying(answer: string) {
  const calls: Array<unknown> = [];
  return {
    calls,
    complete: (messages: unknown, options?: { purpose?: string }) => {
      calls.push(structuredClone(messages));
      return Promise.resolve(directorAnswer(messages, options) ?? { text: answer, usage: {}, estimated: 5 });
    },
  };
}

/**
 * Two interfaces that share native ids: `fake` and `other`, each with a root `g1` and a channel `d1`, `fake` with
 * another channel `d2` and a channel `d3` outside the root, a private chat, and enabled mirrors as named.
 */
async function places(mirrorOn: ReadonlyArray<'fake:d1' | 'fake:d2' | 'fake:d3' | 'other:d1'> = []) {
  const scene = await mirrorScene({ ifaces: ['fake', 'other'] });
  const fakeRoot = scene.place({ iface: 'fake', native: 'g1', kind: 'root' });
  const otherRoot = scene.place({ iface: 'other', native: 'g1', kind: 'root' });
  scene.place({ iface: 'fake', native: 'd1', parent: fakeRoot });
  scene.place({ iface: 'fake', native: 'd2', parent: fakeRoot });
  scene.place({ iface: 'fake', native: 'd3' });
  scene.place({ iface: 'other', native: 'd1', parent: otherRoot });
  scene.place({ iface: 'fake', native: 'u1', kind: 'dm' });
  for (const one of mirrorOn) {
    const [iface, chatId] = one.split(':') as [string, string];
    scene.db
      .prepare(
        "INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by, extra) VALUES (?, 'diary', ?, 1, ?, 'owner', NULL)"
      )
      .run(`mirror:test:${one}`, `${iface}:channel:${chatId}`, new Date(T0).toISOString());
  }
  return scene;
}

/** One diary turn in which the persona answers `answer`, over the scene's memory: the turn's result and the model's requests. */
async function writeEntry(scene: Scene, answer: string) {
  freshWorld();
  world().channel({ id: 'd1', name: 'journal', placeId: ROOT });
  const store = createStore({ dataDir: scene.memory.dataDir, memoryDb: scene.memory.memoryDb });
  const model = modelSaying(answer);
  const result = await sceneRunner(model, store).runTurn({
    mode: 'diary',
    diary: { kind: 'thought', forced: true },
    placeId: ROOT,
  });
  await store.flushSettled({});
  return { result, entry: entryOf(result), store, writer: model.calls.at(-1) };
}

/** What the persona's turn said about the audience they named. */
const audienceOf = (result: unknown): unknown => (result as { diary?: { audience?: unknown } }).diary?.audience;

/** Every destination a send was attempted to, as `<iface>:<chat>`, sorted. */
function reached(scene: Scene): Array<string> {
  const out: Array<string> = [];
  for (const iface of ['fake', 'other'])
    for (const attempt of scene.transport(iface).attempts) out.push(`${iface}:${attempt.chatId}`);
  return out.sort();
}

test('leaving the audience out records an unrestricted entry that reaches every interface', async () => {
  // Catches: an omitted audience stored as nothing, which is what an old ambiguous entry looks like.
  const scene = await places(['fake:d1', 'other:d1']);
  const { result, entry } = await writeEntry(scene, `<msg>${TEXT}</msg>`);
  assert.deepEqual(audienceOf(result), { ok: true, audience: { kind: 'unrestricted' } });
  await scene.publisher().publishEntry(entry);
  assert.deepEqual(reached(scene), ['fake:d1', 'other:d1']);
});

test('a root audience names no mirror, so it is refused and reaches no channel', async () => {
  // Catches: the persona's choice resolved against every group place memory knows instead of the mirrors listed to them.
  // The places the persona may name are the mirrors alone, so a root that is no mirror is an unknown place and
  // the entry stays in their diary, copied nowhere, as any unlisted token is.
  const scene = await places(['fake:d1', 'fake:d2', 'fake:d3', 'other:d1']);
  const { result, entry } = await writeEntry(scene, `<audience>place:${ROOT_PLACE}</audience><msg>${TEXT}</msg>`);
  assert.deepEqual(audienceOf(result), { ok: false, code: 'audience-unknown-place' });
  await scene.publisher().publishEntry(entry);
  assert.deepEqual(reached(scene), []);
});

for (const [value, code] of [
  ['place:fake:channel:nowhere', 'audience-unknown-place'],
  ['place:d1', 'audience-unknown-place'],
  ['place:fake:dm:u1', 'audience-unknown-place'],
  ['interface:nothing', 'audience-unknown-interface'],
  ['everywhere', 'audience-malformed'],
  ['place:', 'audience-malformed'],
  ['', 'audience-malformed'],
] as const) {
  test(`the audience "${value}" fails closed with ${code}, keeps the entry and publishes nothing`, async () => {
    // Catches: a bad value read as no restriction, which publishes what the persona meant to hold back.
    const scene = await places(['fake:d1', 'other:d1']);
    const { result, entry } = await writeEntry(scene, `<audience>${value}</audience><msg>${TEXT}</msg>`);
    assert.deepEqual(audienceOf(result), { ok: false, code });
    assert.equal(diaryRows(scene.memory.memoryDb)[0]?.text, TEXT, 'memory holds the entry');
    const outcomes = await scene.publisher().publishEntry(entry);
    assert.deepEqual(reached(scene), []);
    assert.ok(
      outcomes.length === 2 && outcomes.every((one) => one.status === 'failed' && one.code === 'audience-invalid')
    );
    await scene.publisher().drainQueued();
    assert.deepEqual(reached(scene), []);
  });
}

test('two different audiences in one answer fail closed', async () => {
  // Catches: "the first one wins", when the second one may be the narrower thing the persona meant.
  const scene = await places(['fake:d1']);
  const { result, entry } = await writeEntry(
    scene,
    `<audience>unrestricted</audience><audience>place:${D1}</audience><msg>${TEXT}</msg>`
  );
  assert.deepEqual(audienceOf(result), { ok: false, code: 'audience-malformed' });
  await scene.publisher().publishEntry(entry);
  assert.deepEqual(reached(scene), []);
});

const NOW = Date.parse('2026-11-03T12:00:00Z');

describe('a publication in a turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('an internal turn refuses direct drawing in another chat before generation', async () => {
    const images = fakeImages();
    const context = issueContext({ kind: 'internal', newId: () => 'ctx:draw-internal', now: () => NOW });
    const result = await drawTurn({
      images,
      setup: () => {
        world().channel({ id: '555', name: 'destination' });
      },
      answers: [toolAnswer('', [call('draw.create', { people: [], place: '555', text: 'private scene' })]), '<skip/>'],
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
    const { internalContext } = await import('../../../src/memory/db/scope.ts');
    const images = fakeImages();
    const result = await drawTurn({
      images,
      setup: () => {
        world().channel({ id: '555', name: 'destination' });
      },
      answers: [toolAnswer('', [call('draw.create', { people: [], place: '555', text: 'ordinary scene' })]), '<skip/>'],
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
      answers: [toolAnswer('', [call('draw.create', { people: [], place: '555', text: 'private scene' })]), '<skip/>'],
      params: {
        publicationBoundary: { kind: 'internal-turn', origin: { iface: 'fake', chatId: 'cli-origin' } },
      },
    });
    assert.deepEqual(images.calls, []);
    assert.deepEqual(result.port.messagesIn('555'), []);
  });
});
