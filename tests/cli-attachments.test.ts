// Images in the mounted chat with fake acquisition and staging: what reaches `send`, what stays, what is released.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClipboardResult } from '../cli/clipboard.ts';
import type { ChatAttachment, ChatImages, StageResult } from '../cli/index.ts';
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
