// The command line's chat over its stored lines (plan 2026-11-06-turn-frame, slice 4 "Done"): a fresh chat draws the
// newest stored lines of `cli:dm:owner`, and Page Up at the top of the transcript loads the page before the oldest line
// shown. The chat asks through one function of its env, the shape the specifier chose:
//   ChatEnv.storedPage?: (before: string | null) => Promise<ReadonlyArray<ChatEntry & { id: string }>>
// `before` null asks for the newest page, an id for the page that ends just before that stored line, oldest first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatEntry } from '../cli/index.ts';
import { KEY, chatEnv, press, shows, until, withChat } from './fixtures/chat-rig.ts';
import type { Rig } from './fixtures/chat-rig.ts';

type Stored = ChatEntry & { id: string };

const PAGES: Record<string, ReadonlyArray<Stored>> = {
  newest: [
    { id: 's3', who: 'owner', text: 'ΓΡΑΜΜΗ-ΤΡΙΤΗ' },
    { id: 's4', who: 'her', text: 'ΓΡΑΜΜΗ-ΤΕΤΑΡΤΗ' },
  ],
  s3: [
    { id: 's1', who: 'owner', text: 'ΓΡΑΜΜΗ-ΠΡΩΤΗ' },
    { id: 's2', who: 'her', text: 'ΓΡΑΜΜΗ-ΔΕΥΤΕΡΗ' },
  ],
};

function pager(): {
  asked: Array<string | null>;
  storedPage: (before: string | null) => Promise<ReadonlyArray<Stored>>;
} {
  const asked: Array<string | null> = [];
  return {
    asked,
    storedPage: (before) => {
      asked.push(before);
      return Promise.resolve(PAGES[before ?? 'newest'] ?? []);
    },
  };
}

test('a fresh chat shows the newest stored lines', async () => {
  // Bug: the chat opens empty after a restart, though the core keeps every line of the session.
  const { asked, storedPage } = pager();
  const { env } = chatEnv({ storedPage });
  await withChat(env, async (rig) => {
    await until(shows(rig, 'ΓΡΑΜΜΗ-ΤΕΤΑΡΤΗ'));
    assert.ok(rig.screen().join('\n').includes('ΓΡΑΜΜΗ-ΤΡΙΤΗ'));
    assert.ok(rig.screen().join('\n').includes('ΓΡΑΜΜΗ-ΤΕΤΑΡΤΗ'));
  });
  assert.deepEqual(asked.slice(0, 1), [null]);
});

test('Page Up at the top asks for the page before the oldest line shown and draws it above', async () => {
  // Bug: the second page starts again from the newest line, or from a line the screen already holds.
  const { asked, storedPage } = pager();
  const { env } = chatEnv({ storedPage });
  await withChat(env, async (rig) => {
    await until(shows(rig, 'ΓΡΑΜΜΗ-ΤΕΤΑΡΤΗ'));
    rig.type(KEY.pageUp);
    await until(shows(rig, 'ΓΡΑΜΜΗ-ΠΡΩΤΗ'));
    const screen = rig.screen().join('\n');
    assert.ok(
      screen.indexOf('ΓΡΑΜΜΗ-ΔΕΥΤΕΡΗ') >= 0 && screen.indexOf('ΓΡΑΜΜΗ-ΔΕΥΤΕΡΗ') < screen.indexOf('ΓΡΑΜΜΗ-ΤΡΙΤΗ')
    );
  });
  assert.deepEqual(asked.slice(0, 2), [null, 's3']);
});

// A line's time, from the specifier's shape: `ChatEntry.at` (ms since the epoch, when it was sent) and `ChatEnv.timeZone`
// (`bot.timezone`), drawn as the date and the minute in that zone.
const SENT = Date.UTC(2026, 10, 8, 13, 4);
const DRAWN = Date.UTC(2026, 10, 9, 7, 30);

test('a stored line carries the time it was sent, not the time it was drawn', async () => {
  // Bug: the transcript shows no times, or a line loaded from memory shows the moment the chat opened.
  const { env } = chatEnv({
    storedPage: (before) =>
      Promise.resolve(before === null ? [{ id: 's1', who: 'owner', text: 'ΓΡΑΜΜΗ-ΠΡΩΤΗ', at: SENT }] : []),
    now: () => DRAWN,
    timeZone: 'UTC',
  });
  await withChat(env, async (rig) => {
    await until(shows(rig, 'ΓΡΑΜΜΗ-ΠΡΩΤΗ'));
    const screen = rig.screen().join('\n');
    assert.ok(screen.includes('2026-11-08 13:04'), screen);
    assert.ok(!screen.includes('2026-11-09 07:30'));
  });
});

test("the owner's line just sent carries its send time in the persona's zone", async () => {
  // Bug: the time is the server's local clock or UTC whatever `bot.timezone` says.
  const { env } = chatEnv({ now: () => SENT, timeZone: 'Asia/Tokyo' });
  await withChat(env, async (rig) => {
    await press(rig, 'ΓΡΑΜΜΗ-ΝΕΑ', shows(rig, '> ΓΡΑΜΜΗ-ΝΕΑ'));
    rig.type(KEY.enter);
    await until(shows(rig, '2026-11-08 22:04'));
    assert.ok(rig.screen().join('\n').includes('2026-11-08 22:04'), 'the time in the persona zone');
  });
});

/** The rows above the input box: the chat and the header, never the draft's own `> ` prompt. */
const chatRows = (rig: Rig): Array<string> => {
  const screen = rig.screen();
  return screen
    .slice(
      0,
      screen.findIndex((line) => line.startsWith('╭'))
    )
    .map((line) => line.trimEnd());
};

test('every line opens with its time, then its number, then its text, and no line carries a `>` mark', async () => {
  // Bug: the time stands on a row of its own, the number is missing or comes first, or the owner's line keeps `> `.
  const { env, entry } = chatEnv({ now: () => SENT, timeZone: 'UTC' });
  await withChat(env, async (rig) => {
    await press(rig, 'ΓΡΑΜΜΗ-ΝΕΑ', shows(rig, '> ΓΡΑΜΜΗ-ΝΕΑ'));
    await press(rig, KEY.enter, () => chatRows(rig).some((line) => line.includes('ΓΡΑΜΜΗ-ΝΕΑ')));
    entry({ who: 'her', text: 'her-reply' });
    await until(shows(rig, 'her-reply'));
    const rows = chatRows(rig);
    assert.ok(rows.includes('[2026-11-08 13:04] [#1] ΓΡΑΜΜΗ-ΝΕΑ'), rows.join('\n'));
    assert.ok(rows.includes('[2026-11-08 13:04] [#2] her-reply'), rows.join('\n'));
    assert.equal(
      rows.some((line) => line.trimStart().startsWith('>')),
      false
    );
  });
});

test("a blank row stands after her line only when the owner's line follows it", async () => {
  // Bug: a blank row before every owner line, after every reply, or none between her answer and his next line.
  const { env, entry } = chatEnv({ timeZone: 'UTC' });
  await withChat(env, async (rig) => {
    for (const [who, text] of [
      ['owner', 'o-one'],
      ['her', 'h-one'],
      ['owner', 'o-two'],
      ['owner', 'o-three'],
      ['her', 'h-two'],
      ['her', 'h-three'],
    ] as const)
      entry({ who, text });
    await until(shows(rig, 'h-three'));
    const rows = chatRows(rig);
    const at = (needle: string): number => rows.findIndex((line) => line.endsWith(` ${needle}`));
    assert.equal(at('h-one') - at('o-one'), 1);
    assert.equal(at('o-two') - at('h-one'), 2);
    assert.equal(rows[at('h-one') + 1], '');
    assert.equal(at('o-three') - at('o-two'), 1);
    assert.equal(at('h-two') - at('o-three'), 1);
    assert.equal(at('h-three') - at('h-two'), 1);
  });
});

test("a line's later rows start in the column of its text, under the lead", async () => {
  // Bug: a reply's second line starts at the left edge, under the time, so the text loses its column.
  const { env, entry } = chatEnv({ timeZone: 'UTC' });
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'first-row\nsecond-row' });
    await until(shows(rig, 'second-row'));
    const rows = chatRows(rig);
    const first = rows.find((line) => line.endsWith('first-row')) ?? '';
    const second = rows.find((line) => line.endsWith('second-row')) ?? '';
    assert.equal(second.indexOf('second-row'), first.indexOf('first-row'));
  });
});
