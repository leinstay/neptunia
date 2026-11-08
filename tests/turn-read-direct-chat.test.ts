// conversation.read of a person's direct chat (plan 2026-11-08-meta-person, fault 2): a direct chat has no channel
// handle, so she names the person instead, and the read takes that person's newest direct chat other than the one she
// stands in, on any interface. The audience rule that decides any read of a stored place decides this one: the owner's
// command line reads his chat on another interface, a group turn reads no direct chat. A refusal never shows the lines.
// Synthetic names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/tools/operations/index.ts';
import { createInTurnTools } from '../src/turn/in-turn-tools.ts';
import { turnRoutes } from '../src/behavior/turn-ability-route.ts';
import { frameReadsOver } from '../src/memory/db/frame-reads.ts';
import { groupContext, internalContext } from '../src/memory/db/scope.ts';
import type { Context } from '../src/memory/db/scope.ts';
import { addDm, addLine, addPerson, noteInterface, openWorld } from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';
import { rig, channel } from './fixtures/reads-rig.ts';
import { labels } from './fixtures/labels.ts';

const OWNER = 'person:owner';
const SECRET = 'a line of the owner in his chat on the fake interface';

/** The owner with a chat on the fake interface and on the command line; the turn stands in the command line's chat. */
function ownerWorld(): World {
  const w = openWorld();
  noteInterface(w, 'fake', [{ id: 'g1', name: 'Agora' }]);
  addPerson(w.db, {
    id: OWNER,
    accounts: [
      { id: 'fake:777', iface: 'fake', native: '777', names: ['Orestis'] },
      { id: 'cli:owner', iface: 'cli', native: 'owner', names: ['Orestis'] },
    ],
  });
  const fakeDm = addDm(w.db, { iface: 'fake', native: '777', person: OWNER, account: 'fake:777' });
  const cliDm = addDm(w.db, { iface: 'cli', native: 'owner', person: OWNER, account: 'cli:owner' });
  addLine(w.db, {
    id: 'f1',
    iface: 'fake',
    place: fakeDm,
    author: 'fake:777',
    text: SECRET,
    at: '2026-11-02T09:00:00.000Z',
    audience: { dm: fakeDm, iface: 'fake', person: OWNER },
  });
  addLine(w.db, {
    id: 'c1',
    iface: 'cli',
    place: cliDm,
    author: 'cli:owner',
    text: 'a line of the command line',
    at: '2026-11-02T09:30:00.000Z',
    audience: { dm: cliDm, iface: 'cli', person: OWNER },
  });
  return w;
}

async function readPerson(
  world: World,
  context: Context,
  person: string
): Promise<{ status: string; code?: string; data?: { text: string } }> {
  const io = rig();
  const hot = { config: { bot: { timezone: 'UTC' }, features: { coreTools: true } }, prompts: { labels } };
  const tools = createInTurnTools({
    hot,
    store: { listUserProfiles: () => [] },
    recall: null,
    speech: null,
    record: null,
    routes: turnRoutes(hot, null),
    clock: () => Date.parse('2026-11-02T10:00:00.000Z'),
    ifaceReads: io.reads,
    lookup: undefined,
    describer: undefined,
    memberOf: () => null,
    chatOf: (current) => ({ iface: 'cli', chatId: current.id }),
    turnContextOf: () => context,
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
  return (await handlers['conversation.read']({ person, last: 10 })) as {
    status: string;
    code?: string;
    data?: { text: string };
  };
}

test("the owner's command line reads his direct chat on another interface named by his name", async () => {
  // Bug: a direct chat has no handle, so she cannot name the owner's chat on another interface and reads nothing.
  const world = ownerWorld();
  try {
    const read = await readPerson(world, internalContext(), 'Orestis');
    assert.equal(read.status, 'ok', JSON.stringify(read));
    const text = read.data?.text ?? '';
    assert.ok(text.includes(SECRET), text);
    assert.equal(text.includes('a line of the command line'), false, 'not the chat she stands in');
  } finally {
    world.close();
  }
});

test('a group turn naming a person reads none of their direct chats', async () => {
  // Bug: naming a person opens their private chat to a context that may read only the groups.
  const world = ownerWorld();
  try {
    const read = await readPerson(world, groupContext('fake'), 'Orestis');
    assert.notEqual(read.status, 'ok', JSON.stringify(read));
    assert.equal(JSON.stringify(read).includes(SECRET), false);
  } finally {
    world.close();
  }
});

test('a person nobody is called is refused with the reason and nothing is read', async () => {
  // Bug: an unknown person falls back to the chat she stands in, or to some other chat.
  const world = ownerWorld();
  try {
    const read = await readPerson(world, internalContext(), 'Theofilos');
    assert.equal(read.code, 'unknown-member', JSON.stringify(read));
    assert.equal(JSON.stringify(read).includes(SECRET), false);
  } finally {
    world.close();
  }
});
