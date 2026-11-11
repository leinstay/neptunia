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
import { createKeepLines } from '../src/pipeline/keep-lines.ts';
import type { KeepLines } from '../src/pipeline/keep-lines.ts';
import type { ObserveLine } from '../src/pipeline/observe.ts';

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
    const { calls } = rig.fake;
    assert.equal(
      calls.some((one) => one.op === 'history' && (one.args[0] as { chatId?: string }).chatId === 'c2'),
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

// Owner's rule of 2026-11-10: a one-time phrase is a line like any other, shown to her and kept.
const CODE_LINE =
  'Your one-time pairing phrase is: πέτρα δέντρο νερό φωτιά αέρας χώμα. Type /interfaces pair followed by these six words in her command line within an hour.';

test('shows and stores her line that carries a pairing phrase', async () => {
  const seed = (fake: Fake): void => {
    fake.seedChat(channelInfo('c1', { name: 'general' }));
    fake.seedEvent(lineEvent({ id: 'k0', text: CODE_LINE, at: EARLIER, authorId: 'self-id' }));
  };
  await withFakeCore({ seed }, async (rig) => {
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'γεια σου', at: NOW - 1000, mention: true }));
    await until(() => rig.posted('c1').length === 1);
    assert.equal(rig.requestText(0).includes('πέτρα δέντρο νερό φωτιά αέρας χώμα'), true, 'the line is in her chat');
    await until(() => rig.linesOf('k0').length > 0);
    await settle();
    assert.equal(rig.linesOf('k0').length, 1);
  });
});

/** One line of a served channel as a history read returns it. */
const historyLine = {
  iface: 'fake',
  at: NOW,
  chat: { id: 'c1', rootId: 'r1', chatType: 'channel' },
  message: { id: 'h1', at: EARLIER, content: 'το πηγάδι στην αυλή', author: { id: 'u2', name: 'Zoe' } },
} as unknown as Parameters<KeepLines>[0][number];

/** A keeper whose observer answers `answer` and counts what it is asked for. */
function keeperAnswering(answer: Awaited<ReturnType<ObserveLine>>): { keep: KeepLines; asked: Array<string> } {
  const asked: Array<string> = [];
  const observeLine: ObserveLine = (event) => {
    asked.push(event.message.id);
    return Promise.resolve(answer);
  };
  const keep = createKeepLines({
    hot: {},
    store: null,
    observeLine,
    selfIdOf: () => 'self-id',
    isServedRoot: () => true,
  });
  return { keep, asked };
}

const drained = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// The writer owns the retries of a line it was handed (src/memory/db/service.ts, OBSERVE_ATTEMPTS): a write that threw is
// queued and tried again, and a line handed while the database is closed waits in its queue. Its null answer is the end
// of that line's run, so a second hand-over only starts a fresh run of attempts on every tool step.
test('does not hand a line again to the observer when its write failed and the next read holds it', async () => {
  // Bug (2026-11-10): the keeper forgets a line whose write failed, so each history read of a tool loop hands it again
  // with a new run of attempts, 458 dropped observations and 2290 warnings for some twenty lines.
  const { keep, asked } = keeperAnswering(null);
  keep([historyLine]);
  await drained();
  keep([historyLine]);
  await drained();
  assert.deepEqual(asked, ['h1']);
});

test('does not hand a line again to the observer when the writer refused it and the next read holds it', async () => {
  // Bug: a refusal (`ok: false` with a code) is final for the same line, and handing it again refuses it again each step.
  const { keep, asked } = keeperAnswering({ ok: false, code: 'BAD_PLACE' });
  keep([historyLine]);
  await drained();
  keep([historyLine]);
  await drained();
  assert.deepEqual(asked, ['h1']);
});
