// cli/editor-actions.ts: search, jumps, undo, stash and the external editor over the draft of cli/composer.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { draftFromParts, draftFromText, assembleDraft } from '../cli/composer.ts';
import type { Draft } from '../cli/composer.ts';
import {
  applyEdit,
  editExternally,
  editorStart,
  jumpToPrompt,
  popStash,
  redo,
  searchHistory,
  searchTranscript,
  stashDraft,
  undo,
} from '../cli/editor-actions.ts';
import { tempDir } from './fixtures/tmp.ts';

const textOf = (draft: Draft): string => {
  const assembled = assembleDraft(draft);
  return assembled.ok ? assembled.text : '';
};

const HISTORY = ['deploy the core', 'look at logs', 'deploy the bot', 'other'];

test('reverse search finds the newest match first and walks to older ones', () => {
  // Bug: search starts from the oldest line, or repeats one match forever.
  assert.deepEqual(searchHistory(HISTORY, 'deploy', 0), { index: 0, text: 'deploy the core' });
  assert.deepEqual(searchHistory(HISTORY, 'deploy', 1), { index: 2, text: 'deploy the bot' });
  assert.equal(searchHistory(HISTORY, 'deploy', 3), null);
});

test('reverse search ignores case and finds nothing on an empty query', () => {
  // Bug: an empty query recalls a line and Enter sends it by accident.
  assert.equal(searchHistory(HISTORY, 'LOGS', 0)?.index, 1);
  assert.equal(searchHistory(HISTORY, '', 0), null);
  assert.equal(searchHistory([], 'x', 0), null);
});

test('transcript search reports each match by entry id and offset, oldest first', () => {
  // Bug: matches are row numbers that a resize or a new entry invalidates.
  const entries = [
    { id: 'a', who: 'owner' as const, text: 'needle and needle' },
    { id: 'b', who: 'her' as const, text: 'nothing' },
    { id: 'c', who: 'her' as const, text: 'a NEEDLE' },
  ];
  assert.deepEqual(searchTranscript(entries, 'needle'), [
    { entryId: 'a', offset: 0 },
    { entryId: 'a', offset: 11 },
    { entryId: 'c', offset: 2 },
  ]);
  assert.deepEqual(searchTranscript(entries, ''), []);
});

test('a prompt jump lands only on the owner lines, in both directions, and stops at the ends', () => {
  // Bug: the jump lands on her answers, or wraps around to the other end of the conversation.
  const entries = [
    { id: 'p1', who: 'owner' as const, text: 'one' },
    { id: 'r1', who: 'her' as const, text: 'two' },
    { id: 'p2', who: 'owner' as const, text: 'three' },
    { id: 'r2', who: 'system' as const, text: 'four' },
  ];
  assert.equal(jumpToPrompt(entries, 'r2', -1), 'p2');
  assert.equal(jumpToPrompt(entries, 'p2', -1), 'p1');
  assert.equal(jumpToPrompt(entries, 'p1', -1), null);
  assert.equal(jumpToPrompt(entries, 'p1', 1), 'p2');
  assert.equal(jumpToPrompt(entries, 'p2', 1), null);
  assert.equal(jumpToPrompt([], 'p1', 1), null);
});

test('undo and redo walk the edits, and a new edit drops the redo branch', () => {
  // Bug: undo after an edit restores a future that no longer applies.
  let state = editorStart(draftFromText('d', 'a', 1));
  state = applyEdit(state, draftFromText('d', 'ab', 2));
  state = applyEdit(state, draftFromText('d', 'abc', 3));
  state = undo(state);
  assert.equal(textOf(state.draft), 'ab');
  state = redo(state);
  assert.equal(textOf(state.draft), 'abc');
  state = undo(undo(state));
  assert.equal(textOf(state.draft), 'a');
  assert.equal(textOf(undo(state).draft), 'a', 'nothing older stays put');
  state = applyEdit(state, draftFromText('d', 'x', 1));
  assert.equal(textOf(redo(state).draft), 'x');
});

test('the undo stack has a bound and an unchanged edit adds no step', () => {
  // Bug: a long session holds every keystroke's draft, paste payloads included, or undo seems to do nothing.
  let state = editorStart(draftFromText('d', '', 0), { limit: 3 });
  for (const text of ['1', '2', '3', '4', '5']) state = applyEdit(state, draftFromText('d', text, 1));
  for (let step = 0; step < 10; step += 1) state = undo(state);
  assert.equal(textOf(state.draft), '2');
  const same = editorStart(draftFromText('d', 'same', 4));
  assert.equal(textOf(undo(applyEdit(same, draftFromText('d', 'same', 4))).draft), 'same');
  assert.equal(same.past.length, 0);
});

test('a stash holds a draft with its parts, in order, and popping nothing changes nothing', () => {
  // Bug: a stash keeps only text, and a stashed paste or image is lost.
  const parts = [
    { kind: 'text' as const, id: 't', text: 'caption ' },
    { kind: 'paste' as const, id: 'p', payload: 'exact\npayload', lines: 2 },
  ];
  let state = editorStart(draftFromParts('d', parts));
  state = stashDraft(state, 'fresh');
  assert.equal(textOf(state.draft), '');
  assert.equal(state.draft.id, 'fresh');
  state = applyEdit(state, draftFromText('fresh', 'other', 5));
  state = stashDraft(state, 'fresh2');
  state = popStash(state);
  assert.equal(textOf(state.draft), 'other');
  state = popStash(state);
  assert.equal(textOf(state.draft), 'caption exact\npayload');
  assert.equal(textOf(popStash(state).draft), 'caption exact\npayload');
});

const editorRig = (edit: (file: string) => { code: number }) => {
  const dir = tempDir('nep-editor-');
  const calls: Array<ReadonlyArray<string>> = [];
  const modes: Array<number> = [];
  return {
    dir,
    calls,
    modes,
    deps: {
      command: ['ed itor', '--wait'],
      tempDir: dir,
      run: (argv: ReadonlyArray<string>) => {
        calls.push(argv);
        const file = String(argv.at(-1));
        modes.push(fs.statSync(file).mode & 0o777);
        return Promise.resolve(edit(file));
      },
    },
  };
};

test('the editor gets literal argv and a private file, and its multiline Unicode text comes back exactly', async () => {
  // Bug: the command runs through a shell, the draft is world-readable, or the editor's final newline lands in the turn.
  const rig = editorRig((file) => {
    fs.appendFileSync(file, '\nγραμμή  あ\n\ntail');
    return { code: 0 };
  });
  const result = await editExternally(draftFromText('d', 'first\nsecond', 5), rig.deps);
  assert.equal(result.status, 'edited');
  assert.equal(textOf(result.draft), 'first\nsecond\nγραμμή  あ\n\ntail');
  assert.deepEqual(rig.calls[0]?.slice(0, 2), ['ed itor', '--wait']);
  assert.equal(rig.calls[0]?.length, 3);
  assert.deepEqual(rig.modes, [0o600]);
  assert.deepEqual(fs.readdirSync(rig.dir), [], 'the temporary draft is gone');
});

test('attachments stay parts of the draft through the editor', async () => {
  // Bug: the image of a draft is dropped because a text editor cannot hold it.
  const attachment = { id: 'a1', name: 'a.png', contentType: 'image/png', reference: 'ref', size: 8 };
  const rig = editorRig((file) => {
    fs.writeFileSync(file, 'rewritten');
    return { code: 0 };
  });
  const draft = draftFromParts('d', [
    { kind: 'text', id: 't', text: 'caption' },
    { kind: 'attachment', id: 'a1', attachment },
  ]);
  const result = await editExternally(draft, rig.deps);
  const assembled = assembleDraft(result.draft);
  assert.equal(assembled.ok, true);
  if (assembled.ok) {
    assert.equal(assembled.text, 'rewritten');
    assert.deepEqual(assembled.attachments, [attachment]);
  }
});

test('an editor failure and a cancel return the exact draft and clean up', async () => {
  // Bug: a crashed editor empties the draft, or leaves the text in a temporary file.
  const draft = draftFromText('d', 'precious', 8);
  const failing = editorRig((file) => {
    fs.writeFileSync(file, 'half-written');
    return { code: 1 };
  });
  const failed = await editExternally(draft, failing.deps);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.draft, draft);
  assert.deepEqual(fs.readdirSync(failing.dir), []);
  const emptied = editorRig((file) => {
    fs.writeFileSync(file, '');
    return { code: 0 };
  });
  const cancelled = await editExternally(draft, emptied.deps);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.draft, draft);
});

test('an editor that cannot start is a failure with the draft kept', async () => {
  // Bug: a missing $EDITOR throws out of the input handler and ends the chat.
  const rig = editorRig(() => ({ code: 0 }));
  const draft = draftFromText('d', 'precious', 8);
  const result = await editExternally(draft, { ...rig.deps, run: () => Promise.reject(new Error('ENOENT')) });
  assert.equal(result.status, 'failed');
  assert.equal(result.draft, draft);
  assert.deepEqual(fs.readdirSync(rig.dir), []);
});
