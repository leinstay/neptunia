// The mounted chat with colour on. Ink's colour level is fixed when it loads, so the rig is imported after the setting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { createElement } from 'react';
import type { ChatEnv } from '../cli/app.ts';

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

// The owner's colour of 2026-11-08: red for his lines, the header's title and its galaxy, one colour for the three. The
// test held cyan, the colour of before PR #716, until the owner's word of 2026-11-08 chose red.
const OWNER_RED = { color: 'red' };
const SENT = Date.UTC(2026, 10, 8, 13, 4);
const ESC = String.fromCharCode(27);

/** The styled row of the last frame whose text includes the needle. */
const rawRow = (raw: string, needle: string): string =>
  raw.split('\n').find((row) => stripVTControlCharacters(row).includes(needle)) ?? '';

type Style = { fg: string | null; dim: boolean };

/** The foreground colour and the dim flag in force where `needle` starts in a styled row, read from its SGR codes. */
function styleAt(raw: string, needle: string): Style {
  const end = raw.indexOf(needle);
  assert.ok(end >= 0, `${JSON.stringify(needle)} in ${JSON.stringify(raw)}`);
  const style: Style = { fg: null, dim: false };
  for (const found of raw.slice(0, end).matchAll(new RegExp(`${ESC}\\[([\\d;]*)m`, 'g'))) {
    const codes = (found[1] ?? '').split(';');
    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index] ?? '';
      if (code === '' || code === '0') Object.assign(style, { fg: null, dim: false });
      else if (code === '2') style.dim = true;
      else if (code === '22') style.dim = false;
      else if (code === '39') style.fg = null;
      else if (/^(3[0-7]|9[0-7])$/.test(code)) style.fg = code;
      else if (code === '38') {
        style.fg = codes.slice(index).join(';');
        break;
      }
    }
  }
  return style;
}

/** The style Ink draws a cell in for a token. */
const styleOf = (token: object): Style => styleAt(renderToString(createElement(Text, token, 'X')), 'X');

const BRIEF: Awaited<ReturnType<ChatEnv['status']>> = {
  core: { state: 'running', reason: null, model: null, route: 'direct-api', bound: true },
  memory: { session: 'apply', model: null, route: 'direct-api', bound: true, probe: 'ok', checkedAt: 1 },
  analyzer: { model: null, route: 'direct-api', bound: true },
  interfaces: [],
};

test("the owner's lines draw in red and her text in the terminal's own colour", async () => {
  // Bug: the owner's text takes another colour than the one he chose, or her plain text is tinted.
  const owner = styleOf(THEME.owner);
  assert.equal(owner.fg, styleOf(OWNER_RED).fg);
  const { env, entry } = chatEnv({ now: () => SENT, timeZone: 'UTC' });
  await withChat(env, async (rig) => {
    entry({ who: 'owner', text: 'o-line' });
    entry({ who: 'her', text: 'h-line' });
    await until(shows(rig, 'h-line'));
    const raw = rig.rawScreen();
    assert.equal(styleAt(rawRow(raw, 'o-line'), 'o-line').fg, owner.fg);
    assert.equal(styleAt(rawRow(raw, 'h-line'), 'h-line').fg, null);
  });
});

test("the header's title and its galaxy draw in the owner's colour, and its role lines in the terminal's own", async () => {
  // Bug: the title or the galaxy keeps a colour of its own beside his red, or a role line turns red with them.
  const owner = styleOf(THEME.owner).fg;
  const { env } = chatEnv({ status: () => Promise.resolve(BRIEF) });
  await withChat(env, async (rig) => {
    await until(() => rig.screen().some((line) => line.includes('Core: active')));
    const raw = rig.rawScreen();
    assert.equal(styleAt(rawRow(raw, 'neptunia'), 'neptunia').fg, owner);
    // The galaxy's still frame holds its centre `@` on the middle of its five rows.
    assert.equal(styleAt(rawRow(raw, '@'), '@').fg, owner);
    assert.equal(styleAt(rawRow(raw, 'Core: active'), 'Core: active').fg, null);
  });
});

test('the line numbers and the time row draw in the muted style', async () => {
  // Bug: the time row takes the owner's red, or a number lead loses its grey and reads as part of the text.
  const muted = styleOf(THEME.muted);
  const { env, entry } = chatEnv({ now: () => SENT, timeZone: 'UTC' });
  await withChat(env, async (rig) => {
    entry({ who: 'owner', text: 'o-line' });
    entry({ who: 'her', text: 'h-line' });
    await until(shows(rig, 'h-line'));
    const raw = rig.rawScreen();
    assert.deepEqual(styleAt(rawRow(raw, '[2026-11-08 13:04]'), '[2026-11-08 13:04]'), muted);
    assert.deepEqual(styleAt(rawRow(raw, 'o-line'), '[#1]'), muted);
    assert.deepEqual(styleAt(rawRow(raw, 'h-line'), '[#2]'), muted);
  });
});
