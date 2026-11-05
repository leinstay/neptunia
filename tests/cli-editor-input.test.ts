// The editor actions on the mounted chat: nothing is sent or stored by a search, and an unfinished draft always comes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY, chatEnv, pause, withChat } from './fixtures/chat-rig.ts';
import type { Rig } from './fixtures/chat-rig.ts';

const keys = async (rig: Rig, ...typed: ReadonlyArray<string>): Promise<void> => {
  for (const one of typed) {
    rig.type(one);
    await pause();
  }
};

test('reverse search, cancelled, restores the exact draft and sends nothing', async () => {
  // Bug: Escape from the search clears what the owner was typing, or the query goes to the core.
  const { env, sent, saved } = chatEnv({ history: ['needle in the history', 'other'] });
  await withChat(env, async (rig) => {
    await keys(rig, 'unfinished  draft', KEY.ctrlR, 'needle');
    assert.match(rig.screen().join('\n'), /needle in the history/);
    await keys(rig, KEY.escape);
    assert.match(rig.screen().join('\n'), /> unfinished {2}draft/);
    assert.equal(rig.screen().join('\n').includes('needle in the history'), false);
  });
  assert.deepEqual(sent, []);
  assert.deepEqual(saved, []);
});

test('reverse search, accepted, loads the match into the draft and leaves sending to the next Enter', async () => {
  // Bug: Enter on a match runs an old command straight away.
  const { env, sent } = chatEnv({ history: ['needle in the history', 'other'] });
  await withChat(env, async (rig) => {
    await keys(rig, KEY.ctrlR, 'needle', KEY.enter);
    assert.deepEqual(sent, []);
    assert.match(rig.screen().join('\n'), /> needle in the history/);
    await keys(rig, KEY.enter);
  });
  assert.deepEqual(sent, ['needle in the history']);
});

test('undo and redo step through typed edits of the input', async () => {
  // Bug: Ctrl+Z is ignored, or inserts a control character into the draft.
  const { env, sent } = chatEnv();
  await withChat(env, async (rig) => {
    await keys(rig, 'first', ' second', KEY.ctrlZ);
    assert.equal(rig.screen().join('\n').includes('second'), false);
    await keys(rig, KEY.ctrlY);
    assert.match(rig.screen().join('\n'), /first second/);
    await keys(rig, KEY.enter);
  });
  assert.deepEqual(sent, ['first second']);
});

test('a stashed draft leaves the input and comes back on the second stash key on an empty input', async () => {
  // Bug: the stash loses the draft, or stashing an empty input overwrites the one held.
  const { env, sent } = chatEnv();
  await withChat(env, async (rig) => {
    await keys(rig, 'held draft', KEY.ctrlS);
    assert.equal(rig.screen().join('\n').includes('held draft'), false);
    await keys(rig, 'quick', KEY.enter, KEY.ctrlS);
    assert.match(rig.screen().join('\n'), /> held draft/);
    await keys(rig, KEY.enter);
  });
  assert.deepEqual(sent, ['quick', 'held draft']);
});

test('the external editor returns its text into the draft, and a failure leaves the draft', async () => {
  // Bug: the chat sends the edited text at once, or a failing editor costs the draft.
  let outcome: 'edit' | 'fail' = 'edit';
  const asked: Array<string> = [];
  const { env, sent } = chatEnv({
    editDraft: (text) => {
      asked.push(text);
      return Promise.resolve(
        outcome === 'edit' ? { status: 'edited', text: 'from γ editor' } : { status: 'failed', text }
      );
    },
  });
  await withChat(env, async (rig) => {
    await keys(rig, 'original', KEY.ctrlG);
    assert.deepEqual(asked, ['original']);
    assert.deepEqual(sent, []);
    assert.match(rig.screen().join('\n'), /> from γ editor/);
    outcome = 'fail';
    await keys(rig, KEY.ctrlG);
    assert.match(rig.screen().join('\n'), /> from γ editor/);
  });
});

test('Ctrl+Z, the stash and the editor do nothing inside a secret question', async () => {
  // Bug: a typed key is copied into the undo stack, the stash or a temporary draft file.
  const asked: Array<string> = [];
  const { env, question } = chatEnv({
    editDraft: (text) => {
      asked.push(text);
      return Promise.resolve({ status: 'edited', text });
    },
  });
  let answered = '';
  await withChat(env, async (rig) => {
    question({ question: 'The key:', secret: true, answer: (text) => (answered = text) });
    await pause();
    await keys(rig, 'sk-one', KEY.ctrlZ, KEY.ctrlS, KEY.ctrlG, '-two', KEY.enter);
  });
  assert.equal(answered, 'sk-one-two');
  assert.deepEqual(asked, []);
});

test('Enter in an open slash menu completes the row, and the composer behind it sends nothing', async () => {
  // Bug: a rebuilt key handler gives one Enter to the menu and to the composer.
  const { env, sent } = chatEnv();
  await withChat(env, async (rig) => {
    await keys(rig, '/st', KEY.enter);
    assert.deepEqual(sent, []);
    assert.match(rig.screen().join('\n'), /> \/status/);
  });
});

test('a keymap conflict from the settings shows when the chat opens', async () => {
  // Bug: a broken binding silently does nothing.
  const { env } = chatEnv({ bindings: [{ context: 'composer', key: 'enter', action: 'history.search' }] });
  const { env: clean } = chatEnv();
  let plain = '';
  await withChat(clean, async (rig) => {
    await pause();
    plain = rig.screen().join('\n');
  });
  await withChat(env, async (rig) => {
    await pause();
    assert.notEqual(rig.screen().join('\n'), plain);
    assert.match(rig.screen().join('\n'), /enter/i);
  });
});

test('a mouse report on a terminal without mouse support never enters the draft', async () => {
  // Bug: a stray wheel report appends `[<64;2;3M` to the message.
  const { env, sent } = chatEnv({ mouse: false });
  await withChat(env, async (rig) => {
    await keys(rig, 'clean', '\u001b[<64;2;3M', '\u001b[<0;5;7M', '\u001b[<0;5;7m', KEY.enter);
  });
  assert.deepEqual(sent, ['clean']);
});

test('a wheel report scrolls the transcript when the mouse is on, and leaves the draft', async () => {
  // Bug: scrolling with the wheel submits or edits the message.
  const { env, sent, entry } = chatEnv({ mouse: true });
  await withChat(env, async (rig) => {
    for (let index = 0; index < 100; index += 1) entry({ who: 'her', text: `entry-${index}` });
    await keys(rig, 'draft');
    assert.ok(rig.screen().join('\n').includes('entry-99'));
    for (let tick = 0; tick < 10; tick += 1) rig.type('\u001b[<64;2;3M');
    await pause(100);
    assert.equal(rig.screen().join('\n').includes('entry-99'), false);
    await keys(rig, KEY.enter);
  });
  assert.deepEqual(sent, ['draft']);
});
