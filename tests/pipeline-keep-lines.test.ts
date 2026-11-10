// The lines in her context are stored (src/pipeline/keep-lines.ts): a line of the chat a turn reads and a line the
// address classifier reads reach the memory database through the live observation, once, with the platform's send
// time, while a line only `conversation.read` returned stays out. The core over the fake interface
// (tests/fixtures/core-over-fake.ts): the history lines are seeded into the fake and never emitted, so only a read
// brings them to the core. Synthetic lines, in Greek.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelInfo, deliver, lineEvent, settle, until, withFakeCore } from './fixtures/core-over-fake.ts';
import type { Fake } from './fixtures/core-over-fake.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';

const NOW = Date.now();
const EARLIER = NOW - 60_000;

/** The chat `c1` with one line the core never received: it is only in the platform's history. */
function seedUnstored(fake: Fake): void {
  fake.seedChat(channelInfo('c1', { name: 'general' }));
  fake.seedEvent(
    lineEvent({ id: 'h0', text: 'μιλούσαμε για τον κήπο', at: EARLIER, authorId: 'u2', authorName: 'Zoe' })
  );
}

test('stores a line of the chat window that memory lacks, once, with its send time', async () => {
  await withFakeCore({ seed: seedUnstored }, async (rig) => {
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'γεια σου', at: NOW - 1000, mention: true }));
    await until(() => rig.posted('c1').length === 1);
    await until(() => rig.linesOf('h0').length > 0);
    await settle();
    const lines = rig.linesOf('h0');
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.kind, 'seen');
    assert.equal(lines[0]?.revision, 1);
    assert.equal(lines[0]?.text, 'μιλούσαμε για τον κήπο');
    assert.equal(lines[0]?.occurred_at, new Date(EARLIER).toISOString());
  });
});

test('stores nothing more when a second turn reads the same window', async () => {
  await withFakeCore({ seed: seedUnstored }, async (rig) => {
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'γεια σου', at: NOW - 2000, mention: true }));
    await until(() => rig.posted('c1').length === 1);
    await until(() => rig.linesOf('h0').length > 0);
    const before = rig.sources('seen').length;
    await rig.emit(deliver(rig.fake, { id: 'm2', text: 'είσαι εκεί;', at: NOW - 1000, mention: true }));
    await until(() => rig.posted('c1').length === 2);
    await settle();
    assert.equal(rig.linesOf('h0').length, 1);
    assert.equal(rig.linesOf('m1').length, 1);
    // The second turn's own line is the one new row.
    assert.equal(rig.sources('seen').length, before + 1);
  });
});

test('stores an edited line of the window as the next revision of the stored line', async () => {
  await withFakeCore({ seed: (fake) => fake.seedChat(channelInfo('c1', { name: 'general' })) }, async (rig) => {
    await rig.emit(
      deliver(rig.fake, { id: 'e0', text: 'πρώτη μορφή', at: EARLIER, authorId: 'u2', authorName: 'Zoe' })
    );
    await until(() => rig.linesOf('e0').length === 1);
    // The message was edited while the core did not hear it: only the history holds the new text.
    rig.fake.seedEvent(
      lineEvent({
        id: 'e0',
        text: 'δεύτερη μορφή',
        at: EARLIER,
        editedAt: NOW - 30_000,
        authorId: 'u2',
        authorName: 'Zoe',
      })
    );
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'γεια σου', at: NOW - 1000, mention: true }));
    await until(() => rig.posted('c1').length === 1);
    await until(() => rig.linesOf('e0').length > 1);
    await settle();
    assert.deepEqual(
      rig.linesOf('e0').map((line) => [line.revision, line.text]),
      [
        [1, 'πρώτη μορφή'],
        [2, 'δεύτερη μορφή'],
      ]
    );
  });
});

test('leaves out a line that only conversation.read returned', async () => {
  const seed = (fake: Fake): void => {
    seedUnstored(fake);
    fake.seedChat(channelInfo('c2', { name: 'garden' }));
    fake.seedEvent(lineEvent({ id: 'r0', chatId: 'c2', text: 'φυτέψαμε ντομάτες', at: EARLIER, authorId: 'u3' }));
  };
  const answers = [
    toolAnswer('<think>Look there.</think>', [call('conversation.read', { place: 'garden' })]),
    '<msg>εντάξει</msg>',
  ];
  await withFakeCore({ seed, answers }, async (rig) => {
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'τι λένε στον κήπο;', at: NOW - 1000, mention: true }));
    await until(() => rig.posted('c1').length === 1);
    await until(() => rig.linesOf('h0').length > 0);
    await settle();
    assert.equal(
      rig.fake.calls.some((one) => one.op === 'history' && (one.args[0] as { chatId?: string }).chatId === 'c2'),
      true,
      'the read reached the platform'
    );
    assert.deepEqual(rig.linesOf('r0'), []);
  });
});

test('stores a line the address classifier read when it lets no turn start', async () => {
  await withFakeCore({ seed: seedUnstored, addressAnswer: 'no' }, async (rig) => {
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'ο κήπος θέλει πότισμα', at: NOW - 1000, mention: true }));
    await until(() => rig.linesOf('h0').length > 0);
    await settle();
    assert.equal(rig.requests.length, 0, 'no turn ran');
    assert.equal(rig.linesOf('h0').length, 1);
  });
});
