// interfaces/cli/clipboard.ts: acquiring an image from the clipboard, with fake processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClipboard } from '../../../interfaces/cli/clipboard.ts';
import { syntheticPng } from '../../fixtures/synthetic-png.ts';

const png = syntheticPng();

function runner(answer: { code: number; stdout: Uint8Array; missing?: boolean }) {
  const calls: Array<ReadonlyArray<string>> = [];
  return {
    calls,
    run: (argv: ReadonlyArray<string>) => {
      calls.push(argv);
      return Promise.resolve(answer);
    },
  };
}

test('over SSH the clipboard is unavailable and no process is started', async () => {
  // Bug: the server's own clipboard, or an error, is passed off as the laptop's picture.
  const fake = runner({ code: 0, stdout: png });
  const clipboard = createClipboard({
    platform: 'linux',
    env: { SSH_CONNECTION: '192.0.2.1 1 192.0.2.2 22', DISPLAY: ':0' },
    run: fake.run,
  });
  assert.equal((await clipboard.read()).status, 'unavailable');
  assert.deepEqual(fake.calls, []);
});

test('a Wayland session reads a PNG with literal argv and no shell', async () => {
  // Bug: a command string through a shell, or a picture returned changed.
  const fake = runner({ code: 0, stdout: png });
  const clipboard = createClipboard({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, run: fake.run });
  const result = await clipboard.read();
  assert.equal(result.status, 'image');
  if (result.status === 'image') {
    assert.deepEqual(Buffer.from(result.bytes), png);
    assert.equal(result.contentType, 'image/png');
  }
  const call = fake.calls[0];
  assert.equal(call?.[0], 'wl-paste');
  assert.equal(['sh', 'bash'].includes(String(call?.[0])), false);
});

test('an X11 session uses its own tool', async () => {
  // Bug: only Wayland works, or an X11 desktop reports no clipboard at all.
  const fake = runner({ code: 0, stdout: png });
  const clipboard = createClipboard({ platform: 'linux', env: { DISPLAY: ':0' }, run: fake.run });
  assert.equal((await clipboard.read()).status, 'image');
  const call = fake.calls[0];
  assert.equal(call?.[0], 'xclip');
});

test('a missing tool is unavailable, a failing one is failed, and no display at all starts nothing', async () => {
  // Bug: a missing wl-paste reads as an empty clipboard, and the owner never learns why paste does nothing.
  const env = { WAYLAND_DISPLAY: 'wayland-0' };
  const missing = createClipboard({
    platform: 'linux',
    env,
    run: runner({ code: 127, stdout: new Uint8Array(), missing: true }).run,
  });
  assert.equal((await missing.read()).status, 'unavailable');
  const failing = createClipboard({ platform: 'linux', env, run: runner({ code: 2, stdout: new Uint8Array() }).run });
  assert.equal((await failing.read()).status, 'failed');
  const fake = runner({ code: 0, stdout: png });
  assert.equal((await createClipboard({ platform: 'linux', env: {}, run: fake.run }).read()).status, 'unavailable');
  assert.deepEqual(fake.calls, []);
});

test('text in the clipboard is not an image, and no bytes is empty', async () => {
  // Bug: copied text is staged as a broken picture part.
  const env = { WAYLAND_DISPLAY: 'wayland-0' };
  const text = createClipboard({ platform: 'linux', env, run: runner({ code: 0, stdout: Buffer.from('words') }).run });
  assert.equal((await text.read()).status, 'empty');
  const none = createClipboard({ platform: 'linux', env, run: runner({ code: 0, stdout: new Uint8Array() }).run });
  assert.equal((await none.read()).status, 'empty');
});

test('a platform with no adapter says unavailable', async () => {
  // Bug: an unsupported platform crashes the chat on the first paste.
  const fake = runner({ code: 0, stdout: png });
  assert.equal((await createClipboard({ platform: 'aix', env: {}, run: fake.run }).read()).status, 'unavailable');
  assert.deepEqual(fake.calls, []);
});
