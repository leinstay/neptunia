// The mounted chat with colour on. Ink's colour level is fixed when it loads, so the rig is imported after the setting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { createElement } from 'react';

process.env.FORCE_COLOR = '3';
const { KEY, chatEnv, press, shows, until, withChat } = await import('./fixtures/chat-rig.ts');
const { Text, renderToString } = await import('ink');
const { THEME } = await import('../cli/theme.ts');

test('the caret on an astral character styles the whole character', async () => {
  // Bug: the caret cell takes one UTF-16 unit, the style splits the surrogate pair and the terminal shows two broken cells.
  const { env } = chatEnv();
  await withChat(env, async (rig) => {
    await press(rig, '🙂x', shows(rig, '> 🙂x'));
    // The caret is only a style, so the plain screen cannot show a move: the styled frame changing does.
    for (let move = 0; move < 2; move += 1) {
      const before = rig.rawScreen();
      await press(rig, KEY.left, () => rig.rawScreen() !== before);
    }
    assert.equal(rig.rawScreen().includes('�'), false);
    assert.match(rig.rawScreen(), /🙂/);
  });
});

// The owner's colour as it stood before PR #716: `userMarker` in `cli/theme.ts` at 840d99ad.
const BEFORE_716 = { color: 'cyan' };
const SENT = Date.UTC(2026, 10, 8, 13, 4);

/** The escape sequence that opens a style, read from Ink drawing one cell in it. */
const opening = (style: object): string => {
  const drawn = renderToString(createElement(Text, style, 'X'));
  return drawn.slice(0, drawn.indexOf('X'));
};

/** The styled row of the last frame whose text includes the needle. */
const rawRow = (raw: string, needle: string): string =>
  raw.split('\n').find((row) => stripVTControlCharacters(row).includes(needle)) ?? '';

/** Any escape sequence that sets a foreground colour. */
const COLOUR_CODE = new RegExp(`${String.fromCharCode(27)}\\[(?:3[0-79]|9[0-7]|38;)`);

test("the owner's lines and his time row draw in his colour of before PR #716, and her text in the terminal's own", async () => {
  // Bug: the owner's text takes another colour than the one he knew, or her plain text is tinted grey.
  assert.deepEqual(THEME.owner, BEFORE_716);
  const owner = opening(THEME.owner);
  const { env, entry } = chatEnv({ now: () => SENT, timeZone: 'UTC' });
  await withChat(env, async (rig) => {
    entry({ who: 'owner', text: 'o-line' });
    entry({ who: 'her', text: 'h-line' });
    await until(shows(rig, 'h-line'));
    const raw = rig.rawScreen();
    assert.ok(rawRow(raw, 'o-line').includes(owner), JSON.stringify(rawRow(raw, 'o-line')));
    assert.ok(rawRow(raw, '2026-11-08 13:04').includes(owner), JSON.stringify(rawRow(raw, '2026-11-08 13:04')));
    assert.equal(COLOUR_CODE.test(rawRow(raw, 'h-line')), false, JSON.stringify(rawRow(raw, 'h-line')));
  });
});
