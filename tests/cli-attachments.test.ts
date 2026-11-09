// Images in the mounted chat with fake acquisition and staging: what reaches `send`, what stays, what is released.
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAttachmentActions } from '../interfaces/cli/attachment-actions.ts';
import type { ClipboardResult } from '../interfaces/cli/clipboard.ts';
import type { ChatAttachment, ChatImages, LineFile, LineFiles, StageResult } from '../interfaces/cli/index.ts';
import { KEY, chatEnv, pause, press, shows, until, withChat } from './fixtures/chat-rig.ts';
import type { Rig } from './fixtures/chat-rig.ts';
import { syntheticPng } from './fixtures/synthetic-png.ts';

function images(over: Partial<ChatImages> = {}) {
  const released: Array<string> = [];
  const stagedIds: Array<string> = [];
  const stage = (name: string): Promise<StageResult> => {
    const id = `a${stagedIds.length + 1}`;
    stagedIds.push(id);
    return Promise.resolve({
      ok: true,
      staged: { id, name, contentType: 'image/png', reference: `ref-${id}`, size: 8 },
    });
  };
  const fake: ChatImages = {
    clipboard: () =>
      Promise.resolve<ClipboardResult>({ status: 'image', bytes: syntheticPng(), contentType: 'image/png' }),
    stageBytes: (_bytes, { name }) => stage(name),
    stageFile: (file) => stage(file.split('/').at(-1) ?? file),
    release: (id) => {
      released.push(id);
      return Promise.resolve();
    },
    ...over,
  };
  return { fake, released, stagedIds };
}

function chatOf(fake: ChatImages) {
  const turns: Array<{ line: string; attachments: ReadonlyArray<ChatAttachment> }> = [];
  const rig = chatEnv({
    images: fake,
    send: (line, attachments = []) => void turns.push({ line, attachments }),
  });
  return { ...rig, turns };
}

test('a caption and a clipboard image go out together, once, with the staged reference', async () => {
  // Bug: the image goes as a second message, or Enter sends the caption before the image is staged.
  const { fake } = images();
  const { env, turns, saved } = chatOf(fake);
  await withChat(env, async (rig) => {
    await press(rig, 'Explain this chart.', shows(rig, '> Explain this chart.'));
    await press(rig, KEY.ctrlV, shows(rig, '[image clipboard.png]'));
    await press(rig, KEY.enter, () => turns.length === 1);
    rig.type(KEY.enter);
    // The second Enter finds an empty composer and changes nothing, so only a fixed wait lets a second turn show.
    await pause();
  });
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.line, 'Explain this chart.');
  assert.deepEqual(
    turns[0]?.attachments.map((one) => one.reference),
    ['ref-a1']
  );
  assert.ok(JSON.stringify(saved).includes('Explain this chart.'));
});

test('/attach stages a file on this machine, and the path never reaches the core as text', async () => {
  // Bug: the file-path fallback goes to her as a chat line, with the owner's path in it.
  const { fake } = images();
  const { env, turns } = chatOf(fake);
  await withChat(env, async (rig) => {
    await press(rig, '/attach /home/example/chart.png', shows(rig, '> /attach /home/example/chart.png'));
    await press(rig, KEY.enter, shows(rig, '[image chart.png]'));
    await press(rig, 'Caption', shows(rig, 'Caption'));
    await press(rig, KEY.enter, () => turns.length === 1);
  });
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.line, 'Caption');
  assert.equal(turns[0]?.attachments.length, 1);
});

test('an unavailable clipboard keeps the caption and sends nothing', async () => {
  // Bug: under SSH the paste clears the draft, or sends the caption alone as if the image had gone.
  const { fake, stagedIds } = images({
    clipboard: () => Promise.resolve({ status: 'unavailable', reason: 'ssh' }),
  });
  const { env, turns, saved } = chatOf(fake);
  await withChat(env, async (rig) => {
    await press(rig, 'Explain this chart.', shows(rig, '> Explain this chart.'));
    const before = rig.screen().join('\n');
    await press(rig, KEY.ctrlV, shows(rig, 'No clipboard image'));
    assert.match(rig.screen().join('\n'), /Explain this chart\./);
    assert.notEqual(rig.screen().join('\n'), before, 'the state shows');
  });
  assert.deepEqual(turns, []);
  assert.deepEqual(stagedIds, []);
  assert.deepEqual(saved, []);
});

test('a clipboard result that arrives after the draft changed attaches nothing and frees what it staged', async () => {
  // Bug: a slow read drops last minute's picture into the next message.
  let finish: (result: ClipboardResult) => void = () => {};
  const pending = new Promise<ClipboardResult>((resolve) => (finish = resolve));
  let asked = 0;
  const { fake, released, stagedIds } = images({
    clipboard: () => {
      asked += 1;
      return pending;
    },
  });
  const { env, turns } = chatOf(fake);
  await withChat(env, async (rig) => {
    await press(rig, 'first', shows(rig, '> first'));
    await press(rig, KEY.ctrlV, () => asked === 1);
    await press(rig, KEY.enter, () => turns.length === 1);
    finish({ status: 'image', bytes: syntheticPng(), contentType: 'image/png' });
    // The late result is dropped before it stages anything, so nothing on the screen or in the fakes changes. Only a
    // fixed wait lets a wrongly staged or attached image show.
    await pause();
    await press(rig, 'second', shows(rig, '> second'));
    await press(rig, KEY.enter, () => turns.length === 2);
  });
  assert.deepEqual(
    turns.map((turn) => [turn.line, turn.attachments.length]),
    [
      ['first', 0],
      ['second', 0],
    ]
  );
  assert.equal(asked, 1, 'Ctrl+V started the read');
  assert.deepEqual(released, stagedIds);
});

test('an invalid file shows its failure and sends nothing', async () => {
  // Bug: a refused image leaves an empty attachment part that goes with the next Enter.
  const { fake } = images({ stageFile: () => Promise.resolve({ ok: false, code: 'invalid-image' }) });
  const { env, turns } = chatOf(fake);
  await withChat(env, async (rig) => {
    await press(rig, '/attach /home/example/not.png', shows(rig, '> /attach /home/example/not.png'));
    const before = rig.screen().join('\n');
    await press(rig, KEY.enter, shows(rig, 'was not attached'));
    assert.notEqual(rig.screen().join('\n'), before);
    await press(rig, 'Caption', shows(rig, '> Caption'));
    await press(rig, KEY.enter, () => turns.length === 1);
  });
  assert.deepEqual(
    turns.map((turn) => [turn.line, turn.attachments.length]),
    [['Caption', 0]]
  );
});

test('Backspace on an attachment removes it and frees its staging', async () => {
  // Bug: a removed image still goes with the turn, or its bytes stay staged for the whole lifetime.
  const { fake, released } = images();
  const { env, turns } = chatOf(fake);
  await withChat(env, async (rig) => {
    await press(rig, KEY.ctrlV, shows(rig, '[image clipboard.png]'));
    await press(rig, KEY.backspace, () => !rig.screen().join('\n').includes('[image') && released.length === 1);
    await press(rig, 'text', shows(rig, '> text'));
    await press(rig, KEY.enter, () => turns.length === 1);
  });
  assert.deepEqual(released, ['a1']);
  assert.deepEqual(turns[0]?.attachments, []);
});

test('a received image shows its name and text alternative in the transcript', async () => {
  // Bug: an image from her leaves an empty row on a terminal that cannot draw it.
  const { env, entry } = chatEnv();
  await withChat(env, async (rig) => {
    entry({
      who: 'her',
      text: '',
      attachments: [{ id: 'out1', name: 'out.png', contentType: 'image/png', reference: 'ref', alt: 'A grey square' }],
    });
    await until(() => shows(rig, 'out.png')() && shows(rig, 'A grey square')());
    const shown = rig.screen().join('\n');
    assert.match(shown, /out\.png/);
    assert.match(shown, /A grey square/);
  });
});

// The files of a numbered line, from the specifier's shape: `ChatEnv.lineFiles(number)` asks the core for the files of
// the line with that number (`session.line`), each with its absolute path on this machine, null when it was not kept,
// and the description memory stores for it. `/attach open #N [k]` shows one in the command window through the terminal
// alone: a picture with the graphics protocol the terminal answers to, a text file's content, and for anything else, or
// a terminal with no protocol, the stored description. `AttachmentActions.readKept(file, maxBytes)` reads a kept file's
// size and, up to `maxBytes`, its bytes. `/attach save #N [k] [dir]` copies one with `saveFile`. A line with several files
// and no `k` lists them numbered. The terminal is asked once a session: kitty's graphics query, then DA1.
const PICTURE: LineFile = {
  name: 'pic.png',
  kind: 'image',
  path: '/data/media/cli/p1.png',
  description: 'A grey square',
};
const NOTES: LineFile = { name: 'notes.md', kind: 'file', path: '/data/media/cli/t1.md', description: null };
const VIDEO: LineFile = {
  name: 'clip.mp4',
  kind: 'video',
  path: '/data/media/cli/v1.mp4',
  description: 'A cat walks across a table',
};
const VOICE: LineFile = {
  name: 'note.ogg',
  kind: 'voice',
  path: '/data/media/cli/v2.ogg',
  description: 'Transcript: see you at nine',
};
const LOST: LineFile = { name: 'lost.pdf', kind: 'file', path: null, description: null };

const BYTES: Readonly<Record<string, Uint8Array>> = {
  '/data/media/cli/p1.png': syntheticPng(),
  '/data/media/cli/t1.md': Buffer.from('# Plan\nfirst-row-of-notes\nsecond-row-of-notes\n'),
  '/data/media/cli/v1.mp4': Buffer.alloc(2048),
  '/data/media/cli/v2.ogg': Buffer.alloc(1536),
};

const DA1 = '\u001b[c';
// eslint-disable-next-line no-control-regex
const SIXEL = /\u001bP[\d;]*q[\s\S]*#\d[\s\S]*\u001b\\/;
// eslint-disable-next-line no-control-regex
const KITTY = /\u001b_G[^\u001b]*f=100[^\u001b]*;/;
// eslint-disable-next-line no-control-regex
const ITERM = /\u001b\]1337;File=[^\u0007]*inline=1/;

function lineRig(lines: Readonly<Record<number, ReadonlyArray<LineFile>>>) {
  const copies: Array<[string, string]> = [];
  const asked: Array<number> = [];
  const received = createAttachmentActions({
    read: () => Promise.resolve(null),
    writeFile: () => Promise.resolve(),
    copyFile: (from, to) => {
      copies.push([from, to]);
      return Promise.resolve();
    },
    readKept: (file, maxBytes) => {
      const bytes = BYTES[file];
      return Promise.resolve(
        bytes === undefined ? null : { size: bytes.length, bytes: bytes.length <= maxBytes ? bytes : null }
      );
    },
  });
  const lineFiles = (number: number): Promise<LineFiles> => {
    asked.push(number);
    const files = lines[number];
    return Promise.resolve(
      files === undefined ? { ok: false, reason: `No line #${number} in this chat.` } : { ok: true, files }
    );
  };
  const turns: Array<string> = [];
  const { env } = chatEnv({ received, lineFiles, send: (line) => void turns.push(line) });
  return { env, copies, asked, turns };
}

/** The fake terminal: once the chat sends DA1, it answers `reply`, as a terminal answers on stdin. */
async function answerQueries(rig: Rig, reply: string): Promise<void> {
  await until(() => rig.frames().includes(DA1));
  assert.ok(rig.frames().includes(DA1), 'the chat asked the terminal what it can draw');
  rig.type(reply);
}

/** Types `/attach open …`, answers the terminal's queries with `reply`, and waits for `landed`. */
async function openOn(rig: Rig, line: string, reply: string | null, landed: () => boolean): Promise<void> {
  await press(rig, line, shows(rig, `> ${line}`));
  rig.type(KEY.enter);
  if (reply !== null) await answerQueries(rig, reply);
  await until(landed);
}

test('a Sixel terminal gets the picture of the line as a Sixel sequence, and no process starts', async () => {
  // Bug: the picture goes to `xdg-open`, which shows nothing over SSH, or reaches the terminal in no protocol it draws.
  const spawned: Array<unknown> = [];
  const onSpawn = (message: unknown): void => void spawned.push(message);
  subscribe('child_process', onSpawn);
  const { env, asked, turns } = lineRig({ 1333: [PICTURE] });
  try {
    await withChat(env, async (rig) => {
      await openOn(rig, '/attach open #1333', '\u001b[6;20;10t\u001b[?62;4;22c', () => SIXEL.test(rig.frames()));
      assert.match(rig.frames(), SIXEL);
      assert.ok(shows(rig, 'pic.png')(), rig.screen().join('\n'));
    });
  } finally {
    unsubscribe('child_process', onSpawn);
  }
  assert.deepEqual(spawned, []);
  assert.deepEqual(asked, [1333]);
  assert.deepEqual(turns, []);
});

test('a kitty terminal gets the picture through the kitty graphics protocol', async () => {
  // Bug: kitty's answer to the query is ignored, or its reply reaches the draft as typed text.
  const { env } = lineRig({ 1333: [PICTURE] });
  await withChat(env, async (rig) => {
    await openOn(rig, '/attach open #1333', '\u001b_Gi=31;OK\u001b\\\u001b[?62;22c', () => KITTY.test(rig.frames()));
    assert.match(rig.frames(), KITTY);
    assert.equal(SIXEL.test(rig.frames()), false);
    assert.equal(rig.screen().join('\n').includes('OK'), false, 'the reply never reaches the input');
  });
});

test('an iTerm2 terminal gets the picture through its inline image protocol', async () => {
  // Bug: iTerm2, which answers no kitty query and no Sixel, is left with the description only.
  const before = process.env.LC_TERMINAL;
  process.env.LC_TERMINAL = 'iTerm2';
  try {
    const { env } = lineRig({ 1333: [PICTURE] });
    await withChat(env, async (rig) => {
      await openOn(rig, '/attach open #1333', '\u001b[?62;22c', () => ITERM.test(rig.frames()));
      assert.match(rig.frames(), ITERM);
    });
  } finally {
    if (before === undefined) delete process.env.LC_TERMINAL;
    else process.env.LC_TERMINAL = before;
  }
});

test('a terminal with no graphics protocol says the picture cannot be shown here and gives its path', async () => {
  // Bug: a terminal that draws no picture gets escape sequences it prints as garbage, or an empty window.
  const { env } = lineRig({ 1333: [PICTURE] });
  await withChat(env, async (rig) => {
    await openOn(rig, '/attach open #1333', '\u001b[?62;22c', shows(rig, '/data/media/cli/p1.png'));
    const screen = rig.screen().join('\n');
    assert.ok(screen.includes('This file format cannot be shown here.'), screen);
    assert.ok(screen.includes('/data/media/cli/p1.png'), screen);
    assert.ok(screen.includes('A grey square'), screen);
    assert.equal(SIXEL.test(rig.frames()) || KITTY.test(rig.frames()), false);
  });
});

test('the terminal is asked once a session, and the second picture uses the answer it gave', async () => {
  // Bug: every picture asks again, and a terminal slow to answer stalls each open.
  const { env } = lineRig({ 1333: [PICTURE] });
  await withChat(
    env,
    async (rig) => {
      await openOn(rig, '/attach open #1333', '\u001b[?62;22c', shows(rig, '/data/media/cli/p1.png'));
      await press(rig, '/attach open #1333', shows(rig, '> /attach open #1333'));
      rig.type(KEY.enter);
      await until(() => rig.screen().join('\n').split('/data/media/cli/p1.png').length > 2);
      assert.ok(rig.screen().join('\n').split('/data/media/cli/p1.png').length > 2, rig.screen().join('\n'));
      assert.equal(rig.frames().split(DA1).length - 1, 1);
    },
    { rows: 60 }
  );
});

test('a text file of the line shows its content in the command window', async () => {
  // Bug: a code or notes file needs an opener the server lacks, or shows as a description of nothing.
  const { env } = lineRig({ 1333: [NOTES] });
  await withChat(env, async (rig) => {
    await openOn(rig, '/attach open #1333', null, shows(rig, 'second-row-of-notes'));
    assert.ok(shows(rig, 'first-row-of-notes')() && shows(rig, 'second-row-of-notes')(), rig.screen().join('\n'));
  });
});

test('a voice note, which the window cannot show, says so in plain words and gives the path of its stored file', async () => {
  // Bug: a format the terminal cannot show leaves an empty window, a terse code, or no way to reach the file.
  const { env } = lineRig({ 1333: [VOICE] });
  await withChat(
    env,
    async (rig) => {
      await openOn(rig, '/attach open #1333', null, shows(rig, '/data/media/cli/v2.ogg'));
      const screen = rig.screen().join('\n');
      assert.ok(screen.includes('This file format cannot be shown here.'), screen);
      assert.ok(screen.includes('You can open it or download it from this path:'), screen);
      assert.ok(screen.includes('/data/media/cli/v2.ogg'), screen);
      assert.ok(screen.includes('note.ogg') && screen.includes('voice') && screen.includes('1.5 KiB'), screen);
    },
    { rows: 30 }
  );
  // Changed: a finished command takes one more row for its finish time (owner, 2026-11-09), and at 24 rows the window's
  // tail no longer holds the header line of this answer.
});

test('/attach open with an unknown #N answers a clear refusal', async () => {
  // Bug: an unknown number shows the newest file, or fails without a word.
  const { env } = lineRig({ 1333: [VOICE] });
  await withChat(env, async (rig) => {
    await openOn(rig, '/attach open #9999', null, shows(rig, 'No line #9999 in this chat.'));
    assert.ok(shows(rig, 'No line #9999 in this chat.')(), rig.screen().join('\n'));
  });
});

test('a line with several files lists them numbered, and a second number shows that one', async () => {
  // Bug: the first file shows whatever the owner meant, or the list numbers from zero.
  const { env } = lineRig({ 1334: [VIDEO, VOICE] });
  await withChat(env, async (rig) => {
    await openOn(rig, '/attach open #1334', null, () => shows(rig, '1. clip.mp4')() && shows(rig, '2. note.ogg')());
    assert.ok(shows(rig, '1. clip.mp4')() && shows(rig, '2. note.ogg')(), rig.screen().join('\n'));
    assert.equal(shows(rig, '/data/media/cli/v2.ogg')(), false);
    await openOn(rig, '/attach open #1334 2', null, shows(rig, '/data/media/cli/v2.ogg'));
    assert.ok(shows(rig, '/data/media/cli/v2.ogg')(), rig.screen().join('\n'));
  });
});

test('a file that was not kept says so', async () => {
  // Bug: a line from before files were kept reads a file that is not there.
  const { env } = lineRig({ 1333: [LOST] });
  await withChat(env, async (rig) => {
    await openOn(rig, '/attach open #1333', null, shows(rig, 'lost.pdf was not kept'));
    assert.ok(shows(rig, 'lost.pdf was not kept')(), rig.screen().join('\n'));
  });
});

test('/attach save #N k dir copies that file into the directory under its own name', async () => {
  // Bug: the save writes over the directory, or under the kept file's id instead of its name.
  const { env, copies } = lineRig({ 1334: [VIDEO, VOICE] });
  await withChat(env, async (rig) => {
    await press(rig, '/attach save #1334 1 /home/owner/out', shows(rig, '> /attach save #1334 1 /home/owner/out'));
    await press(rig, KEY.enter, shows(rig, 'Saved clip.mp4'));
    assert.ok(shows(rig, 'Saved clip.mp4')(), rig.screen().join('\n'));
  });
  assert.deepEqual(copies, [['/data/media/cli/v1.mp4', '/home/owner/out/clip.mp4']]);
});

test('/attach open shows the newest picture she sent in the command window, through the terminal', async () => {
  // Bug: the newest picture still goes to a desktop opener, which a chat over SSH has none of.
  const received = createAttachmentActions({
    read: () => Promise.resolve(syntheticPng()),
    writeFile: () => Promise.resolve(),
  });
  const { env, entry } = chatEnv({ received });
  await withChat(env, async (rig) => {
    entry({
      who: 'her',
      text: '',
      attachments: [{ id: 'o1', name: 'out.png', contentType: 'image/png', reference: 'ref', alt: 'A grey square' }],
    });
    await until(shows(rig, 'out.png'));
    await openOn(rig, '/attach open', '\u001b_Gi=31;OK\u001b\\\u001b[?62c', () => KITTY.test(rig.frames()));
    assert.match(rig.frames(), KITTY);
  });
});
