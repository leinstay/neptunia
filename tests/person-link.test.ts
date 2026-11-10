// Her link tool (src/interface/person-link.ts, plan 2026-11-08-meta-person "Linking accounts by her own tool"): in a
// conversation with account A she names the meta-person she believes the person is, and a one-time phrase of six
// words goes to an account B of that meta-person in a direct message, naming A. The next message from A in that
// conversation is checked by the door: the six words in any order merge A's meta-person into B's (B winning, the private layers joined), anything else merges
// nothing. Hermes's limits hold, a closed direct chat refuses, the owner's meta-person is never touched, and a
// restart keeps the waiting phrase and the limits. A real temporary memory database, a recording port, synthetic
// words and synthetic ids only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createPersonLinks } from '../src/interface/person-link.ts';
import type { PersonLinks } from '../src/interface/person-link.ts';
import { createPhraseCodes } from '../src/interface/phrase-codes.ts';
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
const CODE = /your link phrase is (.+)$/;
const WORDS = ['amber', 'birch', 'cedar', 'dune', 'ember', 'fjord', 'grove', 'heath', 'inlet', 'jade', 'kelp', 'loam'];
const LABELS = {
  link: { code: 'from {handle} on {iface}: your link phrase is {phrase}' },
  tools: {
    tools: { link: { sent: 'SENT-MARK the next message from this account must be the code', already: 'SAME' } },
  },
};

type Sent = { chat: ChatRef; text: string };
type Rig = {
  links: PersonLinks;
  /** The links built again over the same database and state file, as after a restart. */
  restart: () => PersonLinks;
  file: string;
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
  const phrases = createPhraseCodes({ words: () => WORDS, matcher: () => ({ stem: (word) => word, endings: [] }) });
  const file = path.join(tempDir('nep-person-link-state-'), 'link-codes.json');
  const build = (): PersonLinks => createPersonLinks({ hot, memoryDb, port, now: () => now, phrases, file });
  try {
    await body({
      links: build(),
      restart: build,
      file,
      sent,
      db,
      at: (ms) => (now = START + ms),
      closeDirect: () => (closed = true),
    });
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
  assert.ok(found, `no phrase in ${JSON.stringify(sent)}`);
  return found[1] ?? '';
}

test('sends a code to the known person account in a direct chat and tells her only the rule of the next message', async () => {
  await withLinks(async ({ links, sent }) => {
    const result = await links.start(ASK);
    assert.equal(result.status, 'ok');
    assert.deepEqual(
      sent.map((one) => one.chat),
      [{ iface: 'farnet', chatId: 'dm-farnet-b1' }]
    );
    // The owner's decision of 2026-11-08: six words of the list, and the message names account A and its interface.
    assert.match(sent[0]?.text ?? '', /^from a1 on chatnet: your link phrase is /);
    assert.equal(
      codeIn(sent)
        .split(' ')
        .filter((word) => WORDS.includes(word)).length,
      6
    );
    assert.match(result.data?.text ?? '', /SENT-MARK/);
    assert.equal(JSON.stringify(result).includes(codeIn(sent)), false);
  });
});

test('the right code as the next message of the account merges its meta-person into the known one', async () => {
  await withLinks(async ({ links, sent, db }) => {
    await links.start(ASK);
    const reordered = codeIn(sent).split(' ').reverse().join(', ');
    // Owner's rule of 2026-11-10: the message that answered the code is kept like any line (observed, no turn), so
    // the screen observes it where it once dropped it and withheld its id.
    assert.equal(await links.screen(line('a1', 'm1', `it is me: ${reordered}`)), 'observe');
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

test('a phrase answered once merges nothing when it comes again', async () => {
  await withLinks(async ({ links, sent }) => {
    await links.start(ASK);
    const code = codeIn(sent);
    // Owner's rule of 2026-11-10: the answer is observed, no longer dropped.
    assert.equal(await links.screen(line('a1', 'm1', code)), 'observe');
    assert.equal(await links.screen(line('a1', 'm2', code)), 'pass');
  });
});

test('five of the six words merge nothing', async () => {
  await withLinks(async ({ links, sent, db }) => {
    await links.start(ASK);
    assert.equal(await links.screen(line('a1', 'm1', codeIn(sent).split(' ').slice(1).join(' '))), 'pass');
    assert.equal(personOfAccount(db, 'account:a1'), NEW);
  });
});

test('a restart mid-challenge keeps the waiting phrase', async () => {
  await withLinks(async ({ links, restart, sent, db }) => {
    await links.start(ASK);
    const code = codeIn(sent);
    // Owner's rule of 2026-11-10: the answer is observed, no longer dropped.
    assert.equal(await restart().screen(line('a1', 'm1', code)), 'observe');
    assert.equal(personOfAccount(db, 'account:a1'), KNOWN);
  });
});

test('a restart reopens neither an ended attempt nor the ten-minute limit', async () => {
  await withLinks(async ({ links, restart, sent, db }) => {
    await links.start(ASK);
    const code = codeIn(sent);
    assert.equal(await links.screen(line('a1', 'm1', 'what phrase?')), 'pass');
    const after = restart();
    assert.equal(await after.screen(line('a1', 'm2', code)), 'pass');
    assert.equal(personOfAccount(db, 'account:a1'), NEW);
    assert.deepEqual([(await after.start(ASK)).code], ['cooldown']);
  });
});

// Owner's rule of 2026-11-10: the message that carried the phrase is kept like any line, so no withheld id survives a
// restart; what the state file must still never hold is the phrase.
test('the state file keeps no phrase once it was answered', async () => {
  await withLinks(async ({ links, sent, file }) => {
    await links.start(ASK);
    const code = codeIn(sent);
    await links.screen(line('a1', 'm1', code));
    assert.equal(fs.readFileSync(file, 'utf8').includes(code), false);
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
    // Owner's rule of 2026-11-10: the answer is observed, no longer dropped.
    assert.equal(await links.screen(line('a1', 'm3', code)), 'observe');
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

// Owner's rule of 2026-11-10: her line that carries a code is kept like any line, so nothing tells it apart any more;
// the log still never holds the code.
test('the code reaches no log line', async () => {
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
