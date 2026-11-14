// The user message of a request built on the turn frame (docs/prompt-contract.md, "Blocks per kind"): every kind carries
// the tags of `frame.blocks` in that list's order. The stable segment holds `<self>`, the surroundings segment
// `<surroundings>`, each with its own cache marker (src/llm/openrouter.ts#withCacheMarker). The tail holds `<memory>`
// from the graph reader, `<meanwhile>` from her lines elsewhere, a selfreflection request's `<virtual_world>`, `<chat>`,
// `<recall>` from her lookups, `<found>` with what the reader and the prefetch found, `<inner>`, `<spatial_awareness>`
// with the clock and her time away, and `<task>`. The budget fits them in this priority: the fixed part, the person she answers, the memory shares, the
// recall, the chat (cut to a step of `context.chatSteps`), the background, her own state, the world, her past entries.
// Handles are given before the blocks are rendered (src/behavior/handles.ts#handleBook): a person's from the meta-person,
// the chat's as it was rendered, then the people of `<memory>` and the authors of `<meanwhile>`, and a person a stored
// text mentions when it is met; a place's from its chat id. Every block names a line's author and a place by them. A
// selfreflection request gives none. buildRequest (src/behavior/prompt.ts) calls it. Pure.

import { CHANNEL_HANDLE_PREFIX } from '../../behavior/handles.ts';
import { fill, renderTranscript } from '../../format.ts';
import { fitSections } from '../../llm/budget.ts';
import { allowances, mindSettingsOf } from '../../memory/db/mind-read.ts';
import { normalName, phrasesOf } from '../../memory/db/names.ts';
import type { Mind } from '../../memory/db/mind-read.ts';
import { SEARCH_HANDLE_GAP } from '../calls.ts';
import type { Lookup, SearchRef } from '../calls.ts';
import type { BlockName, Frame } from './frame.ts';
import { innerBlockOf } from './inner-block.ts';
import type { InnerParts } from './inner-block.ts';
import { meanwhileSettingsOf, meanwhileText, meanwhileWindows, windowText } from './meanwhile.ts';
import type { MeanwhileReads, MeanwhileWindow } from './meanwhile.ts';
import {
  MEMORY_SUBTAGS,
  factItemsOf,
  memoryItemsOf,
  printOrder,
  renderMemory,
  strangerItemsOf,
  subtagBody,
} from './memory-block.ts';
import type { ChatIdOf, ChatStranger, LiveOf, MemoryItem, MemorySubtag, StoredFact } from './memory-block.ts';
import { numberedLookups, recallBlockOf, shownLookups } from './recall-block.ts';
import { refResolverOf } from './refs.ts';
import type { LineOf } from './refs.ts';
import type { Senses } from './senses.ts';
import type { PlaceFields } from './surroundings.ts';
import type { SelfreflectionFramed } from './selfreflection.ts';
import { blockRecords, userParts } from './tail.ts';
import type { BlockRecord, ListedBlock, UserPart } from './tail.ts';
import { handleBook } from '../../behavior/handles.ts';
import type { InterfaceNames } from '../../protocol/serve.ts';
import type { HandleBook } from '../../behavior/handles.ts';
import type { EntryRefs } from './memory-block.ts';
import type { MeanwhileRefs } from './meanwhile.ts';
import {
  block,
  escapeStored,
  keepsEmoji,
  placeIdsIn,
  placeOwnText,
  placeRefText,
  shownName,
  withPlaces,
} from './text.ts';
import type {
  Fit,
  HandleTarget,
  Labels,
  MemoryRead,
  NameOf,
  PlacePathView,
  RequestConfig,
  RequestRefs,
  Section,
  TranscriptItem,
} from './types.ts';

/** What the interface and the memory say of the turn's place, for `<surroundings>`. */
export type SurroundingsInput = {
  readonly interfaceText: string;
  /** What the interface declared of itself (its name, its nouns, its word for a direct chat), for the places in words. */
  readonly names?: InterfaceNames;
  readonly root: PlaceFields | null;
  readonly place: PlaceFields | null;
  /** The `current_version` ids of the descriptions `root` and `place` render. */
  readonly versions?: ReadonlyArray<string>;
};

/** What the frame's request is built from, every text already rendered by the builders before it. */
export type ReaderInput = {
  frame: Frame;
  config: RequestConfig;
  labels: Labels;
  timezone: string;
  cost: (text: string) => number;
  limit: number;
  system: string;
  task: string;
  spatialText: string;
  /** `<now>`'s lines without the clock: her recent time away, folded into `<spatial_awareness>`. */
  awayText: string;
  senses: Senses;
  toolsText: string;
  selfFacts: Array<string>;
  /** `<lessons>` of `<self>`: the header and the lines, best first, cut to their budget (src/turn/request/lessons.ts). */
  lessons?: { header: string; lines: Array<string> };
  /** `<attitudes>` of `<self>`: the header and the lines as one text, '' for none (src/turn/request/attitudes.ts). */
  attitudes?: string;
  /**
   * The body of `<surroundings>`, rendered and held per cache bucket by the caller (src/turn/request/framed.ts), given the
   * handle of the turn's place (without `#`) and, in a direct chat, its partner's handle (with `@`), both as the request's
   * handle books cut them; null when the request gives none.
   */
  surroundingsText: (handle: string | null, partner: string | null) => string;
  mind: Mind;
  /** The chat ids of the places her selfreflection is mirrored to, marked in `<memory>`. */
  selfreflectionIds?: ReadonlySet<string>;
  /** The stored facts the prefetch found, shown in `<found>` after the mind's excerpts. */
  facts?: ReadonlyArray<StoredFact>;
  lookups: ReadonlyArray<Lookup>;
  meanwhileReads: MeanwhileReads | null;
  chatItems: Array<TranscriptItem>;
  tempoText: string;
  inner: InnerParts;
  /** A selfreflection request's world, past entries and own parts of `<inner>`; null on any other kind. */
  selfreflection?: SelfreflectionFramed | null;
  errandResult: string;
  nameOf: NameOf;
  lineOf: LineOf | null;
  /** Whether the line of a lookup's source is gone or unreadable, read by the source's row. */
  isSourceRetired: SourceRetired | null;
  live: LiveOf | null;
  /** The handles the chat was rendered with, by what each is cut from: they keep their form whatever joins them. */
  chatHandles: Map<string, string> | null;
  /** The same handles by the platform id of each member of the chat in view. */
  chatHandleById?: ReadonlyMap<string, string> | null;
  /** The members of the chat by platform id with the name a line gave them, for where her `@handle` may mention them. */
  chatMembers?: ReadonlyArray<{ readonly native: string; readonly name: string | null; readonly reactor?: boolean }>;
  /** What the handle of a member of the turn's interface is cut from, by platform id (head.ts). */
  keyOfMember?: ((native: string) => string) | null;
  /** What the handle of the member a stored `<@id>` names is cut from; null when no account row holds the id. */
  memberKeyOf?: ((native: string) => string | null) | null;
  /** A stored place by its path of names and a direct chat's partner, null with no row. */
  placePathOf?: ((placeId: string) => PlacePathView | null) | null;
  /** The chat id of the turn's place: it gets a channel handle with the places memory and meanwhile show. */
  currentChannelId: string | null;
  /** The chat id of a stored place memory and meanwhile show, from its row; null for a DM and without a reader. */
  chatIdOf?: ChatIdOf | null;
  /** The text of the line she answers, whose named places `<places>` keeps first; null when she answers none. */
  answeredText?: string | null;
};

/** The frame's request: its parts, the archive's record, the fit, the chat lines kept and the handles given. */
export type ReaderResult = {
  parts: Array<UserPart>;
  blocks: Array<BlockRecord>;
  fit: Fit;
  keptChat: Array<TranscriptItem>;
  /** Handle -> the platform id on the turn's interface, else what the handle is cut from; null without handles. */
  handles: Map<string, string> | null;
  /** Chat id -> channel handle: the current place and every place the request names. */
  channelHandleById: Map<string, string>;
  /** The request's people and places for the rest of the turn; null on a request that gives no handles. */
  refs: RequestRefs | null;
  memberNames: Map<string, Array<string>>;
  peopleShown: Array<{ id: string; names: Array<string> }>;
  memoryReads: Array<MemoryRead>;
  /** The lines the numbers of `<recall>` name, for the turn's registry (src/turn/calls.ts#searchHandles). */
  recallRefs: Array<SearchRef>;
};

/** The window of `<chat>` by line identity (`src:<iface>:<message id>`), each to its `#n`. */
function chatWindow(frame: Frame, items: ReadonlyArray<TranscriptItem>): Map<string, number> {
  const window = new Map<string, number>();
  for (const item of items)
    if (typeof item.id === 'string' && typeof item.index === 'number')
      window.set(`src:${frame.interface}:${item.id}`, item.index);
  return window;
}

/** Whether the line of a source is gone or unreadable, by the source's id; true for an id no row holds. */
export type SourceRetired = (sourceId: string) => boolean;

/** The ids of a lookup's sources whose line is gone or unreadable. */
function retiredOf(lookups: ReadonlyArray<Lookup>, isSourceRetired: SourceRetired | null): Set<string> {
  if (isSourceRetired === null) return new Set();
  return new Set(lookups.flatMap((lookup) => lookup.sourceIds).filter((id) => isSourceRetired(id)));
}

/** What the frame's request offers the budget before the fit. */
type Offered = {
  surroundings: string;
  spatial: string;
  memory: Array<MemoryItem>;
  /** The memory items `memoryCut` left out, by subtag. */
  memoryLeftOut: Record<string, number>;
  recall: string;
  recallRefs: Array<SearchRef>;
  chat: Array<TranscriptItem>;
  windows: Array<MeanwhileWindow>;
  windowTexts: Array<string>;
  inner: Array<{ key: keyof InnerParts; text: string }>;
  /** `<inner>`'s parts with the places of `<my_day>` and `<intentions>` named as the rest of the request names them. */
  innerParts: InnerParts;
  resolveRef: (text: string) => string;
  names: Names;
};

/** How the request names people and places: its handle books and the refs the blocks render with. */
type Names = {
  people: HandleBook;
  places: HandleBook;
  entryRefs: EntryRefs;
  meanwhileRefs: MeanwhileRefs;
  /** A place id by its handle and path, null for a place the memory holds no row of. */
  placeRef: (placeId: string) => string | null;
  /** A stored place as a line of `<my_day>` or `<intentions>` names it: its handle, else its name, else the unnamed word. */
  placeNamed: (placeId: string) => string;
  /** The windows of `<meanwhile>`, every author keyed. */
  windows: Array<MeanwhileWindow>;
};

/** What of a selfreflection request the budget never cuts: its own parts of `<inner>` and the first line of its entries. */
const selfreflectionFixed = (given: SelfreflectionFramed | null): Array<string> =>
  given === null ? [] : [...given.parts.map((part) => part.text), given.intro];

/**
 * Whether a memory item goes first in its subtag's budget: the graph reader kept it whatever its room, or it is a place
 * whose stored name stands whole among the words of the line she answers (`names`, its phrases of up to three words as
 * the reader indexes them, names.ts#phrasesOf).
 */
function keptFirst(item: MemoryItem, names: ReadonlySet<string>): boolean {
  if (item.keep === true) return true;
  const name = item.subtag === 'places' && item.placeName ? normalName(item.placeName) : '';
  return name !== '' && names.has(name);
}

/** The items of a memory subtag in the order the budget takes them: the ones kept first, each group in the reader's rank. */
function budgetOrder(given: ReaderInput, items: ReadonlyArray<MemoryItem>): Array<MemoryItem> {
  const names = new Set(phrasesOf(given.answeredText ?? ''));
  const first = items.filter((one) => keptFirst(one, names));
  return [...first, ...items.filter((one) => !first.includes(one))];
}

/**
 * The memory items the request keeps, cut by the graph reader's own rule (src/memory/db/mind-read.ts#cut) at the
 * request's price of a text: one total of `context.memory.budgetTokens`, each subtag its share with what the stable
 * shares leave unused lent (`allowances`, `found` lends nothing), the person she answers always and counted in `<people>`. Each item takes the first
 * of its details that fits what its subtag has left; one that fits at none is left out and counted, unless the reader
 * kept it whatever the budget, which stays at its lowest detail. The kept items come back in the reader's rank.
 */
function memoryCut(
  given: ReaderInput,
  items: ReadonlyArray<MemoryItem>
): { items: Array<MemoryItem>; leftOut: Record<string, number> } {
  const settings = mindSettingsOf(given.config);
  const ordered = (subtag: string): Array<MemoryItem> => [
    ...items.filter((one) => one.subtag === subtag && one.counterpart),
    ...budgetOrder(
      given,
      items.filter((one) => one.subtag === subtag && !one.counterpart)
    ),
  ];
  const demand = Object.fromEntries(
    MEMORY_SUBTAGS.map((subtag) => [subtag, ordered(subtag).reduce((sum, one) => sum + given.cost(one.text), 0)])
  ) as Record<MemorySubtag, number>;
  const allowance = allowances(settings, demand);
  const chosen = new Map<MemoryItem, string>();
  const leftOut: Record<string, number> = {};
  for (const subtag of MEMORY_SUBTAGS) {
    let left = allowance[subtag];
    for (const one of ordered(subtag)) {
      const texts = [one.text, ...(one.lower ?? [])];
      const fits = one.counterpart ? one.text : texts.find((text) => given.cost(text) <= left);
      if (fits === undefined && one.keep !== true) {
        leftOut[subtag] = (leftOut[subtag] ?? 0) + 1;
        continue;
      }
      const text = fits ?? texts.at(-1) ?? one.text;
      left -= given.cost(text);
      chosen.set(one, text);
    }
  }
  return {
    items: items.flatMap((one) => {
      const text = chosen.get(one);
      return text === undefined ? [] : [text === one.text ? one : { ...one, text }];
    }),
    leftOut,
  };
}

/** The budget's sections of the frame's request, in priority order. */
function sectionsOf(given: ReaderInput, offered: Offered): Array<Section> {
  const fixed = [
    given.system,
    given.task,
    offered.spatial,
    given.senses.stable,
    given.senses.turn,
    given.toolsText,
    offered.surroundings,
    given.tempoText,
    given.errandResult,
    ...selfreflectionFixed(given.selfreflection ?? null),
  ].filter(Boolean);
  const counterpart = offered.memory.filter((one) => one.counterpart).map((one) => one.text);
  const { caps } = given.config.context;
  return [
    { name: 'fixed', required: true, items: fixed },
    { name: 'counterpart', required: true, items: counterpart },
    { name: 'self', cap: caps.aboutChat, items: given.selfFacts },
    { name: 'lessons', items: given.lessons?.lines ?? [] },
    { name: 'attitudes', items: given.attitudes ? [given.attitudes] : [] },
    // The memory items are cut to the memory's budget already (memoryCut); here only the request's limit cuts them.
    ...MEMORY_SUBTAGS.map((subtag) => ({
      name: subtag,
      keep: 'first' as const,
      items: budgetOrder(
        given,
        offered.memory.filter((one) => one.subtag === subtag && !one.counterpart)
      ).map((one) => one.text),
    })),
    { name: 'recall', items: [offered.recall].filter(Boolean) },
    { name: 'chat', keep: 'newest', steps: chatStepsOf(given.config), items: offered.chat.map((item) => item.text) },
    { name: 'meanwhile', keep: 'newest', items: offered.windowTexts },
    { name: 'inner', keep: 'first', items: offered.inner.map((one) => one.text) },
    { name: 'virtual_world', items: [given.selfreflection?.world ?? ''].filter(Boolean) },
    // The entries stand newest first, so the contiguous run from the start the budget keeps is the newest.
    { name: 'selfreflection', keep: 'oldest', items: given.selfreflection?.entries ?? [] },
  ];
}

/** `context.chatSteps`, read now: the line counts `<chat>` may be cut to, none when the setting is not a list. */
const chatStepsOf = (config: RequestConfig): ReadonlyArray<number> => {
  const steps: unknown = config.context.chatSteps;
  return Array.isArray(steps) ? steps.filter((step): step is number => typeof step === 'number') : [];
};

/** The items of a section the budget kept, by identity of their text and in their own order. */
function keptOf<T>(all: ReadonlyArray<T>, kept: ReadonlyArray<string> | undefined, text: (one: T) => string): Array<T> {
  const left = [...(kept ?? [])];
  return all.filter((one) => {
    const at = left.indexOf(text(one));
    if (at < 0) return false;
    left.splice(at, 1);
    return true;
  });
}

/** `<inner>`'s parts as single items, so the budget can keep the first of them. */
function innerItems(parts: InnerParts): Array<{ key: keyof InnerParts; text: string }> {
  const out: Array<{ key: keyof InnerParts; text: string }> = [];
  const myDay = parts.myDay.filter(Boolean).join('\n');
  if (myDay) out.push({ key: 'myDay', text: myDay });
  for (const key of ['intentions', 'errands', 'feedback', 'work', 'board'] as const) {
    const text = parts[key];
    if (typeof text === 'string' && text.trim()) out.push({ key, text });
  }
  if (parts.previousThink?.text) out.push({ key: 'previousThink', text: parts.previousThink.text });
  return out;
}

/** Whom and which message she answers, for `<spatial_awareness>`: the line's `#n` when the chat shows it. */
function answersLine(given: ReaderInput, names: Names): string {
  const { frame, labels } = given;
  const them = frame.counterpart;
  const answered = frame.answers;
  if (them === null || answered === null) return '';
  const key = names.entryRefs.counterpartKey ?? them.personId ?? them.accountId;
  const name = them.name ? escapeStored(them.name) : `@${names.people.handleOf(key)}`;
  const n = given.chatItems.find((item) => item.id === answered.messageId)?.index;
  const l = labels.spatial ?? {};
  return typeof n === 'number' ? fill(l.answers ?? '', { name, n }) : fill(l.answersOutside ?? '', { name });
}

/** The request's reader of a stored place's chat id; without one no stored place gets a channel handle. */
const chatIdOfInput = (given: ReaderInput): ChatIdOf => given.chatIdOf ?? (() => null);

/** The place ids of the lookups of `<recall>` that name a place, by the argument the ring keeps. */
const lookupPlaces = (lookups: ReadonlyArray<Lookup>): Array<string> =>
  lookups.flatMap((lookup) => {
    const place = lookup.args.place ?? lookup.args.channel;
    return typeof place === 'string' && place !== '' ? [place] : [];
  });

/**
 * The windows with every author's key: the one the reads give, else the key of the platform id on the turn's interface
 * (head.ts), so a line of a reader that gives none still names its author by a handle.
 */
function keyedWindows(given: ReaderInput, windows: ReadonlyArray<MeanwhileWindow>): Array<MeanwhileWindow> {
  const keyOf = given.keyOfMember ?? null;
  return windows.map((window) => ({
    ...window,
    lines: window.lines.map((line) =>
      line.self || line.authorKey || !line.authorId || keyOf === null
        ? line
        : { ...line, authorKey: keyOf(line.authorId) }
    ),
  }));
}

/** The texts of `<inner>` that hold place tokens: the lines of `<my_day>` and the body of `<intentions>`. */
const innerTexts = (inner: InnerParts): Array<string | null> => [...inner.myDay, inner.intentions];

/** `<inner>`'s parts with each place token of `<my_day>` and `<intentions>` named by `named`. */
function innerNamed(inner: InnerParts, named: (placeId: string) => string): InnerParts {
  return {
    ...inner,
    myDay: inner.myDay.map((line) => withPlaces(line, named)),
    intentions: inner.intentions === null ? null : withPlaces(inner.intentions, named),
  };
}

/**
 * The handles and names of the request, given before anything is rendered: the people book over the chat's handles,
 * then every person of the mind and every author of the windows; the places book over the current place, the places of
 * the mind, the windows and the places her lookups searched.
 */
function namesOf(given: ReaderInput, rawWindows: ReadonlyArray<MeanwhileWindow>): Names {
  const { frame, labels, mind } = given;
  const chatIdOf = chatIdOfInput(given);
  const windows = keyedWindows(given, rawWindows);
  const them = frame.counterpart;
  // The person she answers by the key their lines in the chat carry, so their entry and their lines share one handle.
  const counterpartKey =
    them === null
      ? null
      : given.keyOfMember && them.nativeId
        ? given.keyOfMember(them.nativeId)
        : (them.personId ?? them.accountId);
  const people = handleBook(given.chatHandles ?? new Map(), {
    profiled: [...(counterpartKey === null ? [] : [counterpartKey]), ...mind.people.map((person) => person.personId)],
    inView: windows.flatMap((window) => window.lines.flatMap((line) => (line.authorKey ? [line.authorKey] : []))),
  });
  const places = handleBook(
    new Map(),
    {
      profiled: [
        given.currentChannelId,
        ...mind.places.map((place) => chatIdOf(place.placeId)),
        ...windows.map((window) => chatIdOf(window.placeId)),
        ...lookupPlaces(given.lookups).map((id) => chatIdOf(id)),
        ...placeIdsIn(innerTexts(given.inner)).map((id) => chatIdOf(id)),
      ].filter((id): id is string => typeof id === 'string' && id !== ''),
    },
    CHANNEL_HANDLE_PREFIX
  );
  const keepEmoji = keepsEmoji(given.config);
  const unknown = labels.authors?.unknown ?? '';
  const partner = (key: string | null | undefined): string => (key ? `@${people.handleOf(key)}` : unknown);
  const mention = (native: string): string => {
    const shown = given.chatHandleById?.get(native);
    if (shown !== undefined) return `@${shown}`;
    const key = given.memberKeyOf?.(native) ?? null;
    return key === null ? unknown : `@${people.handleOf(key)}`;
  };
  const placeRef = (named: string): string | null => {
    // A lookup keeps the chat id of the place it was made in: the turn's own place is named by its stored id.
    const placeId = named === given.currentChannelId && frame.place !== null ? frame.place.id : named;
    const view = given.placePathOf?.(placeId) ?? null;
    if (view === null) return null;
    const chatId = chatIdOf(placeId);
    return placeRefText(labels, chatId === null ? null : places.handleOf(chatId), {
      iface: view.iface,
      chain: view.chain,
      ...(view.names === undefined ? {} : { names: view.names }),
      partner: view.dm ? partner(view.partnerKey) : null,
      keepEmoji,
    });
  };
  const placeNamed = (placeId: string): string => {
    const view = given.placePathOf?.(placeId) ?? null;
    if (view === null) return escapeStored(labels.spatial?.unnamed ?? '');
    const chatId = handled(given) ? chatIdOf(placeId) : null;
    if (chatId !== null && chatId !== '') return `#${places.handleOf(chatId)}`;
    const name = view.chain.at(0)?.name;
    if (typeof name === 'string') return escapeStored(shownName(name, keepEmoji));
    return placeOwnText(labels, {
      iface: view.iface,
      chain: view.chain,
      ...(view.names === undefined ? {} : { names: view.names }),
      partner: view.dm ? partner(view.partnerKey) : null,
      keepEmoji,
    });
  };
  return {
    people,
    places,
    entryRefs: {
      mention,
      place: (placeId, fallback) =>
        placeRef(placeId) ??
        (fallback
          ? placeRefText(labels, null, { ...fallback, keepEmoji })
          : escapeStored(labels.spatial?.unnamed ?? '')),
      partnerOf: (placeId) => partner(given.placePathOf?.(placeId)?.partnerKey),
      counterpartKey,
    },
    meanwhileRefs: { handleOf: (key) => people.handleOf(key), mention },
    placeRef,
    placeNamed,
    windows,
  };
}

/** The subtags `<memory>` prints; `<found>` is a root tag of its own, printed after `<chat>`. */
const IN_MEMORY: ReadonlyArray<MemorySubtag> = ['people', 'places', 'lore', 'recent'];

/** Whether the request names people by handle: every one but a selfreflection's, which names them by name alone. */
const handled = (given: ReaderInput): boolean => given.selfreflection === null || given.selfreflection === undefined;

/** The handle of the partner of the turn's own place when it is a one-to-one chat the request holds a view of; else null. */
function directPartnerOf(given: ReaderInput, names: Names): string | null {
  const place = given.frame.place;
  const view = place === null || !handled(given) ? null : (given.placePathOf?.(place.id) ?? null);
  return view?.dm ? names.entryRefs.partnerOf(place?.id ?? '') : null;
}

/** The channel handle a window is headed with, null for a place with no chat id and in a request that gives no handles. */
function windowHandle(given: ReaderInput, names: Names, window: MeanwhileWindow): string | null {
  const chatId = !handled(given) ? null : chatIdOfInput(given)(window.placeId);
  return chatId === null ? null : names.places.handleOf(chatId);
}

/**
 * Where each handle of the request may mention its person: the name and accounts of an entry of `<people>`, the
 * members of the chat on the turn's interface and the authors of the windows on theirs, joined by handle.
 */
function targetsOf(given: ReaderInput, offered: Offered, people: ReadonlyArray<MemoryItem>): Map<string, HandleTarget> {
  const book = offered.names.people;
  const byKey = new Map<string, { name: string | null; accounts: Array<{ iface: string; native: string }> }>();
  const add = (key: string, name: string | null, accounts: ReadonlyArray<{ iface: string; native: string }>): void => {
    const known = byKey.get(key) ?? { name: null, accounts: [] };
    known.name ??= name;
    for (const account of accounts)
      if (!known.accounts.some((one) => one.iface === account.iface && one.native === account.native))
        known.accounts.push(account);
    byKey.set(key, known);
  };
  for (const one of people) if (one.handleKey) add(one.handleKey, one.name, one.accounts ?? []);
  const keyOf = given.keyOfMember ?? ((native: string) => native);
  for (const member of given.chatMembers ?? [])
    add(keyOf(member.native), member.name, [{ iface: given.frame.interface, native: member.native }]);
  for (const line of offered.windows.flatMap((window) => window.lines))
    if (line.authorKey && line.authorId)
      add(line.authorKey, line.authorName ?? null, [
        { iface: line.authorIface ?? given.frame.interface, native: line.authorId },
      ]);
  return new Map([...byKey].map(([key, target]) => [book.handleOf(key), target]));
}

/**
 * The request's handle -> id map over the chat's handles and the others that stand in its text (`shown`): a handle to
 * the platform id of its person's account on the turn's interface, the one a member argument and the chat's lines name, else to what the
 * handle is cut from. A person the budget left out has no handle a tool would resolve.
 */
function handleIdsOf(
  given: ReaderInput,
  offered: Offered,
  targets: ReadonlyMap<string, HandleTarget>,
  shown: (handle: string) => boolean
): Map<string, string> {
  const ids = new Map<string, string>();
  // The chat's members keep the handles the chat was rendered with.
  for (const [native, handle] of given.chatHandleById ?? []) if (!ids.has(handle)) ids.set(handle, native);
  const { people } = offered.names;
  for (const [key, handle] of people.entries()) {
    if (ids.has(handle) || !shown(handle)) continue;
    const here = targets.get(handle)?.accounts.find((account) => account.iface === given.frame.interface);
    ids.set(handle, here?.native ?? key);
  }
  return ids;
}

/**
 * The members of the chat memory holds no entry of, an author or a reactor of her line, each once by what their
 * handle is cut from: everyone whose handle stands in `<chat>` gets an entry of `<people>`.
 */
function strangersOf(given: ReaderInput, items: ReadonlyArray<MemoryItem>): Array<ChatStranger> {
  const keyOf = given.keyOfMember ?? ((native: string) => native);
  const known = new Set(items.flatMap((one) => (one.handleKey ? [one.handleKey] : [])));
  const out: Array<ChatStranger> = [];
  for (const member of given.chatMembers ?? []) {
    const key = keyOf(member.native);
    if (known.has(key)) continue;
    known.add(key);
    out.push({ key, native: member.native, name: member.name, evidence: member.reactor ? 'edge' : 'author' });
  }
  return out;
}

/**
 * The lookups `<recall>` shows with the numbers of their extracts given in this request, past the numbers of `<chat>`
 * where the turn's registry starts the numbers of its reads (src/turn/calls.ts#searchHandles), and the lines they name.
 * A kind without `<recall>` keeps the lookups as given and names no line.
 */
function recallNumbered(
  given: ReaderInput,
  retired: ReadonlySet<string>
): { lookups: Array<Lookup>; refs: Array<SearchRef> } {
  const { frame, lookups, chatItems, isSourceRetired, labels } = given;
  if (!frame.blocks.includes('recall')) return { lookups: [...lookups], refs: [] };
  const floor = Math.max(0, ...chatItems.map((item) => item.index).filter((n) => typeof n === 'number'));
  return numberedLookups(shownLookups(lookups, retired), {
    from: floor + SEARCH_HANDLE_GAP + 1,
    live: (sourceId) => isSourceRetired === null || !isSourceRetired(sourceId),
    labels,
  });
}

/** Everything the frame's request offers, rendered before the fit. */
function offeredOf(given: ReaderInput): Offered {
  const { frame, labels, timezone, mind, lineOf } = given;
  const resolveRef = refResolverOf({
    window: chatWindow(frame, given.chatItems),
    lineOf: lineOf ?? (() => null),
    labels,
    timezone,
    keepEmoji: keepsEmoji(given.config),
  });
  const gone = retiredOf(given.lookups, given.isSourceRetired);
  const retired = { retired: gone };
  const numbered = recallNumbered(given, gone);
  const lookups = numbered.lookups.map((lookup) => ({ ...lookup, extract: resolveRef(lookup.extract) }));
  const names = namesOf(
    given,
    given.meanwhileReads ? meanwhileWindows(given.meanwhileReads, frame, meanwhileSettingsOf(given.config, frame)) : []
  );
  const { windows } = names;
  const innerParts = innerNamed(given.inner, names.placeNamed);
  const items = memoryItemsOf(
    mind,
    frame,
    labels,
    given.nameOf,
    given.live,
    given.selfreflectionIds,
    chatIdOfInput(given),
    handled(given) ? names.entryRefs : null,
    keepsEmoji(given.config)
  );
  const memory = memoryCut(given, [
    ...items,
    ...(handled(given) ? strangerItemsOf(strangersOf(given, items), frame, labels, keepsEmoji(given.config)) : []),
    ...factItemsOf(given.facts ?? [], labels, handled(given) ? names.entryRefs : null),
  ]);
  return {
    spatial: [given.spatialText, answersLine(given, names), given.awayText].filter(Boolean).join('\n'),
    surroundings: given.surroundingsText(
      handled(given) && given.currentChannelId !== null ? names.places.handleOf(given.currentChannelId) : null,
      directPartnerOf(given, names)
    ),
    memory: memory.items,
    memoryLeftOut: memory.leftOut,
    recall: recallBlockOf(
      lookups,
      retired,
      labels,
      timezone,
      (placeId) => names.entryRefs.place(placeId),
      keepsEmoji(given.config)
    ),
    recallRefs: numbered.refs,
    chat: given.chatItems.map((item) => ({ ...item, text: resolveRef(item.text) })),
    windows,
    windowTexts: windows.map((window) =>
      windowText(
        window,
        frame,
        labels,
        given.nameOf,
        windowHandle(given, names, window),
        handled(given) ? names.meanwhileRefs : null,
        keepsEmoji(given.config)
      )
    ),
    inner: innerItems(innerParts),
    innerParts,
    resolveRef,
    names,
  };
}

/** The body of `<inner>` from the parts the budget kept, the errand's result first. */
function innerTextOf(given: ReaderInput, offered: Offered, fit: Fit): string {
  const kept = new Set(keptOf(offered.inner, fit.kept.inner, (one) => one.text).map((one) => one.key));
  const { innerParts: inner } = offered;
  const parts: InnerParts = {
    myDay: kept.has('myDay') ? inner.myDay : [],
    intentions: kept.has('intentions') ? inner.intentions : null,
    errands: kept.has('errands') ? inner.errands : null,
    feedback: kept.has('feedback') ? inner.feedback : null,
    work: kept.has('work') ? (inner.work ?? null) : null,
    board: kept.has('board') ? (inner.board ?? null) : null,
    previousThink: kept.has('previousThink') ? inner.previousThink : null,
  };
  return [
    block('errand_result', given.errandResult),
    innerBlockOf(parts, given.labels, offered.resolveRef),
    selfreflectionInnerOf(given.selfreflection ?? null, fit),
  ]
    .filter(Boolean)
    .join('\n');
}

/** A selfreflection request's parts of `<inner>`: her past entries the budget kept, then the request's own parts. */
function selfreflectionInnerOf(given: SelfreflectionFramed | null, fit: Fit): string {
  if (given === null) return '';
  const entries = fit.kept.selfreflection ?? [];
  return [
    block('selfreflection', entries.length > 0 ? [given.intro, ...entries].filter(Boolean).join('\n') : ''),
    ...given.parts.map((part) => block(part.tag, part.text)),
  ]
    .filter(Boolean)
    .join('\n');
}

/** The body of `<lessons>`: its header over the lines the budget kept; '' when it kept none. */
const lessonsTextOf = (given: ReaderInput, kept: ReadonlyArray<string>): string =>
  kept.length === 0 ? '' : [given.lessons?.header ?? '', ...kept].filter(Boolean).join('\n');

/** The body of `<self>`: her senses, her tools in text, the facts about herself, what people taught her and the people she feels most strongly about, as the budget kept them. */
const selfTextOf = (given: ReaderInput, fit: Fit): string =>
  [
    block('senses', [given.senses.stable, given.senses.turn].filter(Boolean).join('\n')),
    block('tools', given.toolsText),
    block('self_facts', (fit.kept.self ?? []).join('\n')),
    block('lessons', lessonsTextOf(given, fit.kept.lessons ?? [])),
    block('attitudes', (fit.kept.attitudes ?? []).join('\n')),
  ]
    .filter(Boolean)
    .join('\n');

type Bodies = { memory: string; found: string; inner: string; meanwhile: string; chat: string };

/** The blocks that belong to the turn itself: the first of them in the frame's order ends the `memory` segment. */
const TURN_OWN: ReadonlySet<string> = new Set(['chat', 'recall', 'found', 'inner', 'spatial_awareness', 'task']);

/**
 * Every block of the request, the ones the frame lists in the frame's order, then the others empty: the frame's list
 * is the printed order (src/turn/request/frame.ts#blocksOf). A listed block of the tail that stands before the first
 * of the turn's own blocks goes in the segment `memory`.
 */
function listedOf(given: ReaderInput, offered: Offered, fit: Fit, bodies: Bodies): Array<ListedBlock> {
  const { kept } = fit;
  const tail = (name: BlockName, source: string, text: string, section?: string): ListedBlock => ({
    name,
    segment: 'tail',
    source,
    text: block(name, text),
    ...(section ? { section } : {}),
  });
  const listed: Array<ListedBlock> = [
    { name: 'self', segment: 'stable', source: 'self', text: block('self', selfTextOf(given, fit)) },
    {
      name: 'surroundings',
      segment: 'tail',
      source: 'surroundings',
      text: block('surroundings', offered.surroundings),
    },
    tail('memory', 'mind', bodies.memory, 'people'),
    tail('meanwhile', 'meanwhile', bodies.meanwhile, 'meanwhile'),
    tail('virtual_world', 'world', kept.virtual_world?.[0] ?? '', 'virtual_world'),
    tail('chat', 'kept.chat', bodies.chat, 'chat'),
    tail('recall', 'lookups', kept.recall?.[0] ?? '', 'recall'),
    tail('found', 'mind', bodies.found, 'found'),
    tail('inner', 'inner', bodies.inner, 'inner'),
    tail('spatial_awareness', 'spatial', offered.spatial),
    tail('task', 'task', given.task),
  ];
  const order: ReadonlyArray<string> = given.frame.blocks;
  const sorted = listed
    .filter((one) => order.includes(one.name))
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  // The blocks between `<self>` and the first of the turn's own blocks repeat between turns: the `memory` segment, whose
  // cache marker every request of a turn carries (src/llm/openrouter.ts#withCacheMarker).
  const firstOwn = sorted.findIndex((one) => TURN_OWN.has(one.name));
  const inList = sorted.map((one, at) =>
    one.segment === 'tail' && (firstOwn < 0 || at < firstOwn) ? { ...one, segment: 'memory' as const } : one
  );
  const offList = listed.filter((one) => !order.includes(one.name)).map((one) => ({ ...one, text: '', offKind: true }));
  return [...inList, ...offList];
}

/** The user message of a request on the frame. */
export function readerRequest(given: ReaderInput): ReaderResult {
  const { labels, timezone, mind } = given;
  const offered = offeredOf(given);
  const fit = fitSections(sectionsOf(given, offered), given.limit, given.cost);
  const keptMemory = offered.memory.filter(
    (one) => one.counterpart || keptOf([one], fit.kept[one.subtag], (item) => item.text).length > 0
  );
  const people = keptMemory.filter((one) => one.subtag === 'people');
  const keptWindows = keptOf(offered.windows, fit.kept.meanwhile, (window) => {
    return offered.windowTexts[offered.windows.indexOf(window)];
  });
  const named = handled(given);
  const { names } = offered;
  const withHandle = (one: MemoryItem): MemoryItem => {
    if (!named) return one;
    if (!one.handleKey) return one;
    const ref = labels.people?.ref ?? '@{handle}: {name}';
    return { ...one, text: fill(ref, { handle: names.people.handleOf(one.handleKey), name: one.text }) };
  };
  const { stats } = fit;
  const cutBy = Object.fromEntries(
    MEMORY_SUBTAGS.map((subtag) => [
      subtag,
      (mind.leftOut[subtag] ?? 0) + (offered.memoryLeftOut[subtag] ?? 0) + (stats[subtag]?.dropped ?? 0),
    ])
  );
  const keptChat = offered.chat.slice(offered.chat.length - (fit.kept.chat ?? []).length);
  const printed = printOrder(keptMemory).map(withHandle);
  const blocks = listedOf(given, offered, fit, {
    memory: renderMemory(printed, cutBy, labels, IN_MEMORY),
    found: subtagBody('found', printed, cutBy, labels),
    inner: innerTextOf(given, offered, fit),
    meanwhile: meanwhileText(
      keptWindows,
      given.frame,
      labels,
      given.nameOf,
      (window) => windowHandle(given, names, window),
      named ? names.meanwhileRefs : null,
      keepsEmoji(given.config)
    ),
    chat: renderTranscript(keptChat, timezone, labels, given.tempoText),
  });
  const memberNames = new Map<string, Array<string>>();
  for (const one of people) for (const id of one.handleIds) if (one.name) memberNames.set(id, [one.name]);
  const targets = named
    ? targetsOf(
        given,
        offered,
        keptMemory.filter((one) => one.subtag === 'people')
      )
    : new Map();
  const parts = userParts(blocks);
  const text = parts.map((part) => part.text).join('');
  const shown = (handle: string): boolean => new RegExp(`@${handle}(?![\\p{L}\\p{N}_])`, 'u').test(text);
  const handleIds = named ? handleIdsOf(given, offered, targets, shown) : null;
  return {
    parts,
    blocks: blockRecords(blocks, fit.stats),
    fit,
    keptChat,
    handles: handleIds,
    channelHandleById: named ? names.places.entries() : new Map<string, string>(),
    refs: named ? { targets, personHandle: (key) => names.people.handleOf(key), placeRef: names.placeRef } : null,
    memberNames,
    peopleShown: people
      .filter((one) => one.name !== null && one.handleIds.length > 0)
      .map((one) => ({ id: one.handleIds[0], names: [one.name ?? ''] })),
    memoryReads: keptMemory.flatMap((one) => [...one.reads]),
    recallRefs: offered.recallRefs,
  };
}
