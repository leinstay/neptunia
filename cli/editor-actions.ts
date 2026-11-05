// What the owner does to a draft beyond typing: reverse history search, transcript search, prompt jumps, undo and redo, a
// draft stash and an external editor. Everything works on the same draft and entry ids, and a search stays in this
// process: it sends nothing and stores nothing. The editor gets literal argv and a private temporary file. cli/app.ts holds
// the state, and bin/chat-images.ts gives the editor its command.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assembleDraft, displayDraft, draftFromText, replaceDraftText } from './composer.ts';
import type { Draft } from './composer.ts';
import type { ProcessResult } from './clipboard.ts';

export type EditorState = {
  draft: Draft;
  past: ReadonlyArray<Draft>;
  future: ReadonlyArray<Draft>;
  stash: ReadonlyArray<Draft>;
  limit: number;
};

/** One keystroke's draft is small, and a paste's payload is shared between steps, so a hundred steps cost little. */
const UNDO_STEPS = 100;

export function editorStart(draft: Draft, { limit = UNDO_STEPS }: { limit?: number } = {}): EditorState {
  return { draft, past: [], future: [], stash: [], limit };
}

const sameContent = (one: Draft, other: Draft): boolean =>
  one.parts.length === other.parts.length && displayDraft(one) === displayDraft(other) && sameParts(one, other);

function sameParts(one: Draft, other: Draft): boolean {
  return one.parts.every((part, index) => {
    const twin = other.parts[index];
    return part === twin || (part.kind === twin?.kind && part.id === twin.id);
  });
}

/** One step of the undo stack. An edit that changes nothing adds no step, and a new edit drops what could be redone. */
export function applyEdit(state: EditorState, draft: Draft): EditorState {
  if (sameContent(state.draft, draft)) return { ...state, draft };
  return { ...state, draft, past: [...state.past, state.draft].slice(-state.limit), future: [] };
}

/** The same step as the edit before it: the letters of one word undo together. */
export function coalesceEdit(state: EditorState, draft: Draft): EditorState {
  return { ...state, draft, future: [] };
}

export function undo(state: EditorState): EditorState {
  const draft = state.past.at(-1);
  if (draft === undefined) return state;
  return { ...state, draft, past: state.past.slice(0, -1), future: [state.draft, ...state.future] };
}

export function redo(state: EditorState): EditorState {
  const draft = state.future[0];
  if (draft === undefined) return state;
  return { ...state, draft, past: [...state.past, state.draft], future: state.future.slice(1) };
}

/** A new empty draft and no undo steps: what follows a send. The stash stays. */
function freshDraft(state: EditorState, id: string): EditorState {
  return { ...state, draft: draftFromText(id, '', 0), past: [], future: [] };
}

/** Puts the draft away with all its parts and starts an empty one. */
export function stashDraft(state: EditorState, newId: string): EditorState {
  return { ...freshDraft(state, newId), stash: [...state.stash, state.draft] };
}

/** Brings back the newest stashed draft. What the input held stays one undo away, and an empty stash changes nothing. */
export function popStash(state: EditorState): EditorState {
  const draft = state.stash.at(-1);
  if (draft === undefined) return state;
  return { ...applyEdit(state, draft), stash: state.stash.slice(0, -1) };
}

/** The `skip`-th line holding the query, newest first. An empty query finds nothing, so Enter cannot send a line by accident. */
export function searchHistory(
  history: ReadonlyArray<string>,
  query: string,
  skip: number
): { index: number; text: string } | null {
  if (query === '') return null;
  const asked = query.toLowerCase();
  let left = skip;
  for (const [index, text] of history.entries()) {
    if (!text.toLowerCase().includes(asked)) continue;
    if (left === 0) return { index, text };
    left -= 1;
  }
  return null;
}

/** Every match as an entry id and an offset, oldest first: these survive a resize and a new entry, and a row number would not. */
export function searchTranscript(
  entries: ReadonlyArray<{ id: string; text: string }>,
  query: string
): Array<{ entryId: string; offset: number }> {
  if (query === '') return [];
  const asked = query.toLowerCase();
  const matches: Array<{ entryId: string; offset: number }> = [];
  for (const entry of entries) {
    const text = entry.text.toLowerCase();
    for (let at = text.indexOf(asked); at !== -1; at = text.indexOf(asked, at + asked.length))
      matches.push({ entryId: entry.id, offset: at });
  }
  return matches;
}

/** The owner's nearest line in a direction, null at either end. */
export function jumpToPrompt(
  entries: ReadonlyArray<{ id: string; who: string }>,
  fromId: string,
  direction: -1 | 1
): string | null {
  const from = entries.findIndex((entry) => entry.id === fromId);
  if (from === -1) return null;
  for (let index = from + direction; index >= 0 && index < entries.length; index += direction) {
    const entry = entries[index];
    if (entry?.who === 'owner') return entry.id;
  }
  return null;
}

export type EditorResult = { status: 'edited' | 'cancelled' | 'failed'; draft: Draft };

/**
 * The draft's text in the owner's editor. A failure and an emptied file return the very same draft, the file is gone
 * afterwards in every case, and attachments stay parts of the draft. The newline an editor adds at the end is not the owner's.
 */
export async function editExternally(
  draft: Draft,
  {
    command,
    tempDir,
    run,
  }: {
    command: ReadonlyArray<string>;
    tempDir: string;
    run: (argv: ReadonlyArray<string>) => Promise<Pick<ProcessResult, 'code'>>;
  }
): Promise<EditorResult> {
  const assembled = assembleDraft(draft);
  if (!assembled.ok) return { status: 'failed', draft };
  const file = path.join(tempDir, `neptunia-draft-${randomUUID()}.txt`);
  try {
    await fs.writeFile(file, assembled.text, { mode: 0o600, flag: 'wx' });
    const result = await run([...command, file]);
    if (result.code !== 0) return { status: 'failed', draft };
    const text = (await fs.readFile(file, 'utf8')).replace(/\r?\n$/, '');
    return text === '' ? { status: 'cancelled', draft } : { status: 'edited', draft: replaceDraftText(draft, text) };
  } catch {
    return { status: 'failed', draft };
  } finally {
    await fs.rm(file, { force: true });
  }
}
