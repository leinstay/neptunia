// Contract tests of the interface port (src/interface/port.ts): the SAME suite runs against the
// in-memory adapter (scripts/lib/fake.ts) and the Discord adapter (interfaces/discord/port.ts)
// over a fake discord.js client, proving the engine can swap one for the other. Each harness
// gives the suite a port and a neutral view of what reached its chats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES } from '../../../src/interface/port.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { table, wrongly, present } from '../../fixtures/loose-types.ts';
import type { Adapter, MessageRef } from '../../../src/protocol/adapter.ts';
import { OTHER, ROOM, SELF, discordHarness } from '../../fixtures/discord-harness.ts';

/** No typing lease: the tests of the port contract ask for a typing indicator without naming how long. */
const noLease = wrongly<{ untilMs: number }>(undefined);

function fakeHarness({ operations = null }: { operations?: Untyped } = {}) {
  const port = createFakeAdapter({ iface: 'fake', selfId: SELF, operations, now: () => 1000 });
  const view = (ref: Record<string, Untyped>) => {
    const message = port.messages.get(`${ref.chatId}/${ref.messageId}`);
    if (!message || message.deleted) return null;
    return { text: message.text, authorId: message.authorId, reactions: [...message.reactions] };
  };
  return {
    port,
    foreign: () => port.seed(ROOM, { authorId: OTHER, text: 'καλημέρα' }),
    view,
    lastSent() {
      const all = port.messagesIn(ROOM).filter((message) => message.authorId === SELF);
      const message = all.at(-1);
      return {
        text: present(message).text,
        replyToId: present(message).replyTo?.messageId ?? null,
        attachments: present(message).attachments.map((attachment) => attachment.name),
      };
    },
    timeoutNextSend: () => port.failNext('send', { status: 'unknown', error: { code: 'timeout', retryable: false } }),
    effects: () => port.messagesIn(ROOM).length,
  };
}

type Harness = {
  port: Adapter;
  foreign(): MessageRef;
  view(ref: MessageRef): { text: string; authorId: string; reactions: Array<string> } | null;
  lastSent(): { text: string; replyToId: string | null; attachments: Array<string> };
  timeoutNextSend(): void;
  effects(): number;
};

for (const [name, makeAny] of table([
  ['fake', fakeHarness],
  ['discord', discordHarness],
])) {
  const room = (port: Adapter) => ({ iface: port.iface, chatId: ROOM });
  // The same harness `make` builds, typed for the split tests (the pair of harnesses is a union the checker cannot call).
  const make = wrongly<(options?: { operations?: Untyped }) => Harness>(makeAny);
  const build = make;

  test(`port contract (${name}): send answers ok with the new message's reference`, async () => {
    const harness = make();
    const { port } = harness;
    const result = await port.send(room(port), { text: 'γεια σας' });
    assert.equal(result.status, 'ok');
    assert.equal(present(result.ref).iface, port.iface);
    assert.equal(present(result.ref).chatId, ROOM);
    assert.equal(typeof present(result.ref).messageId, 'string');
    assert.deepEqual(harness.view(present(result.ref)), { text: 'γεια σας', authorId: SELF, reactions: [] });
  });

  // The content carries no mentions, so the reply is checked for its text and target alone.
  test(`port contract (${name}): a reply carries its target`, async () => {
    const h = make();
    const target = h.foreign();
    const result = await h.port.send(room(h.port), { text: 'ναι', replyTo: target });
    assert.equal(result.status, 'ok');
    assert.deepEqual(h.lastSent(), { text: 'ναι', replyToId: target.messageId, attachments: [] });
  });

  test(`port contract (${name}): an attachment is sent by name`, async () => {
    const h = make();
    const result = await h.port.send(room(h.port), {
      attachments: [{ name: 'image.png', data: Buffer.from('png'), contentType: 'image/png' }],
    });
    assert.equal(result.status, 'ok');
    assert.deepEqual(h.lastSent().attachments, ['image.png']);
  });

  test(`port contract (${name}): edit changes the persona's own message, never someone else's`, async () => {
    const h = make();
    const own = present((await h.port.send(room(h.port), { text: 'πρώτο' })).ref);
    assert.equal((await h.port.edit(own, { text: 'δεύτερο' })).status, 'ok');
    assert.equal(present(h.view(own)).text, 'δεύτερο');

    const theirs = h.foreign();
    const refused = await h.port.edit(theirs, { text: 'άλλο' });
    assert.equal(refused.status, 'forbidden');
    assert.equal(present(refused.error).code, 'not-own-message');
    assert.equal(present(h.view(theirs)).text, 'καλημέρα');
  });

  test(`port contract (${name}): delete removes the persona's own message, never someone else's`, async () => {
    const h = make();
    const own = present((await h.port.send(room(h.port), { text: 'λάθος' })).ref);
    assert.equal((await h.port.delete(own)).status, 'ok');
    assert.equal(h.view(own), null);

    const theirs = h.foreign();
    assert.equal((await h.port.delete(theirs)).status, 'forbidden');
    assert.notEqual(h.view(theirs), null);
  });

  test(`port contract (${name}): react puts a reaction and unreact takes it back`, async () => {
    const h = make();
    const target = h.foreign();
    assert.equal((await h.port.react(target, '\u{1F389}')).status, 'ok');
    assert.deepEqual(present(h.view(target)).reactions, ['\u{1F389}']);
    assert.equal((await h.port.unreact(target, '\u{1F389}')).status, 'ok');
    assert.deepEqual(present(h.view(target)).reactions, []);
  });

  test(`port contract (${name}): typing answers ok`, async () => {
    const { port } = make();
    assert.equal((await port.typing(room(port), noLease)).status, 'ok');
  });

  // The capabilities take the shape of src/protocol/adapter.ts (`maxChars`, `maxFiles`, `maxFileBytes`),
  // since the adapter splits by `maxChars` and the core reads the same names.
  test(`port contract (${name}): capabilities name every operation and the limits`, () => {
    const { port } = make();
    const caps: Record<string, Untyped> = port.capabilities();
    assert.deepEqual([...caps.operations].sort(), Object.values(CAPABILITIES).sort());
    for (const key of ['maxChars', 'maxFiles', 'maxFileBytes']) assert.ok(caps[key] > 0, key);
  });

  test(`port contract (${name}): a send that timed out is unknown, never retried by the port`, async () => {
    const h = make();
    h.timeoutNextSend();
    const before = h.effects();
    const result = await h.port.send(room(h.port), { text: 'χάθηκε;' });
    assert.equal(result.status, 'unknown');
    assert.equal(present(result.error).retryable, false);
    assert.equal(h.effects(), before, 'the port did not send it again');
  });

  test(`port contract (${name}): an operation whose capability is off is unsupported and does nothing`, async () => {
    const h = make({
      operations: Object.values(CAPABILITIES).filter((capability) => capability !== CAPABILITIES.edit),
    });
    const own = present((await h.port.send(room(h.port), { text: 'μένει' })).ref);
    const result = await h.port.edit(own, { text: 'αλλαγμένο' });
    assert.equal(result.status, 'unsupported');
    assert.equal(present(h.view(own)).text, 'μένει');
    // `operations` is a list in the adapter contract; spreading it holds for a list or a set.
    assert.equal([...h.port.capabilities().operations].includes(CAPABILITIES.edit), false);
  });

  test(`port contract (${name}): a reference of another interface or empty content fails without an effect`, async () => {
    const h = make();
    const before = h.effects();
    const foreign = await h.port.send({ iface: 'elsewhere', chatId: ROOM }, { text: 'όχι' });
    assert.deepEqual([foreign.status, present(foreign.error).code], ['failed', 'foreign-reference']);
    const empty = await h.port.send(room(h.port), { text: '' });
    assert.deepEqual([empty.status, present(empty.error).code], ['failed', 'empty-content']);
    assert.equal(h.effects(), before);
  });

  // The adapter splits a send over the limit into parts that join to the text, so `send` refuses no long text; only
  // an edit, which cannot grow into several messages, keeps it.
  test(`port contract (${String(name)}): a send over the limit is posted as parts that join to the text`, async () => {
    const h = build();
    const limit = h.port.capabilities().maxChars;
    const text = 'α'.repeat(limit + 1);
    const before = h.effects();
    const delivery = await h.port.send({ iface: h.port.iface, chatId: ROOM }, { text });
    assert.equal(delivery.status, 'ok');
    assert.equal(delivery.parts.length, 2);
    assert.equal(h.effects(), before + 2);
    const posted = delivery.parts.map((ref) => h.view(ref)?.text ?? '');
    assert.ok(posted.every((part) => Array.from(part).length <= limit));
    assert.equal(posted.join(''), text);
    assert.deepEqual(delivery.ref, delivery.parts[0], 'ref is the first part');
  });

  test(`port contract (${String(name)}): an edit over the limit is still refused as text-too-long`, async () => {
    const h = build();
    const own = present((await h.port.send({ iface: h.port.iface, chatId: ROOM }, { text: 'μένει' })).ref);
    assert.ok(own);
    const result = await h.port.edit(own, { text: 'α'.repeat(h.port.capabilities().maxChars + 1) });
    assert.deepEqual([result.status, result.error?.code], ['failed', 'text-too-long']);
    assert.equal(h.view(own)?.text, 'μένει');
  });

  test(`port contract (${name}): no operation throws on malformed arguments`, async () => {
    const { port } = make();
    for (const call of [
      () => port.send(wrongly(null), wrongly(null)),
      () => port.edit(wrongly({}), {}),
      () => port.delete(wrongly(undefined)),
      () => port.react(wrongly({ iface: port.iface, chatId: ROOM }), ''),
      () => port.unreact(wrongly(null), wrongly(null)),
      () => port.typing(wrongly({}), noLease),
    ]) {
      const result = await call();
      assert.ok(['ok', 'failed', 'unknown', 'unsupported', 'forbidden'].includes(result.status));
      assert.notEqual(result.status, 'ok');
    }
  });
}
