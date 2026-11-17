// The owner on 2026-11-17: the block of custom emoji and stickers is <media>.
// src/turn/request/legend.ts: the body of the root block `<media>`, the legend. Each custom emoji and sticker the
// window uses stands once, under its interface and its kind, with its stable name, its platform name and its full
// description (.agents/docs/specs/2026-11-17-stable-names-and-legend.md, "The legend"). Contract:
//   legendText(items: ReadonlyArray<{ iface, kind: 'emoji' | 'sticker', name, platformName, text: string | null,
//     readable: boolean }>, labels: Labels): string
// The labels are the test's own: a test reads structure and the values that pass through, never a label's wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legendText } from '../src/turn/request/legend.ts';
import { labels } from './fixtures/labels.ts';

const LABELS = {
  ...labels,
  legend: {
    line: '{name} {platformName}: {text}',
    lineNoText: 'NOTEXT {name} {platformName}',
    unreadable: 'UNSEEN {name} {platformName}',
  },
};

type Item = Parameters<typeof legendText>[0][number];

function emoji(name: string, platformName: string, text: string | null, iface = 'discord'): Item {
  return { iface, kind: 'emoji', name, platformName, text, readable: true };
}

function sticker(name: string, platformName: string, text: string | null, readable = true): Item {
  return { iface: 'discord', kind: 'sticker', name, platformName, text, readable };
}

/** The subtags of `text` in the order they open, nested ones included. */
function tagsOf(text: string): Array<string> {
  return [...text.matchAll(/<([a-z_]+)>/g)].map((match) => match[1]);
}

/** The lines of one kind's subtag under one interface's subtag, [] when it is absent. */
function kindLines(text: string, iface: string, kind: string): Array<string> {
  const scope = new RegExp(`<${iface}>([\\s\\S]*?)</${iface}>`).exec(text)?.[1] ?? '';
  const body = new RegExp(`<${kind}>([\\s\\S]*?)</${kind}>`).exec(scope)?.[1] ?? '';
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

test('legendText is empty when no item is given', () => {
  // Bug: the block's frame is printed with nothing in it.
  assert.equal(legendText([], LABELS), '');
});

test('legendText groups by interface, then emojis before stickers, holding only the interfaces and kinds that occur', () => {
  // Bug: the kinds mix in one list, or an empty `<stickers>` is printed for an interface that has none.
  const text = legendText(
    [
      emoji('e5', 'blob', 'a blob', 'matrix'),
      sticker('s12', 'wave', 'a cat raising one paw'),
      emoji('e23', 'kekw', 'a frog laughing'),
    ],
    LABELS
  );
  assert.deepEqual(tagsOf(text), ['discord', 'emojis', 'stickers', 'matrix', 'emojis']);
  assert.deepEqual(kindLines(text, 'discord', 'emojis'), [':e23: kekw: a frog laughing']);
  assert.deepEqual(kindLines(text, 'discord', 'stickers'), ['s12 wave: a cat raising one paw']);
  assert.deepEqual(kindLines(text, 'matrix', 'emojis'), [':e5: blob: a blob']);
});

test('legendText lists the things of a kind in the order of their numbers', () => {
  // Bug: the names sort as text, so `e12` stands before `e3` and the order moves as names are issued.
  const text = legendText([emoji('e12', 'twelve', 'twelve'), emoji('e3', 'three', 'three')], LABELS);
  assert.deepEqual(kindLines(text, 'discord', 'emojis'), [':e3: three: three', ':e12: twelve: twelve']);
});

test('legendText keeps a description of 1,400 characters whole', () => {
  // Bug: the legend shortens a description, and she loses the end of what the helper saw.
  const long = `${'x'.repeat(1396)} END`;
  assert.equal(long.length, 1400);
  const text = legendText([emoji('e23', 'kekw', long)], LABELS);
  assert.deepEqual(kindLines(text, 'discord', 'emojis'), [`:e23: kekw: ${long}`]);
});

test('legendText writes a thing with no description yet in lineNoText', () => {
  // Bug: a thing not yet described is dropped, and she meets a name the legend does not explain.
  const text = legendText([emoji('e24', 'wavey', null), sticker('s14', 'nod', null)], LABELS);
  assert.deepEqual(kindLines(text, 'discord', 'emojis'), ['NOTEXT :e24: wavey']);
  assert.deepEqual(kindLines(text, 'discord', 'stickers'), ['NOTEXT s14 nod']);
});

test('legendText writes a sticker with no picture in unreadable, whatever text it carries', () => {
  // Bug: a Lottie sticker reads as seen, from a caption nobody could have made of it.
  const text = legendText([sticker('s13', 'dance_loop', 'a stale caption', false)], LABELS);
  assert.deepEqual(kindLines(text, 'discord', 'stickers'), ['UNSEEN s13 dance_loop']);
});
