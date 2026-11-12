// The result of a request built on the turn frame (src/turn/request/reader.ts), in the shape buildRequest returns for
// every request: the messages, the budget's line, the cache segments, the archive's blocks, the handles and what of
// the chat went in. buildRequest (src/behavior/prompt.ts) calls it for every request on the frame once the head, the
// task, the senses and her own texts are built. Pure.

import { createHash } from 'node:crypto';
import { liveFields } from '../../behavior/around.ts';
import type { BuildRequestResult } from '../../behavior/prompt-types.ts';
import type { computeTempo } from '../../format.ts';
import type { Mind } from '../../memory/db/mind-read.ts';
import type { LiveOf, StoredFact } from './memory-block.ts';
import type { Frame } from './frame.ts';
import type { Base, Room } from './head.ts';
import { readerRequest } from './reader.ts';
import type { SurroundingsInput } from './reader.ts';
import { ordered } from './reads.ts';
import { renderSenses } from './senses.ts';
import type { SensesOf } from './senses.ts';
import { selfreflectionFramedOf } from './selfreflection.ts';
import { surroundingsOf } from './surroundings.ts';
import { lessonsBlockOf, lessonsBudgetOf } from './lessons.ts';
import { keepsEmoji } from './text.ts';
import type { SelfreflectionFramed } from './selfreflection.ts';
import { seenOf } from './tail.ts';
import type { Task } from './task.ts';
import { handleOf } from '../../behavior/handles.ts';
import { mentionsNamed } from '../../format.ts';
import type { RequestInput } from './types.ts';
import type { WakeTexts } from './wake.ts';

/** The empty mind: a request built with no reader. */
const NO_MIND: Mind = {
  people: [],
  places: [],
  interfaces: [],
  lore: [],
  recent: [],
  found: [],
  leftOut: {},
  reads: [],
};

/** What the steps before the frame's request built. */
export type FramedSteps = {
  frame: Frame;
  base: Base;
  task: Task;
  senses: SensesOf;
  own: WakeTexts;
  room: Room;
  tempo: ReturnType<typeof computeTempo>;
  tempoText: string;
};

/** The live line of a person by their platform ids, the frame's interface first, from the interface's snapshot. */
function liveOf(base: Base, now: number): LiveOf | null {
  const snapshot = base.liveSnapshot;
  if (!base.liveOn || !snapshot) return null;
  return (nativeIds) => {
    const [native] = nativeIds;
    if (!native) return null;
    const lines = liveFields(snapshot, native, {
      labels: base.labels,
      channelNameOf: base.voiceChannelNameOf,
      now,
    }).map((line) => line.replace(/^- /, ''));
    return lines.length > 0 ? lines.join('; ') : null;
  };
}

/** The interface's own text for `<surroundings>`: what it declares of itself, and of its custom emoji when it has any. */
function interfaceTextOf(given: RequestInput, base: Base): string {
  const declared = given.surroundings?.interfaceText ?? '';
  const emoji = base.customEmoji.length > 0 ? (given.mediaPickText ?? '') : '';
  return [declared, emoji].filter((text) => text.trim() !== '').join('\n');
}

/**
 * The body of `<surroundings>`, held for the cache bucket per place (freezePerBucket) while the description versions it
 * renders stay the same: a field edited under the same version shows at the next bucket edge, a new version or a
 * renamed place at once. `handle` and `partner` are the turn's place handle (without `#`) and a direct chat's partner handle as the request's books cut them.
 */
function surroundingsHeld(
  given: RequestInput,
  base: Base,
  frame: Frame,
  handle: string | null,
  partner: string | null
): string {
  const stored: SurroundingsInput | null = given.surroundings ?? null;
  const versions = [...(stored?.versions ?? [])].sort().join(',');
  const { place } = frame;
  const path = place === null ? '' : place.path.join('/');
  const names = JSON.stringify(stored?.names ?? null);
  const keepEmoji = keepsEmoji(given.config);
  // The in-jokes are claims, not description versions: a new or retired one shows at once too.
  const injokes = stored?.root?.injokes ?? '';
  return base.frozen(
    `surroundings:${place?.id ?? ''}`,
    `${path}|${versions}|${names}|${handle ?? ''}|${partner ?? ''}|${keepEmoji}|${injokes}`,
    () =>
      surroundingsOf(
        frame,
        interfaceTextOf(given, base),
        stored?.root ?? null,
        stored?.place ?? null,
        base.labels,
        partner ?? partnerHandleOf(frame, base),
        { mention: storedMention(given, base) },
        stored?.names,
        handle,
        keepEmoji
      )
  );
}

/**
 * `<lessons>` of `<self>`, held like `<self_facts>` for the cache bucket while the stored lessons, their labels and the
 * budget stay the same (the order they rank in changes the bytes only at the next bucket edge): the header and the lines
 * that fit `context.lessons.budgetTokens`, none without lessons or a budget.
 */
function lessonsHeld(given: RequestInput, base: Base, room: Room): { header: string; lines: Array<string> } {
  const lessons = given.lessons ?? [];
  const budget = lessonsBudgetOf(given.config);
  if (lessons.length === 0 || budget === null) return { header: '', lines: [] };
  const { lessons: words, authors } = base.labels;
  const wording = `${words?.header ?? ''}|${words?.line ?? ''}|${authors?.unknown ?? ''}`;
  const stored = lessons.map((lesson) => `${lesson.teacher ?? ''}\u0000${lesson.text}`).sort();
  return base.frozen('lessons', `${budget}|${wording}|${stored.join('\u0001')}`, () =>
    lessonsBlockOf(lessons, budget, { labels: base.labels, mention: storedMention(given, base), cost: room.cost })
  );
}

/** The stored facts among the prefetch's excerpts (`source: 'semantic'`), for `<found>`. */
function storedFactsOf(prefetch: RequestInput['prefetch']): Array<StoredFact> {
  return (prefetch?.excerpts ?? []).flatMap((excerpt) =>
    excerpt?.source === 'semantic' && typeof excerpt.lines === 'string'
      ? [{ state: excerpt.state, polarity: excerpt.polarity, text: excerpt.lines }]
      : []
  );
}

/** What she has not been told: the turn's facts, then a selfreflection request's refused audiences; null with neither. */
function feedbackOf(told: string, selfreflection: SelfreflectionFramed | null): string | null {
  return [told, selfreflection?.feedback ?? ''].filter(Boolean).join('\n') || null;
}

/** The handle (with `@`) a one-to-one chat's path ends in: its partner's, by the key their lines carry; null elsewhere. */
function partnerHandleOf(frame: Frame, base: Base): string | null {
  const partner = frame.scope === 'dm' ? frame.counterpart : null;
  return partner === null ? null : `@${handleOf(base.keyOfMember(partner.nativeId))}`;
}

/**
 * A `<@id>` of a stored text of the stable part as the handle of the person it names (cut from what memberKeyOf gives,
 * so the cached text holds no per-request form), `authors.unknown` for an account no row holds.
 */
function storedMention(given: RequestInput, base: Base): (native: string) => string {
  const { authors } = base.labels;
  return (native) => {
    const key = given.memberKeyOf?.(native) ?? null;
    return key === null ? (authors?.unknown ?? '') : `@${handleOf(key)}`;
  };
}

/**
 * The members of the chat, she aside: each author once with the name the newest of their lines gave, then each reactor
 * of her lines named at her reaction who wrote nothing.
 */
function chatMembersOf(
  history: RequestInput['history']
): Array<{ native: string; name: string | null; reactor?: boolean }> {
  const names = new Map<string, string | null>();
  for (const line of history)
    if (!line.self && line.authorId !== undefined && line.authorId !== null)
      names.set(String(line.authorId), line.authorName ?? names.get(String(line.authorId)) ?? null);
  const members: Array<{ native: string; name: string | null; reactor?: boolean }> = [...names].map(
    ([native, name]) => ({ native, name })
  );
  for (const user of reactorsOf(history))
    if (!names.has(user.id)) {
      names.set(user.id, user.name);
      members.push({ native: user.id, name: user.name, reactor: true });
    }
  return members;
}

/** The people named at the reactions of her lines, each with the name the reaction gave, in order. */
function reactorsOf(history: RequestInput['history']): Array<{ id: string; name: string | null }> {
  const out: Array<{ id: string; name: string | null }> = [];
  for (const line of history) {
    if (!line.self) continue;
    const reactions: unknown = Reflect.get(line, 'reactions');
    for (const reaction of Array.isArray(reactions) ? reactions : []) {
      const users: unknown = reaction && typeof reaction === 'object' ? Reflect.get(reaction, 'users') : null;
      for (const user of Array.isArray(users) ? users : []) {
        const id: unknown = user && typeof user === 'object' ? Reflect.get(user, 'id') : null;
        const name: unknown = user && typeof user === 'object' ? Reflect.get(user, 'name') : null;
        if ((typeof id === 'string' && id !== '') || typeof id === 'number')
          out.push({ id: String(id), name: typeof name === 'string' ? name : null });
      }
    }
  }
  return out;
}

/** The request of a turn on the frame. */
export function framedBuild(given: RequestInput, steps: FramedSteps): BuildRequestResult {
  const { frame, base, task, senses, own, room, tempo, tempoText } = steps;
  const { labels, nameOf } = base;
  const selfreflection = selfreflectionFramedOf({ ...given, labels });
  const surroundingsText = (handle: string | null, partner: string | null): string =>
    surroundingsHeld(given, base, frame, handle, partner);
  const selfFacts = base.frozen('self', '', () =>
    (given.placeMemory?.self ?? []).map((fact) => `- ${String(mentionsNamed(fact, storedMention(given, base)))}`)
  );
  const built = readerRequest({
    frame,
    config: given.config,
    labels,
    timezone: base.timezone,
    cost: room.cost,
    limit: room.limit,
    system: base.system,
    task: task.fittedTask,
    spatialText: [base.spatialText, given.awake ?? ''].filter(Boolean).join('\n'),
    awayText: base.nowText,
    // The interface's text goes to `<surroundings>`.
    senses: renderSenses(given.config, labels, { ...senses.sensesOptions, interfaceText: null }),
    toolsText: senses.toolsText,
    selfFacts,
    lessons: lessonsHeld(given, base, room),
    surroundingsText,
    mind: given.mind ?? NO_MIND,
    facts: storedFactsOf(given.prefetch),
    selfreflectionIds: new Set(given.selfreflectionChannelIds ?? []),
    lookups: given.lookups ?? [],
    meanwhileReads: given.meanwhileReads ?? null,
    chatItems: base.chatItems,
    tempoText,
    inner: {
      myDay: own.myDayText ? [own.myDayText] : [],
      intentions: own.intentionsText || null,
      errands: own.errandsText.list || null,
      feedback: feedbackOf(own.wakeText, selfreflection),
      work: given.serviceInner?.work || null,
      board: given.serviceInner?.board || null,
      previousThink: given.previousThink ?? null,
    },
    selfreflection,
    errandResult: own.errandsText.result,
    nameOf,
    lineOf: given.refLineOf ?? null,
    isSourceRetired: given.isSourceRetired ?? null,
    live: liveOf(base, given.now),
    chatHandles: base.keyHandles,
    chatHandleById: base.handleById,
    chatMembers: chatMembersOf(given.history),
    keyOfMember: base.keyOfMember,
    memberKeyOf: given.memberKeyOf,
    placePathOf: given.placePathOf,
    currentChannelId: given.currentChannelId ?? null,
    chatIdOf: given.chatIdOf ?? null,
    answeredText: frame.answers === null ? null : (given.trigger?.content ?? null),
  });
  const { parts, fit } = built;
  return {
    messages: [
      { role: 'system', content: base.system },
      { role: 'user', content: parts },
    ],
    stats: { ...fit.stats, used: fit.used, limit: room.limit },
    segments: parts.map((part) => ({
      segment: part.cacheSegment ?? 'tail',
      chars: part.text.length,
      hash: createHash('sha1').update(part.text).digest('hex').slice(0, 8),
    })),
    blocks: built.blocks,
    idByIndex: base.idByIndex,
    tempo,
    pulledIds: new Map(),
    peopleShown: built.peopleShown,
    seen: seenOf({ history: given.history, keptChat: built.keptChat }),
    memoryReads: ordered(built.memoryReads),
    handles: built.handles,
    memberNames: new Map([...(base.memberNames ?? []), ...built.memberNames]),
    // Handle -> channel id, for her `#handle` in a tool argument or a post.
    channelHandles: new Map([...built.channelHandleById].map(([id, handle]) => [handle, id])),
    refs: built.refs,
    recallRefs: built.recallRefs,
  };
}
