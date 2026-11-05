// The editor actions on the mounted chat: nothing is sent or stored by a search, and an unfinished draft always comes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY, chatEnv, pause, press, shows, until, withChat } from './fixtures/chat-rig.ts';
import type { Rig } from './fixtures/chat-rig.ts';

const text = (rig: Rig): string => rig.screen().join('\n');

test('reverse search, cancelled, restores the exact draft and sends nothing', async () => {
  // Bug: Escape from the search clears what the owner was typing, or the query goes to the core.
  const { env, sent, saved } = chatEnv({ history: ['needle in the history', 'other'] });
  await withChat(env, async (rig) => {
    await press(rig, 'unfinished  draft', shows(rig, '> unfinished  draft'));
    await press(rig, KEY.ctrlR, shows(rig, 'history search:'));
    await press(rig, 'needle', shows(rig, 'needle in the history'));
    assert.match(rig.screen().join('\n'), /needle in the history/);
    await press(
      rig,
      KEY.escape,
      () => /> unfinished {2}draft/.test(text(rig)) && !text(rig).includes('history search')
    );
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
    await press(rig, KEY.ctrlR, shows(rig, 'history search:'));
    await press(rig, 'needle', shows(rig, 'needle in the history'));
    await press(
      rig,
      KEY.enter,
      () => /> needle in the history/.test(text(rig)) && !text(rig).includes('history search')
    );
    assert.deepEqual(sent, []);
    assert.match(rig.screen().join('\n'), /> needle in the history/);
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, ['needle in the history']);
});

test('undo and redo step through typed edits of the input', async () => {
  // Bug: Ctrl+Z is ignored, or inserts a control character into the draft.
  const { env, sent } = chatEnv();
  await withChat(env, async (rig) => {
    await press(rig, 'first', shows(rig, '> first'));
    await press(rig, ' second', shows(rig, 'first second'));
    await press(rig, KEY.ctrlZ, () => !text(rig).includes('second'));
    assert.equal(rig.screen().join('\n').includes('second'), false);
    await press(rig, KEY.ctrlY, shows(rig, 'first second'));
    assert.match(rig.screen().join('\n'), /first second/);
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, ['first second']);
});

test('a stashed draft leaves the input and comes back on the second stash key on an empty input', async () => {
  // Bug: the stash loses the draft, or stashing an empty input overwrites the one held.
  const { env, sent } = chatEnv();
  await withChat(env, async (rig) => {
    await press(rig, 'held draft', shows(rig, '> held draft'));
    await press(rig, KEY.ctrlS, () => !text(rig).includes('held draft'));
    assert.equal(rig.screen().join('\n').includes('held draft'), false);
    await press(rig, 'quick', shows(rig, '> quick'));
    await press(rig, KEY.enter, () => sent.length === 1);
    await press(rig, KEY.ctrlS, shows(rig, '> held draft'));
    assert.match(rig.screen().join('\n'), /> held draft/);
    await press(rig, KEY.enter, () => sent.length === 2);
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
    await press(rig, 'original', shows(rig, '> original'));
    await press(rig, KEY.ctrlG, shows(rig, '> from γ editor'));
    assert.deepEqual(asked, ['original']);
    assert.deepEqual(sent, []);
    assert.match(rig.screen().join('\n'), /> from γ editor/);
    outcome = 'fail';
    await press(rig, KEY.ctrlG, () => asked.length === 2);
    // A failing editor leaves the screen as it was, so only a fixed wait lets a lost draft show.
    await pause();
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
    question({ question: 'The key:', secret: true, answer: (given) => (answered = given) });
    await until(shows(rig, 'The key:'));
    await press(rig, 'sk-one', shows(rig, '*'.repeat(6)));
    for (const ignored of [KEY.ctrlZ, KEY.ctrlS, KEY.ctrlG]) {
      rig.type(ignored);
      // An ignored key changes nothing on the screen, so only a fixed wait lets a misplaced edit or stash show.
      await pause();
    }
    await press(rig, '-two', shows(rig, '*'.repeat(10)));
    await press(rig, KEY.enter, () => answered !== '');
  });
  assert.equal(answered, 'sk-one-two');
  assert.deepEqual(asked, []);
});

test('Enter in an open slash menu completes the row, and the composer behind it sends nothing', async () => {
  // Bug: a rebuilt key handler gives one Enter to the menu and to the composer.
  const { env, sent } = chatEnv();
  await withChat(env, async (rig) => {
    await press(rig, '/st', shows(rig, '/status'));
    await press(rig, KEY.enter, shows(rig, /> \/status/));
    assert.deepEqual(sent, []);
    assert.match(rig.screen().join('\n'), /> \/status/);
  });
});

test('a keymap conflict from the settings shows when the chat opens', async () => {
  // Bug: a broken binding silently does nothing.
  const { env } = chatEnv({ bindings: [{ context: 'composer', key: 'enter', action: 'history.search' }] });
  const { env: clean } = chatEnv();
  let plain = '';
  await withChat(clean, (rig) => {
    plain = rig.screen().join('\n');
    return Promise.resolve();
  });
  await withChat(env, async (rig) => {
    await until(shows(rig, /enter/i));
    assert.notEqual(rig.screen().join('\n'), plain);
    assert.match(rig.screen().join('\n'), /enter/i);
  });
});

test('a mouse report on a terminal without mouse support never enters the draft', async () => {
  // Bug: a stray wheel report appends `[<64;2;3M` to the message.
  const { env, sent } = chatEnv({ mouse: false });
  await withChat(env, async (rig) => {
    await press(rig, 'clean', shows(rig, '> clean'));
    for (const report of ['\u001b[<64;2;3M', '\u001b[<0;5;7M', '\u001b[<0;5;7m']) {
      rig.type(report);
      // A swallowed report changes nothing on the screen, so only a fixed wait lets a leaked one show.
      await pause();
    }
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, ['clean']);
});

test('a wheel report scrolls the transcript when the mouse is on, and leaves the draft', async () => {
  // Bug: scrolling with the wheel submits or edits the message.
  const { env, sent, entry } = chatEnv({ mouse: true });
  await withChat(env, async (rig) => {
    for (let index = 0; index < 100; index += 1) entry({ who: 'her', text: `entry-${index}` });
    await press(rig, 'draft', () => text(rig).includes('entry-99') && text(rig).includes('> draft'));
    assert.ok(rig.screen().join('\n').includes('entry-99'));
    for (let tick = 0; tick < 10; tick += 1) rig.type('\u001b[<64;2;3M');
    await until(() => !text(rig).includes('entry-99'));
    assert.equal(rig.screen().join('\n').includes('entry-99'), false);
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, ['draft']);
});
