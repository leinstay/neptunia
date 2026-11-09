// Replying to a line of the owner's chat with a `[#N]` marker at the start of a message, on the mounted chat: the marker
// goes, the line goes with the message id of line N as its parent, and a number the chat does not know keeps the draft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY, chatEnv, press, shows, until, withChat } from './fixtures/chat-rig.ts';
import type { Rig } from './fixtures/chat-rig.ts';
import type { ChatAttachment } from '../interfaces/cli/composer.ts';

type Sent = { line: string; replyTo: string | undefined };

/** A chat whose stored lines 12 and 34 are the messages `msg-12` and `msg-34`, and whose every send is kept with its reply parent. */
function replyChat() {
  const sent: Array<Sent> = [];
  const asked: Array<number> = [];
  const rig = chatEnv({
    send: (line: string, _attachments?: ReadonlyArray<ChatAttachment>, replyTo?: string) => {
      sent.push({ line, replyTo });
      return undefined;
    },
    replyParent: (number: number) => {
      asked.push(number);
      return Promise.resolve(number === 34 || number === 12 ? `msg-${number}` : null);
    },
    mouse: true,
  });
  return { ...rig, sent, asked };
}

const screenText = (rows: ReadonlyArray<string>): string => rows.join('\n');

test('a message that starts with a zero-padded marker replies to that line and sends only its text', async () => {
  // Bug: the marker reaches her and memory as part of the line, or the leading zeros the chat draws name another line.
  const { env, sent } = replyChat();
  await withChat(env, async (rig) => {
    await press(rig, '[#00034] hi', shows(rig, '> [#00034] hi'));
    await press(rig, KEY.enter, () => sent.length === 1);
    await until(shows(rig, '↳ #34'));
    const screen = screenText(rig.screen());
    assert.ok(!screen.includes('[#00034]'), 'the marker is gone from the transcript and the input');
    assert.match(screen, /↳ #34 hi/);
  });
  assert.deepEqual(sent, [{ line: 'hi', replyTo: 'msg-34' }]);
});

test('a marker without zeros names the same line', async () => {
  // Bug: only the padded form the chat draws is read, so a reply typed by hand goes out as plain text.
  const { env, sent } = replyChat();
  await withChat(env, async (rig) => {
    await press(rig, '[#34] hi', shows(rig, '> [#34] hi'));
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, [{ line: 'hi', replyTo: 'msg-34' }]);
});

test('a marker naming no stored line is refused on the status row and the draft stays', async () => {
  // Bug: a mistyped number sends the line as a reply to nothing, or the draft the owner typed is gone.
  const { env, sent, asked } = replyChat();
  await withChat(env, async (rig) => {
    await press(rig, '[#99] hi', shows(rig, '> [#99] hi'));
    await press(rig, KEY.enter, shows(rig, 'No line #99'));
    const screen = rig.screen();
    assert.match(screen.at(-1) ?? '', /No line #99/, 'the refusal stands on the row under the input');
    assert.ok(screenText(screen).includes('> [#99] hi'), 'the draft stays in the input');
  });
  assert.deepEqual(asked, [99]);
  assert.deepEqual(sent, []);
});

test('a marker anywhere but the start is plain text', async () => {
  // Bug: a line that quotes a number in its middle turns into a reply and loses its words.
  const { env, sent, asked } = replyChat();
  await withChat(env, async (rig) => {
    await press(rig, 'see [#34] hi', shows(rig, '> see [#34] hi'));
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, [{ line: 'see [#34] hi', replyTo: undefined }]);
  assert.deepEqual(asked, []);
});

/** Clicks, with no drag, on the first cell of `needle` on the screen. */
function clickOn(rig: Rig, needle: string): void {
  const screen = rig.screen();
  const row = screen.findIndex((line) => line.includes(needle));
  assert.ok(row >= 0, `"${needle}" is not on the screen:\n${screen.join('\n')}`);
  const column = (screen[row] ?? '').indexOf(needle) + 1;
  rig.type(`\u001b[<0;${column};${row + 1}M`);
  rig.type(`\u001b[<0;${column};${row + 1}m`);
}

test('a click on the number of her line makes the next message a reply to it, shown on the status row', async () => {
  // Bug: the owner has to type the marker by hand, or the click selects text and the message goes out with no parent.
  const { env, sent, entry } = replyChat();
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'words of hers', number: 34 });
    await until(shows(rig, 'words of hers'));
    clickOn(rig, '[#34]');
    await until(shows(rig, 'replying to #34'));
    assert.match(rig.screen().at(-1) ?? '', /replying to #34/, 'the reply target stands on the row under the input');
    // The click puts the marker at the start of the draft as one chip.
    await press(rig, 'hi', shows(rig, '> [#34] hi'));
    await press(rig, KEY.enter, () => sent.length === 1);
    await until(() => !rig.screen().join('\n').includes('replying to'));
  });
  assert.deepEqual(sent, [{ line: 'hi', replyTo: 'msg-34' }]);
});

test('a click on the number of his own line makes the next message a reply to it', async () => {
  // Bug: only her lines take a click, so the owner cannot follow up on something he said.
  const { env, sent, entry } = replyChat();
  await withChat(env, async (rig) => {
    entry({ who: 'owner', text: 'words of his', number: 12 });
    entry({ who: 'her', text: 'words of hers', number: 34 });
    await until(shows(rig, 'words of hers'));
    clickOn(rig, '[#12]');
    await until(shows(rig, 'replying to #12'));
    await press(rig, 'more', shows(rig, '> [#12] more'));
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, [{ line: 'more', replyTo: 'msg-12' }]);
});

test('Esc drops the reply target, and the next message goes with no parent', async () => {
  // Bug: a target the owner changed his mind about sticks to his next line, which then answers the wrong message.
  const { env, sent, entry } = replyChat();
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'words of hers', number: 34 });
    await until(shows(rig, 'words of hers'));
    clickOn(rig, '[#34]');
    await until(shows(rig, 'replying to #34'));
    await press(rig, KEY.escape, () => !rig.screen().join('\n').includes('replying to'));
    await press(rig, 'hi', shows(rig, '> hi'));
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, [{ line: 'hi', replyTo: undefined }]);
});

test('a click on a number the store does not know sends nothing and keeps the draft', async () => {
  // Bug: a line shown before it was stored takes a click, and the message goes out as a reply to nothing.
  const { env, sent, entry } = replyChat();
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'words of hers', number: 77 });
    await until(shows(rig, 'words of hers'));
    clickOn(rig, '[#77]');
    await until(shows(rig, 'replying to #77'));
    await press(rig, 'hi', shows(rig, '> [#77] hi'));
    await press(rig, KEY.enter, shows(rig, 'No line #77'));
    // The owner's chip rule of 2026-11-08 keeps the clicked marker in the draft, so the kept draft shows it.
    assert.ok(rig.screen().join('\n').includes('> [#77] hi'), 'the draft stays');
  });
  assert.deepEqual(sent, []);
});

test('one Backspace right after a typed marker removes the whole marker and the reply with it', async () => {
  // Bug: Backspace eats the marker a character at a time, leaving `[#3` that still reads as a reply or as text.
  const { env, sent } = replyChat();
  await withChat(env, async (rig) => {
    await press(rig, '[#34] ', shows(rig, 'replying to #34'));
    await press(rig, KEY.backspace, () => !rig.screen().join('\n').includes('replying to'));
    assert.ok(!rig.screen().join('\n').includes('[#'), 'no piece of the marker stays in the draft');
    await press(rig, 'hi', shows(rig, '> hi'));
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, [{ line: 'hi', replyTo: undefined }]);
});

test('one Backspace right after the marker a click set removes it and the reply with it', async () => {
  // Bug: the reply a click set stays on after the owner deleted what stood for it in the input.
  const { env, sent, entry } = replyChat();
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'words of hers', number: 34 });
    await until(shows(rig, 'words of hers'));
    clickOn(rig, '[#34]');
    await until(shows(rig, 'replying to #34'));
    await press(rig, KEY.backspace, () => !rig.screen().join('\n').includes('replying to'));
    await press(rig, 'hi', shows(rig, '> hi'));
    await press(rig, KEY.enter, () => sent.length === 1);
  });
  assert.deepEqual(sent, [{ line: 'hi', replyTo: undefined }]);
});
