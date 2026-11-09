// The user message of a request built on the turn frame (docs/prompt-contract.md, "Blocks per kind"): every kind carries
// the frame's tags in its order, filtered by `frame.blocks`. The stable segment holds `<self>`, the surroundings segment
// `<surroundings>`, each with its own cache marker (src/llm/openrouter.ts#withCacheMarker). The tail holds `<memory>`
// from the graph reader, `<recall>` from her lookups, `<inner>`, `<meanwhile>` from her lines elsewhere,
// a selfreflection request's `<virtual_world>`, `<spatial_awareness>` with the clock and her time away, `<chat>` and
// `<task>`. The budget fits them in this priority: the fixed part, the person she answers, the memory shares, the
// recall, the chat (cut to a step of `context.chatSteps`), the background, her own state, the world, her past entries. Mention handles are given after the
// fit, to the authors of the chat and to the people `<memory>` and `<meanwhile>` kept, and to nobody else; a
// selfreflection request gives none. buildRequest (src/behavior/prompt.ts) calls it. Pure.

import { assignChannelHandles, assignHandles } from '../../behavior/handles.ts';
import { fill, renderTranscript } from '../../format.ts';
import { fitSections } from '../../llm/budget.ts';
import { mindSettingsOf } from '../../memory/db/mind-read.ts';
import type { Mind } from '../../memory/db/mind-read.ts';
import type { Lookup } from '../calls.ts';
import type { BlockName, Frame } from './frame.ts';
import { innerBlockOf } from './inner-block.ts';
import type { InnerParts } from './inner-block.ts';
import { meanwhileSettingsOf, meanwhileText, meanwhileWindows, windowText } from './meanwhile.ts';
import type { MeanwhileReads, MeanwhileWindow } from './meanwhile.ts';
import { MEMORY_SUBTAGS, factItemsOf, memoryItemsOf, renderMemory } from './memory-block.ts';
import type { ChatIdOf, LiveOf, MemoryItem, StoredFact } from './memory-block.ts';
import { recallBlockOf } from './recall-block.ts';
import { refResolverOf } from './refs.ts';
import type { LineOf } from './refs.ts';
import type { Senses } from './senses.ts';
import type { PlaceFields } from './surroundings.ts';
import type { SelfreflectionFramed } from './selfreflection.ts';
import { blockRecords, userParts } from './tail.ts';
import type { BlockRecord, ListedBlock, UserPart } from './tail.ts';
import { block, escapeStored } from './text.ts';
import type { Fit, Labels, MemoryRead, NameOf, RequestConfig, Section, TranscriptItem } from './types.ts';

/** What the interface and the memory say of the turn's place, for `<surroundings>`. */
export type SurroundingsInput = {
  readonly interfaceText: string;
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
  /** The body of `<surroundings>`, rendered and held per cache bucket by the caller (src/turn/request/framed.ts). */
  surroundingsText: string;
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
  /** The handles the chat was rendered with, by platform id: they keep their form whatever joins them. */
  chatHandles: Map<string, string> | null;
  /** The chat id of the turn's place: it gets a channel handle with the places memory and meanwhile show. */
  currentChannelId: string | null;
  /** The chat id of a stored place memory and meanwhile show, from its row; null for a DM and without a reader. */
  chatIdOf?: ChatIdOf | null;
};

/** The frame's request: its parts, the archive's record, the fit, the chat lines kept and the handles given. */
export type ReaderResult = {
  parts: Array<UserPart>;
  blocks: Array<BlockRecord>;
  fit: Fit;
  keptChat: Array<TranscriptItem>;
  handleById: Map<string, string> | null;
  /** Chat id -> channel handle: the current place and the places `<memory>` and `<meanwhile>` kept. */
  channelHandleById: Map<string, string>;
  memberNames: Map<string, Array<string>>;
  peopleShown: Array<{ id: string; names: Array<string> }>;
  memoryReads: Array<MemoryRead>;
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
  recall: string;
  chat: Array<TranscriptItem>;
  windows: Array<MeanwhileWindow>;
  windowTexts: Array<string>;
  inner: Array<{ key: keyof InnerParts; text: string }>;
  resolveRef: (text: string) => string;
};

/** What of a selfreflection request the budget never cuts: its own parts of `<inner>` and the first line of its entries. */
const selfreflectionFixed = (given: SelfreflectionFramed | null): Array<string> =>
  given === null ? [] : [...given.parts.map((part) => part.text), given.intro];

/** The budget's sections of the frame's request, in priority order. */
function sectionsOf(given: ReaderInput, offered: Offered): Array<Section> {
  const settings = mindSettingsOf(given.config);
  const shares: Record<string, number> = settings.shares;
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
    ...MEMORY_SUBTAGS.map((subtag) => ({
      name: subtag,
      keep: 'first' as const,
      cap: Math.floor(settings.budgetTokens * (shares[subtag] ?? 0)) || undefined,
      items: offered.memory.filter((one) => one.subtag === subtag && !one.counterpart).map((one) => one.text),
    })),
    { name: 'recall', items: [offered.recall].filter(Boolean) },
    { name: 'chat', keep: 'newest', steps: chatStepsOf(given.config), items: offered.chat.map((item) => item.text) },
    { name: 'meanwhile', keep: 'newest', items: offered.windowTexts },
    { name: 'inner', keep: 'first', items: offered.inner.map((one) => one.text) },
    { name: 'virtual_world', items: [given.selfreflection?.world ?? ''].filter(Boolean) },
    { name: 'selfreflection', keep: 'newest', items: given.selfreflection?.entries ?? [] },
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

/** The handles of the request: the chat's as rendered, then the people `<memory>` and `<meanwhile>` kept. */
function handlesOf(
  chatHandles: Map<string, string> | null,
  people: ReadonlyArray<MemoryItem>,
  windows: ReadonlyArray<MeanwhileWindow>
): Map<string, string> | null {
  if (chatHandles === null) return null;
  const shownIds = [
    ...people.flatMap((one) => one.handleIds),
    ...windows.flatMap((window) => window.lines.filter((line) => !line.self).map((line) => line.authorId ?? '')),
  ];
  const added = assignHandles({ profiled: [...chatHandles.keys()], inView: shownIds });
  // The chat's handles stand as rendered; assignHandles places them first, so they come out the same.
  for (const [id, handle] of chatHandles) added.set(id, handle);
  return added;
}

/** Whom and which message she answers, for `<spatial_awareness>`: the line's `#n` when the chat shows it. */
function answersLine(given: ReaderInput): string {
  const { frame, labels } = given;
  const them = frame.counterpart;
  const answered = frame.answers;
  if (them === null || answered === null) return '';
  const name = escapeStored(them.name ?? them.accountId);
  const n = given.chatItems.find((item) => item.id === answered.messageId)?.index;
  const l = labels.spatial ?? {};
  return typeof n === 'number' ? fill(l.answers ?? '', { name, n }) : fill(l.answersOutside ?? '', { name });
}

/** The request's reader of a stored place's chat id; without one no stored place gets a channel handle. */
const chatIdOfInput = (given: ReaderInput): ChatIdOf => given.chatIdOf ?? (() => null);

/** The channel handles of the request: the current place, then the places `<memory>` and `<meanwhile>` kept. */
function channelHandlesOf(
  current: string | null,
  places: ReadonlyArray<MemoryItem>,
  windows: ReadonlyArray<MeanwhileWindow>,
  chatIdOf: ChatIdOf
): Map<string, string> {
  const ids = [
    current,
    ...places.map((one) => one.chatId ?? null),
    ...windows.map((window) => (window.dm ? null : chatIdOf(window.placeId))),
  ].filter((id): id is string => typeof id === 'string' && id !== '');
  return assignChannelHandles(ids);
}

/** Everything the frame's request offers, rendered before the fit. */
function offeredOf(given: ReaderInput): Offered {
  const { frame, labels, timezone, mind, lineOf } = given;
  const resolveRef = refResolverOf({
    window: chatWindow(frame, given.chatItems),
    lineOf: lineOf ?? (() => null),
    labels,
    timezone,
  });
  const lookups = given.lookups.map((lookup) => ({ ...lookup, extract: resolveRef(lookup.extract) }));
  const windows = given.meanwhileReads
    ? meanwhileWindows(given.meanwhileReads, frame, meanwhileSettingsOf(given.config, frame))
    : [];
  return {
    spatial: [given.spatialText, answersLine(given), given.awayText].filter(Boolean).join('\n'),
    surroundings: given.surroundingsText,
    memory: [
      ...memoryItemsOf(mind, frame, labels, given.nameOf, given.live, given.selfreflectionIds, chatIdOfInput(given)),
      ...factItemsOf(given.facts ?? [], labels),
    ],
    recall: recallBlockOf(lookups, { retired: retiredOf(given.lookups, given.isSourceRetired) }, labels, timezone),
    chat: given.chatItems.map((item) => ({ ...item, text: resolveRef(item.text) })),
    windows,
    windowTexts: windows.map((window) => windowText(window, frame, labels, given.nameOf)),
    inner: innerItems(given.inner),
    resolveRef,
  };
}

/** The body of `<inner>` from the parts the budget kept, the errand's result first. */
function innerTextOf(given: ReaderInput, offered: Offered, fit: Fit): string {
  const kept = new Set(keptOf(offered.inner, fit.kept.inner, (one) => one.text).map((one) => one.key));
  const { inner } = given;
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

/** The body of `<self>`: her senses, her tools in text and the facts about herself the budget kept. */
const selfTextOf = (given: ReaderInput, fit: Fit): string =>
  [
    block('senses', [given.senses.stable, given.senses.turn].filter(Boolean).join('\n')),
    block('tools', given.toolsText),
    block('self_facts', (fit.kept.self ?? []).join('\n')),
  ]
    .filter(Boolean)
    .join('\n');

type Bodies = { memory: string; inner: string; meanwhile: string; chat: string };

/** Every block of the frame's request in its order; a block the frame does not list goes out empty. */
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
      segment: 'surroundings',
      source: 'surroundings',
      text: block('surroundings', offered.surroundings),
    },
    tail('memory', 'mind', bodies.memory, 'people'),
    tail('recall', 'lookups', kept.recall?.[0] ?? '', 'recall'),
    tail('inner', 'inner', bodies.inner, 'inner'),
    tail('meanwhile', 'meanwhile', bodies.meanwhile, 'meanwhile'),
    tail('virtual_world', 'world', kept.virtual_world?.[0] ?? '', 'virtual_world'),
    tail('spatial_awareness', 'spatial', offered.spatial),
    tail('chat', 'kept.chat', bodies.chat, 'chat'),
    tail('task', 'task', given.task),
  ];
  const listedNames = new Set<string>(given.frame.blocks);
  return listed.map((one) => (listedNames.has(one.name) ? one : { ...one, text: '', offKind: true }));
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
  // A selfreflection request names people and places by name alone: an entry mentions nobody.
  const named = given.selfreflection === null || given.selfreflection === undefined;
  const handleById = named ? handlesOf(given.chatHandles, people, keptWindows) : null;
  const channelHandleById = named
    ? channelHandlesOf(given.currentChannelId, keptMemory, keptWindows, chatIdOfInput(given))
    : new Map<string, string>();
  const withHandle = (one: MemoryItem): MemoryItem => {
    const channel = one.chatId ? channelHandleById.get(one.chatId) : undefined;
    if (channel) return { ...one, text: `#${channel} ${one.text}` };
    const handle = one.handleIds.map((id) => handleById?.get(id)).find(Boolean);
    return handle ? { ...one, text: `@${handle} ${one.text}` } : one;
  };
  const windowHandle = (window: MeanwhileWindow): string | null =>
    window.dm ? null : (channelHandleById.get(chatIdOfInput(given)(window.placeId) ?? '') ?? null);
  const { stats } = fit;
  const cutBy = Object.fromEntries(
    MEMORY_SUBTAGS.map((subtag) => [subtag, (mind.leftOut[subtag] ?? 0) + (stats[subtag]?.dropped ?? 0)])
  );
  const keptChat = offered.chat.slice(offered.chat.length - (fit.kept.chat ?? []).length);
  const blocks = listedOf(given, offered, fit, {
    memory: renderMemory(keptMemory.map(withHandle), cutBy, labels),
    inner: innerTextOf(given, offered, fit),
    meanwhile: meanwhileText(keptWindows, given.frame, labels, given.nameOf, windowHandle),
    chat: renderTranscript(keptChat, timezone, labels, given.tempoText),
  });
  const memberNames = new Map<string, Array<string>>();
  for (const one of people) for (const id of one.handleIds) if (one.name) memberNames.set(id, [one.name]);
  return {
    parts: userParts(blocks),
    blocks: blockRecords(blocks, fit.stats),
    fit,
    keptChat,
    handleById,
    channelHandleById,
    memberNames,
    peopleShown: people
      .filter((one) => one.name !== null && one.handleIds.length > 0)
      .map((one) => ({ id: one.handleIds[0], names: [one.name ?? ''] })),
    memoryReads: keptMemory.flatMap((one) => [...one.reads]),
  };
}
