// The owner's chat when one of her lines changes after it was said (`lineChange` of the chat's listeners, which
// bin/neptunia.ts feeds from the client's `onLineChange`): an edit redraws the line with the edited mark, a deletion
// redraws it as a deleted message without its images, and nothing else on the screen moves. The mounted chat over
// fakes; synthetic lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatEnv, until, withChat } from './fixtures/chat-rig.ts';
import type { Rig } from './fixtures/chat-rig.ts';

const SQUARE = { id: 'i1', name: 'square.png', contentType: 'image/png', reference: 'ref', alt: 'A grey square' };
const screenOf = (rig: Rig): string => rig.screen().join('\n');

/** A chat holding the owner's line #1 and her lines #2 (a picture with it) and #3, the last two by message id. */
async function withLines(body: (rig: Rig, change: (change: object) => void) => Promise<void>): Promise<void> {
  const { env, listeners, entry } = chatEnv();
  await withChat(env, async (rig) => {
    entry({ who: 'owner', text: 'put the kettle on', number: 1 });
    entry({ who: 'her', text: 'the kettle is on 🙂', number: 2, messageId: 'm-2', attachments: [SQUARE] });
    entry({ who: 'her', text: 'tea is next', number: 3, messageId: 'm-3' });
    await until(() => screenOf(rig).includes('tea is next'));
    await body(rig, (change) => listeners.lineChange?.(change as never));
  });
}

test('an edit draws the new text of her line with the edited mark and moves nothing else', async () => {
  // Bug: the screen keeps the words she took out, or the edit reorders, renumbers or redraws the other lines.
  await withLines(async (rig, change) => {
    const before = screenOf(rig);
    const numbers = before.match(/#0*\d+/g);
    assert.equal(numbers?.length, 3, 'the three numbered lines are drawn');
    change({ id: 'm-2', text: 'the kettle is on' });
    await until(() => screenOf(rig).includes('the kettle is on (edited)'));
    const after = screenOf(rig);
    assert.equal(after.includes('🙂'), false, 'the old text is gone');
    assert.deepEqual(after.match(/#0*\d+/g), numbers, 'every line keeps its number');
    const at = ['put the kettle on', 'the kettle is on (edited)', 'tea is next'].map((text) => after.indexOf(text));
    assert.deepEqual(
      at,
      [...at].sort((one, two) => one - two),
      'the lines keep their order'
    );
    assert.equal(at.includes(-1), false, 'the other lines are still drawn');
  });
});

test('a deletion keeps the place and number of her line, reads it as a deleted message and drops its images', async () => {
  // Bug: the line vanishes and every later line shifts, or the words or the picture stay drawn after she took them back.
  await withLines(async (rig, change) => {
    assert.ok(screenOf(rig).includes('A grey square'), 'the picture was drawn');
    const numbers = screenOf(rig).match(/#0*\d+/g);
    change({ id: 'm-2', deleted: true });
    await until(() => screenOf(rig).includes('message deleted'));
    const after = screenOf(rig);
    assert.equal(after.includes('the kettle is on'), false, 'her words are gone');
    assert.equal(after.includes('A grey square'), false, 'its picture is gone');
    assert.deepEqual(after.match(/#0*\d+/g), numbers, 'every line keeps its number');
    assert.ok(after.indexOf('put the kettle on') < after.indexOf('message deleted'));
    assert.ok(after.indexOf('message deleted') < after.indexOf('tea is next'));
  });
});

test('a change for a message id the screen does not hold changes nothing', async () => {
  // Bug: a change names a line the screen never drew and it rewrites another line, or the owner's line of that id.
  await withLines(async (rig, change) => {
    const before = screenOf(rig);
    change({ id: 'no-such-line', text: 'changed' });
    change({ id: 'no-such-line', deleted: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(screenOf(rig), before);
  });
});

// Production, 2026-11-12: a line of an earlier session is drawn from the stored history, and a change for it found no
// entry because only the lines printed in this session carried their message id. A stored line of hers carries it
// in `messageId` of the page `storedPage` returns, as `ChatEntry` names it.
test('a line drawn from the stored history is redrawn by a change for its message id', async () => {
  // Bug: the owner's screen keeps the words she edited in a line from before the restart.
  const { env, listeners } = chatEnv({
    storedPage: () =>
      Promise.resolve([
        { id: 'src-1', who: 'owner' as const, text: 'put the kettle on', number: 140 },
        { id: 'src-2', who: 'her' as const, text: 'the kettle is on 🙂', number: 141, messageId: 'm-old' },
      ]),
  });
  await withChat(env, async (rig) => {
    await until(() => screenOf(rig).includes('the kettle is on 🙂'));
    listeners.lineChange?.({ id: 'm-old', text: 'the kettle is on' });
    await until(() => screenOf(rig).includes('the kettle is on (edited)'));
    const after = screenOf(rig);
    assert.equal(after.includes('🙂'), false);
    assert.ok(after.includes('put the kettle on'), 'the owner line stays');
  });
});
