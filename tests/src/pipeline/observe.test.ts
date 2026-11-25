import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directIn, postedIn, seedDm, waitFor, withFakes } from '../../fixtures/two-fakes.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { withIface } from '../../../src/memory/db/current-iface.ts';
import { isOwnerId } from '../../../src/tools/operations/grants.ts';
import { query, spawnCli, startUnitsCore, until, withRig } from '../../fixtures/core-units.ts';
import type { Dirs, Rig } from '../../fixtures/core-units.ts';
import { createEventDoor } from '../../../src/interface/door.ts';
import { createObserve } from '../../../src/pipeline/observe.ts';
import type { ObserveWhere } from '../../../src/pipeline/observe.ts';
import { createIngestRecord } from '../../../src/memory/db/ingest.ts';
import type { MessageEvent } from '../../../src/pipeline/edits.ts';
import { openTestMemory } from '../../fixtures/memory-db/service.ts';

// A DM from ingestion to the model's request on an interface that serves no root, through the real link. Fake
// interfaces, a scripted model and temporary folders. The gate stays closed for a stranger: having no root to check
// membership in is no reason to answer anyone.

const ROOT_PLACES = "SELECT id FROM places WHERE kind = 'guild' ORDER BY id";

test('a core with no root at all answers the owner in a DM and makes up no root', async () => {
  // Bug: every step asks for the home root first, so the DM is dropped or kept under an invented root.
  await withFakes({ owners: ['u1'], names: ['solo'] }, async ({ connect, requests, rows }) => {
    const solo = await connect('solo', []);
    seedDm(solo, 'd1', 'u1');
    await directIn(solo, 'd1', 'u1', 'm1');
    await waitFor(() => postedIn(solo, 'd1').length > 0, 'the answer to the DM');
    assert.equal(requests.length, 1);
    assert.deepEqual(rows(ROOT_PLACES), []);
    const audiences = rows("SELECT DISTINCT audience_id FROM sources WHERE scope_kind = 'dm'");
    assert.deepEqual(audiences, [{ audience_id: 'aud:dm:solo:dm:u1' }]);
  });
});

// The command line belongs to the owner: only the `cli` principal speaks as `iface: 'cli'`, so its account is the owner's
// from the first line, on an install nobody prepared. Each test runs the real core and the real `neptunia` command over
// fresh folders, because the link spans the observation, the writer and the setting. Synthetic ids only.

const configOf = (dirs: Dirs): { bot: { ownerPerson: string } } =>
  JSON.parse(readFileSync(path.join(dirs.privateDir, 'config', 'config.json'), 'utf8')) as {
    bot: { ownerPerson: string };
  };

const cliAccount = (dirs: Dirs) =>
  query(dirs, "SELECT id, person_id, link FROM accounts WHERE iface = 'cli' AND native_key = 'owner'")[0];

/** The owner types one line in the chat of the command line; returns once the line is stored. */
async function firstLine({ dirs, clis }: Pick<Rig, 'dirs' | 'clis'>): Promise<void> {
  const chat = spawnCli(dirs, []);
  clis.push(chat);
  chat.type('the first line of a new install');
  await until(
    () => query(dirs, "SELECT 1 FROM sources WHERE iface = 'cli' AND kind = 'seen'").length > 0,
    () => chat.stderr()
  );
}

const ownerOn = (iface: string, native: string, config: object): boolean =>
  withIface(iface, () => isOwnerId(config, native));

test('on a raw install the first line of the command line makes the owner person, and the line already sits under it', async () => {
  // Bug: `neptunia setup` provisions a client and nothing else, so the owner stays a stranger in the owner's own chat, the persona gives
  // the owner a separate tracked person, and the owner's facts split between the chat and every other interface.
  await withRig({}, async ({ dirs, llm, clis, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    await firstLine({ dirs, clis });
    const account = cliAccount(dirs);
    assert.match(String(account?.person_id), /^person:/, 'the account has a person from its first line');
    assert.equal(account?.link, 'verified');
    assert.deepEqual(
      query(dirs, 'SELECT partner_person FROM places WHERE partner_account = ?', account?.id),
      [{ partner_person: account?.person_id }],
      'the DM of the chat names the owner as well'
    );
    assert.deepEqual(
      query(dirs, "SELECT scope_dm FROM sources WHERE iface = 'cli' AND kind = 'seen'"),
      [{ scope_dm: account?.person_id }],
      'the first line itself is scoped to the person of the owner'
    );
    await until(() => configOf(dirs).bot.ownerPerson === account?.person_id, 'bot.ownerPerson names that person');
    assert.equal(ownerOn('cli', 'owner', configOf(dirs)), true);
  });
});

// Real observation writes retain the receipt of the accepted event across overlapping messages.

const NOW = Date.parse('2026-10-24T12:00:00Z');
const quiet = { info() {}, warn() {} };
function message(id: string, room: string, content: string, edit = false): MessageEvent {
  return {
    kind: 'message.received',
    iface: 'synthetic',
    id,
    at: NOW,
    edit,
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
    chat: { id: room, kind: 'channel', chatType: 'channel', rootId: 'root' },
    message: {
      id: 'same-message',
      at: NOW - 60000,
      content,
      author: { id: 'member', name: 'Member', self: false, bot: false },
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
  };
}

for (const sameFamily of [false, true]) {
  test(`overlapping accepted ${sameFamily ? 'edits of one family' : 'messages in separate chats'} keep their own receipts`, async () => {
    const memory = await openTestMemory({ now: () => NOW });
    try {
      const ingest = createIngestRecord({ memoryDb: memory.memoryDb, hot: memory.hot, now: () => NOW });
      const firstDone = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      let writes = 0;
      const observed = createObserve({
        hot: memory.hot,
        selfIdOf: () => 'self',
        timers: { set: () => null, clear() {} },
        memoryDb: {
          ...memory.memoryDb,
          observeMessage: async (envelope: object, where: ObserveWhere) => {
            const result = await memory.memoryDb.observeMessage(envelope, where);
            writes += 1;
            if (writes === 1) {
              entered.resolve();
              await firstDone.promise;
            }
            return result;
          },
        },
      });
      const door = createEventDoor({
        log: quiet,
        ingest,
        handlers: {
          'message.received': async (event: MessageEvent, context) => {
            await observed.observeLine(
              event,
              false,
              { placeId: 'root' },
              context.receipt
                ? {
                    eventId: context.receipt.eventId,
                    locator: { iface: event.iface, chatId: event.chat.id, messageId: event.message.id },
                    receipt: context.receipt,
                  }
                : undefined
            );
          },
        },
      });
      const a = door.submit(message('first-event', 'room-a', 'First body', sameFamily), {
        principal: 'adapter',
        seq: 1,
      });
      await Promise.race([entered.promise, a]);
      const b = await door.submit(
        message('second-event', sameFamily ? 'room-a' : 'room-b', 'Second body', sameFamily),
        { principal: 'adapter', seq: 2 }
      );
      firstDone.resolve();
      assert.equal((await a).status, 'ok');
      assert.equal(b.status, 'ok');
      const db = memory.memoryDb.database();
      if (!db) throw new Error('database unavailable');
      assert.deepEqual(
        db
          .prepare('SELECT i.event_id, s.text FROM ingest i JOIN sources s ON s.id = i.source_id ORDER BY i.seq')
          .all()
          .map((row) => [row.event_id, row.text]),
        [
          ['first-event', 'First body'],
          ['second-event', 'Second body'],
        ]
      );
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_families').get()?.n, sameFamily ? 1 : 2);
    } finally {
      await memory.close();
    }
  });
}

test('an observation timeout is unacknowledged until its late writer commit becomes durable', async () => {
  const memory = await openTestMemory({ now: () => NOW });
  const gate = Promise.withResolvers<void>();
  const timer = Promise.withResolvers<() => unknown>();
  const committed = Promise.withResolvers<void>();
  try {
    const ingest = createIngestRecord({ memoryDb: memory.memoryDb, hot: memory.hot, now: () => NOW });
    const observed = createObserve({
      hot: memory.hot,
      selfIdOf: () => 'self',
      timers: {
        set: (fn) => {
          timer.resolve(fn);
          return null;
        },
        clear() {},
      },
      memoryDb: {
        ...memory.memoryDb,
        observeMessage: async (envelope: object, where: ObserveWhere) => {
          await gate.promise;
          const result = await memory.memoryDb.observeMessage(envelope, where);
          committed.resolve();
          return result;
        },
      },
    });
    const door = createEventDoor({
      log: quiet,
      ingest,
      handlers: {
        'message.received': async (event: MessageEvent, context) => {
          await observed.observeLine(
            event,
            false,
            { placeId: 'root' },
            context.receipt
              ? {
                  eventId: context.receipt.eventId,
                  locator: { iface: event.iface, chatId: event.chat.id, messageId: event.message.id },
                  receipt: context.receipt,
                }
              : undefined
          );
        },
      },
    });
    const input = message('slow-event', 'room-a', 'Slow body');
    const result = door.submit(input, { principal: 'adapter', seq: 1 });
    (await timer.promise)();
    assert.equal((await result).status, 'failed');
    assert.equal(ingest.seen('adapter', 'slow-event'), false);
    gate.resolve();
    await committed.promise;
    assert.equal(ingest.seen('adapter', 'slow-event'), true);
    assert.equal((await door.submit(input, { principal: 'adapter', seq: 1 })).status, 'duplicate');
  } finally {
    gate.resolve();
    await memory.close();
  }
});
