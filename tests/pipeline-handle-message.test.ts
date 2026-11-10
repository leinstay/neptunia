// A bot is a person to her (owner's rule of 2026-11-10, src/pipeline/handle-message.ts): a line a bot or a webhook
// writes is stored like a member's, and a bot that names her starts her turn as a member would. The core over the
// fake interface (tests/fixtures/core-over-fake.ts). Synthetic lines, in Greek.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelInfo, deliver, until, withFakeCore } from './fixtures/core-over-fake.ts';
import type { Fake } from './fixtures/core-over-fake.ts';

const NOW = Date.now();
const seed = (fake: Fake): void => fake.seedChat(channelInfo('c1', { name: 'general' }));

test("stores a bot's line as a seen line", async () => {
  await withFakeCore({ seed }, async (rig) => {
    const line = deliver(rig.fake, {
      id: 'b1',
      text: 'ο καιρός αύριο: βροχή',
      at: NOW - 1000,
      authorId: 'bot1',
      bot: true,
    });
    assert.equal(await rig.emit(line), 'ok');
    await until(() => rig.linesOf('b1').length > 0);
    assert.deepEqual(
      rig.linesOf('b1').map((row) => [row.kind, row.text]),
      [['seen', 'ο καιρός αύριο: βροχή']]
    );
  });
});

test('answers a bot that names her as she answers a member', async () => {
  await withFakeCore({ seed }, async (rig) => {
    const call = deliver(rig.fake, {
      id: 'b2',
      text: 'γεια σου',
      at: NOW - 1000,
      authorId: 'bot1',
      bot: true,
      mention: true,
    });
    assert.equal(await rig.emit(call), 'ok');
    await until(() => rig.posted('c1').length === 1);
    assert.equal(rig.requests.length, 1);
  });
});

test('stores her own line that carries a pairing phrase when its echo arrives', async () => {
  const text =
    'Your one-time pairing phrase is: πέτρα δέντρο νερό φωτιά αέρας χώμα. Type /interfaces pair followed by these six words in her command line within an hour.';
  await withFakeCore({ seed }, async (rig) => {
    assert.equal(await rig.emit(deliver(rig.fake, { id: 'k1', text, at: NOW - 1000, authorId: 'self-id' })), 'ok');
    await until(() => rig.linesOf('k1').length > 0);
    assert.equal(rig.linesOf('k1')[0]?.text, text);
  });
});
