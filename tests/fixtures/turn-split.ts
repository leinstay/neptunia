import { userText } from '../../src/behavior/prompt.ts';
import { fill } from '../../src/format.ts';
import { labels } from './labels.ts';
import { createDiscordAdapter, createDiscordInterface } from '../../interfaces/discord/index.ts';
import type { TriggerKind } from '../../src/turn/triggers.ts';
import type { ChatMessage } from './turn-harness.ts';
import type { LogEntry } from './capture-logs.ts';
import type { TurnResult } from '../../src/turn/outcome.ts';
import { createTurnRunner } from './turn-runner.ts';
import { withCapturedLogs } from './capture-logs.ts';
import { NOW, fakeClient, fakeLookup, fakeStore, fakeTurnChannel, identityCalibrator, lookupHot, normalizedTrigger, rawMessage } from './turn-kit.ts';
import type { FakeHot } from './turn-kit.ts';

type SplitScript = string | Error | ((index: number) => unknown);
type SplitLlm = {
  calls: Record<'split' | 'lookup' | 'talk', Array<{ messages: Array<ChatMessage>; options: Record<string, unknown> }>>;
  complete: (messages: Array<ChatMessage>, options: Record<string, unknown>) => Promise<{ text: unknown; usage: object; estimated: number }>;
};
type ManualSchedule = ((fn: () => void, ms: number) => () => void) & { fire(ms: number): void };
type SplitTurn = {
  result: TurnResult;
  logs: Array<LogEntry>;
  llm: SplitLlm;
  channel: ReturnType<typeof fakeTurnChannel>;
  turns: ReturnType<typeof createTurnRunner>;
  trigger: ReturnType<typeof normalizedTrigger>;
};

const DISCORD = createDiscordInterface().capabilities;

export const SPLIT_SYSTEM = 'Split this call to {{name}} into at most {{maxTasks}} parts.';
export const SPLIT_TEXT = 'ποιος είναι ο Νίκος ακριβώς; κοίτα το κανάλι της Ελένης, και πες μου αν το μιμίδιο είναι αστείο.';
// PR 7d: split.minPartChars is the constant 20, so every part is at least that long.
export const SPLIT_PARTS = ['ποιος είναι ο Νίκος ακριβώς', 'κοίτα το κανάλι της Ελένης', 'το μιμίδιο είναι αστείο;'];
export const PARTS_ANSWER = SPLIT_PARTS.map((part) => `- ${part}`).join('\n');

/**
 * An llm fake routing by request purpose: the splitter (`split`), the search classifier
 * (`lookup`), everything else is the reply request. Each answer is a string, an Error to throw,
 * or a function of the call's index (0-based, per kind) giving one of those or a promise.
 */
export function splitLlm({
  split = PARTS_ANSWER,
  lookup = 'none',
  talk = '<msg reply="#2">ok</msg>',
}: { split?: SplitScript; lookup?: SplitScript; talk?: SplitScript } = {}): SplitLlm {
  const calls: SplitLlm['calls'] = {
    split: [],
    lookup: [],
    talk: [],
  };
  const answer = async (spec: SplitScript, index: number) => {
    const value = typeof spec === 'function' ? await spec(index) : spec;
    if (value instanceof Error) throw value;
    return { text: value, usage: {}, estimated: 10 };
  };
  return {
    calls,
    complete: (messages: Array<ChatMessage>, options: Record<string, unknown>) => {
      const kind = options?.purpose === 'split' ? 'split' : options?.purpose === 'lookup' ? 'lookup' : 'talk';
      calls[kind].push({ messages, options });
      const spec = kind === 'split' ? split : kind === 'lookup' ? lookup : talk;
      return answer(spec, calls[kind].length - 1);
    },
  };
}

/** The settings the split tests rely on, set here: the pre-filter, the cap, and the pace. */
export function splitHot({ features = {}, split = {}, labels: ownLabels }: { features?: Record<string, unknown>; split?: Record<string, unknown>; labels?: unknown } = {}): FakeHot {
  const hot = lookupHot(
    { typingSimulation: false, ...features },
    {},
    {
      split: { minChars: 20, minPartChars: 0, maxTasks: 4, contextMessages: 2, maxOutputTokens: 50, ...split },
      pace: { prepareMs: 5000, prepareSearchMs: 5000, dropAfterMs: 60000 },
    }
  );
  hot.prompts.split = SPLIT_SYSTEM;
  if (ownLabels) hot.prompts.labels = ownLabels;
  return hot;
}

/** A schedule whose timers fire only when `fire(ms)` is called (the turn's clock stands still at NOW). */
export function manualSchedule(): ManualSchedule {
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const schedule = (fn: () => void, ms: number) => {
    const timer = { fn, ms, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  schedule.fire = (ms: number) => {
    for (const timer of timers.filter((t) => t.ms === ms && !t.cancelled)) {
      timer.cancelled = true;
      timer.fn();
    }
  };
  return schedule;
}

/** One reply turn on a call with `content`, under the split settings. */
export async function runSplitTurn({
  hot = splitHot(),
  llm = splitLlm(),
  content = SPLIT_TEXT,
  triggerKind = 'mention',
  extra = {},
  turnExtra = {},
  schedule = manualSchedule(),
}: {
  hot?: FakeHot;
  llm?: ReturnType<typeof splitLlm>;
  content?: string;
  triggerKind?: TriggerKind;
  extra?: Record<string, unknown>;
  turnExtra?: Record<string, unknown>;
  schedule?: ReturnType<typeof manualSchedule>;
} = {}): Promise<SplitTurn> {
  const raw = rawMessage({ id: 'm2', ts: NOW - 1000, content });
  const channel = fakeTurnChannel({
    historyMessages: [
      rawMessage({ id: 'm1', ts: NOW - 5000, authorId: 'u2', authorName: 'Léa', content: 'καλημέρα' }),
      raw,
    ],
  });
  const turns = createTurnRunner({
    discord: DISCORD,
    createPort: createDiscordAdapter,
    hot,
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    lookup: fakeLookup(),
    now: () => NOW,
    schedule,
    ...extra,
  });
  const trigger = normalizedTrigger(raw);
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger, triggerKind, ...turnExtra })
  );
  return { result, logs, llm, channel, turns, trigger };
}

/** labels.task.part as the request renders it for part `index` of SPLIT_PARTS (no queued call). */
export function partLabel(index: number, parts = SPLIT_PARTS): string {
  const others = parts
    .map((text, i) => (i + 1 === index ? null : `${i + 1}. ${text}`))
    .filter(Boolean)
    .join('; ');
  return fill(labels.task.part, { index, total: parts.length, part: parts[index - 1], others });
}


/** The `<task>` block of a talk request. */
export function taskOf(call: { messages: Array<ChatMessage> }): string {
  return /<task>\n([\s\S]*?)\n<\/task>/.exec(userText(call.messages[1].content))?.[1] ?? '';
}
