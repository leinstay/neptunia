// The mounted chat with colour on. Ink's colour level is fixed when it loads, so the rig is imported after the setting.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.FORCE_COLOR = '3';
const { KEY, chatEnv, pause, withChat } = await import('./fixtures/chat-rig.ts');

test('the caret on an astral character styles the whole character', async () => {
  // Bug: the caret cell takes one UTF-16 unit, the style splits the surrogate pair and the terminal shows two broken cells.
  const { env } = chatEnv();
  await withChat(env, async (rig) => {
    rig.type('🙂x');
    await pause();
    rig.type(KEY.left);
    await pause();
    rig.type(KEY.left);
    await pause();
    assert.equal(rig.rawScreen().includes('�'), false);
    assert.match(rig.rawScreen(), /🙂/);
  });
});
