// Tests for src/turn/handles.ts: the turn's one handle registry. Every `#n` of a request is issued here, and `canonical`
// replaces each reference in a text bound for a durable row by the line's identity `src:<iface>:<message id>:<revision>`
// and cuts a number that resolves to nothing. Plan 2026-11-06-turn-frame, slice 2 (f), and "References that survive
// the turn". Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandles } from '../src/turn/handles.ts';

const PLACE = 'discord:channel:room-1';

/** A registry holding fifteen chat lines, numbered `#1` to `#15` in order, `#n` being message `m-<n>` at revision 1. */
function fifteenLines() {
  const handles = createHandles();
  const numbers: Array<number> = [];
  for (let i = 1; i <= 15; i += 1)
    numbers.push(
      handles.issue('chat', { sourceId: `src:discord:m-${i}:1:seen`, placeId: PLACE, messageId: `m-${i}`, revision: 1 })
    );
  assert.deepEqual(
    numbers,
    Array.from({ length: 15 }, (_, i) => i + 1),
    'the chat lines are numbered from 1 in order'
  );
  return { handles };
}

test('canonical replaces a chat line, a reply parent, a pulled line and a search handle by distinct identities, and cuts an unknown number', () => {
  // Bug: two producers number from 1 and collide, or a number nobody can read back is stored as it is.
  const handles = createHandles();
  const chat = handles.issue('chat', {
    sourceId: 'src:discord:m-1:1:seen',
    placeId: PLACE,
    messageId: 'm-1',
    revision: 1,
  });
  const parent = handles.issue('parent', {
    sourceId: 'src:discord:m-2:3:seen',
    placeId: PLACE,
    messageId: 'm-2',
    revision: 3,
  });
  const pulled = handles.issue('pulled', {
    sourceId: 'src:telegram:m-3:1:seen',
    placeId: 'telegram:channel:g-9',
    messageId: 'm-3',
    revision: 1,
  });
  const search = handles.issue('search', {
    sourceId: 'src:discord:m-4:2:said',
    placeId: PLACE,
    messageId: 'm-4',
    revision: 2,
  });
  assert.equal(new Set([chat, parent, pulled, search]).size, 4);
  const unknown = Math.max(chat, parent, pulled, search) + 7;
  const out = handles.canonical(`a #${chat} b #${parent} c #${pulled} d #${search} e #${unknown} f`);
  assert.ok(out.startsWith('a src:discord:m-1:1 b src:discord:m-2:3 c src:telegram:m-3:1 d src:discord:m-4:2 e'), out);
  assert.ok(out.endsWith(' f'), out);
  assert.ok(!/#\d/.test(out), out);
});

test('canonical leaves a number glued to a letter or to a word before it as it is', () => {
  // Bug: a hashtag, a colour or an issue number in her words is rewritten into a line's identity.
  const { handles } = fifteenLines();
  for (const text of ['#12a', 'x#12', 'issue#12 here', '#12b and #12c'])
    assert.equal(handles.canonical(text), text, text);
});

test('canonical reads a bare number, a number in parentheses and a range as references', () => {
  // Bug: only the bare form is recognised, so `(#12)` and `#12-#15` survive into stored text.
  const { handles } = fifteenLines();
  assert.equal(handles.canonical('#12'), 'src:discord:m-12:1');
  assert.equal(handles.canonical('(#12)'), '(src:discord:m-12:1)');
  const range = handles.canonical('#12-#15');
  assert.ok(range.includes('src:discord:m-12:1') && range.includes('src:discord:m-15:1'), range);
  assert.ok(!range.includes('#'), range);
});
