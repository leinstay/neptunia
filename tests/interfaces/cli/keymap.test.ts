// interfaces/cli/keymap.ts: one action registry for dispatch and help, resolved against the focus context first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKeymap } from '../../../interfaces/cli/keymap.ts';
import type { FocusContext } from '../../../interfaces/cli/keymap.ts';
import { KEY, chatEnv, pause, press, shows, until, withChat } from '../../fixtures/chat-rig.ts';

const CONTEXTS: ReadonlyArray<FocusContext> = ['composer', 'menu', 'secret', 'attachment', 'panel', 'search'];

test('Enter, Escape and the paste channel resolve to one action in every focus context', () => {
  // Bug: a hidden composer and an open menu both take the same Enter.
  const keymap = buildKeymap();
  for (const context of CONTEXTS) {
    assert.ok(keymap.resolve(context, 'enter'), `enter in ${context}`);
    assert.ok(keymap.resolve(context, 'escape'), `escape in ${context}`);
    assert.ok(keymap.resolve(context, 'paste'), `paste in ${context}`);
  }
  assert.equal(new Set(CONTEXTS.map((context) => keymap.resolve(context, 'enter'))).size > 1, true);
  assert.deepEqual(keymap.conflicts, []);
});

test('a secret dialog binds no history, stash, undo, external editor or attachment action', () => {
  // Bug: Ctrl+Z, Ctrl+S or the editor copies a typed key into a store that outlives the dialog.
  const keymap = buildKeymap();
  for (const key of ['ctrl+r', 'ctrl+s', 'ctrl+z', 'ctrl+y', 'ctrl+g', 'ctrl+v', 'up', 'down'])
    assert.equal(keymap.resolve('secret', key), null, key);
  assert.ok(keymap.resolve('composer', 'ctrl+z'));
});

test('an override rebinds a key, and the action moves in help and in dispatch alike', () => {
  // Bug: help lists the old key while dispatch follows the new one.
  const keymap = buildKeymap([{ context: 'composer', key: 'ctrl+t', action: 'history.search' }]);
  assert.equal(keymap.resolve('composer', 'ctrl+t'), 'history.search');
  const row = keymap.help('composer').filter((one) => one.action === 'history.search');
  assert.ok(row.some((one) => one.key === 'ctrl+t'));
});

test('every help row of every context resolves back to its own action', () => {
  // Bug: help and dispatch are two tables that drift apart.
  const keymap = buildKeymap();
  for (const context of CONTEXTS)
    for (const row of keymap.help(context)) assert.equal(keymap.resolve(context, row.key), row.action);
});

test('two bindings for one key in one context are reported, and the default stays in force', () => {
  // Bug: the last override silently wins, and Enter stops submitting with no word why.
  const keymap = buildKeymap([{ context: 'composer', key: 'enter', action: 'history.search' }]);
  assert.equal(keymap.conflicts.length, 1);
  const conflict = keymap.conflicts[0];
  assert.equal(conflict?.context, 'composer');
  assert.equal(conflict?.key, 'enter');
  assert.equal(keymap.resolve('composer', 'enter'), buildKeymap().resolve('composer', 'enter'));
});

test('an override naming an unknown action, or one not allowed in the context, is reported and not bound', () => {
  // Bug: a configuration can bind the external editor inside the secret dialog.
  const keymap = buildKeymap([
    { context: 'composer', key: 'ctrl+t', action: 'no.such.action' },
    { context: 'secret', key: 'ctrl+t', action: 'editor.external' },
  ]);
  assert.equal(keymap.resolve('composer', 'ctrl+t'), null);
  assert.equal(keymap.resolve('secret', 'ctrl+t'), null);
  assert.equal(keymap.conflicts.length, 2);
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
