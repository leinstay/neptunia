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
import type { SelfreflectionFramed } from './selfreflection.ts';
import { seenOf } from './tail.ts';
import type { Task } from './task.ts';
import { resolveChatText } from './text.ts';
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
 * renamed place at once.
 */
function surroundingsHeld(given: RequestInput, base: Base, frame: Frame): string {
  const stored: SurroundingsInput | null = given.surroundings ?? null;
  const versions = [...(stored?.versions ?? [])].sort().join(',');
  const { place } = frame;
  const path = place === null ? '' : place.path.join('/');
  return base.frozen(`surroundings:${place?.id ?? ''}`, `${path}|${versions}`, () =>
    surroundingsOf(frame, interfaceTextOf(given, base), stored?.root ?? null, stored?.place ?? null, base.labels)
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

/** The request of a turn on the frame. */
export function framedBuild(given: RequestInput, steps: FramedSteps): BuildRequestResult {
  const { frame, base, task, senses, own, room, tempo, tempoText } = steps;
  const { labels, nameOf } = base;
  const selfreflection = selfreflectionFramedOf({ ...given, labels });
  const surroundingsText = surroundingsHeld(given, base, frame);
  const selfFacts = base.frozen('self', '', () =>
    (given.placeMemory?.self ?? []).map((fact) => `- ${String(resolveChatText(fact, nameOf))}`)
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
    chatHandles: base.handleById,
    currentChannelId: given.currentChannelId ?? null,
    chatIdOf: given.chatIdOf ?? null,
    answeredText: frame.answers === null ? null : (given.trigger?.content ?? null),
  });
  const { parts, fit, handleById } = built;
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
    handles: handleById ? new Map([...handleById].map(([id, handle]) => [handle, id])) : null,
    memberNames: new Map([...(base.memberNames ?? []), ...built.memberNames]),
    // Handle -> channel id, for her `#handle` in a tool argument or a post.
    channelHandles: new Map([...built.channelHandleById].map(([id, handle]) => [handle, id])),
  };
}
