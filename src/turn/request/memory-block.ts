// The body of `<memory>`: what the graph reader (src/memory/db/mind-read.ts#mindOf) brought to her mind, one entry per
// thing in one subtag only (docs/prompt-contract.md). `<people>` opens with the person she answers, marked so and always
// present, a stranger included; `<places>`, `<lore>`, `<recent>` and `<found>` follow. Every entry names its origin
// (`labels.memory.origin.*`), renders at the detail the reader chose and quotes stored text as an escaped value, a
// mention in it by the handle of the person it names. A person's entry lists every account of theirs, one line each,
// the account of the turn's interface marked. The request builder (src/turn/request/reader.ts) fits the items to the
// budget and renders what stayed. Pure.

import { fill, formatDate, mentionsNamed } from '../../format.ts';
import { factStateWords } from '../../memory/retrieval-input.ts';
import { EVIDENCE_ORDER } from '../../memory/db/mind-read.ts';
import type {
  ClaimEntry,
  EpisodeEntry,
  ExcerptEntry,
  InterfaceEntry,
  Mind,
  PersonEntry,
  PlaceEntry,
} from '../../memory/db/mind-read.ts';
import type { PersonAccount } from '../../memory/db/meta-person.ts';
import type { Frame } from './frame.ts';
import { block, escapeStored, pathText } from './text.ts';
import type { LabelGroup, Labels, MemoryLabels, MemoryRead, NameOf } from './types.ts';

/** The subtags of `<memory>`, in their order. */
export const MEMORY_SUBTAGS = ['people', 'places', 'lore', 'recent', 'found'] as const;
export type MemorySubtag = (typeof MEMORY_SUBTAGS)[number];

/**
 * One entry as the budget sees it: its subtag, its text, whether it is the person she answers, what its handle is cut
 * from, the platform ids of its accounts on the turn's interface, and the memory rows it carries for the per-turn record.
 */
export type MemoryItem = {
  readonly subtag: MemorySubtag;
  readonly text: string;
  readonly counterpart: boolean;
  /** The name a person goes by, null for anything else. */
  readonly name: string | null;
  /** The platform ids of a person's accounts on the turn's interface; empty for anything else. */
  readonly handleIds: ReadonlyArray<string>;
  /** What a person's handle is cut from: the person id, else the account key of a stranger; null for anything else. */
  readonly handleKey?: string | null;
  /** Every account of a person by interface and platform id, where her `@handle` may mention them. */
  readonly accounts?: ReadonlyArray<{ readonly iface: string; readonly native: string }>;
  /** The chat id a channel handle is given for once it is shown; null for anything else and a DM. */
  readonly chatId?: string | null;
  /** A place's stored name, for the request's budget to find it in the line she answers; absent for anything else. */
  readonly placeName?: string | null;
  /**
   * True for a person or a place the graph reader kept whatever its room (the entry's `keep`): the request's budget
   * takes it first and never leaves it out.
   */
  readonly keep?: boolean;
  /** The entry's text at each lower detail than `text`, the name last; empty for an entry with one detail. */
  readonly lower?: ReadonlyArray<string>;
  readonly reads: ReadonlyArray<MemoryRead>;
};

/** The chat id a stored place's channel handle stands for, from its row; null for a DM and a place no row holds. */
export type ChatIdOf = (placeId: string) => string | null;

/** What is live about a person now (their status, their voice seat) by their platform ids, one line; null when nothing is. */
export type LiveOf = (nativeIds: ReadonlyArray<string>) => string | null;

/** What of the frame an entry's words read: the interface of its handles, the clock of its dates, the person answered. */
export type FrameView = Pick<Frame, 'interface' | 'timezone' | 'counterpart'>;

/**
 * How an entry names what its stored texts point at: a `<@id>` mention by the handle of the person it names
 * (`authors.unknown` for an account no row holds), and a place id by its handle and path (`places.ref`).
 */
export type EntryRefs = {
  mention: (native: string) => string;
  place: (placeId: string) => string;
  /** The handle a one-to-one chat's path ends in, `@` included, instead of the partner's platform id. */
  partnerOf: (placeId: string) => string;
  /** What the handle of the person she answers is cut from when memory holds no entry of them; null: the frame's ids. */
  counterpartKey?: string | null;
};

type Words = {
  l: LabelGroup;
  origin: LabelGroup;
  frame: FrameView;
  nameOf: NameOf;
  locale: string | undefined;
  refs: EntryRefs;
  unknown: string;
};

/** The refs of a caller that gives none: a mention reads `authors.unknown`, a place the name `nameOf` gives it. */
function plainRefs(labels: Labels, nameOf: NameOf): EntryRefs {
  const unknown = labels.authors?.unknown ?? '';
  return {
    mention: () => unknown,
    place: (id) => escapeStored(nameOf(id) ?? labels.spatial?.unnamed ?? ''),
    partnerOf: () => unknown,
  };
}

/** A stored text as an escaped value, each `<@id>` mention in it read as the handle of the person it names. */
const storedText = (w: Pick<Words, 'refs'>, value: string): string =>
  escapeStored(String(mentionsNamed(value, w.refs.mention)));

/** A labelled line of a stored value, '' when the value or the label is missing. */
function valueLine(w: Words, template: string | undefined, value: string | null | undefined): string {
  if (typeof template !== 'string' || typeof value !== 'string' || value.trim() === '') return '';
  return fill(template, { value: storedText(w, value.trim()) });
}

/** The heading of an entry: its name and why it is here. */
function heading(w: Words, name: string, origin: string, candidate: boolean): string {
  const why = [origin, candidate ? (w.l.candidate ?? '') : ''].filter(Boolean).join('; ');
  return fill(w.l.entry ?? '{name} ({origin})', { name: escapeStored(name), origin: why });
}

/** The platform ids of a person's stored accounts on the frame's interface. */
function nativeIds(accounts: ReadonlyArray<PersonAccount>, iface: string): Array<string> {
  return accounts
    .filter((account) => account.iface === iface)
    .map((account) => account.platformId)
    .filter(Boolean);
}

/** Every account of a person by interface and platform id. */
const accountsOf = (person: PersonEntry): Array<{ iface: string; native: string }> =>
  (person.profileAccounts.length > 0 ? person.profileAccounts : person.platformAccounts).map((one) => ({
    iface: one.iface,
    native: one.platformId,
  }));

const readsOf = (entry: { sources: ReadonlyArray<{ table: string; id: string }> }): Array<MemoryRead> =>
  entry.sources.map((source) => ({ kind: source.table, id: source.id, block: 'memory' }));

/**
 * One line of an account: `memory.account` (`{iface}`, `{id}` its platform id, `{names}` every name of the account
 * joined with `, `), `memory.accountHere` for an account on the turn's interface, and `memory.accountUnnamed` or
 * `memory.accountUnnamedHere` for an account with no name.
 */
function accountLine(w: Words, iface: string, id: string, names: ReadonlyArray<string>): string {
  const here = iface === w.frame.interface;
  const shown = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  const key = shown.length > 0 ? (here ? 'accountHere' : 'account') : here ? 'accountUnnamedHere' : 'accountUnnamed';
  const template = w.l[key];
  if (typeof template !== 'string') return '';
  return fill(template, {
    iface: escapeStored(iface),
    id: escapeStored(id),
    names: shown.map(escapeStored).join(', '),
  });
}

/** The lines of every account of a person, one each. */
function accountLines(w: Words, person: PersonEntry): Array<string> {
  return person.profileAccounts.map((one) =>
    accountLine(w, one.iface, one.platformId, one.names ?? [one.displayName ?? ''])
  );
}

/** The open aliases of a person the context may see, as `memory.aliases`; '' with none. */
function aliasLine(w: Words, person: PersonEntry): string {
  const aliases = [
    ...new Set(person.claims.filter((claim) => claim.kind === 'alias').map((claim) => claim.text.trim())),
  ];
  const shown = aliases.filter(Boolean).map((alias) => storedText(w, alias));
  return shown.length > 0 && typeof w.l.aliases === 'string' ? fill(w.l.aliases, { value: shown.join(', ') }) : '';
}

/** The name an entry of a person opens with: the person's, else the first name of an account, else `authors.unknown`. */
function personName(w: Words, person: PersonEntry): string {
  const named = person.profileAccounts.map((one) => one.displayName).find((name) => Boolean(name));
  return person.name ?? named ?? w.unknown;
}

function personText(w: Words, person: PersonEntry, counterpart: boolean, live: string | null): string {
  const origin = counterpart ? (w.l.counterpart ?? '') : (w.origin[person.evidence] ?? '');
  const lines = [heading(w, personName(w, person), origin, person.candidate)];
  const detail = counterpart && person.detail === 'name' ? 'compact' : person.detail;
  if (detail === 'whole') lines.push(valueLine(w, w.l.realName, person.realName));
  if (detail !== 'name') lines.push(aliasLine(w, person));
  lines.push(...accountLines(w, person));
  if (detail !== 'name') lines.push(valueLine(w, w.l.relation, person.relation));
  if (detail === 'whole') {
    lines.push(valueLine(w, w.l.character, person.character));
    lines.push(valueLine(w, w.l.style, person.style));
    for (const claim of person.claims)
      if (claim.kind !== 'alias') lines.push(fill(w.l.claim ?? '- {text}', { text: storedText(w, claim.text) }));
  }
  if (live) lines.push(valueLine(w, w.l.live, live));
  return lines.filter(Boolean).join('\n');
}

function placeText(w: Words, place: PlaceEntry, selfreflection: boolean): string {
  // A one-to-one chat's path ends in its partner's handle, never in the partner's platform id.
  const path = place.kind === 'dm' ? [...place.path.slice(0, -1), w.refs.partnerOf(place.placeId)] : place.path;
  const lines = [heading(w, pathText(path, w.l.pathJoin), w.origin[place.evidence] ?? '', place.candidate)];
  // A place her selfreflection is mirrored to is marked at every detail, so she knows it as hers wherever it shows.
  if (selfreflection) lines.push(w.l.selfreflection ?? '');
  if (place.detail !== 'name') {
    for (const field of ['purpose', 'tone', 'topics'] as const) {
      const value = place[field];
      if (value) lines.push(storedText(w, value));
    }
    const date = place.ownLastAt ? formatDate(Date.parse(place.ownLastAt), w.frame.timezone, w.locale) : '';
    if (place.ownLines > 0 && date) lines.push(fill(w.l.ownLines ?? '', { count: place.ownLines, date }));
  }
  return lines.filter(Boolean).join('\n');
}

const interfaceText = (w: Words, entry: InterfaceEntry): string =>
  heading(w, entry.name ?? entry.iface, w.origin[entry.evidence] ?? '', entry.candidate);

const loreText = (w: Words, claim: ClaimEntry): string =>
  fill(w.l.lore ?? '{subject}: {text}', { subject: w.refs.place(claim.subjectId), text: storedText(w, claim.text) });

const episodeText = (w: Words, episode: EpisodeEntry): string =>
  fill(w.l.episode ?? '{date}: {what}', { date: episode.date ?? '', what: storedText(w, episode.what) });

function excerptText(w: Words, excerpt: ExcerptEntry): string {
  const at = excerpt.at ? Date.parse(excerpt.at) : NaN;
  return fill(w.l.excerpt ?? '{date}, {path}: "{text}"', {
    date: Number.isFinite(at) ? formatDate(at, w.frame.timezone, w.locale) : '',
    path: excerpt.placeId ? w.refs.place(excerpt.placeId) : '',
    text: storedText(w, excerpt.text),
  });
}

/**
 * Whether `person` is the one the frame answers: the same person, one of their accounts, or their account on the
 * frame's interface by the platform id, which is all a frame knows when its store links no account.
 */
function answers(frame: FrameView, person: PersonEntry): boolean {
  const them = frame.counterpart;
  if (them === null) return false;
  if (person.personId === them.personId || person.accounts.includes(them.accountId)) return true;
  return person.platformAccounts.some((one) => one.iface === frame.interface && one.platformId === them.nativeId);
}

/** The details below `detail`, strongest first, as the graph reader steps down (src/memory/db/mind-read.ts#cut). */
const DETAILS = ['whole', 'compact', 'name'] as const;
const below = (detail: (typeof DETAILS)[number]): Array<(typeof DETAILS)[number]> =>
  DETAILS.slice(DETAILS.indexOf(detail) + 1);

/** `<people>`'s items: the person she answers first, from the reader or as a stranger, then everyone else once. */
function peopleItems(w: Words, mind: Mind, live: LiveOf | null): Array<MemoryItem> {
  const item = (person: PersonEntry, counterpart: boolean): MemoryItem => {
    const now = live ? live(nativeIds(person.platformAccounts, w.frame.interface)) : null;
    return {
      subtag: 'people',
      text: personText(w, person, counterpart, now),
      counterpart,
      name: person.name,
      handleIds: nativeIds(person.platformAccounts, w.frame.interface),
      handleKey: person.personId,
      accounts: accountsOf(person),
      ...(person.keep === true ? { keep: true } : {}),
      lower: counterpart ? [] : below(person.detail).map((detail) => personText(w, { ...person, detail }, false, now)),
      reads: readsOf(person),
    };
  };
  const seen = new Set<string>();
  const people = mind.people.filter((person) => !seen.has(person.personId) && Boolean(seen.add(person.personId)));
  const found = people.find((person) => answers(w.frame, person)) ?? null;
  const them = w.frame.counterpart;
  const first: Array<MemoryItem> = [];
  if (found) first.push(item(found, true));
  else if (them !== null) {
    const now = live ? live([them.nativeId]) : null;
    first.push({
      subtag: 'people',
      text: [
        heading(w, them.name ?? w.unknown, w.l.counterpart ?? '', false),
        them.nativeId ? accountLine(w, w.frame.interface, them.nativeId, [them.name ?? '']) : '',
        now ? valueLine(w, w.l.live, now) : '',
      ]
        .filter(Boolean)
        .join('\n'),
      counterpart: true,
      name: them.name,
      handleIds: [them.nativeId].filter(Boolean),
      handleKey: w.refs.counterpartKey ?? them.personId ?? them.accountId,
      accounts: them.nativeId ? [{ iface: w.frame.interface, native: them.nativeId }] : [],
      reads: [],
    });
  }
  return [...first, ...people.filter((person) => person !== found).map((person) => item(person, false))];
}

/** A fact the retrieval service stored and the prefetch found (src/behavior/recall-facts.ts#factExcerpts). */
export type StoredFact = { readonly state?: unknown; readonly polarity?: unknown; readonly text: string };

/**
 * The prefetch's stored facts as `<found>` items, in its order: `memory.fact` with `{state}` (`labels.prefetch.factStates`,
 * as everywhere a fact reaches a model) and `{text}` as she wrote it.
 */
export function factItemsOf(facts: ReadonlyArray<StoredFact>, labels: Labels): Array<MemoryItem> {
  const template = labels.memory?.fact;
  if (typeof template !== 'string' || template === '') return [];
  return facts
    .filter((fact) => fact.text.trim() !== '')
    .map((fact) => ({
      subtag: 'found',
      text: fill(template, {
        state: factStateWords(fact, labels.prefetch?.factStates),
        text: escapeStored(fact.text),
      }),
      counterpart: false,
      name: null,
      handleIds: [],
      reads: [],
    }));
}

/** The words of an entry under `labels`, its refs those of the request or, without them, plainRefs. */
function wordsOf(labels: Labels, frame: FrameView, nameOf: NameOf, refs: EntryRefs | null): Words {
  const l = labels.memory ?? {};
  return {
    l,
    origin: l.origin ?? {},
    frame,
    nameOf,
    locale: labels.locale,
    refs: refs ?? plainRefs(labels, nameOf),
    unknown: labels.authors?.unknown ?? '',
  };
}

/**
 * Every entry of `mind` as an item, in the order of the subtags and, inside one, the reader's rank. `selfreflectionIds`
 * are the chat ids of the places her selfreflection is mirrored to (src/memory/db/mirrors.ts), `refs` how the request
 * names a mention and a place.
 */
export function memoryItemsOf(
  mind: Mind,
  frame: FrameView,
  labels: Labels,
  nameOf: NameOf,
  live: LiveOf | null = null,
  selfreflectionIds: ReadonlySet<string> = new Set(),
  chatIdOf: ChatIdOf = () => null,
  refs: EntryRefs | null = null
): Array<MemoryItem> {
  const chatOf = (place: PlaceEntry): string | null => (place.kind === 'dm' ? null : chatIdOf(place.placeId));
  const mine = (place: PlaceEntry): boolean => selfreflectionIds.has(chatOf(place) ?? '');
  const w = wordsOf(labels, frame, nameOf, refs);
  const plain = (subtag: MemorySubtag, text: string, reads: Array<MemoryRead>): MemoryItem => ({
    subtag,
    text,
    counterpart: false,
    name: null,
    handleIds: [],
    reads,
  });
  return [
    ...peopleItems(w, mind, live),
    ...mind.interfaces.map((entry) => plain('places', interfaceText(w, entry), readsOf(entry))),
    ...mind.places.map((place) => ({
      ...plain('places', placeText(w, place, mine(place)), readsOf(place)),
      chatId: chatOf(place),
      placeName: place.name,
      ...(place.keep === true ? { keep: true } : {}),
      lower: below(place.detail).map((detail) => placeText(w, { ...place, detail }, mine(place))),
    })),
    ...mind.lore.map((claim) => plain('lore', loreText(w, claim), readsOf(claim))),
    ...mind.recent.map((episode) => plain('recent', episodeText(w, episode), readsOf(episode))),
    ...mind.found.map((excerpt) => plain('found', excerptText(w, excerpt), readsOf(excerpt))),
  ];
}

/**
 * The body of `<memory>` from the items that stayed, each subtag in its order with the count it left out at its foot
 * (`leftOut`, by subtag: the reader's cut and the budget's). '' with no item.
 */
export function renderMemory(
  items: ReadonlyArray<MemoryItem>,
  leftOut: Readonly<Record<string, number>>,
  labels: Labels
): string {
  const l = labels.memory ?? {};
  return MEMORY_SUBTAGS.map((subtag) => {
    const texts = items.filter((one) => one.subtag === subtag).map((one) => one.text);
    const cut = leftOut[subtag] ?? 0;
    if (texts.length === 0) return '';
    const foot = cut > 0 && typeof l.leftOut === 'string' ? fill(l.leftOut, { count: cut }) : '';
    return block(subtag, [...texts, foot].filter(Boolean).join('\n\n'));
  })
    .filter(Boolean)
    .join('\n');
}

/** The body of `<memory>` with every entry of `mind`, and the memory rows it carries. */
export function memoryBlockOf(
  mind: Mind,
  frame: Frame,
  labels: Labels,
  nameOf: NameOf,
  live: LiveOf | null = null
): { text: string; reads: Array<MemoryRead> } {
  const items = memoryItemsOf(mind, frame, labels, nameOf, live);
  return { text: renderMemory(items, mind.leftOut, labels), reads: items.flatMap((one) => [...one.reads]) };
}

/**
 * A `<memory>` of `people` alone, as a tool result carries it after the lines a read returned: each person at the
 * detail the reader chose under their handle (`handleOfKey` of the person id), none marked as the one she answers, with
 * the count the budget left out at the foot. '' with nobody.
 */
export function peopleMemoryOf(
  people: ReadonlyArray<PersonEntry>,
  leftOut: number,
  view: FrameView,
  labels: Labels,
  nameOf: NameOf,
  refs: EntryRefs | null = null,
  handleOfKey: ((key: string) => string) | null = null
): string {
  const w = wordsOf(labels, view, nameOf, refs);
  const handled = (person: PersonEntry, text: string): string =>
    handleOfKey === null ? text : `@${handleOfKey(person.personId)} ${text}`;
  const items: Array<MemoryItem> = people.map((person) => ({
    subtag: 'people',
    text: handled(person, personText(w, person, false, null)),
    counterpart: false,
    name: person.name,
    handleIds: nativeIds(person.platformAccounts, view.interface),
    reads: readsOf(person),
  }));
  const body = renderMemory(items, leftOut > 0 ? { people: leftOut } : {}, labels);
  return body === '' ? '' : block('memory', body);
}

/** One change of her attitude toward a person, as memory.read's section `changes` renders it. */
export type AttitudeChange = { readonly at: string; readonly applied: number; readonly reason: string };

/**
 * One change as a line: `memory.warmer` or `memory.cooler` (`{date}`, `{amount}`, the move without its sign), inside
 * `memory.changeReason` (`{change}`, `{reason}`) when it has a stated reason.
 */
function changeLine(w: Words, change: AttitudeChange): string {
  const at = Date.parse(change.at);
  const date = Number.isFinite(at) ? formatDate(at, w.frame.timezone, w.locale) : '';
  const amount = Math.round(Math.abs(change.applied) * 100) / 100;
  const line = fill((change.applied < 0 ? w.l.cooler : w.l.warmer) ?? '{date}: {amount}', { date, amount });
  const reason = change.reason.trim();
  return reason !== '' && typeof w.l.changeReason === 'string'
    ? fill(w.l.changeReason, { change: line, reason: storedText(w, reason) })
    : line;
}

/**
 * A `<memory>` of what memory.read found for one subject: every entry of `mind` as memoryItemsOf renders it, none marked
 * as the one she answers, each with the read's own origin (`memory.origin.read`) in its heading. With `changes` the
 * people of `mind` render as their heading alone followed by those changes, newest first. '' with nothing.
 */
export function subjectMemoryOf(
  mind: Mind,
  view: FrameView,
  labels: Labels,
  nameOf: NameOf,
  changes: ReadonlyArray<AttitudeChange> | null = null
): string {
  const l = labels.memory ?? {};
  const read = l.origin?.read ?? '';
  const origin = Object.fromEntries(EVIDENCE_ORDER.map((evidence) => [evidence, read]));
  // MemoryLabels is a group of strings with one nested group, which no object literal satisfies as written.
  const told: Labels = { ...labels, memory: { ...l, origin } as MemoryLabels };
  const frame: FrameView = { ...view, counterpart: null };
  const people = changes === null ? mind.people : mind.people.map((person) => ({ ...person, detail: 'name' as const }));
  const items = memoryItemsOf({ ...mind, people }, frame, told, nameOf);
  const w = { ...wordsOf(labels, frame, nameOf, null), origin };
  const lines = (changes ?? []).map((change) => changeLine(w, change));
  const withChanges = items.map((item) =>
    item.subtag === 'people' && lines.length > 0 ? { ...item, text: [item.text, ...lines].join('\n') } : item
  );
  const body = renderMemory(withChanges, {}, labels);
  return body === '' ? '' : block('memory', body);
}
