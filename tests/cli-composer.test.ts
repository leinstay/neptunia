// interfaces/cli/composer.ts: the draft as ordered text, paste and attachment parts, driven by the traces of the paste examples.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleDraft,
  displayDraft,
  draftFromParts,
  draftFromText,
  pasteIntoDraft,
  removePart,
  restorePart,
  typeIntoDraft,
} from '../interfaces/cli/composer.ts';
import type { Draft, PasteLimits } from '../interfaces/cli/composer.ts';

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

test('a draft with an unresolved paste refuses to assemble and offers restore and remove', () => {
  // Bug: a lost payload sends the rest of the draft, or an empty string where the paste stood.
  const assembled = assembleDraft(draftFromParts('d1', [{ kind: 'paste', id: 'missing', payload: null, lines: 4 }]));
  assert.equal(assembled.ok, false);
  if (!assembled.ok) {
    assert.deepEqual(assembled.partIds, ['missing']);
    assert.deepEqual(assembled.actions, ['restore', 'remove']);
  }
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

test('a chip keeps the full payload, and restore puts a removed part back at its place', () => {
  // Bug: a chip keeps only its preview, or undoing a removal moves the paste to the end of the draft.
  // The chat has no key that shows what stands behind a chip (Claude Code has none), so the full payload is checked
  // through the assembled text instead of through the inspect function the key used.
  const payload = 'one\ntwo\nthree\nfour';
  const draft = typeIntoDraft(pasteIntoDraft(draftFromText('d', 'before ', 7), { id: 'p', payload }, LIMITS), ' after');
  assert.equal(textOf(draft), `before ${payload} after`);
  const removed = removePart(draft, 'p');
  assert.equal(textOf(removed), 'before  after');
  assert.equal(textOf(restorePart(removed, 'p')), `before ${payload} after`);
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
