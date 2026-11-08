// Her link tool (src/interface/person-link.ts, plan 2026-11-08-meta-person "Linking accounts by her own tool"): in a
// conversation with account A she names the meta-person she believes the person is, and a one-time code goes to an
// account B of that meta-person in a direct message. The next message from A in that conversation is checked by the
// door: the right code merges A's meta-person into B's (B winning, the private layers joined), anything else merges
// nothing. Hermes's limits hold, a closed direct chat refuses, and the owner's meta-person is never touched. A real
// temporary memory database, a recording port and synthetic ids only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createPersonLinks } from '../src/interface/person-link.ts';
import type { PersonLinks } from '../src/interface/person-link.ts';
import { hasCodeLine } from '../src/interface/owner-pairing.ts';
import { handleOf } from '../src/behavior/handles.ts';
import { onLog } from '../src/log.ts';
import { personOfAccount } from '../src/memory/db/meta-person.ts';
import { bindAccount } from '../src/memory/db/person-bind.ts';
import type { BindConfirm, BindInput, BindResult } from '../src/memory/db/person-bind.ts';
import { personMembers } from '../src/memory/db/person-links.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import type { Content } from '../src/protocol/actions.ts';
import type { ChatRef, Delivery, MessageEvent } from '../src/protocol/adapter.ts';
import { lineEvent } from './fixtures/core-over-fake.ts';
import { addAccount, addPerson } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const MINUTE = 60_000;
const START = Date.parse('2026-11-08T12:00:00Z');
const OWNER = 'person:0a1b0000-owner';
const KNOWN = 'person:7a1e0000-known';
const NEW = 'person:3c9d0000-new';
const CODE = /[A-HJ-NP-Z2-9]{8}/;
const LABELS = {
  link: { code: 'your link code is {code}' },
  tools: {
    tools: { link: { sent: 'SENT-MARK the next message from this account must be the code', already: 'SAME' } },
  },
};

type Sent = { chat: ChatRef; text: string };
type Rig = {
  links: PersonLinks;
  sent: Array<Sent>;
  db: Db;
  at: (ms: number) => void;
  closeDirect: () => void;
};

function addMetaAccount(db: Db, id: string, iface: string, native: string, person: string): void {
  addPerson(db, person);
  db.prepare('UPDATE people SET meta = 1 WHERE id = ?').run(person);
  addAccount(db, { id, iface, authority: `${iface}/global`, native, person });
  db.prepare(
    'INSERT INTO person_accounts (id, person_id, iface, platform_id, display_name, recorded_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, person, iface, native, native, '2026-11-01T00:00:00.000Z');
}

/**
 * The known meta-person with an account `b1` on `farnet`, the person she talks with as account `a1` on `chatnet` under
 * a meta-person of its own, and the owner with his accounts on both.
 */
async function withLinks(body: (rig: Rig) => Promise<void>): Promise<void> {
  const handle = openMemoryDb(path.join(tempDir('nep-person-link-'), 'memory.db'));
  const db = dbOf(handle);
  addMetaAccount(db, 'account:b1', 'farnet', 'b1', KNOWN);
  addMetaAccount(db, 'account:a1', 'chatnet', 'a1', NEW);
  addMetaAccount(db, 'account:o1', 'chatnet', 'o1', OWNER);
  addMetaAccount(db, 'account:o2', 'farnet', 'o2', OWNER);
  let now = START;
  const config: Row = { bot: { ownerPerson: OWNER } };
  const hot = { config, prompts: { labels: LABELS } };
  const memoryDb = {
    database: () => db,
    personBind: (input: BindInput, confirm: BindConfirm | null): Promise<BindResult> =>
      bindAccount(
        { db, write: (update) => Promise.resolve(applyMemoryWrite(handle, update)), llm: null, hot, now: () => now },
        input,
        confirm
      ),
  };
  const sent: Array<Sent> = [];
  let closed = false;
  const failed = { code: 'closed', retryable: false, retryAfterMs: null };
  const port = {
    dmChatOf: (partner: { iface: string; accountId: string }) =>
      Promise.resolve({ status: 'ok' as const, chatId: `dm-${partner.iface}-${partner.accountId}` }),
    send: (chat: ChatRef, content: Content): Promise<Delivery> => {
      if (closed)
        return Promise.resolve({
          status: 'forbidden',
          ref: null,
          parts: [],
          at: null,
          idempotencyKey: 'k',
          error: failed,
        });
      sent.push({ chat, text: content.text ?? '' });
      return Promise.resolve({ status: 'ok', ref: null, parts: [], at: now, idempotencyKey: 'k', error: null });
    },
  };
  let turn = 0;
  const links = createPersonLinks({ hot, memoryDb, port, now: () => now, rng: () => ((turn += 3) % 10) / 10 });
  try {
    await body({ links, sent, db, at: (ms) => (now = START + ms), closeDirect: () => (closed = true) });
  } finally {
    handle.close();
  }
}

/** A message of `author` in the chat `c1` on `chatnet`, the conversation where she called the tool. */
function line(author: string, id: string, text: string, chat = 'c1'): MessageEvent {
  const event = lineEvent({ chatId: chat, id, text, at: START, authorId: author });
  return { ...event, iface: 'chatnet', id: `chatnet:message:${id}` };
}

const ASK = { iface: 'chatnet', native: 'a1', chatId: 'c1', person: KNOWN };

function codeIn(sent: ReadonlyArray<Sent>): string {
  const found = CODE.exec(sent.at(-1)?.text ?? '');
  assert.ok(found, `no code in ${JSON.stringify(sent)}`);
  return found[0];
}

test('sends a code to the known person account in a direct chat and tells her only the rule of the next message', async () => {
  await withLinks(async ({ links, sent }) => {
    const result = await links.start(ASK);
    assert.equal(result.status, 'ok');
    assert.deepEqual(
      sent.map((one) => one.chat),
      [{ iface: 'farnet', chatId: 'dm-farnet-b1' }]
    );
    assert.match(sent[0]?.text ?? '', /^your link code is [A-HJ-NP-Z2-9]{8}$/);
    assert.match(result.data?.text ?? '', /SENT-MARK/);
    assert.equal(JSON.stringify(result).includes(codeIn(sent)), false);
  });
});

test('the right code as the next message of the account merges its meta-person into the known one', async () => {
  await withLinks(async ({ links, sent, db }) => {
    await links.start(ASK);
    assert.equal(await links.screen(line('a1', 'm1', ` ${codeIn(sent)} `)), 'drop');
    // The message that carried the code stays out of every chat a turn reads.
    assert.equal(links.isWithheld('chatnet', 'c1', 'm1'), true);
    assert.equal(links.isWithheld('chatnet', 'c1', 'm2'), false);
    assert.equal(personOfAccount(db, 'account:a1'), KNOWN);
    assert.equal(personOfAccount(db, 'account:b1'), KNOWN);
    const known = db.prepare('SELECT meta FROM people WHERE id = ?').get(KNOWN);
    assert.equal(known?.meta, 1);
  });
});

test('after the merge the private layers join: the known person holds both accounts for an outward reader', async () => {
  await withLinks(async ({ links, sent, db }) => {
    await links.start(ASK);
    await links.screen(line('a1', 'm1', codeIn(sent)));
    const members = personMembers(db, KNOWN, { ownerMergesOnly: true });
    const accounts = members.accounts.map((one) => one.id);
    assert.deepEqual([...accounts].sort(), ['account:a1', 'account:b1']);
  });
});

test('a wrong next message is passed on, merges nothing and ends the attempt', async () => {
  await withLinks(async ({ links, sent, db }) => {
    await links.start(ASK);
    const code = codeIn(sent);
    assert.equal(await links.screen(line('a1', 'm1', 'what code?')), 'pass');
    assert.equal(await links.screen(line('a1', 'm2', code)), 'pass');
    assert.equal(personOfAccount(db, 'account:a1'), NEW);
  });
});

test('only the account that asked, in the conversation it asked in, can answer the code', async () => {
  await withLinks(async ({ links, sent, db }) => {
    await links.start(ASK);
    const code = codeIn(sent);
    assert.equal(await links.screen(line('x9', 'm1', code)), 'pass');
    assert.equal(await links.screen(line('a1', 'm2', 'elsewhere', 'c2')), 'pass');
    assert.equal(personOfAccount(db, 'account:a1'), NEW);
    assert.equal(await links.screen(line('a1', 'm3', code)), 'drop');
    assert.equal(personOfAccount(db, 'account:a1'), KNOWN);
  });
});

test('a code an hour old merges nothing', async () => {
  await withLinks(async ({ links, sent, db, at }) => {
    await links.start(ASK);
    const code = codeIn(sent);
    at(60 * MINUTE + 1);
    assert.equal(await links.screen(line('a1', 'm1', code)), 'pass');
    assert.equal(personOfAccount(db, 'account:a1'), NEW);
  });
});

test('an account asks for one link per ten minutes', async () => {
  await withLinks(async ({ links, sent, at }) => {
    await links.start(ASK);
    at(9 * MINUTE);
    const again = await links.start(ASK);
    assert.deepEqual([again.status, again.code], ['denied', 'cooldown']);
    assert.equal(sent.length, 1);
    at(10 * MINUTE + 1);
    assert.equal((await links.start(ASK)).status, 'ok');
  });
});

test('five wrong answers lock the account for an hour', async () => {
  await withLinks(async ({ links, at }) => {
    let clock = 0;
    for (let tries = 0; tries < 5; tries += 1) {
      at(clock);
      assert.equal((await links.start(ASK)).status, 'ok');
      await links.screen(line('a1', `w${tries}`, 'WRONGXYZ'));
      clock += 11 * MINUTE;
    }
    at(clock);
    assert.deepEqual([(await links.start(ASK)).status, (await links.start(ASK)).code], ['denied', 'cooldown']);
    at(clock + 61 * MINUTE);
    assert.equal((await links.start(ASK)).status, 'ok');
  });
});

test('a closed direct chat refuses, and nothing is linked', async () => {
  await withLinks(async ({ links, closeDirect, db }) => {
    closeDirect();
    const result = await links.start(ASK);
    assert.deepEqual([result.status, result.code], ['failed', 'chat-closed']);
    assert.equal(await links.screen(line('a1', 'm1', 'ABCDEFGH')), 'pass');
    assert.equal(personOfAccount(db, 'account:a1'), NEW);
  });
});

test('linking to the owner meta-person is refused and sends nothing', async () => {
  await withLinks(async ({ links, sent }) => {
    const result = await links.start({ ...ASK, person: OWNER });
    assert.deepEqual([result.status, result.code], ['denied', 'forbidden']);
    assert.equal(sent.length, 0);
  });
});

test('linking an account of the owner to anyone is refused and sends nothing', async () => {
  await withLinks(async ({ links, sent, db }) => {
    const result = await links.start({ ...ASK, native: 'o1' });
    assert.deepEqual([result.status, result.code], ['denied', 'forbidden']);
    assert.equal(sent.length, 0);
    assert.equal(personOfAccount(db, 'account:o1'), OWNER);
  });
});

test('a person that is no meta-person she knows is refused', async () => {
  await withLinks(async ({ links, sent }) => {
    const result = await links.start({ ...ASK, person: 'person:ffff0000-nobody' });
    assert.deepEqual([result.status, result.code], ['invalid', 'PERSON_NOT_FOUND']);
    assert.equal(sent.length, 0);
  });
});

test('the code reaches no log line, and her line that carries it is told apart', async () => {
  const lines: Array<string> = [];
  const stop = onLog((entry) => lines.push(JSON.stringify(entry)));
  try {
    await withLinks(async ({ links, sent }) => {
      await links.start(ASK);
      const code = codeIn(sent);
      await links.screen(line('a1', 'm1', code));
      assert.ok(lines.length > 0, 'the link logs what happened');
      assert.equal(
        lines.some((one) => one.includes(code)),
        false
      );
      assert.equal(links.isCodeLine(sent[0]?.text), true);
      // The history a turn reads drops her line with the code by the same labels.
      assert.equal(hasCodeLine({ labels: LABELS }, sent[0]?.text), true);
      assert.equal(links.isCodeLine('your link code is late'), false);
    });
  } finally {
    stop();
  }
});

test('names the known person by the member handle of one of their accounts as well', async () => {
  await withLinks(async ({ links, sent }) => {
    const result = await links.start({ ...ASK, person: `@${handleOf('b1')}` });
    assert.equal(result.status, 'ok');
    assert.deepEqual(
      sent.map((one) => one.chat.chatId),
      ['dm-farnet-b1']
    );
  });
});
