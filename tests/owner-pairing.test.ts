// The owner proves his account on a newly connected interface by pairing (src/interface/owner-pairing.ts): while he
// opened pairing there, a direct message to her is answered with a one-time phrase of six words instead of a turn,
// and the phrase he approves in the command line binds that account to his meta-person by the rules of `/memory bind`
// (src/memory/db/person-bind.ts). A second paired account becomes the interface's owner account and the first stays
// his. A real temporary memory database, a recording port and synthetic ids only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createOwnerPairing } from '../src/interface/owner-pairing.ts';
import type { OwnerPairing } from '../src/interface/owner-pairing.ts';
import { createPairing } from '../src/interface/pairing.ts';
import { createPhraseCodes } from '../src/interface/phrase-codes.ts';
import { onLog } from '../src/log.ts';
import { withIface } from '../src/memory/db/current-iface.ts';
import { personOfAccount } from '../src/memory/db/meta-person.ts';
import { bindAccount } from '../src/memory/db/person-bind.ts';
import type { BindConfirm, BindInput, BindResult } from '../src/memory/db/person-bind.ts';
import { createOwnerAccounts, ownerAccountOf } from '../src/memory/db/person-links.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import type { Content } from '../src/protocol/actions.ts';
import type { ChatRef, Delivery, MessageEvent } from '../src/protocol/adapter.ts';
import { isOwnerId, useOwnerAccounts } from '../src/tools/operations/grants.ts';
import { lineEvent, channelInfo } from './fixtures/core-over-fake.ts';
import { addAccount, addPerson } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';
import { readFileSync } from 'node:fs';
import { query, runCli, settle, spawnCli, startUnitsCore, startedUnit, until, withRig } from './fixtures/core-units.ts';
import type { Dirs, Rig as CoreRig, Unit } from './fixtures/core-units.ts';

const IFACE = 'chatnet';
const OWNER = 'person:0a1b0000-owner';
const NOW = Date.parse('2026-11-08T12:00:00Z');
const CODE = /^pair with (.+) please$/;
const LABELS = { pairing: { code: 'pair with {phrase} please', ask: 'approve on {iface}' } };
const WORDS = ['amber', 'birch', 'cedar', 'dune', 'ember', 'fjord', 'grove', 'heath', 'inlet', 'jade', 'kelp', 'loam'];

type Sent = { chat: ChatRef; text: string };
type Rig = { pairing: OwnerPairing; sent: Array<Sent>; db: Db; config: Row };

function addMetaAccount(db: Db, id: string, iface: string, native: string, person: string): void {
  addPerson(db, person);
  db.prepare('UPDATE people SET meta = 1 WHERE id = ?').run(person);
  addAccount(db, { id, iface, authority: `${iface}/global`, native, person });
  db.prepare(
    'INSERT INTO person_accounts (id, person_id, iface, platform_id, display_name, recorded_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, person, iface, native, native, '2026-11-01T00:00:00.000Z');
}

/** The owner's meta-person with his command line account, and two accounts on the new interface with their own. */
async function withPairing(body: (rig: Rig) => Promise<void>): Promise<void> {
  const handle = openMemoryDb(path.join(tempDir('nep-owner-pairing-'), 'memory.db'));
  const db = dbOf(handle);
  addMetaAccount(db, 'account:cli-owner', 'cli', 'owner', OWNER);
  addMetaAccount(db, 'account:u9', IFACE, 'u9', 'person:9e9e0000-u9');
  addMetaAccount(db, 'account:u10', IFACE, 'u10', 'person:1f1f0000-u10');
  const config: Row = { bot: { ownerPerson: OWNER } };
  const hot = { config, prompts: { labels: LABELS } };
  const memoryDb = {
    database: () => db,
    personBind: (input: BindInput, confirm: BindConfirm | null): Promise<BindResult> =>
      bindAccount(
        { db, write: (update) => Promise.resolve(applyMemoryWrite(handle, update)), llm: null, hot, now: () => NOW },
        input,
        confirm
      ),
  };
  const sent: Array<Sent> = [];
  const port = {
    send: (chat: ChatRef, content: Content): Promise<Delivery> => {
      sent.push({ chat, text: content.text ?? '' });
      return Promise.resolve({ status: 'ok', ref: null, parts: [], at: NOW, idempotencyKey: 'k', error: null });
    },
  };
  const phrases = createPhraseCodes({ words: () => WORDS, matcher: () => ({ stem: (word) => word, endings: [] }) });
  const pairing = createOwnerPairing({
    hot,
    pairing: createPairing({ now: () => NOW, phrases }),
    memoryDb,
    port,
    selfId: () => 'self-id',
  });
  const stop = useOwnerAccounts(createOwnerAccounts({ database: () => db, home: () => 'cli' }));
  try {
    await body({ pairing, sent, db, config });
  } finally {
    stop();
    handle.close();
  }
}

/** A direct message of `author` to her on the new interface. */
function direct(author: string, id: string, text = 'hello there'): MessageEvent {
  const line = lineEvent({ id, text, at: NOW, authorId: author });
  return {
    ...line,
    iface: IFACE,
    id: `${IFACE}:message:${id}`,
    chat: { id: `dm-${author}`, kind: 'dm', rootId: null, partnerId: author, name: author },
  };
}

function codeIn(sent: ReadonlyArray<Sent>): string {
  const found = CODE.exec(sent.at(-1)?.text ?? '');
  assert.ok(found, `no phrase in ${JSON.stringify(sent)}`);
  return found[1] ?? '';
}

const ownerOn = (native: string, config: Row): boolean => withIface(IFACE, () => isOwnerId(config, native));

async function pair(rig: Rig, author: string, id: string): Promise<{ text: string; status: string }> {
  rig.pairing.open(IFACE);
  assert.equal(await rig.pairing.screen(direct(author, id)), 'observe');
  return rig.pairing.approve(codeIn(rig.sent));
}

test('answers a direct message with a code in that chat while pairing is open', async () => {
  await withPairing(async ({ pairing, sent }) => {
    pairing.open(IFACE);
    assert.equal(await pairing.screen(direct('u9', 'm1')), 'observe');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.chat, { iface: IFACE, chatId: 'dm-u9' });
    // The owner's decision of 2026-11-08 replaced the eight-character code with six words of the list.
    assert.equal(
      codeIn(sent)
        .split(' ')
        .filter((word) => WORDS.includes(word)).length,
      6
    );
  });
});

test('the approved code binds the account to the owner meta-person and gives it the owner rights', async () => {
  await withPairing(async (rig) => {
    assert.equal(ownerOn('u9', rig.config), false);
    const answer = await pair(rig, 'u9', 'm1');
    assert.equal(answer.status, 'ok', answer.text);
    assert.equal(personOfAccount(rig.db, 'account:u9'), OWNER);
    assert.equal(ownerOn('u9', rig.config), true);
  });
});

test('a second paired account becomes the interface owner account and the first stays the owner', async () => {
  await withPairing(async (rig) => {
    await pair(rig, 'u9', 'm1');
    assert.equal(ownerAccountOf(rig.db, OWNER, IFACE), 'u9');
    const answer = await pair(rig, 'u10', 'm2');
    assert.equal(answer.status, 'ok', answer.text);
    assert.equal(ownerAccountOf(rig.db, OWNER, IFACE), 'u10');
    assert.equal(ownerOn('u9', rig.config), true);
    assert.equal(ownerOn('u10', rig.config), true);
    assert.equal(personOfAccount(rig.db, 'account:u9'), OWNER);
  });
});

test('a wrong code binds nothing', async () => {
  await withPairing(async ({ pairing, db, config }) => {
    pairing.open(IFACE);
    await pairing.screen(direct('u9', 'm1'));
    const answer = await pairing.approve('ZZZZZZZZ');
    assert.equal(answer.status, 'invalid');
    assert.equal(personOfAccount(db, 'account:u9'), 'person:9e9e0000-u9');
    assert.equal(ownerOn('u9', config), false);
  });
});

test('passes a direct message on while pairing is closed and sends nothing', async () => {
  await withPairing(async ({ pairing, sent }) => {
    assert.equal(await pairing.screen(direct('u9', 'm1')), 'pass');
    assert.equal(sent.length, 0);
  });
});

test('passes a line in a group place on while pairing is open', async () => {
  await withPairing(async ({ pairing, sent }) => {
    pairing.open(IFACE);
    const event = { ...direct('u9', 'm1'), chat: { id: 'c1', kind: 'channel' as const, rootId: 'g1', name: 'room' } };
    assert.equal(await pairing.screen(event), 'pass');
    assert.equal(sent.length, 0);
  });
});

test('passes the owner account on once it is paired, while pairing is open again', async () => {
  await withPairing(async (rig) => {
    await pair(rig, 'u9', 'm1');
    rig.pairing.open(IFACE);
    const before = rig.sent.length;
    assert.equal(await rig.pairing.screen(direct('u9', 'm3')), 'pass');
    assert.equal(rig.sent.length, before);
  });
});

test('tells her line that carries a code from any other line', async () => {
  await withPairing(async ({ pairing, sent }) => {
    pairing.open(IFACE);
    await pairing.screen(direct('u9', 'm1'));
    assert.equal(pairing.isCodeLine(sent[0]?.text), true);
    assert.equal(pairing.isCodeLine('pair with nothing please'), false);
    assert.equal(pairing.isCodeLine('hello there'), false);
  });
});

test('the code reaches no log line from the request to the approval', async () => {
  const lines: Array<string> = [];
  const stop = onLog((entry) => lines.push(JSON.stringify(entry)));
  try {
    await withPairing(async (rig) => {
      await pair(rig, 'u9', 'm1');
      const code = codeIn(rig.sent);
      assert.ok(lines.length > 0, 'pairing logs what happened');
      assert.equal(
        lines.some((line) => line.includes(code)),
        false
      );
    });
  } finally {
    stop();
  }
});

// Pairing the owner's account in the running core: `/interfaces pair open <name>` opens pairing on an interface, a
// direct message there is answered with a one-time phrase of six words and starts no turn, and `/interfaces pair`
// with that phrase in the command line binds that account to the owner's meta-person. The phrase reaches no model
// request and no log. The real
// core, the real `neptunia` command and the fake interface as a unit over fresh folders; synthetic ids only.

// The phrase as the shipped `labels.pairing.code` words it.
const CODE_CORE = /pairing phrase is: (.+?)\. Type/;

const configOf = (dirs: Dirs): { bot: { ownerPerson?: string } } =>
  JSON.parse(readFileSync(path.join(dirs.privateDir, 'config', 'config.json'), 'utf8')) as {
    bot: { ownerPerson?: string };
  };

const personOf = (dirs: Dirs, native: string): unknown =>
  query(dirs, "SELECT person_id FROM accounts WHERE iface = 'fake' AND native_key = ?", native)[0]?.person_id;

async function firstLine({ dirs, clis }: Pick<CoreRig, 'dirs' | 'clis'>): Promise<void> {
  const chat = spawnCli(dirs, []);
  clis.push(chat);
  chat.type('the first line of a new install');
  await until(() => typeof configOf(dirs).bot.ownerPerson === 'string', 'bot.ownerPerson written');
}

/** A direct message of `author` to her on the fake interface, in the chat `dm-<author>`. */
async function coreDirect(unit: Unit, author: string, id: string, text = 'hello, it is me'): Promise<void> {
  const chat = `dm-${author}`;
  await unit.ask({ op: 'seed-chat', info: channelInfo(chat, { kind: 'dm', rootId: null, partnerId: author }) }, 'done');
  const line = lineEvent({ chatId: chat, id, text, at: Date.now(), authorId: author });
  const event: MessageEvent = {
    ...line,
    chat: { id: chat, kind: 'dm', rootId: null, partnerId: author, name: author },
  };
  await unit.emit(event);
}

test('a code approved in the command line binds the account that wrote to her, with no turn and no logged code', async () => {
  await withRig({ config: { dm: { enabled: true } } }, async ({ dirs, llm, units, clis, cores, logs }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);
    await firstLine({ dirs, clis });
    const opened = await runCli(dirs, ['-p', '/interfaces pair open fake']);
    assert.equal(opened.code, 0, opened.stdout + opened.stderr.slice(-2000));

    // A member of the root, as a private chat asks of anyone, the owner included.
    const member = {
      id: 'u9',
      name: 'Owner',
      bot: false,
      groupIds: [],
      avatar: { hash: null, url: null, largeUrl: null },
    };
    await unit.ask({ op: 'seed-member', rootId: 'g1', member }, 'done');
    await coreDirect(unit, 'u9', 'm1');
    let posted: Array<string> = [];
    // The posted texts are read over the unit's channel, so they are polled here rather than through `until`.
    for (let tries = 0; tries < 80 && posted.length === 0; tries += 1) {
      posted = await unit.posted('dm-u9');
      await settle(50);
    }
    const code = CODE_CORE.exec(posted.join('\n'))?.[1] ?? '';
    // The owner's decision of 2026-11-08 replaced the eight-character code with six words of the list.
    assert.equal(code.split(' ').length, 6, `no phrase in ${JSON.stringify(posted)}`);
    await until(() => personOf(dirs, 'u9') !== undefined, 'her sight of u9');

    const approved = await runCli(dirs, ['-p', `/interfaces pair ${code.split(' ').reverse().join(' ')}`]);
    assert.equal(approved.code, 0, approved.stdout + approved.stderr.slice(-2000));
    const config = configOf(dirs);
    assert.equal(personOf(dirs, 'u9'), config.bot.ownerPerson);
    assert.equal(
      withIface('fake', () => isOwnerId(config, 'u9')),
      true
    );
    // The pairing line started no turn.
    assert.equal(
      llm.requests.some((request) => JSON.stringify(request).includes('hello, it is me')),
      false
    );
    // Her next turn in that chat reads its history, and her line with the code stays out of the request.
    await coreDirect(unit, 'u9', 'm2', 'and now a real question');
    await until(
      () => llm.requests.some((request) => JSON.stringify(request).includes('and now a real question')),
      'a turn over the next line'
    );
    assert.equal(
      llm.requests.some((request) => JSON.stringify(request).includes(code)),
      false
    );
    assert.equal(
      logs.some((entry) => JSON.stringify(entry).includes(code)),
      false
    );
  });
});
