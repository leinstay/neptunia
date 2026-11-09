// The address of a direct chat is the interface's: the core stores the chat id a `message.received` carries on the
// place (`places.native_id`), for a direct chat as for a channel, and hands it back as it is for every read of the
// place. A direct chat whose place holds no address yet is opened once through the `dm.chat` read and the answer is
// stored through the one writer. A read that fails tells her the interface's code. Real temporary databases, the fake
// interface, synthetic names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/tools/operations/index.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { observe } from '../src/memory/db/observe.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { createInTurnTools } from '../src/turn/in-turn-tools.ts';
import { turnRoutes } from '../src/behavior/turn-ability-route.ts';
import { frameReadsOver } from '../src/memory/db/frame-reads.ts';
import { internalContext } from '../src/memory/db/scope.ts';
import { notOk } from '../src/protocol/actions.ts';
import { postingChat } from '../src/tools/operations/shared.ts';
import type { PostingContext } from '../src/tools/operations/shared.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { addDm, addPerson, noteInterface, openWorld } from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';
import { rig, channel, message } from './fixtures/reads-rig.ts';
import type { Rig } from './fixtures/reads-rig.ts';
import { labels } from './fixtures/labels.ts';

const NOW = Date.parse('2026-11-02T10:00:00.000Z');
const quiet = { info() {}, warn() {}, error() {} };
const OWNER = 'person:owner';
const PARTNER = '777';
const DM_CHAT = 'dm-chat-41';
const LINE = 'a line of the owner in his direct chat';

function dmEvent(chatId: string, id: string): Record<string, unknown> {
  return {
    kind: 'message.received',
    iface: 'other',
    at: NOW,
    id: `other:message:${id}`,
    chat: { id: chatId, kind: 'dm', chatType: 'dm', partnerId: PARTNER, rootId: null },
    message: {
      id,
      author: { id: PARTNER, name: 'Orestis', self: false, bot: false },
      content: 'γεια',
      at: NOW,
      replyToId: null,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
  };
}

function dmAddresses(events: ReadonlyArray<Record<string, unknown>>): Array<unknown> {
  const handle = openMemoryDb(':memory:');
  try {
    for (const event of events) {
      const result = observe(handle, observationOf(event), { now: () => NOW, log: quiet });
      assert.equal(result.ok, true, JSON.stringify(result));
    }
    return dbOf(handle)
      .prepare("SELECT native_id FROM places WHERE kind = 'dm'")
      .all()
      .map((row) => row.native_id);
  } finally {
    handle.close();
  }
}

test('a direct message stores the chat id the interface gave as its place address', () => {
  // Bug: the core keyed a direct chat by its partner and dropped the chat's address, so no read could reach the chat.
  assert.deepEqual(dmAddresses([dmEvent(DM_CHAT, 'm1')]), [DM_CHAT]);
});

test('a direct chat stored without an address takes it from its next message', () => {
  // Bug: a direct chat observed before addresses were stored keeps none for good.
  const handle = openMemoryDb(':memory:');
  try {
    observe(handle, observationOf(dmEvent(DM_CHAT, 'm1')), { now: () => NOW, log: quiet });
    dbOf(handle).prepare("UPDATE places SET native_id = NULL WHERE kind = 'dm'").run();
    observe(handle, observationOf(dmEvent(DM_CHAT, 'm2')), { now: () => NOW, log: quiet });
    const rows = dbOf(handle).prepare("SELECT native_id FROM places WHERE kind = 'dm'").all();
    assert.deepEqual(
      rows.map((row) => row.native_id),
      [DM_CHAT]
    );
  } finally {
    handle.close();
  }
});

/** The owner with a direct chat on the fake interface whose place holds `address`; the turn stands in the command line. */
function ownerWorld(address: string | null): { world: World; place: string } {
  const world = openWorld();
  noteInterface(world, 'fake', [{ id: 'g1', name: 'Agora' }]);
  addPerson(world.db, {
    id: OWNER,
    accounts: [
      { id: 'fake:777', iface: 'fake', native: PARTNER, names: ['Orestis'] },
      { id: 'cli:owner', iface: 'cli', native: 'owner', names: ['Orestis'] },
    ],
  });
  const place = addDm(world.db, { iface: 'fake', native: PARTNER, person: OWNER, account: 'fake:777' });
  addDm(world.db, { iface: 'cli', native: 'owner', person: OWNER, account: 'cli:owner' });
  world.db.prepare('UPDATE places SET native_id = ? WHERE id = ?').run(address, place);
  return { world, place };
}

/** The fake interface holding the owner's direct chat `DM_CHAT` with one line of his. */
function dmRig(): Rig {
  const io = rig();
  const dm = channel(DM_CHAT, { kind: 'dm', rootId: null, public: false });
  io.fake.seedChat(dm);
  io.fake.seedEvent(message(dm, 'm1', NOW - 60_000, LINE, { authorId: PARTNER, authorName: 'Orestis' }));
  return io;
}

type ReadAnswer = { status: string; code?: string; values?: Record<string, unknown>; data?: { text: string } };

/** One conversation.read of the place `place` from the command line chat, through the in-turn tools. */
async function readPlace(world: World, io: Rig, place: string): Promise<ReadAnswer> {
  const hot = { config: { bot: { timezone: 'UTC' }, features: { coreTools: true } }, prompts: { labels } };
  const tools = createInTurnTools({
    hot,
    store: {
      listUserProfiles: () => [],
      notePlaceAddress: (placeId: string, address: string) =>
        Promise.resolve(applyMemoryWrite(world.db, { kind: 'place-address', placeId, address })),
    },
    recall: null,
    speech: null,
    record: null,
    routes: turnRoutes(hot, null),
    clock: () => NOW,
    ifaceReads: io.reads,
    lookup: undefined,
    describer: undefined,
    memberOf: () => null,
    chatOf: (current) => ({ iface: 'cli', chatId: current.id }),
    turnContextOf: () => internalContext(),
    placeReads: frameReadsOver(
      () => world.db,
      () => hot.config
    ),
    linkCalls: (lines) => lines,
    drawTool: () => Promise.reject(new Error('drawing is outside this fixture')),
  });
  const handlers = tools.inTurnTools({
    channel: channel('cli:dm:owner'),
    placeId: 'cli:dm:owner',
    selfId: 'self',
    selfName: 'Synthetic persona',
    history: [],
    draft: {},
  });
  return (await handlers['conversation.read']({ placeId: place, last: 10 })) as ReadAnswer;
}

const chatsAsked = (io: Rig): Array<unknown> => io.asked('history').map((ref) => (ref as { chatId: string }).chatId);

test("a read of a direct chat reaches the interface's chat through the address its place holds", async () => {
  // Bug: the read asked the interface for a chat named by the partner's user id, which the platform answers with 404.
  const { world, place } = ownerWorld(DM_CHAT);
  try {
    const io = dmRig();
    const read = await readPlace(world, io, place);
    assert.equal(read.status, 'ok', JSON.stringify(read));
    assert.ok(read.data?.text.includes(LINE), JSON.stringify(read));
    assert.deepEqual(chatsAsked(io), [DM_CHAT]);
    assert.equal(io.asked('dmChatOf').length, 0);
  } finally {
    world.close();
  }
});

test('a direct chat whose place holds no address is opened once through dm.chat and the answer is stored', async () => {
  // Bug: a direct chat seen before addresses were stored can never be read, or every read opens the chat again.
  const { world, place } = ownerWorld(null);
  try {
    const io = dmRig();
    io.fake.seedDmChat(PARTNER, DM_CHAT);
    const first = await readPlace(world, io, place);
    assert.equal(first.status, 'ok', JSON.stringify(first));
    assert.ok(first.data?.text.includes(LINE), JSON.stringify(first));
    assert.equal(world.db.prepare('SELECT native_id FROM places WHERE id = ?').get(place)?.native_id, DM_CHAT);
    const second = await readPlace(world, io, place);
    assert.equal(second.status, 'ok', JSON.stringify(second));
    assert.equal(io.asked('dmChatOf').length, 1);
    assert.deepEqual(chatsAsked(io), [DM_CHAT, DM_CHAT]);
  } finally {
    world.close();
  }
});

test("a read the interface answers with 404 tells her the interface's status, not a bare error", async () => {
  // Bug: every failed history read reached her as `error`, so she could not tell a gone chat from a broken engine.
  const { world, place } = ownerWorld(DM_CHAT);
  try {
    const io = dmRig();
    io.fake.failNext('history', notOk('failed', 'http-404'));
    const read = await readPlace(world, io, place);
    assert.deepEqual([read.status, read.code, read.values?.status], ['failed', 'http', '404'], JSON.stringify(read));
  } finally {
    world.close();
  }
});

/** A post of hers from the command line chat to the place `place`, with direct chats on: the chat it would go to. */
function postTo(world: World, io: Rig, place: string): Promise<string> {
  const reads = frameReadsOver(
    () => world.db,
    () => ({})
  );
  return postingChat({
    reads: io.reads,
    store: {
      placeRefOf: (id: string) => reads.placeRef?.(id) ?? null,
      notePlaceAddress: (placeId: string, address: string) =>
        Promise.resolve(applyMemoryWrite(world.db, { kind: 'place-address', placeId, address })),
    },
    iface: 'cli',
    chatId: place,
    context: {
      placeId: 'cli:dm:owner',
      env: wrongly<NonNullable<PostingContext['env']>>({ hot: { config: { dm: { enabled: true } } } }),
    },
    need: 'send',
  });
}

test('a post to a direct chat from another place goes to the address its place holds', async () => {
  // Bug: her message into a person's direct chat was addressed to the user id, which the platform answers with 404.
  const { world, place } = ownerWorld(DM_CHAT);
  try {
    const io = dmRig();
    assert.equal(await postTo(world, io, place), DM_CHAT);
    assert.equal(io.asked('dmChatOf').length, 0);
  } finally {
    world.close();
  }
});

test('her first post to a direct chat that holds no address opens it once through dm.chat and stores it', async () => {
  // Bug: writing first to a person whose direct chat holds no address went nowhere.
  const { world, place } = ownerWorld(null);
  try {
    const io = dmRig();
    io.fake.seedDmChat(PARTNER, DM_CHAT);
    assert.equal(await postTo(world, io, place), DM_CHAT);
    assert.equal(await postTo(world, io, place), DM_CHAT);
    assert.equal(io.asked('dmChatOf').length, 1);
    assert.equal(world.db.prepare('SELECT native_id FROM places WHERE id = ?').get(place)?.native_id, DM_CHAT);
  } finally {
    world.close();
  }
});
