// The paste path of the mounted chat: Ink's bracketed-paste parser, the one focus owner, and an exact turn on Enter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY, bracketed, chatEnv, pause, press, shows, until, withChat } from './fixtures/chat-rig.ts';
import type { Rig } from './fixtures/chat-rig.ts';

const LIMITS = { collapseLines: 3, collapseChars: 800 };
const CHIP = /\[pasted \d+ lines\]/;
const chips = (rig: Rig): number =>
  (
    rig
      .screen()
      .join('\n')
      .match(/\[pasted \d+ lines\]/g) ?? []
  ).length;

test('a paste with embedded Enter sends nothing until the explicit submit, then the exact expanded text', async () => {
  // Bug: a newline inside a paste submits the first line, or the turn loses its trailing spaces.
  const { env, sent } = chatEnv({ composer: LIMITS });
  const payload = 'alpha  \n\nbeta\ngamma\ndelta   ';
  await withChat(env, async (rig) => {
    await press(rig, 'Review ', shows(rig, '> Review'));
    await press(rig, bracketed(payload), shows(rig, CHIP));
    await press(rig, ' for errors.', shows(rig, 'for errors.'));
    assert.deepEqual(sent, []);
    assert.equal(rig.screen().join('\n').includes('gamma'), false, 'the chip stands for the payload');
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, [`Review ${payload} for errors.`]);
});

test('every single-byte split of a bracketed paste arrives as one paste with its UTF-8 whole', async () => {
  // Bug: a parallel stdin parser leaks the delimiters into the draft, or a split character becomes U+FFFD.
  const bytes = Buffer.from(bracketed('aé\nb'), 'utf8');
  for (let at = 1; at < bytes.length; at += 1) {
    const { env, sent } = chatEnv({ composer: { collapseLines: 1, collapseChars: 800 } });
    await withChat(env, async (rig) => {
      rig.type(bytes.subarray(0, at));
      await press(rig, bytes.subarray(at), shows(rig, CHIP));
      assert.deepEqual(sent, [], `split at ${at}`);
      assert.equal(
        rig.screen().join('\n').includes('aé'),
        false,
        `a chip, so the paste channel took it; split at ${at}`
      );
      await press(rig, KEY.enter, () => sent.length === 1);
    });
    assert.deepEqual(sent, ['aé\nb'], `split at ${at}`);
  }
});

test('a paste whose escape prefix arrives a moment late is still one paste', async () => {
  // Bug: a delayed ESC reads as the Escape key, clears the draft and types the delimiter as text.
  const { env, sent } = chatEnv({ composer: { collapseLines: 1, collapseChars: 800 } });
  await withChat(env, async (rig) => {
    await press(rig, 'kept ', shows(rig, '> kept'));
    rig.type('\u001b');
    // The gap is the scenario: the rest of the paste comes a moment after its escape prefix.
    await pause(5);
    await press(rig, '[200~one\ntwo\u001b[201~', shows(rig, CHIP));
    assert.equal(rig.screen().join('\n').includes('one'), false, 'a chip, so the paste channel took it');
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, ['kept one\ntwo']);
});

test('Backspace after a chip removes that paste alone and leaves the identical one', async () => {
  // Bug: Backspace eats one hidden character of the payload, or removes every paste with the same content.
  const { env, sent } = chatEnv({ composer: LIMITS });
  const payload = 'a\nb\nc\nd';
  await withChat(env, async (rig) => {
    await press(rig, bracketed(payload), () => chips(rig) === 1);
    await press(rig, bracketed(payload), () => chips(rig) === 2);
    await press(rig, KEY.backspace, () => chips(rig) === 1);
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, [payload]);
});

test('a draft with an unresolved paste is not sent and the failure shows while the draft stays', async () => {
  // Bug: a restored draft whose payload is gone goes out without it, with no word to the owner.
  const { env, sent } = chatEnv({
    composer: LIMITS,
    initialParts: [
      { kind: 'text', id: 't', text: 'keep-me ' },
      { kind: 'paste', id: 'missing', payload: null, lines: 4 },
    ],
  });
  await withChat(env, async (rig) => {
    const shownBefore = rig.screen().join('\n');
    await press(rig, KEY.enter, shows(rig, 'A pasted text is gone'));
    assert.deepEqual(sent, []);
    assert.match(rig.screen().join('\n'), /keep-me/);
    assert.notEqual(rig.screen().join('\n'), shownBefore, 'the failure shows');
  });
});

test('a paste into a secret question reaches only that question, and the interrupted draft comes back', async () => {
  // Bug: a pasted key lands in the conversation draft, in the paste store or in the history file.
  const secret = 'synthetic-secret-for-test';
  let clock = 1000;
  const { env, sent, saved, question } = chatEnv({ composer: LIMITS, now: () => clock });
  let answered = '';
  await withChat(env, async (rig) => {
    await press(rig, 'Keep this draft.', shows(rig, '> Keep this draft.'));
    question({ question: 'The key:', secret: true, answer: (text) => (answered = text) });
    await until(shows(rig, 'The key:'));
    await press(rig, bracketed(secret), shows(rig, '*'.repeat(secret.length)));
    assert.equal(rig.frames().includes(secret), false);
    await press(rig, KEY.enter, () => answered !== '' && shows(rig, '> Keep this draft.')());
    assert.match(rig.screen().join('\n'), /Keep this draft\./);
    clock += 10_000;
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.equal(answered, secret);
  assert.deepEqual(sent, ['Keep this draft.']);
  assert.equal(JSON.stringify(saved).includes(secret), false);
});

test('a multiline draft comes back whole from the history, and an unfinished draft survives browsing', async () => {
  // Bug: Up recalls one line of a paste, or Down past the newest wipes what the owner was typing.
  const { env, sent } = chatEnv({ composer: LIMITS });
  const payload = 'first\nsecond\nthird\nfourth';
  await withChat(env, async (rig) => {
    await press(rig, bracketed(payload), shows(rig, CHIP));
    await press(rig, KEY.enter, () => sent.length === 1);
    await press(rig, 'unfinished', shows(rig, '> unfinished'));
    await press(rig, KEY.up, () => !rig.screen().join('\n').includes('> unfinished'));
    await press(rig, KEY.down, shows(rig, '> unfinished'));
    assert.match(rig.screen().join('\n'), /> unfinished/);
    await press(rig, KEY.up, () => !rig.screen().join('\n').includes('> unfinished'));
    await press(rig, KEY.enter, () => sent.length === 2);
  });
  assert.deepEqual(sent, [payload, payload]);
});
