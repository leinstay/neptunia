// The body of `<memory>`: what the graph reader (src/memory/db/mind-read.ts#mindOf) brought to her mind, one entry per
// thing in one subtag only (docs/prompt-contract.md). `<people>` opens with the person she answers, marked so and always
// present, a stranger included; `<places>`, `<lore>`, `<recent>` and `<found>` follow. Every entry names its origin
// (`labels.memory.origin.*`), renders at the detail the reader chose and quotes stored text as an escaped value. The
// request builder (src/turn/request/reader.ts) fits the items to the budget and renders what stayed. Pure.

import { fill, formatDate } from '../../format.ts';
import { nativeOfAny } from '../../memory/db/ids.ts';
import { factStateWords } from '../../memory/retrieval-input.ts';
import type {
  ClaimEntry,
  EpisodeEntry,
  ExcerptEntry,
  InterfaceEntry,
  Mind,
  PersonEntry,
  PlaceEntry,
} from '../../memory/db/mind-read.ts';
import type { Frame } from './frame.ts';
import { block, escapeStored, pathText } from './text.ts';
import type { LabelGroup, Labels, MemoryRead, NameOf } from './types.ts';

/** The subtags of `<memory>`, in their order. */
export const MEMORY_SUBTAGS = ['people', 'places', 'lore', 'recent', 'found'] as const;
export type MemorySubtag = (typeof MEMORY_SUBTAGS)[number];

/**
 * One entry as the budget sees it: its subtag, its text, whether it is the person she answers, the platform ids a
 * mention handle is given for once it is shown, and the memory rows it carries for the per-turn record.
 */
export type MemoryItem = {
  readonly subtag: MemorySubtag;
  readonly text: string;
  readonly counterpart: boolean;
  /** The name a person goes by, null for anything else. */
  readonly name: string | null;
  readonly handleIds: ReadonlyArray<string>;
  /** The place a channel handle is given for once it is shown; null for anything else and a DM. */
  readonly placeId?: string | null;
  readonly reads: ReadonlyArray<MemoryRead>;
};

/** What is live about a person now (their status, their voice seat), one line; null when nothing is. */
export type LiveOf = (accounts: ReadonlyArray<string>) => string | null;

/** What of the frame an entry's words read: the interface of its handles, the clock of its dates, the person answered. */
export type FrameView = Pick<Frame, 'interface' | 'timezone' | 'counterpart'>;

type Words = { l: LabelGroup; origin: LabelGroup; frame: FrameView; nameOf: NameOf; locale: string | undefined };

/** A labelled line of a stored value, '' when the value or the label is missing. */
function valueLine(template: string | undefined, value: string | null | undefined): string {
  if (typeof template !== 'string' || typeof value !== 'string' || value.trim() === '') return '';
  return fill(template, { value: escapeStored(value.trim()) });
}

/** The heading of an entry: its name and why it is here. */
function heading(w: Words, name: string, origin: string, candidate: boolean): string {
  const why = [origin, candidate ? (w.l.candidate ?? '') : ''].filter(Boolean).join('; ');
  return fill(w.l.entry ?? '{name} ({origin})', { name: escapeStored(name), origin: why });
}

/** The platform id of an account row on the frame's interface, else of its first account. */
function nativeIds(accounts: ReadonlyArray<string>, iface: string): Array<string> {
  const native = (account: string): string => account.slice(account.indexOf(':') + 1);
  const here = accounts.filter((account) => account.startsWith(`${iface}:`));
  return (here.length > 0 ? here : accounts.slice(0, 1)).map(native).filter(Boolean);
}

const readsOf = (entry: { sources: ReadonlyArray<{ table: string; id: string }> }): Array<MemoryRead> =>
  entry.sources.map((source) => ({ kind: source.table, id: source.id, block: 'memory' }));

/**
 * The accounts of a person with more than one, each `memory.account` (`{iface}`, `{id}`) or `memory.accountNamed` with
 * its display name, joined in `memory.accounts`; '' for one account or none, or with a label missing.
 */
function accountsLine(w: Words, person: PersonEntry): string {
  const { accounts: template, account, accountNamed } = w.l;
  if (person.profileAccounts.length < 2 || typeof template !== 'string' || typeof account !== 'string') return '';
  const each = person.profileAccounts.map((one) => {
    const values = { iface: escapeStored(one.iface), id: escapeStored(one.platformId) };
    return one.displayName && typeof accountNamed === 'string'
      ? fill(accountNamed, { ...values, name: escapeStored(one.displayName) })
      : fill(account, values);
  });
  return fill(template, { value: each.join('; ') });
}

function personText(w: Words, person: PersonEntry, counterpart: boolean, live: string | null): string {
  const origin = counterpart ? (w.l.counterpart ?? '') : (w.origin[person.evidence] ?? '');
  const lines = [heading(w, person.name ?? person.accounts[0] ?? person.personId, origin, person.candidate)];
  const detail = counterpart && person.detail === 'name' ? 'compact' : person.detail;
  lines.push(accountsLine(w, person));
  if (detail !== 'name') lines.push(valueLine(w.l.relation, person.relation));
  if (detail === 'whole') {
    lines.push(valueLine(w.l.realName, person.realName));
    lines.push(valueLine(w.l.character, person.character));
    lines.push(valueLine(w.l.style, person.style));
    for (const claim of person.claims) lines.push(fill(w.l.claim ?? '- {text}', { text: escapeStored(claim.text) }));
  }
  if (live) lines.push(valueLine(w.l.live, live));
  return lines.filter(Boolean).join('\n');
}

function placeText(w: Words, place: PlaceEntry, selfreflection: boolean): string {
  const lines = [heading(w, pathText(place.path, w.l.pathJoin), w.origin[place.evidence] ?? '', place.candidate)];
  // A place her selfreflection is mirrored to is marked at every detail, so she knows it as hers wherever it shows.
  if (selfreflection) lines.push(w.l.selfreflection ?? '');
  if (place.detail !== 'name') {
    for (const field of ['purpose', 'tone', 'topics'] as const) {
      const value = place[field];
      if (value) lines.push(escapeStored(value));
    }
    const date = place.ownLastAt ? formatDate(Date.parse(place.ownLastAt), w.frame.timezone, w.locale) : '';
    if (place.ownLines > 0 && date) lines.push(fill(w.l.ownLines ?? '', { count: place.ownLines, date }));
  }
  return lines.filter(Boolean).join('\n');
}

const interfaceText = (w: Words, entry: InterfaceEntry): string =>
  heading(w, entry.name ?? entry.iface, w.origin[entry.evidence] ?? '', entry.candidate);

const loreText = (w: Words, claim: ClaimEntry): string =>
  fill(w.l.lore ?? '{subject}: {text}', {
    subject: escapeStored(w.nameOf(claim.subjectId) ?? claim.subjectId),
    text: escapeStored(claim.text),
  });

const episodeText = (w: Words, episode: EpisodeEntry): string =>
  fill(w.l.episode ?? '{date}: {what}', { date: episode.date ?? '', what: escapeStored(episode.what) });

function excerptText(w: Words, excerpt: ExcerptEntry): string {
  const at = excerpt.at ? Date.parse(excerpt.at) : NaN;
  const place = excerpt.placeId ? (w.nameOf(excerpt.placeId) ?? excerpt.placeId) : '';
  return fill(w.l.excerpt ?? '{date}, {path}: "{text}"', {
    date: Number.isFinite(at) ? formatDate(at, w.frame.timezone, w.locale) : '',
    path: escapeStored(place),
    text: escapeStored(excerpt.text),
  });
}

/** The chat id of a stored place, which its channel handle stands for; null for a one-to-one chat. */
export function channelIdOf(placeId: string, kind: string | null): string | null {
  if (kind === 'dm') return null;
  return nativeOfAny(placeId) ?? placeId;
}

/** Whether `person` is the one the frame answers: the same person, or one of their accounts. */
function answers(frame: FrameView, person: PersonEntry): boolean {
  const them = frame.counterpart;
  return them !== null && (person.personId === them.personId || person.accounts.includes(them.accountId));
}

/** `<people>`'s items: the person she answers first, from the reader or as a stranger, then everyone else once. */
function peopleItems(w: Words, mind: Mind, live: LiveOf | null): Array<MemoryItem> {
  const item = (person: PersonEntry, counterpart: boolean): MemoryItem => ({
    subtag: 'people',
    text: personText(w, person, counterpart, live ? live(person.accounts) : null),
    counterpart,
    name: person.name,
    handleIds: nativeIds(person.accounts, w.frame.interface),
    reads: readsOf(person),
  });
  const seen = new Set<string>();
  const people = mind.people.filter((person) => !seen.has(person.personId) && Boolean(seen.add(person.personId)));
  const found = people.find((person) => answers(w.frame, person)) ?? null;
  const them = w.frame.counterpart;
  const first: Array<MemoryItem> = [];
  if (found) first.push(item(found, true));
  else if (them !== null) {
    const name = them.name ?? them.accountId;
    const now = live ? live([them.accountId]) : null;
    first.push({
      subtag: 'people',
      text: [heading(w, name, w.l.counterpart ?? '', false), now ? valueLine(w.l.live, now) : '']
        .filter(Boolean)
        .join('\n'),
      counterpart: true,
      name: them.name,
      handleIds: nativeIds([them.accountId], w.frame.interface),
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

/**
 * Every entry of `mind` as an item, in the order of the subtags and, inside one, the reader's rank. `selfreflectionIds`
 * are the chat ids of the places her selfreflection is mirrored to (src/memory/db/mirrors.ts).
 */
export function memoryItemsOf(
  mind: Mind,
  frame: Frame,
  labels: Labels,
  nameOf: NameOf,
  live: LiveOf | null = null,
  selfreflectionIds: ReadonlySet<string> = new Set()
): Array<MemoryItem> {
  const l = labels.memory ?? {};
  const mine = (place: PlaceEntry): boolean => selfreflectionIds.has(channelIdOf(place.placeId, place.kind) ?? '');
  const w: Words = { l, origin: l.origin ?? {}, frame, nameOf, locale: labels.locale };
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
      placeId: place.kind === 'dm' ? null : place.placeId,
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
 * detail the reader chose, none marked as the one she answers, with the count the budget left out at the foot. '' with
 * nobody.
 */
export function peopleMemoryOf(
  people: ReadonlyArray<PersonEntry>,
  leftOut: number,
  view: FrameView,
  labels: Labels,
  nameOf: NameOf
): string {
  const l = labels.memory ?? {};
  const w: Words = { l, origin: l.origin ?? {}, frame: view, nameOf, locale: labels.locale };
  const items: Array<MemoryItem> = people.map((person) => ({
    subtag: 'people',
    text: personText(w, person, false, null),
    counterpart: false,
    name: person.name,
    handleIds: nativeIds(person.accounts, view.interface),
    reads: readsOf(person),
  }));
  const body = renderMemory(items, leftOut > 0 ? { people: leftOut } : {}, labels);
  return body === '' ? '' : block('memory', body);
}
