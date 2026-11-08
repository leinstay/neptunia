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

test('every line opens with its number, then its text, carries no date and no `>` mark', async () => {
  // Bug: the date stays in the line, the number is missing or comes first, or the owner's line keeps `> `.
  // The lead held the date as well until the owner's word of 2026-11-08 moved it to a time row of its own.
  const { env, entry } = chatEnv({ now: () => SENT, timeZone: 'UTC' });
  await withChat(env, async (rig) => {
    await press(rig, 'ΓΡΑΜΜΗ-ΝΕΑ', shows(rig, '> ΓΡΑΜΜΗ-ΝΕΑ'));
    await press(rig, KEY.enter, () => chatRows(rig).some((line) => line.includes('ΓΡΑΜΜΗ-ΝΕΑ')));
    entry({ who: 'her', text: 'her-reply' });
    await until(shows(rig, 'her-reply'));
    const rows = chatRows(rig);
    assert.ok(rows.includes('[#1] ΓΡΑΜΜΗ-ΝΕΑ'), rows.join('\n'));
    assert.ok(rows.includes('[#2] her-reply'), rows.join('\n'));
    assert.equal(
      rows.some((line) => line.trimStart().startsWith('>')),
      false
    );
  });
});

/**
 * The rows of the chat that hold the time `[2026-11-08 13:04]` and nothing else. The owner's word of 2026-11-08 put the
 * time in brackets, so the bare time of before no longer counts as a time row.
 */
const timeRows = (rows: ReadonlyArray<string>): Array<number> =>
  rows.flatMap((line, index) => (line.trim() === '[2026-11-08 13:04]' ? [index] : []));

test("the time row starts at the terminal's left edge in brackets, as the line numbers do", async () => {
  // Bug: the time row stands indented to the text column, or it loses its brackets and reads as a line of text.
  const { env, entry } = chatEnv({ now: () => SENT, timeZone: 'UTC' });
  await withChat(env, async (rig) => {
    entry({ who: 'owner', text: 'o-first' });
    await until(shows(rig, 'o-first'));
    const rows = chatRows(rig);
    const at = rows.findIndex((line) => line.endsWith(' o-first'));
    assert.equal(rows[at - 1], '[2026-11-08 13:04]', rows.join('\n'));
    assert.equal(rows[at]?.startsWith('[#'), true, rows.join('\n'));
  });
});

/** The number leads of the chat's rows, such as `[#07]`, in the order they stand. */
const leads = (rows: ReadonlyArray<string>): Array<string> => rows.flatMap((line) => /^\[#\d+\]/.exec(line)?.[0] ?? []);

test('a history of nine lines draws its numbers with one digit and no padding', async () => {
  // Bug: the padding counts a digit too many, so a short chat opens `[#01]`.
  const { env, entry } = chatEnv({ now: () => SENT, timeZone: 'UTC' });
  await withChat(
    env,
    async (rig) => {
      for (let index = 1; index <= 9; index += 1) entry({ who: 'her', text: `line-${index}` });
      await until(shows(rig, 'line-9'));
      const rows = chatRows(rig);
      assert.ok(rows.includes('[#1] line-1'), rows.join('\n'));
      assert.ok(rows.includes('[#9] line-9'), rows.join('\n'));
    },
    { rows: 40 }
  );
});

test('a history of 120 lines pads every number to three digits, so the text keeps one column', async () => {
  // Bug: `[#9]`, `[#99]` and `[#120]` take different widths, and the text column jumps from line to line.
  const { env, entry } = chatEnv({ now: () => SENT, timeZone: 'UTC' });
  await withChat(
    env,
    async (rig) => {
      for (let index = 1; index <= 120; index += 1) entry({ who: 'her', text: `line-${index}` });
      await until(shows(rig, 'line-120'));
      const rows = chatRows(rig);
      assert.ok(rows.includes('[#001] line-1'), rows.join('\n'));
      assert.ok(rows.includes('[#010] line-10'), rows.join('\n'));
      assert.ok(rows.includes('[#099] line-99'), rows.join('\n'));
      assert.ok(rows.includes('[#120] line-120'), rows.join('\n'));
      assert.deepEqual(new Set(leads(rows).map((lead) => lead.length)), new Set([6]));
    },
    { rows: 140 }
  );
});

test("a time row stands above the owner's first line and above his line after hers, and nowhere else", async () => {
  // Bug: the time stands above every line, above her lines, or above none of his.
  const { env, entry } = chatEnv({ now: () => SENT, timeZone: 'UTC' });
  await withChat(env, async (rig) => {
    for (const [who, text] of [
      ['owner', 'o-one'],
      ['owner', 'o-two'],
      ['her', 'h-one'],
      ['owner', 'o-three'],
      ['her', 'h-two'],
      ['her', 'h-three'],
    ] as const)
      entry({ who, text });
    await until(shows(rig, 'h-three'));
    const rows = chatRows(rig);
    const at = (needle: string): number => rows.findIndex((line) => line.endsWith(` ${needle}`));
    assert.deepEqual(timeRows(rows), [at('o-one') - 1, at('o-three') - 1], rows.join('\n'));
    assert.equal(rows[at('o-three') - 2], '');
  });
});

test('a chat that opens with her line draws no time row above it', async () => {
  // Bug: the first line of the view takes a time row whoever said it.
  const { env, entry } = chatEnv({ now: () => SENT, timeZone: 'UTC' });
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'h-first' });
    entry({ who: 'her', text: 'h-second' });
    await until(shows(rig, 'h-second'));
    assert.deepEqual(timeRows(chatRows(rig)), []);
  });
});

test("a blank row stands after her line only when the owner's line follows it", async () => {
  // Bug: a blank row before every owner line, after every reply, or none between her answer and his next line.
  // The owner's line after hers carries a time row between the blank row and its text since the owner's word of
  // 2026-11-08, so it stands three rows under her line.
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
    assert.equal(at('o-two') - at('h-one'), 3);
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

// A line's number, from the specifier's shape: `ChatEntry.number`, the line's place in the chat's whole stored history as
// the core numbers it (`session.page`). A new line takes the number after the line before it until her turn is committed,
// and then the number of its stored line, which the chat reads again with `storedPage(null)`.
// The rows below are matched whole as `[#N] text`: the owner's word of 2026-11-08 took the date out of the lead.
const NUMBERED: Record<string, ReadonlyArray<Stored>> = {
  newest: [
    { id: 's3', who: 'owner', text: 'ΓΡΑΜΜΗ-ΤΡΙΤΗ', at: SENT, number: 1334 },
    { id: 's4', who: 'her', text: 'ΓΡΑΜΜΗ-ΤΕΤΑΡΤΗ', at: SENT, number: 1335 },
  ],
  s3: [
    { id: 's1', who: 'owner', text: 'ΓΡΑΜΜΗ-ΠΡΩΤΗ', at: SENT, number: 1332 },
    { id: 's2', who: 'her', text: 'ΓΡΑΜΜΗ-ΔΕΥΤΕΡΗ', at: SENT, number: 1333 },
  ],
};

const numberedPage = (before: string | null): Promise<ReadonlyArray<Stored>> =>
  Promise.resolve(NUMBERED[before ?? 'newest'] ?? []);

test('a stored line draws the number of its place in the whole chat, and keeps it after older lines load above', async () => {
  // Bug: the number counts from the oldest line on the screen, so Page Up renumbers every line already shown.
  const { env } = chatEnv({ storedPage: numberedPage, timeZone: 'UTC' });
  await withChat(env, async (rig) => {
    await until(shows(rig, 'ΓΡΑΜΜΗ-ΤΕΤΑΡΤΗ'));
    assert.ok(chatRows(rig).includes('[#1335] ΓΡΑΜΜΗ-ΤΕΤΑΡΤΗ'), chatRows(rig).join('\n'));
    rig.type(KEY.pageUp);
    await until(shows(rig, 'ΓΡΑΜΜΗ-ΠΡΩΤΗ'));
    const screen = rig.screen().join('\n');
    assert.ok(screen.includes('[#1332] ΓΡΑΜΜΗ-ΠΡΩΤΗ'), screen);
    assert.ok(screen.includes('[#1335] ΓΡΑΜΜΗ-ΤΕΤΑΡΤΗ'), screen);
  });
});

// The owner's word of 2026-11-08: the numbers take one width from the whole stored history, the number of its newest
// line, so a page of older lines with fewer digits loads under the width the chat opened with.
const ACROSS_HUNDRED: Record<string, ReadonlyArray<Stored>> = {
  newest: [
    { id: 's3', who: 'owner', text: 'ΓΡΑΜΜΗ-ΤΡΙΤΗ', at: SENT, number: 100 },
    { id: 's4', who: 'her', text: 'ΓΡΑΜΜΗ-ΤΕΤΑΡΤΗ', at: SENT, number: 101 },
  ],
  s3: [
    { id: 's1', who: 'owner', text: 'ΓΡΑΜΜΗ-ΠΡΩΤΗ', at: SENT, number: 98 },
    { id: 's2', who: 'her', text: 'ΓΡΑΜΜΗ-ΔΕΥΤΕΡΗ', at: SENT, number: 99 },
  ],
};

test('older lines loaded above take the width of the whole history, and the lines shown keep theirs', async () => {
  // Bug: the width follows the lines on the screen, so Page Up or a scroll reflows every line already shown.
  const { env } = chatEnv({
    storedPage: (before) => Promise.resolve(ACROSS_HUNDRED[before ?? 'newest'] ?? []),
    timeZone: 'UTC',
  });
  await withChat(env, async (rig) => {
    await until(shows(rig, 'ΓΡΑΜΜΗ-ΤΕΤΑΡΤΗ'));
    rig.type(KEY.pageUp);
    await until(shows(rig, 'ΓΡΑΜΜΗ-ΠΡΩΤΗ'));
    const screen = rig.screen().join('\n');
    assert.ok(screen.includes('[#098] ΓΡΑΜΜΗ-ΠΡΩΤΗ'), screen);
    assert.ok(screen.includes('[#099] ΓΡΑΜΜΗ-ΔΕΥΤΕΡΗ'), screen);
    assert.ok(screen.includes('[#101] ΓΡΑΜΜΗ-ΤΕΤΑΡΤΗ'), screen);
  });
});

test('a fresh chat over the same stored lines draws the same numbers', async () => {
  // Bug: a restarted chat numbers its first page from one again.
  for (let start = 0; start < 2; start += 1) {
    const { env } = chatEnv({ storedPage: numberedPage, timeZone: 'UTC' });
    await withChat(env, async (rig) => {
      await until(shows(rig, 'ΓΡΑΜΜΗ-ΤΕΤΑΡΤΗ'));
      assert.ok(chatRows(rig).includes('[#1334] ΓΡΑΜΜΗ-ΤΡΙΤΗ'), chatRows(rig).join('\n'));
    });
  }
});

test('a new line takes the number after the newest stored line, and the line sent to her carries no number', async () => {
  // Bug: a new line restarts at one under stored lines, or the drawn `#N` goes into the line her turn reads.
  const { env, sent } = chatEnv({ storedPage: numberedPage, now: () => SENT, timeZone: 'UTC' });
  await withChat(env, async (rig) => {
    await until(shows(rig, 'ΓΡΑΜΜΗ-ΤΕΤΑΡΤΗ'));
    await press(rig, 'ΓΡΑΜΜΗ-ΝΕΑ', shows(rig, '> ΓΡΑΜΜΗ-ΝΕΑ'));
    await press(rig, KEY.enter, () => chatRows(rig).some((line) => line.includes('ΓΡΑΜΜΗ-ΝΕΑ')));
    assert.ok(chatRows(rig).includes('[#1336] ΓΡΑΜΜΗ-ΝΕΑ'), chatRows(rig).join('\n'));
  });
  assert.deepEqual(sent, ['ΓΡΑΜΜΗ-ΝΕΑ']);
});

test('once her turn is committed, a new line takes the number its stored line holds', async () => {
  // Bug: a line sent while another client added lines keeps a counted number that names another stored line.
  let stored: ReadonlyArray<Stored> = NUMBERED.newest ?? [];
  const { env, listeners } = chatEnv({
    storedPage: (before) => Promise.resolve(before === null ? stored : []),
    now: () => SENT,
    timeZone: 'UTC',
  });
  await withChat(env, async (rig) => {
    await until(shows(rig, 'ΓΡΑΜΜΗ-ΤΕΤΑΡΤΗ'));
    await press(rig, 'ΓΡΑΜΜΗ-ΝΕΑ', shows(rig, '> ΓΡΑΜΜΗ-ΝΕΑ'));
    await press(rig, KEY.enter, shows(rig, '[#1336] ΓΡΑΜΜΗ-ΝΕΑ'));
    stored = [
      ...stored,
      { id: 's8', who: 'owner', text: 'from another client', at: SENT, number: 1339 },
      { id: 's9', who: 'owner', text: 'ΓΡΑΜΜΗ-ΝΕΑ', at: SENT, number: 1340 },
    ];
    listeners.turn?.({ type: 'accepted', turnId: 't1', seq: 1, at: SENT });
    listeners.turn?.({ type: 'committed', turnId: 't1', seq: 2, at: SENT });
    await until(shows(rig, '[#1340] ΓΡΑΜΜΗ-ΝΕΑ'));
    assert.ok(shows(rig, '[#1340] ΓΡΑΜΜΗ-ΝΕΑ')(), rig.screen().join('\n'));
    assert.equal(rig.screen().join('\n').includes('[#1336]'), false);
  });
});

test('a file of hers that comes right after her words shares their number, and the next line takes the one after', async () => {
  // Bug: her picture counts as a line of its own, so every later number is one past its stored line.
  const { env, entry } = chatEnv({ now: () => SENT, timeZone: 'UTC' });
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'look' });
    entry({
      who: 'her',
      text: '',
      attachments: [{ id: 'o1', name: 'out.png', contentType: 'image/png', reference: 'ref', alt: 'A grey square' }],
    });
    entry({ who: 'owner', text: 'nice' });
    await until(shows(rig, 'nice'));
    const rows = chatRows(rig);
    assert.ok(rows.includes('[#1] look'), rows.join('\n'));
    assert.ok(rows.includes('[#1] [image] out.png: A grey square'), rows.join('\n'));
    assert.ok(rows.includes('[#2] nice'), rows.join('\n'));
  });
});

// A line's files, from the specifier's shape: `ChatEntry.files`, the kinds of the files memory stores with the line
// (`session.page`), drawn as `[image]`, `[voice]` and so on after its text, in the store's own kind names.
test('a stored line draws a marker for each of its files after its text, in the kind names memory stores', async () => {
  // Bug: a line that carried a voice note or a picture reads as text alone, or as an empty row.
  const { env } = chatEnv({
    storedPage: (before) =>
      Promise.resolve(
        before === null
          ? [
              { id: 's1', who: 'owner', text: 'listen to this', at: SENT, number: 5, files: ['voice'] },
              { id: 's2', who: 'her', text: '', at: SENT, number: 6, files: ['image', 'file'] },
            ]
          : []
      ),
    timeZone: 'UTC',
  });
  await withChat(env, async (rig) => {
    await until(shows(rig, '[#6]'));
    const rows = chatRows(rig);
    assert.ok(rows.includes('[#5] listen to this [voice]'), rows.join('\n'));
    assert.ok(rows.includes('[#6] [image] [file]'), rows.join('\n'));
  });
});
