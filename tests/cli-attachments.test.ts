// Images in the mounted chat with fake acquisition and staging: what reaches `send`, what stays, what is released.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAttachmentActions } from '../cli/attachment-actions.ts';
import type { ClipboardResult } from '../cli/clipboard.ts';
import type { ChatAttachment, ChatImages, LineFile, LineFiles, StageResult } from '../cli/index.ts';
import { KEY, chatEnv, pause, press, shows, until, withChat } from './fixtures/chat-rig.ts';
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
// the line with that number (`session.line`), each with its absolute path on this machine, null when it was not kept.
// `/attach open #N [k]` opens one with `AttachmentActions.openFile` and `/attach save #N [k] [dir]` copies one with
// `saveFile`; a line with several files and no `k` lists them numbered.
const VIDEO: LineFile = { name: 'clip.mp4', kind: 'video', path: '/data/media/cli/v1.mp4' };
const VOICE: LineFile = { name: 'note.ogg', kind: 'voice', path: '/data/media/cli/v2.ogg' };
const LOST: LineFile = { name: 'lost.pdf', kind: 'file', path: null };

function lineRig(lines: Readonly<Record<number, ReadonlyArray<LineFile>>>, code = 0) {
  const runs: Array<ReadonlyArray<string>> = [];
  const copies: Array<[string, string]> = [];
  const asked: Array<number> = [];
  const received = createAttachmentActions({
    read: () => Promise.resolve(null),
    writeFile: () => Promise.resolve(),
    run: (argv) => {
      runs.push(argv);
      return Promise.resolve({ code, stdout: new Uint8Array(), missing: code === 127 });
    },
    platform: 'linux',
    tempDir: '/tmp/unused',
    copyFile: (from, to) => {
      copies.push([from, to]);
      return Promise.resolve();
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
  return { env, runs, copies, asked, turns };
}

test('/attach open #N opens the kept file of that line with the system opener, whatever its kind', async () => {
  // Bug: only an image she sent can be opened, or the command goes to her as a chat line.
  const { env, runs, asked, turns } = lineRig({ 1333: [VIDEO] });
  await withChat(env, async (rig) => {
    await press(rig, '/attach open #1333', shows(rig, '> /attach open #1333'));
    await press(rig, KEY.enter, shows(rig, 'Opened clip.mp4.'));
    assert.ok(shows(rig, 'Opened clip.mp4.')(), rig.screen().join('\n'));
  });
  assert.deepEqual(asked, [1333]);
  assert.deepEqual(runs, [['xdg-open', '/data/media/cli/v1.mp4']]);
  assert.deepEqual(turns, []);
});

test('/attach open with an unknown #N answers a clear refusal and opens nothing', async () => {
  // Bug: an unknown number opens the newest file, or fails without a word.
  const { env, runs } = lineRig({ 1333: [VIDEO] });
  await withChat(env, async (rig) => {
    await press(rig, '/attach open #9999', shows(rig, '> /attach open #9999'));
    await press(rig, KEY.enter, shows(rig, 'No line #9999 in this chat.'));
    assert.ok(shows(rig, 'No line #9999 in this chat.')(), rig.screen().join('\n'));
  });
  assert.deepEqual(runs, []);
});

test('a line with several files lists them numbered, and a second number opens that one', async () => {
  // Bug: the first file opens whatever the owner meant, or the list numbers from zero.
  const { env, runs } = lineRig({ 1334: [VIDEO, VOICE] });
  await withChat(env, async (rig) => {
    await press(rig, '/attach open #1334', shows(rig, '> /attach open #1334'));
    await press(rig, KEY.enter, () => shows(rig, '1. clip.mp4')() && shows(rig, '2. note.ogg')());
    assert.ok(shows(rig, '1. clip.mp4')() && shows(rig, '2. note.ogg')(), rig.screen().join('\n'));
    assert.deepEqual(runs, []);
    await press(rig, '/attach open #1334 2', shows(rig, '> /attach open #1334 2'));
    await press(rig, KEY.enter, shows(rig, 'Opened note.ogg.'));
    assert.ok(shows(rig, 'Opened note.ogg.')(), rig.screen().join('\n'));
  });
  assert.deepEqual(runs, [['xdg-open', '/data/media/cli/v2.ogg']]);
});

test('a file the opener cannot open prints its path', async () => {
  // Bug: a server with no `xdg-open` leaves the owner with no way to reach the file.
  const { env } = lineRig({ 1333: [VOICE] }, 127);
  await withChat(env, async (rig) => {
    await press(rig, '/attach open #1333', shows(rig, '> /attach open #1333'));
    await press(rig, KEY.enter, shows(rig, '/data/media/cli/v2.ogg'));
    assert.ok(shows(rig, '/data/media/cli/v2.ogg')(), rig.screen().join('\n'));
  });
});

test('a file that was not kept says so and opens nothing', async () => {
  // Bug: a line from before files were kept runs the opener on nothing.
  const { env, runs } = lineRig({ 1333: [LOST] });
  await withChat(env, async (rig) => {
    await press(rig, '/attach open #1333', shows(rig, '> /attach open #1333'));
    await press(rig, KEY.enter, shows(rig, 'lost.pdf was not kept'));
    assert.ok(shows(rig, 'lost.pdf was not kept')(), rig.screen().join('\n'));
  });
  assert.deepEqual(runs, []);
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
