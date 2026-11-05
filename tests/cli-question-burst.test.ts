// A question interrupts a draft, and the answer's Enter gives the draft back. A held Enter or a burst of repeats must not
// fall through and send it: the owner has not looked at it yet. The clock is the env's, so the window is driven, never slept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY, chatEnv, pause, press, shows, until, withChat } from './fixtures/chat-rig.ts';

/** A key-repeat interval of an ordinary keyboard, in ms. */
const REPEAT_MS = 30;
/** Long past any repeat: a person who saw the draft come back and pressed Enter on purpose. */
const DELIBERATE_MS = 10_000;

function chat(choices?: ReadonlyArray<string>) {
  let clock = 1000;
  const answers: Array<string> = [];
  const rig = chatEnv({ now: () => clock });
  return {
    ...rig,
    answers,
    advance: (ms: number) => (clock += ms),
    ask: () =>
      rig.question({
        question: 'Continue?',
        secret: false,
        ...(choices === undefined ? {} : { choices }),
        answer: (text) => void answers.push(text),
      }),
  };
}

test('a second Enter in the chunk of the answer leaves the restored draft in the composer', async () => {
  // Bug: the answer's chunk carries two returns, the second lands on the restored draft and sends it unseen.
  const { env, sent, answers, ask } = chat();
  await withChat(env, async (rig) => {
    await press(rig, 'kept draft', shows(rig, '> kept draft'));
    ask();
    await until(shows(rig, 'Continue?'));
    await press(rig, 'yes', shows(rig, '> yes'));
    await press(rig, `${KEY.enter}${KEY.enter}`, () => answers.length === 1 && shows(rig, '> kept draft')());
    // A swallowed Enter changes nothing on the screen, so only a fixed wait lets a stray send show.
    await pause();
    assert.deepEqual(answers, ['yes']);
    assert.deepEqual(sent, []);
    assert.match(rig.screen().join('\n'), /> kept draft/);
  });
});

test('a key-repeat burst after the answer sends nothing, and a deliberate Enter past its window sends the draft once', async () => {
  // Bug: a held Enter sends the draft, or the guard swallows every later Enter and the draft can never go out.
  const { env, sent, answers, ask, advance } = chat();
  await withChat(env, async (rig) => {
    await press(rig, 'kept draft', shows(rig, '> kept draft'));
    ask();
    await until(shows(rig, 'Continue?'));
    await press(rig, 'yes', shows(rig, '> yes'));
    await press(rig, KEY.enter, () => answers.length === 1 && shows(rig, '> kept draft')());
    for (let repeat = 0; repeat < 3; repeat += 1) {
      advance(REPEAT_MS);
      rig.type(KEY.enter);
      // A swallowed Enter changes nothing on the screen, so only a fixed wait lets a stray send show.
      await pause();
    }
    assert.deepEqual(answers, ['yes']);
    assert.deepEqual(sent, []);
    assert.match(rig.screen().join('\n'), /> kept draft/);
    advance(DELIBERATE_MS);
    await press(rig, KEY.enter, () => sent.length === 1);
    assert.deepEqual(sent, ['kept draft']);
  });
});

test('the same burst after choosing from a closed question leaves the draft too', async () => {
  // Bug: the selector takes its own Enter path, and only the typed answer got the guard.
  const { env, sent, answers, ask, advance } = chat(['on', 'off']);
  await withChat(env, async (rig) => {
    await press(rig, 'kept draft', shows(rig, '> kept draft'));
    ask();
    await until(shows(rig, 'Continue?'));
    await press(rig, KEY.enter, () => answers.length === 1 && shows(rig, '> kept draft')());
    advance(REPEAT_MS);
    rig.type(KEY.enter);
    // A swallowed Enter changes nothing on the screen, so only a fixed wait lets a stray send show.
    await pause();
    assert.deepEqual(answers, ['on']);
    assert.deepEqual(sent, []);
    assert.match(rig.screen().join('\n'), /> kept draft/);
  });
});

test('other keys during the window edit the restored draft as usual', async () => {
  // Bug: the guard drops typed text as well as Enter, and the owner's next word is lost.
  const { env, sent, answers, ask, advance } = chat();
  await withChat(env, async (rig) => {
    await press(rig, 'kept', shows(rig, '> kept'));
    ask();
    await until(shows(rig, 'Continue?'));
    await press(rig, 'yes', shows(rig, '> yes'));
    await press(rig, KEY.enter, () => answers.length === 1 && shows(rig, '> kept')());
    await press(rig, ' more', shows(rig, '> kept more'));
    advance(DELIBERATE_MS);
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, ['kept more']);
});

test('the window does not hold an ordinary send with no question before it', async () => {
  // Bug: the guard runs from the last Enter of any kind, and two quick messages lose the second.
  const { env, sent } = chat();
  await withChat(env, async (rig) => {
    await press(rig, 'one', shows(rig, '> one'));
    await press(rig, KEY.enter, () => sent.length === 1);
    await press(rig, 'two', shows(rig, '> two'));
    await press(rig, KEY.enter, () => sent.length === 2);
  });
  assert.deepEqual(sent, ['one', 'two']);
});
