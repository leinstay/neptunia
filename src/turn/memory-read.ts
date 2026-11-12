// memory.read, her one read of what memory holds about one subject, run inside a turn (src/turn/in-turn-tools.ts) under
// the turn's memory context and never as an owner's command.
//
//   runMemoryRead({ args, reads, context, here, labels, timezone, now, selfreflectionIds? })
//     -> { status, code?, reason?, data?: { text } }
//
// `args.subject` names a person, a place, the word `community` or a lore title (src/memory/db/subject.ts#subjectOf).
// A person or a place is the one seed of the graph reader, read alone (src/memory/db/mind-read.ts, `Seeds.alone`): a
// person as the counterpart, so their entry comes at whole detail with their claims and episodes, a place as the place,
// with its lore and episodes. A lore entry comes as its claim. The renderer of `<memory>` renders it
// (src/turn/request/memory-block.ts#subjectMemoryOf), and the entry of a place whose chat id is in `selfreflectionIds`, a
// mirror of her selfreflection (src/memory/db/mirrors.ts#selfreflectionChatIds), carries the mark `<places>` gives it
// (`labels.memory.selfreflection`). `args.section` narrows what is rendered: `summary` (the default)
// renders every entry, `episodes` the episodes alone, `changes` a person's attitude changes, newest first. `args.limit`
// caps the claims, episodes and changes, default 25, at most 100. What the context may not read never comes back: the
// reader filters every row by the audience of the context (src/memory/db/scope.ts#audienceWhere).
// Answers: `ok` with the block in `data.text`; `invalid` `not-found` when the subject names nothing; `invalid`
// `target-ambiguous` with the choices in `data.text` when it names several things of one kind; `invalid` `invalid-args`
// `args.section` with the sections in `data.text` for an unknown section or `changes` of something other than a person;
// `not_configured` `unsupported` while the memory is closed. The wording is `labels.tools.tools.subject`. Never throws.

import { fill } from '../format.ts';
import { CODE } from '../tools/codes.ts';
import { objOf } from '../tools/types.ts';
import type { Obj } from '../tools/types.ts';
import type { FrameReads } from '../memory/db/frame-reads.ts';
import type { Mind, Seeds } from '../memory/db/mind-read.ts';
import type { Context } from '../memory/db/scope.ts';
import type { Subject, SubjectHere } from '../memory/db/subject.ts';
import { subjectMemoryOf } from './request/memory-block.ts';
import { shownName } from './request/text.ts';
import type { AttitudeChange, MirrorMarks } from './request/memory-block.ts';
import type { Labels } from './request/types.ts';

/** The sections of memory.read, the default first. */
export const MEMORY_READ_SECTIONS = Object.freeze(['summary', 'episodes', 'changes'] as const);
type Section = (typeof MEMORY_READ_SECTIONS)[number];

/** The items per section a read returns when it names no limit, and the most it may name. */
export const MEMORY_READ_LIMIT = 25;
export const MEMORY_READ_LIMIT_MAX = 100;

/** The reads of the memory memory.read takes. */
export type MemoryReadReads = Pick<FrameReads, 'mind' | 'subject' | 'affinityChanges' | 'placeRef'>;

/** One memory.read: her arguments, the memory's reads, the turn's context and where she stands. */
export type MemoryReadInput = {
  args: Obj;
  reads: MemoryReadReads | null;
  context: Context | null;
  here: SubjectHere;
  labels: unknown;
  timezone: string;
  now: number;
  /** The chat ids of the places her selfreflection is mirrored to; none when not given. */
  selfreflectionIds?: ReadonlySet<string>;
  /** `context.names.emoji`: the names keep their emoji when true. */
  keepEmoji?: boolean;
};

export type MemoryReadAnswer = { status: string; code?: string; reason?: string; data?: { text: string } };

/** `labels.tools.tools.subject`, a missing key read as ''. */
function wordsOf(labels: unknown): (key: string) => string {
  const words = objOf(objOf(objOf(objOf(labels).tools).tools).subject);
  return (key) => (typeof words[key] === 'string' ? words[key] : '');
}

/** The limit she named, else the default, within its bounds. */
function limitOf(given: unknown): number {
  if (typeof given !== 'number' || !Number.isFinite(given)) return MEMORY_READ_LIMIT;
  return Math.min(Math.max(1, Math.floor(given)), MEMORY_READ_LIMIT_MAX);
}

/** The seeds of a person or a place as the one seed of a read alone. */
function seedsOf(subject: Subject & { kind: 'person' | 'place' }): Seeds {
  return {
    messages: [],
    counterpart: subject.kind === 'person' ? { personId: subject.personId, accountId: subject.accountId } : null,
    place: subject.kind === 'place' ? subject.placeId : null,
    previous: [],
    candidates: [],
    alone: true,
  };
}

const EMPTY_MIND: Mind = {
  people: [],
  places: [],
  interfaces: [],
  lore: [],
  recent: [],
  found: [],
  leftOut: {},
  reads: [],
};

/** What the reader gave for the subject, narrowed to `section` and cut to `limit` items per list. */
function narrowed(mind: Mind, section: Section, limit: number): Mind {
  const recent = mind.recent.slice(0, limit);
  if (section === 'episodes') return { ...EMPTY_MIND, recent };
  const people = mind.people.map((person) => ({ ...person, claims: person.claims.slice(0, limit) }));
  if (section === 'changes') return { ...EMPTY_MIND, people };
  return { ...mind, people, recent, lore: mind.lore.slice(0, limit), interfaces: [], found: [] };
}

/** Whether a read of `subject` found anything to render. */
const holdsAny = (mind: Mind): boolean => mind.people.length + mind.places.length + mind.lore.length > 0;

/** The answer of a subject that names several things: the lead and one line per choice. */
function severalAnswer(
  subject: Subject & { kind: 'several' },
  given: string,
  word: (key: string) => string,
  keepEmoji: boolean
) {
  const lines = subject.choices.map((choice) =>
    fill(word('line'), { name: shownName(choice.name, keepEmoji), ref: choice.ref })
  );
  const text = [fill(word('several'), { given, count: subject.choices.length }), ...lines].filter(Boolean).join('\n');
  return { status: 'invalid', code: CODE.TARGET_AMBIGUOUS, data: { text } };
}

/** The answer of a section memory.read does not have, or of `changes` for something other than a person. */
function sectionAnswer(given: string, word: (key: string) => string): MemoryReadAnswer {
  const text = fill(word('sections'), { given, sections: MEMORY_READ_SECTIONS.join(', ') });
  return { status: 'invalid', code: CODE.INVALID_ARGS, reason: 'args.section', data: { text } };
}

/** The answer of a subject that names nothing the context reads. */
function noneAnswer(given: string, word: (key: string) => string): MemoryReadAnswer {
  const text = fill(word('none'), { given });
  return { status: 'invalid', code: CODE.NOT_FOUND, ...(text ? { data: { text } } : {}) };
}

/** One memory.read. Never throws. */
export function runMemoryRead(input: MemoryReadInput): MemoryReadAnswer {
  const { args, reads, context } = input;
  const word = wordsOf(input.labels);
  const given = typeof args.subject === 'string' ? args.subject.trim() : '';
  if (given === '') return { status: 'invalid', code: CODE.INVALID_ARGS, reason: 'args.subject' };
  const asked = typeof args.section === 'string' && args.section !== '' ? args.section : 'summary';
  if (!(MEMORY_READ_SECTIONS as ReadonlyArray<string>).includes(asked)) return sectionAnswer(asked, word);
  const section = asked as Section;
  if (!reads?.subject || !context) return { status: 'not_configured', code: CODE.UNSUPPORTED };
  try {
    return readSubject(input, reads.subject(context, given, input.here), { given, section, word });
  } catch {
    return { status: 'failed', code: CODE.ERROR };
  }
}

/** The answer for the subject her words named, read and rendered as `section` asks. */
function readSubject(
  input: MemoryReadInput,
  subject: Subject,
  { given, section, word }: { given: string; section: Section; word: (key: string) => string }
): MemoryReadAnswer {
  if (subject.kind === 'none') return noneAnswer(given, word);
  if (subject.kind === 'several') return severalAnswer(subject, given, word, input.keepEmoji === true);
  if (section === 'changes' && subject.kind !== 'person') return sectionAnswer(section, word);
  const limit = limitOf(input.args.limit);
  const mind =
    subject.kind === 'lore' || !input.reads || !input.context
      ? { ...EMPTY_MIND, lore: subject.kind === 'lore' ? loreEntries(subject) : [] }
      : narrowed(input.reads.mind(input.context, seedsOf(subject), input.now), section, limit);
  if (!holdsAny(mind) && mind.recent.length === 0) return noneAnswer(given, word);
  const changes = section === 'changes' && subject.kind === 'person' ? changesOf(input, subject, limit) : null;
  if (changes !== null && changes.length === 0) return { status: 'ok', data: { text: word('noChanges') } };
  const view = { interface: input.here.iface, timezone: input.timezone, counterpart: null };
  const text = subjectMemoryOf(
    mind,
    view,
    input.labels as Labels,
    nameOfIn(mind, subject),
    changes,
    mirrorsOf(input),
    input.keepEmoji === true
  );
  return text === '' ? noneAnswer(given, word) : { status: 'ok', data: { text } };
}

/** The mirrors of her selfreflection as the renderer marks them: their chat ids and a stored place's chat id. */
function mirrorsOf(input: MemoryReadInput): MirrorMarks {
  const chatIdOf = (placeId: string): string | null => {
    const ref = input.reads?.placeRef?.(placeId) ?? null;
    return ref === null || ref.kind === 'dm' ? null : ref.nativeId;
  };
  return { selfreflectionIds: input.selfreflectionIds ?? new Set(), chatIdOf };
}

/** Her attitude changes toward the person, newest first, under the turn's context. */
function changesOf(
  input: MemoryReadInput,
  subject: Subject & { kind: 'person' },
  limit: number
): Array<AttitudeChange> {
  if (!input.reads?.affinityChanges || !input.context) return [];
  return input.reads.affinityChanges(input.context, subject.personId, limit);
}

/** The names of the places of a read, by place id: the read's places and the places its lore entries are about. */
function nameOfIn(mind: Mind, subject: Subject): (id: string) => string | null {
  const names = new Map<string, string>();
  for (const place of mind.places) if (place.name) names.set(place.placeId, place.name);
  if (subject.kind === 'lore') for (const entry of subject.entries) names.set(entry.placeId, entry.placeName);
  return (id) => names.get(id) ?? null;
}

/** A lore subject's entries as the reader's lore entries, rendered whole. */
function loreEntries(subject: Subject & { kind: 'lore' }): Mind['lore'] {
  return subject.entries.map((entry) => ({
    nodeId: `claim:${entry.id}`,
    evidence: 'place',
    detail: 'whole',
    candidate: false,
    anchorMessageId: null,
    sources: [{ table: 'claims', id: entry.id, version: null }],
    claimId: entry.id,
    subjectId: entry.placeId,
    kind: 'lore',
    text: entry.text,
  }));
}
