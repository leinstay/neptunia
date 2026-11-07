// The result of a request built on the turn frame (src/turn/request/reader.ts), in the shape buildRequest returns for
// every request: the messages, the budget's line, the cache segments, the archive's blocks, the handles and what of
// the chat went in. buildRequest (src/behavior/prompt.ts) calls it for a reply and an errand's result once the head,
// the task, the senses and her own texts are built. Pure.

import { createHash } from 'node:crypto';
import { liveFields } from '../../behavior/around.ts';
import type { BuildRequestResult } from '../../behavior/prompt-types.ts';
import type { computeTempo } from '../../format.ts';
import type { Mind, PersonEntry } from '../../memory/db/mind-read.ts';
import type { Frame } from './frame.ts';
import type { Base, Room } from './head.ts';
import { readerRequest } from './reader.ts';
import type { SurroundingsInput } from './reader.ts';
import { ordered } from './reads.ts';
import { renderSenses } from './senses.ts';
import type { SensesOf } from './senses.ts';
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

/** The live line of a person from the interface's snapshot, null without one. */
function liveOf(base: Base, frame: Frame, now: number): ((person: PersonEntry) => string | null) | null {
  const snapshot = base.liveSnapshot;
  if (!base.liveOn || !snapshot) return null;
  return (person) => {
    const account = person.accounts.find((id) => id.startsWith(`${frame.interface}:`)) ?? person.accounts[0];
    if (!account) return null;
    const native = account.slice(account.indexOf(':') + 1);
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

/** The request of a reply or an errand's result on the frame. */
export function framedBuild(given: RequestInput, steps: FramedSteps): BuildRequestResult {
  const { frame, base, task, senses, own, room, tempo, tempoText } = steps;
  const { labels, nameOf } = base;
  const surroundings: SurroundingsInput = {
    interfaceText: interfaceTextOf(given, base),
    root: given.surroundings?.root ?? null,
    place: given.surroundings?.place ?? null,
  };
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
    task: task.pulledTrigger ? task.composeTask(false) : task.fittedTask,
    spatialText: base.spatialText,
    awayText: base.nowText,
    // The interface's text goes to `<surroundings>`, and no `<participation>` is shown.
    senses: renderSenses(given.config, labels, { ...senses.sensesOptions, interfaceText: null, participation: false }),
    toolsText: senses.toolsText,
    skillIndexText: senses.skillIndexText,
    selfFacts,
    surroundings,
    mind: given.mind ?? NO_MIND,
    lookups: given.lookups ?? [],
    meanwhileReads: given.meanwhileReads ?? null,
    chatItems: base.chatItems,
    tempoText,
    inner: {
      myDay: own.myDayText ? [own.myDayText] : [],
      intentions: own.intentionsText || null,
      errands: own.errandsText.list || null,
      feedback: own.wakeText || null,
      previousThink: given.previousThink ?? null,
    },
    errandResult: own.errandsText.result,
    nameOf,
    lineOf: given.refLineOf ?? null,
    live: liveOf(base, frame, given.now),
    chatHandles: base.handleById,
    currentChannelId: given.currentChannelId ?? null,
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
    pulledKept: [],
    pulledViews: [],
    peopleShown: built.peopleShown,
    recent: null,
    seen: seenOf({ history: given.history, keptChat: built.keptChat }),
    memoryReads: ordered(built.memoryReads),
    handles: handleById ? new Map([...handleById].map(([id, handle]) => [handle, id])) : null,
    memberNames: new Map([...(base.memberNames ?? []), ...built.memberNames]),
    // Handle -> channel id, for her `#handle` in a tool argument or a post.
    channelHandles: new Map([...built.channelHandleById].map(([id, handle]) => [handle, id])),
  };
}
