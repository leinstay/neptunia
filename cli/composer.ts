// The draft of the chat's input as ordered parts: text, pastes and attachments, each with its own id. A paste over the
// limits draws as a chip and keeps its whole payload, so two identical pastes stay two parts and the submitted turn gets
// the exact text. The caret is an offset into what is drawn and never stands inside a chip. A removed part keeps its place
// until it is restored. Pure functions over plain values: cli/app.ts holds the draft and cli/editor-actions.ts its undo.
import { graphemes } from './layout.ts';

export type PasteLimits = { collapseLines: number; collapseChars: number };

/** Decided 2026-11-05: longer than a screen's worth of composer, shorter than a file. The settings carry the same values. */
export const DEFAULT_PASTE_LIMITS: PasteLimits = { collapseLines: 10, collapseChars: 2000 };

export type ChatAttachment = {
  id: string;
  name: string;
  contentType: string;
  /** what the core reads the image through */
  reference: string;
  size?: number;
  /** the text alternative of a received image, null when it has none */
  alt?: string | null;
};

export type DraftPart =
  | { kind: 'text'; id: string; text: string }
  /** `payload` null is a paste whose text is gone: the draft refuses to assemble until it is removed or restored. */
  | { kind: 'paste'; id: string; payload: string | null; lines: number }
  | { kind: 'attachment'; id: string; attachment: ChatAttachment };

export type Draft = {
  id: string;
  parts: ReadonlyArray<DraftPart>;
  cursor: number;
  /** removed parts, each with the id of the part it followed */
  removed: ReadonlyArray<{ part: DraftPart; after: string | null }>;
  serial: number;
};

export type Assembled =
  | { ok: true; text: string; attachments: ReadonlyArray<ChatAttachment> }
  | { ok: false; partIds: ReadonlyArray<string>; actions: ReadonlyArray<'restore' | 'remove'> };

type Span = { part: DraftPart; index: number; start: number; end: number };

const lineCount = (text: string): number => text.split('\n').length;

function labelOf(part: DraftPart): string {
  switch (part.kind) {
    case 'text':
      return part.text;
    case 'attachment':
      return `[image ${part.attachment.name}]`;
    case 'paste':
      if (part.payload === null) return `[paste lost, ${part.lines} lines]`;
      return part.lines > 1 ? `[pasted ${part.lines} lines]` : `[pasted ${part.payload.length} characters]`;
  }
}

function spansOf(draft: Draft): Array<Span> {
  let at = 0;
  return draft.parts.map((part, index) => {
    const start = at;
    at += labelOf(part).length;
    return { part, index, start, end: at };
  });
}

const isChip = (part: DraftPart): boolean => part.kind !== 'text';

export function draftFromParts(id: string, parts: ReadonlyArray<DraftPart>): Draft {
  const draft = { id, parts, cursor: 0, removed: [], serial: parts.length };
  return { ...draft, cursor: displayDraft(draft).length };
}

export function draftFromText(id: string, text: string, cursor: number): Draft {
  const parts: Array<DraftPart> = text === '' ? [] : [{ kind: 'text', id: `${id}-t0`, text }];
  return { id, parts, cursor, removed: [], serial: 1 };
}

/** What the input draws: text as it is, a collapsed paste or an attachment as its chip. */
export function displayDraft(draft: Pick<Draft, 'parts'>): string {
  return draft.parts.map(labelOf).join('');
}

/** The exact text of the turn and its attachments in draft order, or which parts stand in the way. */
export function assembleDraft(draft: Draft): Assembled {
  const lost = draft.parts.filter((part) => part.kind === 'paste' && part.payload === null);
  if (lost.length > 0) return { ok: false, partIds: lost.map((part) => part.id), actions: ['restore', 'remove'] };
  const text = draft.parts
    .map((part) => (part.kind === 'text' ? part.text : part.kind === 'paste' ? (part.payload ?? '') : ''))
    .join('');
  const attachments = draft.parts.flatMap((part) => (part.kind === 'attachment' ? [part.attachment] : []));
  return { ok: true, text, attachments };
}

const withParts = (draft: Draft, parts: ReadonlyArray<DraftPart>, cursor: number, serial = draft.serial): Draft => ({
  ...draft,
  parts,
  cursor,
  serial,
});

/** Inserts a whole part at the caret, cutting a text part in two when the caret stands inside it. */
function insertPart(draft: Draft, part: DraftPart): Draft {
  const inside = spansOf(draft).find(
    (span) => span.part.kind === 'text' && span.start < draft.cursor && draft.cursor < span.end
  );
  const size = labelOf(part).length;
  if (inside !== undefined && inside.part.kind === 'text') {
    const cut = draft.cursor - inside.start;
    const { part: split } = inside;
    const head: DraftPart = { ...split, text: split.text.slice(0, cut) };
    const tail: DraftPart = { kind: 'text', id: `${draft.id}-t${draft.serial}`, text: split.text.slice(cut) };
    const parts = [...draft.parts.slice(0, inside.index), head, part, tail, ...draft.parts.slice(inside.index + 1)];
    return withParts(draft, parts, draft.cursor + size, draft.serial + 1);
  }
  const index = spansOf(draft).filter((span) => span.end <= draft.cursor).length;
  return withParts(draft, [...draft.parts.slice(0, index), part, ...draft.parts.slice(index)], draft.cursor + size);
}

/** Typed text goes into the text part at the caret, or into a new one between two chips. */
export function typeIntoDraft(draft: Draft, typed: string): Draft {
  if (typed === '') return draft;
  const span = spansOf(draft).find(
    (one) => one.part.kind === 'text' && one.start <= draft.cursor && draft.cursor <= one.end
  );
  if (span === undefined || span.part.kind !== 'text') {
    const part: DraftPart = { kind: 'text', id: `${draft.id}-t${draft.serial}`, text: typed };
    return { ...insertPart(draft, part), serial: draft.serial + 1 };
  }
  const cut = draft.cursor - span.start;
  const { part: held } = span;
  const text = held.text.slice(0, cut) + typed + held.text.slice(cut);
  const parts = draft.parts.map((part, index) => (index === span.index ? { ...held, text } : part));
  return withParts(draft, parts, draft.cursor + typed.length);
}

const collapses = (payload: string, limits: PasteLimits): boolean =>
  lineCount(payload) > limits.collapseLines || payload.length > limits.collapseChars;

/** A paste within the limits is text like any other, and one over them is a part of its own. An empty paste adds nothing. */
export function pasteIntoDraft(draft: Draft, paste: { id: string; payload: string }, limits: PasteLimits): Draft {
  if (paste.payload === '') return draft;
  if (!collapses(paste.payload, limits)) return typeIntoDraft(draft, paste.payload);
  return insertPart(draft, { kind: 'paste', id: paste.id, payload: paste.payload, lines: lineCount(paste.payload) });
}

/** Adds an attachment at the caret. */
export function attachToDraft(draft: Draft, attachment: ChatAttachment): Draft {
  return insertPart(draft, { kind: 'attachment', id: attachment.id, attachment });
}

/** A draft recalled from the history: its text collapses by the same limits as a paste, and its images come back as parts. */
export function draftFromHistory(
  id: string,
  text: string,
  attachments: ReadonlyArray<ChatAttachment>,
  limits: PasteLimits
): Draft {
  const body = pasteIntoDraft(draftFromText(id, '', 0), { id: `${id}-p0`, payload: text }, limits);
  return attachments.reduce(attachToDraft, body);
}

/** The same attachments under other text: what an external editor gives back. */
export function replaceDraftText(draft: Draft, text: string): Draft {
  const attachments = draft.parts.filter((part) => part.kind === 'attachment');
  const parts: Array<DraftPart> =
    text === '' ? attachments : [{ kind: 'text', id: `${draft.id}-t${draft.serial}`, text }, ...attachments];
  return withParts(draft, parts, text.length, draft.serial + 1);
}

/** Takes one part out, by its identity. It keeps its place for `restorePart`. */
export function removePart(draft: Draft, partId: string): Draft {
  const span = spansOf(draft).find((one) => one.part.id === partId);
  if (span === undefined) return draft;
  const size = span.end - span.start;
  const cursor = draft.cursor >= span.end ? draft.cursor - size : Math.min(draft.cursor, span.start);
  const previous = draft.parts[span.index - 1];
  const after = previous?.id ?? null;
  return {
    ...withParts(
      draft,
      draft.parts.filter((_, index) => index !== span.index),
      cursor
    ),
    removed: [...draft.removed, { part: span.part, after }],
  };
}

/** Puts a removed part back where it stood; the end of the draft when the part it followed is gone. */
export function restorePart(draft: Draft, partId: string): Draft {
  const held = draft.removed.find((one) => one.part.id === partId);
  if (held === undefined) return draft;
  const found = draft.parts.findIndex((part) => part.id === held.after);
  const index = held.after === null ? 0 : found === -1 ? draft.parts.length : found + 1;
  const parts = [...draft.parts.slice(0, index), held.part, ...draft.parts.slice(index)];
  const start = displayDraft({ parts: parts.slice(0, index) }).length;
  const size = labelOf(held.part).length;
  return {
    ...withParts(draft, parts, draft.cursor >= start ? draft.cursor + size : draft.cursor),
    removed: draft.removed.filter((one) => one !== held),
  };
}

/** The chip right before the caret: what Backspace would take. */
export function chipBeforeCaret(draft: Draft): DraftPart | null {
  const span = spansOf(draft).find((one) => isChip(one.part) && one.end === draft.cursor);
  return span?.part ?? null;
}

function textEdit(draft: Draft, span: Span, keep: (text: string, cut: number) => { text: string; cut: number }): Draft {
  if (span.part.kind !== 'text') return draft;
  const { text, cut } = keep(span.part.text, draft.cursor - span.start);
  const parts = draft.parts.map((part, index) => (index === span.index ? { ...span.part, text } : part));
  return withParts(draft, parts, span.start + cut);
}

/** One step of Backspace: a whole grapheme of text, or the whole chip before the caret, which is also returned. */
export function backspaceInDraft(draft: Draft): { draft: Draft; removed: DraftPart | null } {
  const span = spansOf(draft).find((one) => one.start < draft.cursor && draft.cursor <= one.end);
  if (span === undefined) return { draft, removed: null };
  if (isChip(span.part)) return { draft: removePart(draft, span.part.id), removed: span.part };
  const next = textEdit(draft, span, (text, cut) => {
    const head = graphemes(text.slice(0, cut)).slice(0, -1).join('');
    return { text: head + text.slice(cut), cut: head.length };
  });
  return { draft: next, removed: null };
}

/** One step of Delete: a whole grapheme of text, or the whole chip after the caret, which is also returned. */
export function deleteInDraft(draft: Draft): { draft: Draft; removed: DraftPart | null } {
  const span = spansOf(draft).find((one) => one.start <= draft.cursor && draft.cursor < one.end);
  if (span === undefined) return { draft, removed: null };
  if (isChip(span.part)) return { draft: removePart(draft, span.part.id), removed: span.part };
  const next = textEdit(draft, span, (text, cut) => ({
    text: text.slice(0, cut) + graphemes(text.slice(cut)).slice(1).join(''),
    cut,
  }));
  return { draft: next, removed: null };
}

/** One step of the caret: a whole grapheme of text, or across a whole chip. */
export function moveInDraft(draft: Draft, delta: -1 | 1): Draft {
  const spans = spansOf(draft);
  if (delta < 0) {
    const span = spans.find((one) => one.start < draft.cursor && draft.cursor <= one.end);
    if (span === undefined) return draft;
    if (isChip(span.part)) return { ...draft, cursor: span.start };
    const before = graphemes(labelOf(span.part).slice(0, draft.cursor - span.start));
    return { ...draft, cursor: draft.cursor - (before.at(-1)?.length ?? 0) };
  }
  const span = spans.find((one) => one.start <= draft.cursor && draft.cursor < one.end);
  if (span === undefined) return draft;
  if (isChip(span.part)) return { ...draft, cursor: span.end };
  const ahead = graphemes(labelOf(span.part).slice(draft.cursor - span.start));
  return { ...draft, cursor: draft.cursor + (ahead[0]?.length ?? 0) };
}

/** Puts the caret at an offset of what is drawn, past the chip when the offset falls inside one. */
export function placeCaret(draft: Draft, offset: number): Draft {
  const clamped = Math.max(0, Math.min(offset, displayDraft(draft).length));
  const chip = spansOf(draft).find((one) => isChip(one.part) && one.start < clamped && clamped < one.end);
  return { ...draft, cursor: chip?.end ?? clamped };
}
