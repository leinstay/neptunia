// interfaces/cli/composer.ts: the draft as ordered text, paste and attachment parts, driven by the traces of the paste examples.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleDraft,
  cutDraftRange,
  displayDraft,
  draftFromParts,
  draftFromText,
  draftRangeText,
  pasteIntoDraft,
  removePart,
  typeIntoDraft,
} from '../../../interfaces/cli/composer.ts';
import type { Draft, PasteLimits, ChatAttachment } from '../../../interfaces/cli/composer.ts';
import { KEY, chatEnv, press, shows, until, withChat, bracketed } from '../../fixtures/chat-rig.ts';
import type { Rig } from '../../fixtures/chat-rig.ts';

const LIMITS: PasteLimits = { collapseLines: 3, collapseChars: 800 };

const textOf = (draft: Draft): string => {
  const assembled = assembleDraft(draft);
  assert.equal(assembled.ok, true);
  return assembled.ok ? assembled.text : '';
};

test('a paste in the middle of a line assembles prefix, whole payload and suffix, with no chip label in the text', () => {
  // Bug: the submitted turn carries the chip's label instead of what was pasted, or the payload lands at the end.
  const draft = pasteIntoDraft(
    draftFromText('d1', 'Review  for errors.', 7),
    { id: 'paste-1', payload: 'alpha\nbeta\ngamma\ndelta' },
    LIMITS
  );
  const shown = displayDraft(draft);
  assert.equal(shown.includes('alpha'), false, 'a collapsed paste does not show its payload');
  assert.ok(shown.startsWith('Review ') && shown.endsWith(' for errors.'));
  const chip = shown.slice('Review '.length, -' for errors.'.length);
  assert.equal(textOf(draft), 'Review alpha\nbeta\ngamma\ndelta for errors.');
  assert.equal(textOf(draft).includes(chip), false, 'the chip stays out of the text');
});

test('two identical pastes keep their own identity, and removing one leaves the other', () => {
  // Bug: chips keyed by content remove both pastes, or remove the one the owner did not select.
  let draft = pasteIntoDraft(draftFromText('d1', '', 0), { id: 'p1', payload: 'a\nb\nc\nd' }, LIMITS);
  draft = pasteIntoDraft(draft, { id: 'p2', payload: 'a\nb\nc\nd' }, LIMITS);
  assert.equal(textOf(draft), 'a\nb\nc\nda\nb\nc\nd');
  draft = removePart(draft, 'p1');
  assert.equal(textOf(draft), 'a\nb\nc\nd');
  assert.deepEqual(
    draft.parts.filter((part) => part.kind === 'paste').map((part) => part.id),
    ['p2']
  );
});

test('a draft with an unresolved paste refuses to assemble', () => {
  // Bug: a lost payload sends the rest of the draft, or an empty string where the paste stood.
  const assembled = assembleDraft(draftFromParts('d1', [{ kind: 'paste', id: 'missing', payload: null, lines: 4 }]));
  assert.equal(assembled.ok, false);
});

test('the collapse thresholds are inclusive limits, by lines and by characters', () => {
  // Bug: an off-by-one collapses a paste at its limit, or a one-line megabyte stays inline in the composer.
  const atLimit = pasteIntoDraft(draftFromText('d', '', 0), { id: 'p', payload: 'a\nb\nc' }, LIMITS);
  assert.equal(displayDraft(atLimit), 'a\nb\nc');
  const overLines = pasteIntoDraft(draftFromText('d', '', 0), { id: 'p', payload: 'a\nb\nc\nd' }, LIMITS);
  assert.equal(displayDraft(overLines).includes('a\nb'), false);
  const long = 'x'.repeat(801);
  const overChars = pasteIntoDraft(draftFromText('d', '', 0), { id: 'p', payload: long }, LIMITS);
  assert.equal(displayDraft(overChars).includes(long), false);
  assert.equal(textOf(overChars), long);
});

test('trailing spaces, tabs, carriage returns and blank lines in a payload survive assembly', () => {
  // Bug: a trim or a newline normalisation changes pasted code before it reaches the core.
  const payload = '  first  \n\n\tsecond\r\nthird   \n\n';
  const draft = pasteIntoDraft(draftFromText('d', 'x', 1), { id: 'p', payload }, LIMITS);
  assert.equal(textOf(draft), `x${payload}`);
});

test('removing an unknown part and pasting nothing change nothing', () => {
  // Bug: an empty paste adds an invisible part that blocks the empty-draft check.
  const draft = draftFromText('d', 'kept', 4);
  assert.equal(textOf(removePart(draft, 'unknown')), 'kept');
  const empty = pasteIntoDraft(draft, { id: 'p', payload: '' }, LIMITS);
  assert.equal(
    empty.parts.some((part) => part.kind === 'paste'),
    false
  );
});

test('an empty draft assembles to empty text with no attachments', () => {
  // Bug: an empty draft fails to assemble and a bare Enter reports an error.
  const assembled = assembleDraft(draftFromText('d', '', 0));
  assert.equal(assembled.ok, true);
  if (assembled.ok) {
    assert.equal(assembled.text, '');
    assert.deepEqual(assembled.attachments, []);
  }
});

test('the assembled attachments follow the parts, in draft order', () => {
  // Bug: a caption is sent with its images in another order, or an attachment part leaks into the text.
  const image = (id: string) => ({
    kind: 'attachment' as const,
    id,
    attachment: { id, name: `${id}.png`, contentType: 'image/png', reference: `ref-${id}`, size: 8 },
  });
  const assembled = assembleDraft(
    draftFromParts('d', [image('a1'), { kind: 'text', id: 't', text: 'caption' }, image('a2')])
  );
  assert.equal(assembled.ok, true);
  if (assembled.ok) {
    assert.equal(assembled.text, 'caption');
    assert.deepEqual(
      assembled.attachments.map((one) => one.reference),
      ['ref-a1', 'ref-a2']
    );
  }
});

/** `ab`, a paste chip over the limits, then `cd`: the shape a selection across a chip meets. */
const chipBetween = (): Draft =>
  typeIntoDraft(
    pasteIntoDraft(draftFromText('d9', 'ab', 2), { id: 'paste-9', payload: 'one\ntwo\nthree\nfour' }, LIMITS),
    'cd'
  );

test('cutting a range that reaches into a chip takes the whole chip with the covered text', () => {
  // Bug: a selection ending inside a chip's label cuts the label in two and leaves a broken chip in the draft.
  // From after `a` to three cells into the chip's label.
  const cut = cutDraftRange(chipBetween(), 1, 2 + 3);
  assert.equal(textOf(cut.draft), 'acd');
  assert.deepEqual(
    cut.removed.map((part) => part.id),
    ['paste-9']
  );
  assert.equal(cut.draft.cursor, 1);
});

test('an empty range cuts nothing', () => {
  // Bug: a click that selected no character deletes the one under the caret.
  const draft = draftFromText('d10', 'keep', 2);
  const cut = cutDraftRange(draft, 2, 2);
  assert.equal(textOf(cut.draft), 'keep');
  assert.deepEqual(cut.removed, []);
});

test("the text of a range carries a covered paste's whole payload, not its chip", () => {
  // Bug: copying a selection over a collapsed paste puts `[pasted 4 lines]` on the clipboard.
  const draft = chipBetween();
  assert.equal(draftRangeText(draft, 1, displayDraft(draft).length - 1), 'bone\ntwo\nthree\nfourc');
});

// Replying to a line of the owner's chat with a `[#N]` marker at the start of a message, on the mounted chat: the marker
// goes, the line goes with the message id of line N as its parent, and a number the chat does not know keeps the draft.

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
  // Bug: the marker reaches the persona and memory as part of the line, or the leading zeros the chat draws name another line.
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

test('a click on the number of a line of the persona makes the next message a reply to it, shown on the status row', async () => {
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

test('a click on the number of an own line makes the next message a reply to it', async () => {
  // Bug: only the persona's lines take a click, so the owner cannot follow up on their own words.
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
  // Bug: a target the owner dropped sticks to the next line, which then answers the wrong message.
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
    // The chip rule keeps the clicked marker in the draft, so the kept draft shows it.
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

const CLI_PASTE_LIMITS = { collapseLines: 3, collapseChars: 800 };

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
  const { env, sent } = chatEnv({ composer: CLI_PASTE_LIMITS });
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

test('Backspace after a chip removes that paste alone and leaves the identical one', async () => {
  // Bug: Backspace eats one hidden character of the payload, or removes every paste with the same content.
  const { env, sent } = chatEnv({ composer: CLI_PASTE_LIMITS });
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
    composer: CLI_PASTE_LIMITS,
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

test('a multiline draft comes back whole from the history, and an unfinished draft survives browsing', async () => {
  // Bug: Up recalls one line of a paste, or Down past the newest wipes what the owner was typing.
  const { env, sent } = chatEnv({ composer: CLI_PASTE_LIMITS });
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
